-- ====================================================================
-- MIGRATION: 20260913000013_website_lifecycle.sql
-- PHASE:      013 Website Lifecycle (Master Control Center)
-- DESCRIPTION: websites is the SYSTEM OF RECORD for website lifecycle.
--              Replaces the previous fragmented modeling
--              (tickets.category=domain_request / users.domain_name).
--              Includes:
--                1. Capability registration (site.*)
--                2. public.websites (Core lifecycle entity)
--                3. public.website_events (Immutable event sourcing timeline)
--                4. public.website_credentials_ref (Secret reference vault)
--                5. public.website_services (Cloudflare edge & panel services)
--                6. public.website_reclaim_rules (Reclaim & idle policy)
--                7. public.website_health_checks (Diagnostic probe log)
--                8. FSM transition trigger & atomic RPC
--                9. RLS & capability-gated access policies
-- Conventions: security-definer RPCs with search_path='', fail-closed
--              actor/capability gate, immutable audit_logs, RLS.
-- FSM:
--   requested -> validating -> approved -> provisioning -> building -> deploying ->
--   dns_pending -> ssl_pending -> panel_pending -> access_verification -> active ->
--   degraded / suspended / reclaim_warning -> reclaimed
-- ====================================================================

-- 1. CAPABILITY REGISTRATION (site.* lifecycle capabilities)
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('site.request',   'Membuat permintaan website baru', 'sites'),
('site.validate',  'Validasi nama & domain website', 'sites'),
('site.configure', 'Mengatur tema / paket / panel website', 'sites'),
('site.build',     'Menjalankan build website', 'sites'),
('site.deploy',    'Men-deploy website ke Cloudflare', 'sites'),
('site.provision', 'Provisioning DNS/SSL/panel/access', 'sites'),
('site.activate',  'Aktivasi website ke status live/active', 'sites'),
('site.reclaim',   'Eksekusi akuisisi kembali (reclaim) website', 'sites'),
('site.manage',    'Kelola seluruh lifecycle website (gate RPC)', 'sites')
ON CONFLICT (code) DO NOTHING;

-- Grant operational roles full site.* capability
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin'), ('admin'), ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'site.%'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Member may only open a request (the rest is gated by staff RPCs)
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('member')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code = 'site.request'
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. TABLE: websites (system of record)
CREATE TABLE IF NOT EXISTS public.websites (
    id BIGSERIAL PRIMARY KEY,
    website_code VARCHAR(50) UNIQUE NOT NULL,
    domain VARCHAR(255),
    domain_inventory_id UUID REFERENCES public.domain_inventory(id) ON DELETE SET NULL,
    owner_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    lifecycle_status VARCHAR(30) NOT NULL DEFAULT 'requested',
    domain_type VARCHAR(10) NOT NULL DEFAULT 'free',
    theme VARCHAR(50),
    theme_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    commission_rate NUMERIC(5,2),
    commission_effective_at TIMESTAMPTZ,
    progress INT NOT NULL DEFAULT 0,
    activated_at TIMESTAMPTZ,
    last_value_at TIMESTAMPTZ,
    reclaim_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_website_lifecycle CHECK (lifecycle_status IN (
        'requested','validating','approved','provisioning','building','deploying',
        'dns_pending','ssl_pending','panel_pending','access_verification',
        'active','degraded','suspended','reclaim_warning','reclaimed'
    )),
    CONSTRAINT valid_website_domain_type CHECK (domain_type IN ('free','paid')),
    CONSTRAINT valid_website_progress CHECK (progress BETWEEN 0 AND 100),
    CONSTRAINT valid_website_commission CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 100))
);

