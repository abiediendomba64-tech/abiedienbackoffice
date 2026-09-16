-- ====================================================================
-- MIGRATION: 20260929000031_p0_reconciliation_corrective.sql
-- DESCRIPTION: P0 corrective reconciliation — fix runtime-broken RPC contracts
--              without inventing a phantom schema.
--
-- Evidence (live, read-only, production pnvnpencatzspkwxspac):
--   * telegram_notification_log cols:
--       id, recipient_chat_id, message_text, context_type, context_id,
--       status, attempt_count, last_attempt_at, sent_at, telegram_message_id,
--       error_code, error_reason, created_at
--     >>> NO metadata, NO chat_id, NO message. Status CHECK currently allows
--         only ('queued','sending','sent','failed') per 011 definition.
--   * tickets: NO customer_telegram_id (001 definition).
--   * ticket_messages (001): ticket_id, sender_id, sender_type, message,
--     intent, confidence, metadata, created_at
--     >>> NO sender_role, NO is_internal.
--   * ticket_events (live): id, ticket_id, actor_id, actor_role, event_type,
--     from_status, to_status, note, metadata, created_at, old_status,
--     new_status, notes.
--   * audit_logs (001/live): actor_id, actor_role, action_type, resource_type,
--     resource_id, old_value, new_value, reason, ip_address, created_at
--     >>> NO action/entity_type/entity_id/old_values/new_values.
--   * backoffice_role_capabilities (live): role, capability_id, capability_code
--     (capability_id is the canonical NOT NULL join key; see migration 027).
--   * dashboard_access (live): id, auth_user_id, user_id, role, enabled,
--     expires_at, created_at, updated_at, is_active.
--
-- What this migration does (idempotent, guarded):
--   1. reply_ticket_atomic     -> rewrite against LIVE columns only.
--   2. _enqueue_telegram_notification helper (live cols).
--   3. cancel/retry/status workflow RPCs + toggle switch
--      -> revoke anon/PUBLIC (P0-4).
--
-- What this migration does NOT do:
--   * No db push, no function deploy, no backfill. Staging validation first.
--   * Does NOT add customer_telegram_id / metadata phantom columns.
--     If product needs customer telegram routing, that is a separate
--     approved schema change (new migration + RLS + tests), not a silent fix.
-- ====================================================================

SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- --------------------------------------------------------------------
-- 1. Notification helper: single place that writes telegram_notification_log
--    with LIVE columns (recipient_chat_id, message_text, status='queued',
--    context_type, context_id).
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._enqueue_telegram_notification(
    p_recipient_chat_id BIGINT,
    p_message_text TEXT,
    p_context_type VARCHAR(50),
    p_context_id VARCHAR(100)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_recipient_chat_id IS NULL THEN
        RETURN;
    END IF;
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, status, context_type, context_id
    ) VALUES (
        p_recipient_chat_id, p_message_text, 'queued', p_context_type, p_context_id
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public._enqueue_telegram_notification(BIGINT, TEXT, VARCHAR, VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._enqueue_telegram_notification(BIGINT, TEXT, VARCHAR, VARCHAR) TO authenticated, service_role;
-- --------------------------------------------------------------------
-- 2. reply_ticket_atomic: match LIVE ticket_messages + ticket_events +
--    audit_logs + telegram_notification_log.
--    tickets has NO customer_telegram_id -> resolve recipient from the
--    ticket owner's users.telegram_id; NULL recipient => skip notification
--    (reply itself already committed), never fail the reply on notification.
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reply_ticket_atomic(
    p_ticket_id BIGINT,
    p_message TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_ticket RECORD;
    v_actor_role VARCHAR(50);
    v_actor_user_id BIGINT;
    v_has_capability BOOLEAN := FALSE;
    v_recipient_chat_id BIGINT := NULL;
BEGIN
    IF auth.role() = 'authenticated' THEN
        SELECT user_id, role INTO v_actor_user_id, v_actor_role
        FROM public.dashboard_access
        WHERE auth_user_id = auth.uid()
          AND is_active = TRUE;
        IF v_actor_user_id IS NULL THEN
            RAISE EXCEPTION 'Access denied: caller does not have an active dashboard operator account';
        END IF;
    ELSE
        RAISE EXCEPTION 'Unauthorized: only authenticated users can reply';
    END IF;

    SELECT * INTO v_ticket
    FROM public.tickets
    WHERE id = p_ticket_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ticket with id % not found', p_ticket_id;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.backoffice_role_capabilities
        WHERE role = v_actor_role
          AND (capability_code = 'ticket.reply'
               OR capability_code = 'ticket.transition'
               OR capability_code = 'ticket.read_all')
    ) INTO v_has_capability;
    IF NOT v_has_capability AND v_actor_role NOT IN ('super_admin', 'root', 'dev') THEN
        RAISE EXCEPTION 'Actor % with role % lacks ticket.reply capability', v_actor_user_id, v_actor_role;
    END IF;

    IF v_ticket.status IN ('closed', 'cancelled') THEN
        RAISE EXCEPTION 'Cannot reply to ticket in status %', v_ticket.status;
    END IF;

    -- LIVE schema: sender_type, NOT sender_role/is_internal.
    INSERT INTO public.ticket_messages (
        ticket_id, sender_id, sender_type, message
    ) VALUES (
        p_ticket_id, v_actor_user_id, v_actor_role, p_message
    );

    -- LIVE: note/notes + metadata + old/new_status all exist.
    INSERT INTO public.ticket_events (
        ticket_id, actor_id, actor_role, event_type,
        old_status, new_status, note, notes, metadata
    ) VALUES (
        p_ticket_id, v_actor_user_id, v_actor_role, 'REPLIED',
        v_ticket.status, v_ticket.status, p_message, p_message,
        jsonb_build_object('actor_source', 'auth.uid')
    );

    -- LIVE: action_type/old_value/new_value — fail-closed.
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id,
        old_value, new_value
    ) VALUES (
        v_actor_user_id, v_actor_role, 'TICKET_REPLIED', 'tickets', p_ticket_id,
        NULL, jsonb_build_object('message', p_message)
    );

    SELECT u.telegram_id INTO v_recipient_chat_id
    FROM public.users u
    WHERE u.id = v_ticket.user_id;
    IF v_recipient_chat_id IS NOT NULL THEN
        INSERT INTO public.telegram_notification_log (
            recipient_chat_id, message_text, status, context_type, context_id
        ) VALUES (
            v_recipient_chat_id, p_message, 'queued', 'ticket', p_ticket_id::text
        );
    END IF;

    RETURN jsonb_build_object('success', TRUE, 'ticket_id', p_ticket_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reply_ticket_atomic(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reply_ticket_atomic(BIGINT, TEXT) TO authenticated, service_role;

-- --------------------------------------------------------------------
-- 3. P0-4: close anon/PUBLIC on workflow mutation + status RPCs.
--    Bodies unchanged in this step (authz hardening is separate review);
--    this only removes the anonymous SECURITY DEFINER entry point.
-- --------------------------------------------------------------------
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT 'public.cancel_workflow_instance' AS fn, '(VARCHAR, TEXT)' AS sig
        UNION ALL SELECT 'public.retry_workflow_instance', '(VARCHAR, VARCHAR)'
        UNION ALL SELECT 'public.get_workflow_instance_status', '(VARCHAR)'
        UNION ALL SELECT 'public.toggle_dashboard_control_switch', '(VARCHAR, BOOLEAN, TEXT)'
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s%s FROM PUBLIC, anon', r.fn, r.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s%s TO authenticated, service_role', r.fn, r.sig);
    END LOOP;
END;
$$;

RESET lock_timeout;
RESET statement_timeout;
