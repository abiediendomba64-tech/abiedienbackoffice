-- ====================================================================
-- MIGRATION: 20260914000026_security_hardening_p0_and_schema_reconciliation.sql
-- DESCRIPTION: Implements P0 Security Hardening and P1 Schema Reconciliation:
--              1. Lock down telegram_bot_settings (Revoke all client access, drop permissive UPDATE policy).
--              2. Lock down telegram_chat_histories (Revoke all client access, drop permissive SELECT/INSERT).
--              3. Lock down system_controls (Drop public SELECT USING true, allow only verified operators).
--              4. Reconcile ticket_events columns (old_status/new_status/notes vs from_status/to_status/note).
--              5. Reconcile claims columns (payout_amount, bank, account_number, description, collected_data).
--              6. Reconcile domain_requests compatibility table.
--              7. Revoke excessive dangerous privileges (TRUNCATE, TRIGGER, REFERENCES) from anon & authenticated.
--              8. Pure ASCII, idempotent, SECURITY DEFINER.
-- ====================================================================

-- 1. P0 SECURITY LOCKDOWN: telegram_bot_settings
-- Prevent unauthorized configuration takeover and secret exposure
REVOKE ALL ON TABLE public.telegram_bot_settings FROM anon, authenticated, PUBLIC;
DROP POLICY IF EXISTS "Allow update access to bot settings" ON public.telegram_bot_settings;
DROP POLICY IF EXISTS "Allow read access to bot settings" ON public.telegram_bot_settings;
DROP POLICY IF EXISTS "Allow update for admin" ON public.telegram_bot_settings;
ALTER TABLE public.telegram_bot_settings ENABLE ROW LEVEL SECURITY;

-- 2. P0 SECURITY LOCKDOWN: telegram_chat_histories
-- Prevent latent data exposure of chat conversations
REVOKE ALL ON TABLE public.telegram_chat_histories FROM anon, authenticated, PUBLIC;
DROP POLICY IF EXISTS "Allow read access to own chat histories" ON public.telegram_chat_histories;
DROP POLICY IF EXISTS "Allow insert to own chat histories" ON public.telegram_chat_histories;
DROP POLICY IF EXISTS "Allow users to read their own chat history" ON public.telegram_chat_histories;
DROP POLICY IF EXISTS "Allow users to insert their own chat history" ON public.telegram_chat_histories;
DROP POLICY IF EXISTS "chat_history_own_read" ON public.telegram_chat_histories;
ALTER TABLE public.telegram_chat_histories ENABLE ROW LEVEL SECURITY;

-- 3. P0 SECURITY LOCKDOWN: system_controls
-- Restrict control plane visibility to authorized backoffice operators only
DROP POLICY IF EXISTS "system_controls_read" ON public.system_controls;
DROP POLICY IF EXISTS "system_controls_operator_read" ON public.system_controls;
CREATE POLICY system_controls_operator_read ON public.system_controls
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            WHERE da.auth_user_id = auth.uid()
              AND da.role IN ('root', 'super_admin', 'admin', 'dev')
              AND da.is_active = TRUE
        )
    );

-- 4. P1 SCHEMA RECONCILIATION: ticket_events
-- Ensure dual compatibility between old_status/new_status/notes and from_status/to_status/note
ALTER TABLE public.ticket_events 
    ADD COLUMN IF NOT EXISTS old_status VARCHAR(50),
    ADD COLUMN IF NOT EXISTS new_status VARCHAR(50),
    ADD COLUMN IF NOT EXISTS notes TEXT;

-- Auto-sync columns via trigger if either naming convention is inserted
CREATE OR REPLACE FUNCTION public.sync_ticket_events_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.from_status := COALESCE(NEW.from_status, NEW.old_status);
    NEW.to_status := COALESCE(NEW.to_status, NEW.new_status);
    NEW.note := COALESCE(NEW.note, NEW.notes);
    NEW.old_status := COALESCE(NEW.old_status, NEW.from_status);
    NEW.new_status := COALESCE(NEW.new_status, NEW.to_status);
    NEW.notes := COALESCE(NEW.notes, NEW.note);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_ticket_events_columns ON public.ticket_events;
CREATE TRIGGER trg_sync_ticket_events_columns
    BEFORE INSERT OR UPDATE ON public.ticket_events
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_ticket_events_columns();

-- Update mutate_ticket_state_atomic to insert both sets of column names
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
    v_old_status VARCHAR(50);
    v_actor_role VARCHAR(50);
    v_actor_user_id BIGINT;
    v_has_capability BOOLEAN := FALSE;
    v_is_valid_transition BOOLEAN := FALSE;