CREATE INDEX IF NOT EXISTS idx_websites_lifecycle_status ON public.websites(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_websites_owner_user ON public.websites(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_websites_domain ON public.websites(domain);

-- 3. TABLE: website_events (immutable event sourcing / timeline)
CREATE TABLE IF NOT EXISTS public.website_events (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL REFERENCES public.websites(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_role VARCHAR(50),
    event_type VARCHAR(50) NOT NULL,
    old_status VARCHAR(30),
    new_status VARCHAR(30) NOT NULL,
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_website_events_website ON public.website_events(website_id);
CREATE INDEX IF NOT EXISTS idx_website_events_created ON public.website_events(created_at DESC);

-- 4. TABLE: website_credentials_ref (secret reference vault)
-- SECURITY: only a REFERENCE to an externally-managed secret is stored here.
-- The actual panel credentials/token/value live in a secret manager; the
-- dashboard/DB never hold secrets in plaintext.
CREATE TABLE IF NOT EXISTS public.website_credentials_ref (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL UNIQUE REFERENCES public.websites(id) ON DELETE CASCADE,
    panel_url TEXT,
    username TEXT,
    secret_ref VARCHAR(255),
    delivery_channel VARCHAR(30),
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. TABLE: website_services (Cloudflare edge & external service mappings)
CREATE TABLE IF NOT EXISTS public.website_services (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL REFERENCES public.websites(id) ON DELETE CASCADE,
    service_type VARCHAR(50) NOT NULL, -- 'dns', 'ssl', 'pages', 'proxy', 'panel', 'waf'
    provider VARCHAR(50) NOT NULL DEFAULT 'cloudflare',
    service_ref VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'pending', -- 'pending', 'active', 'degraded', 'error'
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_website_service UNIQUE (website_id, service_type)
);

CREATE INDEX IF NOT EXISTS idx_website_services_lookup ON public.website_services(website_id, service_type);

-- 6. TABLE: website_reclaim_rules (Inactivity thresholds & reclaim automation policies)
CREATE TABLE IF NOT EXISTS public.website_reclaim_rules (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL UNIQUE REFERENCES public.websites(id) ON DELETE CASCADE,
    idle_threshold_days INT NOT NULL DEFAULT 7,
    warning_grace_hours INT NOT NULL DEFAULT 48,
    min_value_threshold NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    auto_reclaim BOOLEAN NOT NULL DEFAULT FALSE,
    last_evaluated_at TIMESTAMPTZ,
    evaluation_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. TABLE: website_health_checks (Diagnostic probe logs for incidents and monitoring)
CREATE TABLE IF NOT EXISTS public.website_health_checks (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL REFERENCES public.websites(id) ON DELETE CASCADE,
    check_type VARCHAR(30) NOT NULL, -- 'dns', 'ssl', 'http', 'api', 'auth', 'payment', 'panel'
    status VARCHAR(20) NOT NULL, -- 'pass', 'warn', 'fail'
    latency_ms INT,
    response_code INT,
    error_message TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_health_check_status CHECK (status IN ('pass', 'warn', 'fail'))
);

CREATE INDEX IF NOT EXISTS idx_website_health_site_type ON public.website_health_checks(website_id, check_type);
CREATE INDEX IF NOT EXISTS idx_website_health_checked ON public.website_health_checks(checked_at DESC);

-- 8. Timestamp triggers (reuse audit-safe helpers from baseline 001)
DROP TRIGGER IF EXISTS websites_set_updated_at ON public.websites;
CREATE TRIGGER websites_set_updated_at BEFORE UPDATE ON public.websites
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS website_credentials_ref_set_updated_at ON public.website_credentials_ref;
CREATE TRIGGER website_credentials_ref_set_updated_at BEFORE UPDATE ON public.website_credentials_ref
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS website_services_set_updated_at ON public.website_services;
CREATE TRIGGER website_services_set_updated_at BEFORE UPDATE ON public.website_services
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS website_reclaim_rules_set_updated_at ON public.website_reclaim_rules;
CREATE TRIGGER website_reclaim_rules_set_updated_at BEFORE UPDATE ON public.website_reclaim_rules
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 9. FSM VALIDATION (lifecycle transition guard)
CREATE OR REPLACE FUNCTION public.validate_website_lifecycle_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.lifecycle_status = NEW.lifecycle_status THEN
        RETURN NEW;
    END IF;
    IF OLD.lifecycle_status = 'requested' AND NEW.lifecycle_status NOT IN ('validating','approved','reclaimed') THEN
        RAISE EXCEPTION 'Invalid transition requested -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'validating' AND NEW.lifecycle_status NOT IN ('approved') THEN
        RAISE EXCEPTION 'Invalid transition validating -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'approved' AND NEW.lifecycle_status NOT IN ('provisioning','active') THEN
        RAISE EXCEPTION 'Invalid transition approved -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'provisioning' AND NEW.lifecycle_status NOT IN ('building') THEN
        RAISE EXCEPTION 'Invalid transition provisioning -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'building' AND NEW.lifecycle_status NOT IN ('deploying') THEN
        RAISE EXCEPTION 'Invalid transition building -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'deploying' AND NEW.lifecycle_status NOT IN ('dns_pending','ssl_pending','active') THEN
        RAISE EXCEPTION 'Invalid transition deploying -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'dns_pending' AND NEW.lifecycle_status NOT IN ('ssl_pending','panel_pending','active') THEN
        RAISE EXCEPTION 'Invalid transition dns_pending -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'ssl_pending' AND NEW.lifecycle_status NOT IN ('panel_pending','access_verification','active') THEN
        RAISE EXCEPTION 'Invalid transition ssl_pending -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'panel_pending' AND NEW.lifecycle_status NOT IN ('access_verification') THEN
        RAISE EXCEPTION 'Invalid transition panel_pending -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'access_verification' AND NEW.lifecycle_status NOT IN ('active') THEN
        RAISE EXCEPTION 'Invalid transition access_verification -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'active' AND NEW.lifecycle_status NOT IN ('degraded','suspended','reclaim_warning') THEN
        RAISE EXCEPTION 'Invalid transition active -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'degraded' AND NEW.lifecycle_status NOT IN ('active','suspended') THEN
        RAISE EXCEPTION 'Invalid transition degraded -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'suspended' AND NEW.lifecycle_status NOT IN ('active','reclaimed') THEN
        RAISE EXCEPTION 'Invalid transition suspended -> %', NEW.lifecycle_status;
    END IF;
    IF OLD.lifecycle_status = 'reclaim_warning' AND NEW.lifecycle_status NOT IN ('active','reclaimed') THEN
        RAISE EXCEPTION 'Invalid transition reclaim_warning -> %', NEW.lifecycle_status;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_website_lifecycle ON public.websites;
CREATE TRIGGER trg_validate_website_lifecycle
BEFORE UPDATE ON public.websites
FOR EACH ROW
EXECUTE FUNCTION public.validate_website_lifecycle_transition();

-- 10. ATOMIC LIFECYCLE RPC (single golden path for every mutation)
CREATE OR REPLACE FUNCTION public.transition_website_lifecycle(
    p_website_id BIGINT,
    p_new_status VARCHAR(30),
    p_notes TEXT DEFAULT NULL,
    p_actor_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_old_status VARCHAR(30);
    v_actor_user_id BIGINT;
    v_actor_role VARCHAR(50);
BEGIN
    -- A. Authenticate caller and resolve actor identity (fail-closed)
    IF auth.role() = 'authenticated' THEN
        SELECT da.user_id, da.role INTO v_actor_user_id, v_actor_role
        FROM public.dashboard_access da
        WHERE da.auth_user_id = auth.uid()
          AND da.is_active = TRUE;

        IF v_actor_user_id IS NULL THEN
            RAISE EXCEPTION 'Access denied: no active operator account';
        END IF;

        -- Capability gate: site.manage (root/super_admin bypass)
        IF NOT (v_actor_role IN ('root', 'super_admin'))
           AND NOT EXISTS (
                SELECT 1 FROM public.backoffice_role_capabilities rc
                JOIN public.backoffice_capabilities bc ON bc.code = rc.capability_code
                WHERE rc.role = v_actor_role
                  AND bc.code = 'site.manage'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks site.manage capability', v_actor_role;
        END IF;

    ELSIF auth.role() = 'service_role' THEN
        -- Trusted backend / Edge Function path
        v_actor_user_id := p_actor_id;
        IF v_actor_user_id IS NOT NULL THEN
            SELECT role INTO v_actor_role FROM public.users WHERE id = v_actor_user_id;
        ELSE
            v_actor_role := 'system';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unauthorized: invalid caller role';
    END IF;

    -- B. Load current state (FSM trigger will reject illegal transitions)
    SELECT lifecycle_status INTO v_old_status
    FROM public.websites
    WHERE id = p_website_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Website % not found', p_website_id;
    END IF;

    -- C. Atomic state transition (BEFORE UPDATE triggers enforce FSM)
    UPDATE public.websites
    SET
        lifecycle_status = p_new_status,
        activated_at = CASE WHEN p_new_status = 'active' THEN COALESCE(activated_at, NOW()) ELSE activated_at END,
        reclaim_at    = CASE WHEN p_new_status IN ('reclaim_warning', 'reclaimed') THEN COALESCE(reclaim_at, NOW()) ELSE reclaim_at END
    WHERE id = p_website_id;

    -- D. Immutable event sourcing timeline
    INSERT INTO public.website_events (
        website_id, actor_id, actor_role, event_type, old_status, new_status, notes, metadata
    ) VALUES (
        p_website_id,
        v_actor_user_id,
        COALESCE(v_actor_role, 'system'),
        'STATUS_CHANGE',
        v_old_status,
        p_new_status,
        p_notes,
        jsonb_build_object(
            'actor_source', CASE WHEN auth.role() = 'authenticated' THEN 'auth.uid' ELSE 'service_role' END
        )
    );

    -- E. Immutable audit trail
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id,
        COALESCE(v_actor_role, 'system'),
        'WEBSITE_LIFECYCLE',
        'websites',
        p_website_id,
        jsonb_build_object('status', v_old_status),
        jsonb_build_object('status', p_new_status, 'notes', p_notes)
    );

    RETURN jsonb_build_object(
        'success', true,
        'website_id', p_website_id,
        'from', v_old_status,
        'to', p_new_status,
        'updated_at', NOW()
    );
END;
$$;

-- 11. REVOKE / GRANT on the RPC (strict surface)
REVOKE EXECUTE ON FUNCTION public.transition_website_lifecycle(BIGINT, VARCHAR, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_website_lifecycle(BIGINT, VARCHAR, TEXT, BIGINT) TO authenticated, service_role;

-- 12. ROW LEVEL SECURITY (RLS)
ALTER TABLE public.websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_credentials_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_reclaim_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_health_checks ENABLE ROW LEVEL SECURITY;

-- Operator read policies via security-definer helper
DROP POLICY IF EXISTS websites_operator_read ON public.websites;
CREATE POLICY websites_operator_read ON public.websites
    FOR SELECT
    USING (public.backoffice_has_capability('site.manage'));

DROP POLICY IF EXISTS website_services_operator_read ON public.website_services;
CREATE POLICY website_services_operator_read ON public.website_services
    FOR SELECT
    USING (public.backoffice_has_capability('site.manage'));

DROP POLICY IF EXISTS website_reclaim_rules_operator_read ON public.website_reclaim_rules;
CREATE POLICY website_reclaim_rules_operator_read ON public.website_reclaim_rules
    FOR SELECT
    USING (public.backoffice_has_capability('site.manage'));

DROP POLICY IF EXISTS website_health_checks_operator_read ON public.website_health_checks;
CREATE POLICY website_health_checks_operator_read ON public.website_health_checks
    FOR SELECT
    USING (public.backoffice_has_capability('site.manage'));

-- Member self-read (placeholder until member auth sessions exist)
DROP POLICY IF EXISTS websites_member_self_read ON public.websites;
CREATE POLICY websites_member_self_read ON public.websites
    FOR SELECT
    USING (FALSE);

-- website_events / website_credentials_ref: strictly service_role (Default Deny for client)
-- No public/anon/authenticated client policies are created.

-- 13. GRANTS
GRANT SELECT ON public.websites TO authenticated, service_role;
GRANT SELECT ON public.website_services TO authenticated, service_role;
GRANT SELECT ON public.website_reclaim_rules TO authenticated, service_role;
GRANT SELECT ON public.website_health_checks TO authenticated, service_role;

GRANT ALL ON public.website_events TO service_role;
GRANT ALL ON public.website_credentials_ref TO service_role;

REVOKE ALL ON public.website_events FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.website_credentials_ref FROM anon, authenticated, PUBLIC;

-- End of migration 013