-- ====================================================================
-- MIGRATION: 20260914000014_update_commission_rules.sql
-- PHASE:      014 Update / Commission Rules (Master Control Center)
-- DESCRIPTION: Implements formal commission workflow ("Update Paman73 75%").
--              Eliminates arbitrary client-side rate updates.
--              Includes:
--                1. Capability registration (commission.*)
--                2. public.commission_rules (Master limits & tier rules)
--                3. public.update_requests (FSM request workflow)
--                4. public.commission_audit_history (Rate history ledger)
--                5. FSM transition trigger for update_requests
--                6. Atomic RPCs:
--                   - create_commission_update_request
--                   - approve_commission_update_request (atomic website rate mutation)
--                   - reject_commission_update_request
--                7. RLS & capability-gated access policies
-- Conventions: security-definer RPCs with search_path='', fail-closed
--              actor/capability gate, immutable audit_logs, RLS.
-- FSM:
--   requested -> reviewing -> approved -> scheduled -> effective
--                \            \
--                 rejected     cancelled
-- ====================================================================

-- 1. CAPABILITY REGISTRATION (commission.* capabilities)
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('commission.request', 'Mengajukan permohonan update rate komisi website', 'finance'),
('commission.review',  'Meninjau dan mengevaluasi pengajuan komisi', 'finance'),
('commission.approve', 'Menyetujui atau menolak perubahan komisi (eksekusi atomik)', 'finance'),
('commission.manage',  'Mengelola aturan master batas komisi (commission rules)', 'finance')
ON CONFLICT (code) DO NOTHING;

-- Grant capabilities to operational roles
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin'), ('admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'commission.%'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Dev role may review and inspect
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('commission.review')
ON CONFLICT (role, capability_code) DO NOTHING;

-- Member role may submit requests
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('member')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code = 'commission.request'
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. TABLE: commission_rules (Master policy & tier limits)
CREATE TABLE IF NOT EXISTS public.commission_rules (
    id BIGSERIAL PRIMARY KEY,
    rule_name VARCHAR(100) UNIQUE NOT NULL,
    min_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    max_rate NUMERIC(5,2) NOT NULL DEFAULT 100.00,
    default_rate NUMERIC(5,2) NOT NULL DEFAULT 50.00,
    requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_commission_rule_bounds CHECK (
        min_rate >= 0 AND max_rate <= 100 AND min_rate <= max_rate AND
        default_rate >= min_rate AND default_rate <= max_rate
    )
);

-- Seed default commission tiers
INSERT INTO public.commission_rules (rule_name, min_rate, max_rate, default_rate, requires_approval, description)
VALUES
('Standard Affiliate Tier', 10.00, 70.00, 50.00, TRUE, 'Batas komisi standar untuk seluruh member terdaftar.'),
('VIP Partner Tier', 50.00, 90.00, 75.00, TRUE, 'Batas komisi kemitraan khusus (mis. Paman73 75%).')
ON CONFLICT (rule_name) DO NOTHING;

-- 3. TABLE: update_requests (FSM request workflow)
CREATE TABLE IF NOT EXISTS public.update_requests (
    id BIGSERIAL PRIMARY KEY,
    request_code VARCHAR(50) UNIQUE NOT NULL,
    website_id BIGINT NOT NULL REFERENCES public.websites(id) ON DELETE RESTRICT,
    requested_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    current_rate NUMERIC(5,2) NOT NULL,
    target_rate NUMERIC(5,2) NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'requested',
    approved_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    effective_at TIMESTAMPTZ,
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_update_request_status CHECK (status IN (
        'requested', 'reviewing', 'approved', 'rejected', 'scheduled', 'effective', 'cancelled'
    )),
    CONSTRAINT valid_update_current_rate CHECK (current_rate >= 0 AND current_rate <= 100),
    CONSTRAINT valid_update_target_rate CHECK (target_rate >= 0 AND target_rate <= 100),
    CONSTRAINT different_update_rates CHECK (current_rate != target_rate)
);

