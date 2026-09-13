-- ====================================================================
-- MIGRATION: 20260915000015_incident_management.sql
-- PHASE:      015 Incident Management (Master Control Center)
-- DESCRIPTION: Implements verifiable, evidence-based operational incident
--              management and diagnostic test suite tracking.
--              Eliminates speculative diagnoses ("mungkin server restart").
--              Includes:
--                1. Capability registration (incident.*)
--                2. public.incidents (Core incident tracking entity)
--                3. public.incident_checks (Telemetry & diagnostic test records:
--                   DNS, SSL, HTTP, API, AUTH, PAYMENT, PANEL)
--                4. public.incident_timeline (Immutable incident investigation trail)
--                5. FSM transition trigger for incidents
--                6. Atomic RPCs:
--                   - create_incident_ticket
--                   - record_incident_diagnostic_check
--                   - transition_incident_status
--                7. RLS & capability-gated access policies
-- Conventions: security-definer RPCs with search_path='', fail-closed
--              actor/capability gate, immutable audit_logs, RLS.
-- FSM:
--   reported -> triaged -> investigating -> fixing -> verifying -> resolved -> closed
-- ====================================================================

-- 1. CAPABILITY REGISTRATION (incident.* capabilities)
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('incident.create',    'Membuat laporan tiket insiden operasional baru', 'incidents'),
('incident.run_check',  'Mengeksekusi dan mencatat probe diagnostik telemetri', 'incidents'),
('incident.update',     'Mengubah status analisis & investigasi insiden', 'incidents'),
('incident.resolve',    'Memverifikasi perbaikan dan menutup insiden', 'incidents'),
('incident.manage',     'Akses komprehensif seluruh operasional insiden & SLA', 'incidents')
ON CONFLICT (code) DO NOTHING;

-- Grant capabilities to operational roles
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin'), ('admin'), ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'incident.%'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Operator role may create and update incidents
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('operator')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('incident.create', 'incident.update', 'incident.run_check')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. TABLE: incidents (Core incident tracking entity)
CREATE TABLE IF NOT EXISTS public.incidents (
    id BIGSERIAL PRIMARY KEY,
    incident_code VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    website_id BIGINT REFERENCES public.websites(id) ON DELETE SET NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'medium',
    status VARCHAR(30) NOT NULL DEFAULT 'reported',
    reporter_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    assigned_to BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    root_cause TEXT,
    resolution_notes TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_incident_severity CHECK (severity IN ('critical', 'high', 'medium', 'low')),
    CONSTRAINT valid_incident_status CHECK (status IN (
        'reported', 'triaged', 'investigating', 'fixing', 'verifying', 'resolved', 'closed'
    ))
);

CREATE INDEX IF NOT EXISTS idx_incidents_status ON public.incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON public.incidents(severity);
CREATE INDEX IF NOT EXISTS idx_incidents_website_id ON public.incidents(website_id);
CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON public.incidents(created_at DESC);

-- 3. TABLE: incident_checks (Evidence-based telemetry & probe test records)
CREATE TABLE IF NOT EXISTS public.incident_checks (
    id BIGSERIAL PRIMARY KEY,
    incident_id BIGINT NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
    check_type VARCHAR(30) NOT NULL,
    status VARCHAR(20) NOT NULL,
    response_code INT,
    latency_ms INT,
    endpoint_tested TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    checked_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_check_type CHECK (check_type IN ('dns', 'ssl', 'http', 'api', 'auth', 'payment', 'panel')),
    CONSTRAINT valid_check_status CHECK (status IN ('pass', 'warn', 'fail'))
);

