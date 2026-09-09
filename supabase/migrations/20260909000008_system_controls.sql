-- ====================================================================
-- MIGRATION: 20260909000008_system_controls.sql
-- DESCRIPTION: Enterprise Emergency Controls & Kill-Switches
--              Includes atomic mutation RPC, key validation, capability check,
--              and immutable audit logging.
-- ====================================================================

-- 1. Ensure capability 'system.manage_controls' is registered
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('system.manage_controls', 'Mengelola emergency flags (freeze payment, freeze claims dll)', 'system')
ON CONFLICT (code) DO NOTHING;

-- Grant to root and super_admin
INSERT INTO public.backoffice_role_capabilities (role, capability_code) VALUES
('super_admin', 'system.manage_controls'),
('root', 'system.manage_controls')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. Table: system_controls
CREATE TABLE IF NOT EXISTS public.system_controls (
    id VARCHAR(50) PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,

    CONSTRAINT valid_system_control_id CHECK (id IN ('emergency_flags', 'maintenance_mode', 'rate_limits'))
);

-- Seed initial emergency flags
INSERT INTO public.system_controls (id, value, reason) VALUES 
(
    'emergency_flags',
    '{
        "payment_frozen": false,
        "login_frozen": false,
        "withdrawals_frozen": false,
        "claims_frozen": false,
        "bot_maintenance": false
    }'::jsonb,
    'System baseline initialization'
)
ON CONFLICT (id) DO NOTHING;

-- 3. Row Level Security
ALTER TABLE public.system_controls ENABLE ROW LEVEL SECURITY;

-- Allow read access to authenticated staff and edge functions
DROP POLICY IF EXISTS system_controls_read ON public.system_controls;
CREATE POLICY system_controls_read ON public.system_controls
    FOR SELECT
    USING (true);

-- No direct INSERT / UPDATE / DELETE policies: mutations must go through update_system_control RPC or service_role

-- 4. Atomic Stored Procedure for System Control Mutation
CREATE OR REPLACE FUNCTION public.update_system_control(
    p_id VARCHAR(50),
    p_patch JSONB,
    p_reason TEXT,
    p_actor_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_old_value JSONB;
    v_new_value JSONB;
    v_actor_user_id BIGINT;
    v_actor_role VARCHAR(50);
    v_key TEXT;
    v_allowed_keys TEXT[] := ARRAY['payment_frozen', 'login_frozen', 'withdrawals_frozen', 'claims_frozen', 'bot_maintenance'];
BEGIN
    -- A. Validate input reason
    IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
        RAISE EXCEPTION 'Audit reason must be at least 5 characters long';
    END IF;

    -- B. Authenticate caller and resolve actor identity securely
    IF auth.role() = 'authenticated' THEN
        SELECT da.user_id, da.role INTO v_actor_user_id, v_actor_role
        FROM public.dashboard_access da
        WHERE da.auth_user_id = auth.uid()
          AND da.is_active = TRUE;

        IF v_actor_user_id IS NULL THEN
            RAISE EXCEPTION 'Access denied: caller does not have an active dashboard operator account';
        END IF;

        -- Check capability 'system.manage_controls'
        IF NOT EXISTS (
            SELECT 1 FROM public.backoffice_role_capabilities rc
            WHERE rc.role = v_actor_role
              AND rc.capability_code = 'system.manage_controls'
        ) AND v_actor_role NOT IN ('super_admin', 'root') THEN
            RAISE EXCEPTION 'Access denied: role % lacks system.manage_controls capability', v_actor_role;
        END IF;

    ELSIF auth.role() = 'service_role' THEN
        -- Called via trusted backend/Edge Function
        v_actor_user_id := p_actor_id;
        IF v_actor_user_id IS NOT NULL THEN
            SELECT role INTO v_actor_role FROM public.users WHERE id = v_actor_user_id;
        ELSE
            v_actor_role := 'system';
        END IF;

    ELSE
        RAISE EXCEPTION 'Unauthorized: invalid caller role';
    END IF;

    -- C. Validate control keys if targeting 'emergency_flags'
    IF p_id = 'emergency_flags' THEN
        FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
            IF NOT (v_key = ANY(v_allowed_keys)) THEN
                RAISE EXCEPTION 'Invalid emergency flag key: %. Allowed keys: %', v_key, v_allowed_keys;
            END IF;
        END LOOP;
    END IF;

    -- D. Acquire row lock and fetch previous state
    SELECT value INTO v_old_value
    FROM public.system_controls
    WHERE id = p_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'System control with id % not found', p_id;
    END IF;

    -- Merge patch into old value
    v_new_value := v_old_value || p_patch;

    -- E. Atomic Update
    UPDATE public.system_controls
    SET
        value = v_new_value,
        reason = p_reason,
        updated_at = NOW(),
        updated_by = v_actor_user_id
    WHERE id = p_id;

    -- F. Record Immutable Audit Log
    INSERT INTO public.audit_logs (
        actor_id,
        actor_role,
        action_type,
        resource_type,
        resource_id,
        old_value,
        new_value
    ) VALUES (
        v_actor_user_id,
        COALESCE(v_actor_role, 'unknown'),
        'SYSTEM_CONTROL_MUTATED',
        'system_controls',
        1, -- baseline numeric id for system resource
        jsonb_build_object('id', p_id, 'value', v_old_value),
        jsonb_build_object('id', p_id, 'value', v_new_value, 'patch', p_patch, 'reason', p_reason)
    );

    RETURN jsonb_build_object(
        'success', true,
        'id', p_id,
        'value', v_new_value,
        'updated_at', NOW(),
        'updated_by', v_actor_user_id
    );
END;
$$;

-- 5. Revoke permissions from PUBLIC and grant strictly
REVOKE EXECUTE ON FUNCTION public.update_system_control(VARCHAR, JSONB, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_system_control(VARCHAR, JSONB, TEXT, BIGINT) TO authenticated, service_role;