CREATE INDEX IF NOT EXISTS idx_update_requests_website ON public.update_requests(website_id);
CREATE INDEX IF NOT EXISTS idx_update_requests_status ON public.update_requests(status);
CREATE INDEX IF NOT EXISTS idx_update_requests_created ON public.update_requests(created_at DESC);

-- 4. TABLE: commission_audit_history (Rate history ledger)
CREATE TABLE IF NOT EXISTS public.commission_audit_history (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL REFERENCES public.websites(id) ON DELETE CASCADE,
    update_request_id BIGINT REFERENCES public.update_requests(id) ON DELETE SET NULL,
    previous_rate NUMERIC(5,2),
    new_rate NUMERIC(5,2) NOT NULL,
    applied_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commission_history_website ON public.commission_audit_history(website_id, created_at DESC);

-- 5. Timestamp triggers
DROP TRIGGER IF EXISTS commission_rules_set_updated_at ON public.commission_rules;
CREATE TRIGGER commission_rules_set_updated_at BEFORE UPDATE ON public.commission_rules
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS update_requests_set_updated_at ON public.update_requests;
CREATE TRIGGER update_requests_set_updated_at BEFORE UPDATE ON public.update_requests
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 6. FSM VALIDATION TRIGGER FOR update_requests
CREATE OR REPLACE FUNCTION public.validate_update_request_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'requested' AND NEW.status NOT IN ('reviewing', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from requested to %', NEW.status;
    END IF;
    IF OLD.status = 'reviewing' AND NEW.status NOT IN ('approved', 'rejected', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from reviewing to %', NEW.status;
    END IF;
    IF OLD.status = 'approved' AND NEW.status NOT IN ('scheduled', 'effective', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from approved to %', NEW.status;
    END IF;
    IF OLD.status = 'scheduled' AND NEW.status NOT IN ('effective', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from scheduled to %', NEW.status;
    END IF;
    IF OLD.status IN ('rejected', 'effective', 'cancelled') THEN
        RAISE EXCEPTION 'Cannot transition from terminal state %', OLD.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_update_request ON public.update_requests;
CREATE TRIGGER trg_validate_update_request
BEFORE UPDATE ON public.update_requests
FOR EACH ROW
EXECUTE FUNCTION public.validate_update_request_transition();

-- 7. ATOMIC RPC: create_commission_update_request
CREATE OR REPLACE FUNCTION public.create_commission_update_request(
    p_website_id BIGINT,
    p_target_rate NUMERIC,
    p_reason TEXT,
    p_effective_at TIMESTAMPTZ DEFAULT NULL,
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
    v_current_rate NUMERIC(5,2);
    v_website_code VARCHAR(50);
    v_new_request_id BIGINT;
    v_request_code VARCHAR(50);
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
                  AND bc.code = 'commission.request'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks commission.request capability', v_actor_role;
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

    -- Validate target rate boundaries
    IF p_target_rate < 0 OR p_target_rate > 100 THEN
        RAISE EXCEPTION 'Target commission rate % is invalid (must be 0 - 100)', p_target_rate;
    END IF;

    -- Fetch current website status and rate
    SELECT commission_rate, website_code INTO v_current_rate, v_website_code
    FROM public.websites
    WHERE id = p_website_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Website % not found', p_website_id;
    END IF;

    v_current_rate := COALESCE(v_current_rate, 0.00);

    IF v_current_rate = p_target_rate THEN
        RAISE EXCEPTION 'Target rate % matches current website commission rate', p_target_rate;
    END IF;

    -- Generate human-readable request code
    v_request_code := 'UR-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random() * 10000)::text, 4, '0');

    -- Insert into update_requests
    INSERT INTO public.update_requests (
        request_code, website_id, requested_by, current_rate, target_rate,
        reason, status, effective_at, metadata
    ) VALUES (
        v_request_code, p_website_id, v_actor_user_id, v_current_rate, p_target_rate,
        trim(p_reason), 'requested', p_effective_at,
        jsonb_build_object('website_code', v_website_code, 'created_by_role', v_actor_role)
    ) RETURNING id INTO v_new_request_id;

    -- Insert into audit_logs
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id,
        COALESCE(v_actor_role, 'system'),
        'COMMISSION_REQUEST_CREATED',
        'update_requests',
        v_new_request_id,
        jsonb_build_object('current_rate', v_current_rate),
        jsonb_build_object(
            'target_rate', p_target_rate,
            'request_code', v_request_code,
            'website_code', v_website_code,
            'reason', p_reason
        )
    );

    -- Queue telegram notification
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, context_type, context_id, status
    ) VALUES (
        0, -- Global admin channel sentinel
        format('Permohonan Update Komisi Baru: %s untuk %s (%s%% -> %s%%). Alasan: %s',
               v_request_code, v_website_code, v_current_rate, p_target_rate, p_reason),
        'commission',
        v_request_code,
        'queued'
    );

    RETURN jsonb_build_object(
        'success', true,
        'request_id', v_new_request_id,
        'request_code', v_request_code,
        'website_id', p_website_id,
        'website_code', v_website_code,
        'current_rate', v_current_rate,
        'target_rate', p_target_rate,
        'status', 'requested',
        'created_at', NOW()
    );
END;
$$;

-- 8. ATOMIC RPC: approve_commission_update_request
CREATE OR REPLACE FUNCTION public.approve_commission_update_request(
    p_request_id BIGINT,
    p_effective_at TIMESTAMPTZ DEFAULT NULL,
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
    v_req RECORD;
    v_target_status VARCHAR(30);
    v_effective_time TIMESTAMPTZ;
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
                  AND bc.code = 'commission.approve'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks commission.approve capability', v_actor_role;
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

    -- Lock and retrieve request row
    SELECT * INTO v_req
    FROM public.update_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Update request % not found', p_request_id;
    END IF;

    IF v_req.status NOT IN ('requested', 'reviewing') THEN
        RAISE EXCEPTION 'Cannot approve request in status % (must be requested or reviewing)', v_req.status;
    END IF;

    -- Advance to reviewing first if currently requested
    IF v_req.status = 'requested' THEN
        UPDATE public.update_requests
        SET status = 'reviewing'
        WHERE id = p_request_id;
    END IF;

    v_effective_time := COALESCE(p_effective_at, v_req.effective_at, NOW());

    -- Determine whether transition is immediate 'effective' or 'scheduled'
    IF v_effective_time <= NOW() THEN
        v_target_status := 'effective';
    ELSE
        v_target_status := 'scheduled';
    END IF;

    -- Transition update_requests status
    UPDATE public.update_requests
    SET
        status = 'approved',
        approved_by = v_actor_user_id,
        notes = p_notes
    WHERE id = p_request_id;

    UPDATE public.update_requests
    SET
        status = v_target_status,
        effective_at = v_effective_time
    WHERE id = p_request_id;

    -- If immediately effective, atomically mutate public.websites
    IF v_target_status = 'effective' THEN
        UPDATE public.websites
        SET
            commission_rate = v_req.target_rate,
            commission_effective_at = v_effective_time
        WHERE id = v_req.website_id;

        -- Record into commission_audit_history
        INSERT INTO public.commission_audit_history (
            website_id, update_request_id, previous_rate, new_rate, applied_by, effective_at, notes
        ) VALUES (
            v_req.website_id, p_request_id, v_req.current_rate, v_req.target_rate,
            v_actor_user_id, v_effective_time, p_notes
        );
    END IF;

    -- Immutable audit trail
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id,
        COALESCE(v_actor_role, 'system'),
        'COMMISSION_REQUEST_APPROVED',
        'update_requests',
        p_request_id,
        jsonb_build_object('status', v_req.status, 'rate', v_req.current_rate),
        jsonb_build_object(
            'status', v_target_status,
            'new_rate', v_req.target_rate,
            'effective_at', v_effective_time,
            'approved_by', v_actor_user_id
        )
    );

    -- Queue telegram notification
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, context_type, context_id, status
    ) VALUES (
        0,
        format('Permohonan Update Komisi %s DISETUJUI: Target rate %s%% resmi berlaku (%s). Approver: %s',
               v_req.request_code, v_req.target_rate, v_target_status, COALESCE(v_actor_role, 'admin')),
        'commission',
        v_req.request_code,
        'queued'
    );

    RETURN jsonb_build_object(
        'success', true,
        'request_id', p_request_id,
        'request_code', v_req.request_code,
        'website_id', v_req.website_id,
        'new_rate', v_req.target_rate,
        'status', v_target_status,
        'effective_at', v_effective_time,
        'approved_by', v_actor_user_id
    );
END;
$$;

-- 9. ATOMIC RPC: reject_commission_update_request
CREATE OR REPLACE FUNCTION public.reject_commission_update_request(
    p_request_id BIGINT,
    p_reason TEXT,
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
    v_req RECORD;
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
                  AND bc.code = 'commission.approve'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks commission.approve capability', v_actor_role;
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

    -- Lock and retrieve request row
    SELECT * INTO v_req
    FROM public.update_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Update request % not found', p_request_id;
    END IF;

    IF v_req.status NOT IN ('requested', 'reviewing') THEN
        RAISE EXCEPTION 'Cannot reject request in status %', v_req.status;
    END IF;

    -- Advance to reviewing first if currently requested
    IF v_req.status = 'requested' THEN
        UPDATE public.update_requests
        SET status = 'reviewing'
        WHERE id = p_request_id;
    END IF;

    -- Transition to rejected
    UPDATE public.update_requests
    SET
        status = 'rejected',
        notes = p_reason
    WHERE id = p_request_id;

    -- Immutable audit trail
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id,
        COALESCE(v_actor_role, 'system'),
        'COMMISSION_REQUEST_REJECTED',
        'update_requests',
        p_request_id,
        jsonb_build_object('status', v_req.status),
        jsonb_build_object('status', 'rejected', 'reason', p_reason)
    );

    RETURN jsonb_build_object(
        'success', true,
        'request_id', p_request_id,
        'request_code', v_req.request_code,
        'status', 'rejected',
        'reason', p_reason
    );
END;
$$;

-- 10. REVOKE / GRANT on the RPCs (strict surface)
REVOKE EXECUTE ON FUNCTION public.create_commission_update_request(BIGINT, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_commission_update_request(BIGINT, NUMERIC, TEXT, TIMESTAMPTZ, BIGINT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.approve_commission_update_request(BIGINT, TIMESTAMPTZ, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_commission_update_request(BIGINT, TIMESTAMPTZ, TEXT, BIGINT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.reject_commission_update_request(BIGINT, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_commission_update_request(BIGINT, TEXT, BIGINT) TO authenticated, service_role;

-- 11. ROW LEVEL SECURITY (RLS)
ALTER TABLE public.commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.update_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_audit_history ENABLE ROW LEVEL SECURITY;

-- Operator read policies via security-definer helper
DROP POLICY IF EXISTS commission_rules_operator_read ON public.commission_rules;
CREATE POLICY commission_rules_operator_read ON public.commission_rules
    FOR SELECT
    USING (public.backoffice_has_capability('commission.review'));

DROP POLICY IF EXISTS update_requests_operator_read ON public.update_requests;
CREATE POLICY update_requests_operator_read ON public.update_requests
    FOR SELECT
    USING (public.backoffice_has_capability('commission.review'));

DROP POLICY IF EXISTS commission_audit_history_operator_read ON public.commission_audit_history;
CREATE POLICY commission_audit_history_operator_read ON public.commission_audit_history
    FOR SELECT
    USING (public.backoffice_has_capability('commission.review'));

-- GRANTS
GRANT SELECT ON public.commission_rules TO authenticated, service_role;
GRANT SELECT ON public.update_requests TO authenticated, service_role;
GRANT SELECT ON public.commission_audit_history TO authenticated, service_role;

GRANT ALL ON public.commission_rules TO service_role;
GRANT ALL ON public.update_requests TO service_role;
GRANT ALL ON public.commission_audit_history TO service_role;

-- End of migration 014