CREATE INDEX IF NOT EXISTS idx_incident_checks_incident_id ON public.incident_checks(incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_checks_type_status ON public.incident_checks(incident_id, check_type, status);
CREATE INDEX IF NOT EXISTS idx_incident_checks_checked_at ON public.incident_checks(checked_at DESC);

-- 4. TABLE: incident_timeline (Immutable audit trail & action history)
CREATE TABLE IF NOT EXISTS public.incident_timeline (
    id BIGSERIAL PRIMARY KEY,
    incident_id BIGINT NOT NULL REFERENCES public.incidents(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_role VARCHAR(50),
    action_type VARCHAR(50) NOT NULL,
    old_status VARCHAR(30),
    new_status VARCHAR(30) NOT NULL,
    notes TEXT,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_timeline_incident_id ON public.incident_timeline(incident_id, created_at DESC);

-- 5. Timestamp trigger
DROP TRIGGER IF EXISTS incidents_set_updated_at ON public.incidents;
CREATE TRIGGER incidents_set_updated_at BEFORE UPDATE ON public.incidents
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 6. FSM VALIDATION TRIGGER FOR incidents
CREATE OR REPLACE FUNCTION public.validate_incident_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'reported' AND NEW.status NOT IN ('triaged', 'investigating', 'closed') THEN
        RAISE EXCEPTION 'Invalid transition from reported to %', NEW.status;
    END IF;
    IF OLD.status = 'triaged' AND NEW.status NOT IN ('investigating', 'closed') THEN
        RAISE EXCEPTION 'Invalid transition from triaged to %', NEW.status;
    END IF;
    IF OLD.status = 'investigating' AND NEW.status NOT IN ('fixing', 'closed') THEN
        RAISE EXCEPTION 'Invalid transition from investigating to %', NEW.status;
    END IF;
    IF OLD.status = 'fixing' AND NEW.status NOT IN ('verifying', 'investigating', 'closed') THEN
        RAISE EXCEPTION 'Invalid transition from fixing to %', NEW.status;
    END IF;
    IF OLD.status = 'verifying' AND NEW.status NOT IN ('resolved', 'investigating', 'fixing') THEN
        RAISE EXCEPTION 'Invalid transition from verifying to %', NEW.status;
    END IF;
    IF OLD.status = 'resolved' AND NEW.status NOT IN ('closed', 'investigating') THEN
        RAISE EXCEPTION 'Invalid transition from resolved to %', NEW.status;
    END IF;
    IF OLD.status = 'closed' AND NEW.status NOT IN ('investigating') THEN
        RAISE EXCEPTION 'Closed incident can only be reopened to investigating';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_incident_transition ON public.incidents;
CREATE TRIGGER trg_validate_incident_transition
BEFORE UPDATE ON public.incidents
FOR EACH ROW
EXECUTE FUNCTION public.validate_incident_transition();

-- 7. ATOMIC RPC: create_incident_ticket
CREATE OR REPLACE FUNCTION public.create_incident_ticket(
    p_title VARCHAR(255),
    p_website_id BIGINT DEFAULT NULL,
    p_severity VARCHAR(20) DEFAULT 'medium',
    p_notes TEXT DEFAULT NULL,
    p_actor_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor_user_id BIGINT;
    v_actor_role VARCHAR(50);
    v_new_incident_id BIGINT;
    v_incident_code VARCHAR(50);
    v_website_code VARCHAR(50);
BEGIN
    -- Authenticate caller
    IF auth.role() = 'authenticated' THEN
        SELECT da.user_id, da.role INTO v_actor_user_id, v_actor_role
        FROM public.dashboard_access da
        WHERE da.auth_user_id = auth.uid()
          AND da.is_active = TRUE;

        IF v_actor_user_id IS NULL THEN
            RAISE EXCEPTION 'Access denied: no active operator account';
        END IF;

        IF NOT (v_actor_role IN ('root', 'super_admin'))
           AND NOT EXISTS (
                SELECT 1 FROM public.backoffice_role_capabilities rc
                JOIN public.backoffice_capabilities bc ON bc.code = rc.capability_code
                WHERE rc.role = v_actor_role
                  AND bc.code = 'incident.create'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks incident.create capability', v_actor_role;
        END IF;

    ELSIF auth.role() = 'service_role' THEN
        v_actor_user_id := p_actor_id;
        IF v_actor_user_id IS NOT NULL THEN
            SELECT role INTO v_actor_role FROM public.users WHERE id = v_actor_user_id;
        ELSE
            v_actor_role := 'system';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unauthorized: invalid caller role';
    END IF;

    -- Validate severity
    IF p_severity NOT IN ('critical', 'high', 'medium', 'low') THEN
        RAISE EXCEPTION 'Invalid severity: % (must be critical, high, medium, or low)', p_severity;
    END IF;

    -- Resolve website code if website_id supplied
    IF p_website_id IS NOT NULL THEN
        SELECT website_code INTO v_website_code FROM public.websites WHERE id = p_website_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Website with id % not found', p_website_id;
        END IF;
    END IF;

    -- Generate incident code (INC-YYYYMMDD-XXXX)
    v_incident_code := 'INC-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random() * 10000)::text, 4, '0');

    -- Insert into incidents
    INSERT INTO public.incidents (
        incident_code, title, website_id, severity, status,
        reporter_id, started_at, metadata
    ) VALUES (
        v_incident_code, trim(p_title), p_website_id, p_severity, 'reported',
        v_actor_user_id, NOW(),
        jsonb_build_object('website_code', v_website_code, 'initial_notes', p_notes)
    ) RETURNING id INTO v_new_incident_id;

    -- Append initial timeline event
    INSERT INTO public.incident_timeline (
        incident_id, actor_id, actor_role, action_type, old_status, new_status, notes
    ) VALUES (
        v_new_incident_id, v_actor_user_id, COALESCE(v_actor_role, 'system'),
        'INCIDENT_REPORTED', NULL, 'reported', p_notes
    );

    -- Insert into audit_logs
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id, COALESCE(v_actor_role, 'system'),
        'INCIDENT_CREATED', 'incidents', v_new_incident_id,
        NULL,
        jsonb_build_object(
            'incident_code', v_incident_code,
            'title', p_title,
            'severity', p_severity,
            'website_id', p_website_id,
            'website_code', v_website_code
        )
    );

    -- Queue telegram notification alert
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, context_type, context_id, status
    ) VALUES (
        0,
        format('[ALERT] INSIDEN OPERASIONAL BARU: [%s] %s (Tingkat: %s). Situs: %s. Pelapor: %s',
               v_incident_code, p_title, upper(p_severity), COALESCE(v_website_code, 'Global/Sistem'), COALESCE(v_actor_role, 'staff')),
        'incident',
        v_incident_code,
        'queued'
    );

    RETURN jsonb_build_object(
        'success', true,
        'incident_id', v_new_incident_id,
        'incident_code', v_incident_code,
        'title', p_title,
        'severity', p_severity,
        'status', 'reported',
        'created_at', NOW()
    );
END;
$$;

-- 8. ATOMIC RPC: record_incident_diagnostic_check
CREATE OR REPLACE FUNCTION public.record_incident_diagnostic_check(
    p_incident_id BIGINT,
    p_check_type VARCHAR(30),
    p_status VARCHAR(20),
    p_response_code INT DEFAULT NULL,
    p_latency_ms INT DEFAULT NULL,
    p_endpoint_tested TEXT DEFAULT NULL,
    p_details JSONB DEFAULT '{}'::jsonb,
    p_actor_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor_user_id BIGINT;
    v_actor_role VARCHAR(50);
    v_inc RECORD;
    v_new_check_id BIGINT;
BEGIN
    -- Authenticate caller
    IF auth.role() = 'authenticated' THEN
        SELECT da.user_id, da.role INTO v_actor_user_id, v_actor_role
        FROM public.dashboard_access da
        WHERE da.auth_user_id = auth.uid()
          AND da.is_active = TRUE;

        IF v_actor_user_id IS NULL THEN
            RAISE EXCEPTION 'Access denied: no active operator account';
        END IF;

        IF NOT (v_actor_role IN ('root', 'super_admin'))
           AND NOT EXISTS (
                SELECT 1 FROM public.backoffice_role_capabilities rc
                JOIN public.backoffice_capabilities bc ON bc.code = rc.capability_code
                WHERE rc.role = v_actor_role
                  AND bc.code = 'incident.run_check'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks incident.run_check capability', v_actor_role;
        END IF;

    ELSIF auth.role() = 'service_role' THEN
        v_actor_user_id := p_actor_id;
        IF v_actor_user_id IS NOT NULL THEN
            SELECT role INTO v_actor_role FROM public.users WHERE id = v_actor_user_id;
        ELSE
            v_actor_role := 'system';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unauthorized: invalid caller role';
    END IF;

    -- Validate check type and status
    IF p_check_type NOT IN ('dns', 'ssl', 'http', 'api', 'auth', 'payment', 'panel') THEN
        RAISE EXCEPTION 'Invalid check_type: % (must be dns, ssl, http, api, auth, payment, or panel)', p_check_type;
    END IF;
    IF p_status NOT IN ('pass', 'warn', 'fail') THEN
        RAISE EXCEPTION 'Invalid status: % (must be pass, warn, or fail)', p_status;
    END IF;

    -- Verify incident exists
    SELECT * INTO v_inc FROM public.incidents WHERE id = p_incident_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Incident with id % not found', p_incident_id;
    END IF;

    -- Insert diagnostic test check
    INSERT INTO public.incident_checks (
        incident_id, check_type, status, response_code, latency_ms,
        endpoint_tested, details, checked_by, checked_at
    ) VALUES (
        p_incident_id, p_check_type, p_status, p_response_code, p_latency_ms,
        p_endpoint_tested, COALESCE(p_details, '{}'::jsonb), v_actor_user_id, NOW()
    ) RETURNING id INTO v_new_check_id;

    -- If check failed and incident is in reported or triaged, auto-escalate to investigating
    IF p_status = 'fail' AND v_inc.status IN ('reported', 'triaged') THEN
        UPDATE public.incidents
        SET status = 'investigating'
        WHERE id = p_incident_id;

        INSERT INTO public.incident_timeline (
            incident_id, actor_id, actor_role, action_type, old_status, new_status, notes, evidence
        ) VALUES (
            p_incident_id, v_actor_user_id, COALESCE(v_actor_role, 'system'),
            'AUTO_ESCALATED_INVESTIGATING', v_inc.status, 'investigating',
            format('Pemeriksaan %s GAGAL (Kode: %s, Latensi: %sms). Status otomatis dialihkan ke investigating.',
                   upper(p_check_type), COALESCE(p_response_code::text, 'N/A'), COALESCE(p_latency_ms::text, 'N/A')),
            jsonb_build_object('check_id', v_new_check_id, 'check_type', p_check_type, 'status', p_status)
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'check_id', v_new_check_id,
        'incident_id', p_incident_id,
        'check_type', p_check_type,
        'status', p_status,
        'latency_ms', p_latency_ms,
        'checked_at', NOW()
    );
END;
$$;

-- 9. ATOMIC RPC: transition_incident_status
CREATE OR REPLACE FUNCTION public.transition_incident_status(
    p_incident_id BIGINT,
    p_new_status VARCHAR(30),
    p_notes TEXT DEFAULT NULL,
    p_root_cause TEXT DEFAULT NULL,
    p_resolution_notes TEXT DEFAULT NULL,
    p_actor_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor_user_id BIGINT;
    v_actor_role VARCHAR(50);
    v_inc RECORD;
    v_required_cap VARCHAR(50);
BEGIN
    -- Determine required capability
    IF p_new_status IN ('resolved', 'closed') THEN
        v_required_cap := 'incident.resolve';
    ELSE
        v_required_cap := 'incident.update';
    END IF;

    -- Authenticate caller
    IF auth.role() = 'authenticated' THEN
        SELECT da.user_id, da.role INTO v_actor_user_id, v_actor_role
        FROM public.dashboard_access da
        WHERE da.auth_user_id = auth.uid()
          AND da.is_active = TRUE;

        IF v_actor_user_id IS NULL THEN
            RAISE EXCEPTION 'Access denied: no active operator account';
        END IF;

        IF NOT (v_actor_role IN ('root', 'super_admin'))
           AND NOT EXISTS (
                SELECT 1 FROM public.backoffice_role_capabilities rc
                JOIN public.backoffice_capabilities bc ON bc.code = rc.capability_code
                WHERE rc.role = v_actor_role
                  AND bc.code = v_required_cap
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks % capability', v_actor_role, v_required_cap;
        END IF;

    ELSIF auth.role() = 'service_role' THEN
        v_actor_user_id := p_actor_id;
        IF v_actor_user_id IS NOT NULL THEN
            SELECT role INTO v_actor_role FROM public.users WHERE id = v_actor_user_id;
        ELSE
            v_actor_role := 'system';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unauthorized: invalid caller role';
    END IF;

    -- Lock and retrieve incident
    SELECT * INTO v_inc
    FROM public.incidents
    WHERE id = p_incident_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Incident % not found', p_incident_id;
    END IF;

    -- If resolving, verify root_cause or resolution notes provided
    IF p_new_status = 'resolved' AND COALESCE(p_root_cause, v_inc.root_cause) IS NULL THEN
        RAISE EXCEPTION 'Penyebab utama (root_cause) wajib diisi sebelum insiden dapat ditandai RESOLVED.';
    END IF;

    -- Update incident state
    UPDATE public.incidents
    SET
        status = p_new_status,
        root_cause = COALESCE(p_root_cause, root_cause),
        resolution_notes = COALESCE(p_resolution_notes, resolution_notes),
        resolved_at = CASE WHEN p_new_status = 'resolved' THEN COALESCE(resolved_at, NOW()) ELSE resolved_at END,
        closed_at   = CASE WHEN p_new_status = 'closed' THEN COALESCE(closed_at, NOW()) ELSE closed_at END
    WHERE id = p_incident_id;

    -- Append timeline event
    INSERT INTO public.incident_timeline (
        incident_id, actor_id, actor_role, action_type, old_status, new_status, notes, evidence
    ) VALUES (
        p_incident_id, v_actor_user_id, COALESCE(v_actor_role, 'system'),
        'STATUS_CHANGE', v_inc.status, p_new_status, p_notes,
        jsonb_build_object(
            'root_cause', p_root_cause,
            'resolution_notes', p_resolution_notes
        )
    );

    -- Insert into audit_logs
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id, COALESCE(v_actor_role, 'system'),
        'INCIDENT_STATUS_CHANGED', 'incidents', p_incident_id,
        jsonb_build_object('status', v_inc.status),
        jsonb_build_object('status', p_new_status, 'notes', p_notes, 'root_cause', p_root_cause)
    );

    -- Queue telegram notification
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, context_type, context_id, status
    ) VALUES (
        0,
        format('Status Insiden [%s] diubah: %s -> %s. Catatan: %s',
               v_inc.incident_code, v_inc.status, p_new_status, COALESCE(p_notes, '-')),
        'incident',
        v_inc.incident_code,
        'queued'
    );

    RETURN jsonb_build_object(
        'success', true,
        'incident_id', p_incident_id,
        'incident_code', v_inc.incident_code,
        'from', v_inc.status,
        'to', p_new_status,
        'updated_at', NOW()
    );
END;
$$;

-- 10. REVOKE / GRANT on the RPCs (strict surface)
REVOKE EXECUTE ON FUNCTION public.create_incident_ticket(VARCHAR, BIGINT, VARCHAR, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_incident_ticket(VARCHAR, BIGINT, VARCHAR, TEXT, BIGINT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.record_incident_diagnostic_check(BIGINT, VARCHAR, VARCHAR, INT, INT, TEXT, JSONB, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_incident_diagnostic_check(BIGINT, VARCHAR, VARCHAR, INT, INT, TEXT, JSONB, BIGINT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.transition_incident_status(BIGINT, VARCHAR, TEXT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_incident_status(BIGINT, VARCHAR, TEXT, TEXT, TEXT, BIGINT) TO authenticated, service_role;

-- 11. ROW LEVEL SECURITY (RLS)
ALTER TABLE public.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_timeline ENABLE ROW LEVEL SECURITY;

-- Operator read policies via security-definer helper
DROP POLICY IF EXISTS incidents_operator_read ON public.incidents;
CREATE POLICY incidents_operator_read ON public.incidents
    FOR SELECT
    USING (public.backoffice_has_capability('incident.update'));

DROP POLICY IF EXISTS incident_checks_operator_read ON public.incident_checks;
CREATE POLICY incident_checks_operator_read ON public.incident_checks
    FOR SELECT
    USING (public.backoffice_has_capability('incident.run_check'));

DROP POLICY IF EXISTS incident_timeline_operator_read ON public.incident_timeline;
CREATE POLICY incident_timeline_operator_read ON public.incident_timeline
    FOR SELECT
    USING (public.backoffice_has_capability('incident.update'));

-- GRANTS
GRANT SELECT ON public.incidents TO authenticated, service_role;
GRANT SELECT ON public.incident_checks TO authenticated, service_role;
GRANT SELECT ON public.incident_timeline TO authenticated, service_role;

GRANT ALL ON public.incidents TO service_role;
GRANT ALL ON public.incident_checks TO service_role;
GRANT ALL ON public.incident_timeline TO service_role;

-- End of migration 015
