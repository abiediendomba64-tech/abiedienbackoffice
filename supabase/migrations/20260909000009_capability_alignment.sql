-- ====================================================================
-- MIGRATION: 20260909000009_capability_alignment.sql
-- DESCRIPTION: Hierarchy Expansion, Non-Recursive Authorization Helpers,
--              Capability Enforcement, and RPC Actor Spoofing Prevention.
-- ====================================================================

-- 1. Expand dashboard_access role constraint to include all hierarchy tiers
ALTER TABLE public.dashboard_access DROP CONSTRAINT IF EXISTS valid_dashboard_role;
ALTER TABLE public.dashboard_access ADD CONSTRAINT valid_dashboard_role 
    CHECK (role IN ('admin', 'dev', 'super_admin', 'root'));

-- 2. Register new capabilities in the registry
INSERT INTO public.backoffice_capabilities (capability, description) VALUES
('telegram.send_notification', 'Mengirim notifikasi ke Telegram (E2E)'),
('dashboard.access', 'Akses masuk antarmuka backoffice operator')
ON CONFLICT (capability) DO NOTHING;

-- Grant capabilities strictly aligned with operational hierarchy
-- dev: operations/troubleshooting, but NOT sending arbitrary telegram broadcasts
INSERT INTO public.backoffice_role_capabilities (role, capability_id)
SELECT r.role, bc.id
FROM (VALUES ('root'), ('super_admin'), ('admin'), ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.capability = 'dashboard.access'
ON CONFLICT (role, capability_id) DO NOTHING;

INSERT INTO public.backoffice_role_capabilities (role, capability_id)
SELECT r.role, bc.id
FROM (VALUES ('root'), ('super_admin'), ('admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.capability = 'telegram.send_notification'
ON CONFLICT (role, capability_id) DO NOTHING;

-- 3. Security-Definer Helper Functions (Breaking recursive RLS)

-- Helper A: Fetch current operator identity safely without circular RLS
DROP FUNCTION IF EXISTS public.backoffice_current_access();
CREATE OR REPLACE FUNCTION public.backoffice_current_access()
RETURNS TABLE (
    user_id BIGINT,
    role VARCHAR(50),
    is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    SELECT da.user_id, da.role, da.is_active
    FROM public.dashboard_access da
    WHERE da.auth_user_id = auth.uid()
      AND da.is_active = TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.backoffice_current_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backoffice_current_access() TO authenticated, service_role;

-- Helper B: Unified capability checker
CREATE OR REPLACE FUNCTION public.backoffice_has_capability(required_capability VARCHAR(100))
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_role VARCHAR(50);
    v_has_cap BOOLEAN;
BEGIN
    -- service_role (Edge Functions) bypasses capability checks
    IF auth.role() = 'service_role' THEN
        RETURN TRUE;
    END IF;

    -- Lookup active operator role via security definer
    SELECT da.role INTO v_role
    FROM public.dashboard_access da
    WHERE da.auth_user_id = auth.uid()
      AND da.is_active = TRUE;

    IF v_role IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Check if role has this exact capability (join with capabilities table)
    SELECT EXISTS (
        SELECT 1
        FROM public.backoffice_role_capabilities rc
        JOIN public.backoffice_capabilities bc ON bc.id = rc.capability_id
        WHERE rc.role = v_role
          AND bc.capability = required_capability
    ) INTO v_has_cap;

    RETURN COALESCE(v_has_cap, FALSE);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.backoffice_has_capability(VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backoffice_has_capability(VARCHAR) TO authenticated, service_role;

-- 4. Replace Recursive RLS on dashboard_access
DROP POLICY IF EXISTS dashboard_access_manage_super_admin ON public.dashboard_access;
CREATE POLICY dashboard_access_manage_super_admin ON public.dashboard_access
    FOR ALL
    USING (
        -- Only operators with root or super_admin role can manage dashboard accounts
        EXISTS (
            SELECT 1 FROM public.backoffice_current_access() a
            WHERE a.role IN ('super_admin', 'root')
        )
    );

-- 5. Harden mutate_ticket_state_atomic: Prevent Actor Identity Spoofing
-- Requester identity MUST come from auth.uid() -> dashboard_access -> actor_id,
-- NOT from client-supplied p_actor_id parameter.
CREATE OR REPLACE FUNCTION public.mutate_ticket_state_atomic(
    p_ticket_id BIGINT,
    p_actor_id BIGINT,
    p_new_status VARCHAR(30),
    p_assigned_to BIGINT DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_resolution_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_ticket RECORD;
    v_actor_user_id BIGINT;
    v_actor_role VARCHAR(50);
    v_has_capability BOOLEAN;
    v_is_valid_transition BOOLEAN := FALSE;
    v_old_status VARCHAR(30);
    v_result JSONB;
BEGIN
    -- A. Secure Actor Resolution: Never trust client-supplied p_actor_id for authenticated sessions
    IF auth.role() = 'authenticated' THEN
        SELECT da.user_id, da.role INTO v_actor_user_id, v_actor_role
        FROM public.dashboard_access da
        WHERE da.auth_user_id = auth.uid()
          AND da.is_active = TRUE;

        IF v_actor_user_id IS NULL THEN
            RAISE EXCEPTION 'Access denied: caller does not have an active dashboard operator account';
        END IF;

    ELSIF auth.role() = 'service_role' THEN
        -- Called via trusted backend/Edge Function
        v_actor_user_id := p_actor_id;
        IF v_actor_user_id IS NOT NULL THEN
            SELECT role INTO v_actor_role FROM public.users WHERE id = v_actor_user_id;
            IF v_actor_role IS NULL THEN
                RAISE EXCEPTION 'Actor with id % not found in users', v_actor_user_id;
            END IF;
        ELSE
            v_actor_role := 'system';
        END IF;

    ELSE
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    -- B. Fetch current ticket state with row lock
    SELECT * INTO v_ticket 
    FROM public.tickets 
    WHERE id = p_ticket_id 
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ticket with id % not found', p_ticket_id;
    END IF;

    v_old_status := v_ticket.status;

    -- C. Strict Capability Check
    -- Having dashboard access does NOT mean having all capabilities.
    SELECT EXISTS (
        SELECT 1 FROM public.backoffice_role_capabilities
        WHERE role = v_actor_role AND capability_code = 'ticket.transition'
    ) INTO v_has_capability;

    IF NOT v_has_capability AND v_actor_role NOT IN ('super_admin', 'root') THEN
        RAISE EXCEPTION 'Actor % with role % lacks ticket.transition capability', v_actor_user_id, v_actor_role;
    END IF;

    -- D. Validate Finite State Machine (FSM) Transitions
    IF v_old_status = p_new_status THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'draft' AND p_new_status IN ('pending', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'pending' AND p_new_status IN ('assigned', 'in_progress', 'rejected', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'assigned' AND p_new_status IN ('in_progress', 'waiting_member', 'escalated', 'rejected', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'in_progress' AND p_new_status IN ('waiting_member', 'escalated', 'resolved', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'waiting_member' AND p_new_status IN ('in_progress', 'resolved', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'escalated' AND p_new_status IN ('in_progress', 'resolved', 'closed') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'resolved' AND p_new_status IN ('closed', 'in_progress') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'closed' AND v_actor_role IN ('super_admin', 'root') THEN
        v_is_valid_transition := TRUE;
    END IF;

    IF NOT v_is_valid_transition THEN
        RAISE EXCEPTION 'Invalid state transition from % to % for ticket %', v_old_status, p_new_status, p_ticket_id;
    END IF;

    -- E. Atomic State Update
    UPDATE public.tickets
    SET
        status = p_new_status,
        assigned_to = COALESCE(p_assigned_to, assigned_to),
        resolution_notes = CASE WHEN p_new_status = 'resolved' THEN COALESCE(p_resolution_notes, resolution_notes) ELSE resolution_notes END,
        resolved_at = CASE WHEN p_new_status = 'resolved' THEN NOW() ELSE resolved_at END,
        updated_at = NOW()
    WHERE id = p_ticket_id;

    -- F. Record Transition Event
    INSERT INTO public.ticket_events (
        ticket_id, actor_id, actor_role, event_type, old_status, new_status, notes, metadata
    ) VALUES (
        p_ticket_id,
        v_actor_user_id,
        v_actor_role,
        'STATUS_CHANGE',
        v_old_status,
        p_new_status,
        p_notes,
        jsonb_build_object(
            'assigned_to', COALESCE(p_assigned_to, v_ticket.assigned_to),
            'resolution_notes', p_resolution_notes,
            'actor_source', CASE WHEN auth.role() = 'authenticated' THEN 'auth.uid' ELSE 'service_role' END
        )
    );

    -- G. Record Immutable Audit Log
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id,
        v_actor_role,
        'TICKET_TRANSITION',
        'tickets',
        p_ticket_id,
        jsonb_build_object('status', v_old_status, 'assigned_to', v_ticket.assigned_to),
        jsonb_build_object('status', p_new_status, 'assigned_to', COALESCE(p_assigned_to, v_ticket.assigned_to), 'notes', p_notes)
    );

    -- H. Return Updated State
    SELECT to_jsonb(t) INTO v_result FROM public.tickets t WHERE t.id = p_ticket_id;
    RETURN v_result;
END;
$$;

-- Revoke execute from PUBLIC and anon
REVOKE EXECUTE ON FUNCTION public.mutate_ticket_state_atomic(BIGINT, BIGINT, VARCHAR, BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mutate_ticket_state_atomic(BIGINT, BIGINT, VARCHAR, BIGINT, TEXT, TEXT) TO authenticated, service_role;