BEGIN
    -- Authenticate actor
    IF auth.role() = 'authenticated' THEN
        SELECT user_id, role INTO v_actor_user_id, v_actor_role
        FROM public.dashboard_access
        WHERE auth_user_id = auth.uid()
          AND is_active = TRUE;

        IF v_actor_user_id IS NULL THEN
            RAISE EXCEPTION 'Access denied: caller does not have an active dashboard operator account';
        END IF;

    ELSIF auth.role() = 'service_role' THEN
        v_actor_user_id := p_actor_id;
        IF v_actor_user_id IS NOT NULL THEN
            SELECT role INTO v_actor_role FROM public.users WHERE id = v_actor_user_id;
            IF v_actor_role IS NULL THEN
                v_actor_role := 'operator';
            END IF;
        ELSE
            v_actor_role := 'system';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    -- Fetch ticket with row lock
    SELECT * INTO v_ticket 
    FROM public.tickets 
    WHERE id = p_ticket_id 
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ticket with id % not found', p_ticket_id;
    END IF;

    v_old_status := v_ticket.status;

    -- Capability Check
    SELECT EXISTS (
        SELECT 1 FROM public.backoffice_role_capabilities
        WHERE role = v_actor_role 
          AND (capability_code = 'ticket.transition' OR capability_code = 'ticket.read_all')
    ) INTO v_has_capability;

    IF NOT v_has_capability AND v_actor_role NOT IN ('super_admin', 'root', 'dev') THEN
        RAISE EXCEPTION 'Actor % with role % lacks ticket.transition capability', v_actor_user_id, v_actor_role;
    END IF;

    -- Update Ticket
    UPDATE public.tickets
    SET
        status = p_new_status,
        assigned_to = COALESCE(p_assigned_to, assigned_to),
        resolution_notes = CASE WHEN p_new_status = 'resolved' THEN COALESCE(p_resolution_notes, resolution_notes) ELSE resolution_notes END,
        resolved_at = CASE WHEN p_new_status = 'resolved' THEN NOW() ELSE resolved_at END,
        updated_at = NOW()
    WHERE id = p_ticket_id;

    -- Record Event (populating both sets of columns for 100% compatibility)
    INSERT INTO public.ticket_events (
        ticket_id, actor_id, actor_role, event_type, 
        from_status, to_status, note,
        old_status, new_status, notes, 
        metadata
    ) VALUES (
        p_ticket_id,
        v_actor_user_id,
        v_actor_role,
        'STATUS_CHANGE',
        v_old_status,
        p_new_status,
        p_notes,
        v_old_status,
        p_new_status,
        p_notes,
        jsonb_build_object(
            'assigned_to', COALESCE(p_assigned_to, v_ticket.assigned_to),
            'resolution_notes', p_resolution_notes,
            'actor_source', CASE WHEN auth.role() = 'authenticated' THEN 'auth.uid' ELSE 'service_role' END
        )
    );

    -- Record Audit Log
    BEGIN
        INSERT INTO public.audit_logs (
            actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
        ) VALUES (
            v_actor_user_id,
            v_actor_role,
            'TICKET_STATUS_CHANGED',
            'tickets',
            p_ticket_id,
            jsonb_build_object('status', v_old_status),
            jsonb_build_object('status', p_new_status, 'notes', p_notes)
        );
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN jsonb_build_object(
        'success', TRUE,
        'ticket_id', p_ticket_id,
        'old_status', v_old_status,
        'new_status', p_new_status
    );
END;
$$;

-- 5. P1 SCHEMA RECONCILIATION: claims
-- Add all columns required by Edge Function v3 and UI
ALTER TABLE public.claims
    ADD COLUMN IF NOT EXISTS claim_number VARCHAR(50),
    ADD COLUMN IF NOT EXISTS payout_amount NUMERIC,
    ADD COLUMN IF NOT EXISTS bank VARCHAR(50),
    ADD COLUMN IF NOT EXISTS account_number VARCHAR(50),
    ADD COLUMN IF NOT EXISTS evidence_required BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS collected_data JSONB DEFAULT '{}'::jsonb;

-- 6. P1 SCHEMA RECONCILIATION: domain_requests
-- Ensure legacy telegram-auth commands have a table to safely query/update
CREATE TABLE IF NOT EXISTS public.domain_requests (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    domain_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    assigned_domain VARCHAR(255),
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.domain_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS domain_requests_admin_all ON public.domain_requests;
CREATE POLICY domain_requests_admin_all ON public.domain_requests
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            WHERE da.auth_user_id = auth.uid()
              AND da.role IN ('root', 'super_admin', 'admin', 'dev')
              AND da.is_active = TRUE
        )
    );

-- 7. DEFENSE IN DEPTH: Revoke dangerous privileges from anon & authenticated
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
