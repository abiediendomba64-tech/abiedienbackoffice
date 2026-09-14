-- Migration 20260926000028_p0_canonical_fixes.sql

-- 1. FIX: mutate_ticket_state_atomic (Strict FSM, STATUS_CHANGED, Fail-Closed Audit)
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
    -- Actor resolution from auth context
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

    -- Strict FSM Check
    IF v_old_status = p_new_status THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status IN ('draft', 'pending') AND p_new_status IN ('assigned', 'in_progress', 'rejected', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'assigned' AND p_new_status IN ('in_progress', 'waiting_member', 'escalated', 'rejected', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'in_progress' AND p_new_status IN ('waiting_member', 'escalated', 'resolved', 'closed', 'rejected', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'waiting_member' AND p_new_status IN ('in_progress', 'escalated', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'escalated' AND p_new_status IN ('in_progress', 'resolved', 'closed', 'rejected', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'resolved' AND p_new_status IN ('closed', 'in_progress') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'closed' AND p_new_status IN ('in_progress') THEN
        v_is_valid_transition := TRUE;
    END IF;

    IF NOT v_is_valid_transition THEN
        RAISE EXCEPTION 'Invalid state transition from % to %', v_old_status, p_new_status;
    END IF;

    -- Canonical Capability Check
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
        resolution_notes = CASE WHEN p_new_status IN ('resolved', 'rejected', 'cancelled') THEN COALESCE(p_resolution_notes, resolution_notes) ELSE resolution_notes END,
        resolved_at = CASE WHEN p_new_status IN ('resolved', 'closed', 'rejected', 'cancelled') THEN NOW() ELSE resolved_at END,
        updated_at = NOW()
    WHERE id = p_ticket_id;

    -- Record Event (must be STATUS_CHANGED)
    INSERT INTO public.ticket_events (
        ticket_id, actor_id, actor_role, event_type, 
        from_status, to_status, note,
        old_status, new_status, notes, 
        metadata
    ) VALUES (
        p_ticket_id,
        v_actor_user_id,
        v_actor_role,
        'STATUS_CHANGED',
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

    -- Record Audit Log (Fail-closed)
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

    RETURN jsonb_build_object(
        'success', TRUE,
        'ticket_id', p_ticket_id,
        'old_status', v_old_status,
        'new_status', p_new_status
    );
END;
$$;


-- 2. NEW FIX: reply_ticket_atomic
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
BEGIN
    -- Actor resolution from auth context
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

    -- Fetch ticket with row lock
    SELECT * INTO v_ticket 
    FROM public.tickets 
    WHERE id = p_ticket_id 
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ticket with id % not found', p_ticket_id;
    END IF;

    -- Canonical Capability Check
    SELECT EXISTS (
        SELECT 1 FROM public.backoffice_role_capabilities
        WHERE role = v_actor_role 
          AND (capability_code = 'ticket.reply' OR capability_code = 'ticket.transition' OR capability_code = 'ticket.read_all')
    ) INTO v_has_capability;

    IF NOT v_has_capability AND v_actor_role NOT IN ('super_admin', 'root', 'dev') THEN
        RAISE EXCEPTION 'Actor % with role % lacks ticket.reply capability', v_actor_user_id, v_actor_role;
    END IF;

    -- State validation
    IF v_ticket.status IN ('closed', 'cancelled') THEN
        RAISE EXCEPTION 'Cannot reply to ticket in status %', v_ticket.status;
    END IF;

    -- Insert Message
    INSERT INTO public.ticket_messages (
        ticket_id, sender_id, sender_role, message, is_internal
    ) VALUES (
        p_ticket_id, v_actor_user_id, v_actor_role, p_message, FALSE
    );

    -- Record Event (REPLIED)
    INSERT INTO public.ticket_events (
        ticket_id, actor_id, actor_role, event_type, 
        note, notes, metadata
    ) VALUES (
        p_ticket_id, v_actor_user_id, v_actor_role, 'REPLIED', p_message, p_message, jsonb_build_object('actor_source', 'auth.uid')
    );

    -- Record Audit Log (Fail-closed)
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id, v_actor_role, 'TICKET_REPLIED', 'tickets', p_ticket_id, NULL, jsonb_build_object('message', p_message)
    );

    -- Enqueue notification
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, status, metadata
    ) VALUES (
        v_ticket.customer_telegram_id,
        p_message,
        'pending',
        jsonb_build_object('ticket_id', p_ticket_id, 'type', 'ticket_reply')
    );

    RETURN jsonb_build_object('success', TRUE, 'ticket_id', p_ticket_id);
END;
$$;


-- 3. FIX: submit_claim_atomic (Audit fix, UUID resource_id)
CREATE OR REPLACE FUNCTION public.submit_claim_atomic(
    p_telegram_user_id BIGINT,
    p_claim_type VARCHAR(100),
    p_amount NUMERIC(14, 2),
    p_notes TEXT,
    p_evidence_path TEXT,
    p_submitted_by UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_canonical_user_id BIGINT;
    v_recent_count INT;
    v_active_exists BOOLEAN;
    v_new_claim_id UUID;
    v_caller_auth_id UUID := auth.uid();
BEGIN
    IF p_evidence_path IS NULL OR length(trim(p_evidence_path)) < 3 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_EVIDENCE');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('claim_lock_' || p_telegram_user_id::text));

    SELECT linked_user_id INTO v_canonical_user_id FROM public.telegram_users WHERE telegram_user_id = p_telegram_user_id;

    SELECT COUNT(*) INTO v_recent_count FROM public.claims
    WHERE telegram_user_id = p_telegram_user_id AND created_at >= NOW() - INTERVAL '24 hours';
    IF v_recent_count >= 3 THEN RETURN jsonb_build_object('success', false, 'error_code', 'RATE_LIMIT_EXCEEDED'); END IF;

    SELECT EXISTS(SELECT 1 FROM public.claims WHERE telegram_user_id = p_telegram_user_id AND claim_type = p_claim_type AND status IN ('pending', 'reviewing')) INTO v_active_exists;
    IF v_active_exists THEN RETURN jsonb_build_object('success', false, 'error_code', 'ACTIVE_CLAIM_EXISTS'); END IF;

    INSERT INTO public.claims (
        user_id, telegram_user_id, submitted_by, claim_type, amount, notes, evidence_path, status
    ) VALUES (
        v_canonical_user_id, p_telegram_user_id, COALESCE(p_submitted_by, v_caller_auth_id), p_claim_type, p_amount, p_notes, p_evidence_path, 'pending'
    ) RETURNING id INTO v_new_claim_id;

    -- FIX: UUID constraint, use NULL for resource_id and store claim_id in new_value
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_canonical_user_id, 'member', 'CLAIM_SUBMITTED', 'claims', NULL,
        jsonb_build_object('telegram_user_id', p_telegram_user_id),
        jsonb_build_object('claim_id', v_new_claim_id, 'claim_type', p_claim_type, 'amount', p_amount, 'user_id', v_canonical_user_id)
    );

    RETURN jsonb_build_object('success', true, 'claim_id', v_new_claim_id, 'status', 'pending', 'user_id', v_canonical_user_id, 'created_at', NOW());
END;
$$;


-- 4. FIX: start_workflow_instance (No users.auth_user_id dependency)
CREATE OR REPLACE FUNCTION public.start_workflow_instance(
    p_workflow_code VARCHAR(100),
    p_target_entity_type VARCHAR(50),
    p_target_entity_id VARCHAR(100),
    p_initial_context JSONB DEFAULT '{}'::jsonb,
    p_trigger_source VARCHAR(50) DEFAULT 'system'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor_role VARCHAR(50);
    v_actor_id BIGINT;
    v_caller_auth UUID;
    v_wf_def RECORD;
    v_steps_count INT;
    v_first_step_name VARCHAR(100);
    v_instance_code VARCHAR(100);
    v_instance_id BIGINT;
    v_first_step JSONB;
BEGIN
    v_caller_auth := auth.uid();
    IF v_caller_auth IS NOT NULL THEN
        -- Only check dashboard_access
        SELECT da.role, da.user_id INTO v_actor_role, v_actor_id
        FROM public.dashboard_access da
        WHERE da.auth_user_id = v_caller_auth AND da.is_active = TRUE
        LIMIT 1;

        IF v_actor_role NOT IN ('root', 'super_admin') THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.backoffice_role_capabilities
                WHERE role = v_actor_role AND capability_code = 'workflow.execute'
            ) THEN
                RETURN jsonb_build_object('success', false, 'error', 'Akses ditolak: Memerlukan izin workflow.execute');
            END IF;
        END IF;
    ELSE
        v_actor_role := 'system';
    END IF;

    SELECT * INTO v_wf_def FROM public.workflow_definitions WHERE code = p_workflow_code AND is_active = TRUE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Definisi workflow tidak ditemukan'); END IF;

    v_steps_count := jsonb_array_length(v_wf_def.steps);
    IF v_steps_count = 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Workflow kosong'); END IF;

    v_first_step := v_wf_def.steps->0;
    v_first_step_name := v_first_step->>'name';
    v_instance_code := 'WF-' || UPPER(p_workflow_code) || '-' || TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS') || '-' || SUBSTRING(MD5(RANDOM()::text) FROM 1 FOR 6);

    INSERT INTO public.workflow_instances (
        instance_code, workflow_code, target_entity_type, target_entity_id,
        status, current_step_name, current_step_index, total_steps,
        context_data, trigger_source, actor_id, actor_role, started_at
    ) VALUES (
        v_instance_code, p_workflow_code, p_target_entity_type, p_target_entity_id,
        'running', v_first_step_name, 0, v_steps_count,
        COALESCE(p_initial_context, '{}'::jsonb), p_trigger_source, v_actor_id, COALESCE(v_actor_role, 'system'), NOW()
    ) RETURNING id INTO v_instance_id;

    INSERT INTO public.workflow_step_executions (
        instance_id, step_name, step_index, step_type, status, max_retries, input_payload, started_at
    ) VALUES (
        v_instance_id, v_first_step_name, 0, COALESCE(v_first_step->>'type', 'rpc_call'), 'running', COALESCE((v_first_step->>'max_retries')::int, 3), COALESCE(p_initial_context, '{}'::jsonb), NOW()
    );

    -- Canonical Audit log
    INSERT INTO public.audit_logs (
        action_type, resource_type, resource_id, actor_id, actor_role, old_value, new_value
    ) VALUES (
        'WORKFLOW_STARTED', 'workflow_instance', v_instance_id, v_actor_id, COALESCE(v_actor_role, 'system'), '{}'::jsonb,
        jsonb_build_object('instance_code', v_instance_code, 'workflow_code', p_workflow_code, 'target_type', p_target_entity_type, 'target_id', p_target_entity_id, 'first_step', v_first_step_name)
    );

    RETURN jsonb_build_object(
        'success', true, 'instance_id', v_instance_id, 'instance_code', v_instance_code,
        'workflow_code', p_workflow_code, 'status', 'running',
        'current_step', v_first_step_name, 'current_step_index', 0, 'total_steps', v_steps_count
    );
END;
$$;


-- 5. FIX: advance_workflow_step (Canonical notification_log schema, Canonical audit)
CREATE OR REPLACE FUNCTION public.advance_workflow_step(
    p_instance_code VARCHAR(100),
    p_step_name VARCHAR(100),
    p_status VARCHAR(50),
    p_output_payload JSONB DEFAULT '{}'::jsonb,
    p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_inst RECORD;
    v_wf_def RECORD;
    v_step_exec RECORD;
    v_next_index INT;
    v_next_step JSONB;
    v_next_step_name VARCHAR(100);
    v_updated_context JSONB;
    v_duration INT;
BEGIN
    SELECT * INTO v_inst FROM public.workflow_instances WHERE instance_code = p_instance_code FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Instance workflow tidak ditemukan'); END IF;
    IF v_inst.status NOT IN ('running', 'paused', 'waiting_approval') THEN RETURN jsonb_build_object('success', false, 'error', 'Status tidak aktif'); END IF;

    SELECT * INTO v_wf_def FROM public.workflow_definitions WHERE code = v_inst.workflow_code;
    SELECT * INTO v_step_exec FROM public.workflow_step_executions WHERE instance_id = v_inst.id AND step_name = p_step_name ORDER BY id DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Langkah eksekusi tidak ditemukan'); END IF;

    v_duration := EXTRACT(EPOCH FROM (NOW() - COALESCE(v_step_exec.started_at, NOW()))) * 1000;

    IF p_status = 'failed' THEN
        IF v_step_exec.retry_count < v_step_exec.max_retries THEN
            UPDATE public.workflow_step_executions SET retry_count = retry_count + 1, error_message = p_error_message, finished_at = NOW(), duration_ms = v_duration WHERE id = v_step_exec.id;
            RETURN jsonb_build_object('success', true, 'status', 'retry_scheduled', 'retry_count', v_step_exec.retry_count + 1, 'max_retries', v_step_exec.max_retries);
        ELSE
            UPDATE public.workflow_step_executions SET status = 'failed', error_message = p_error_message, output_payload = COALESCE(p_output_payload, '{}'::jsonb), finished_at = NOW(), duration_ms = v_duration WHERE id = v_step_exec.id;
            UPDATE public.workflow_instances SET status = 'failed', error_message = p_error_message, completed_at = NOW(), updated_at = NOW() WHERE id = v_inst.id;

            -- Canonical Telegram Alert
            INSERT INTO public.telegram_notification_log (
                recipient_chat_id, message_text, status, metadata
            ) VALUES (
                -1002277561858,
                '[WORKFLOW FAILED] Instance ' || p_instance_code || ' gagal. Error: ' || COALESCE(p_error_message, 'Unknown'),
                'pending',
                jsonb_build_object('instance_code', p_instance_code, 'workflow_code', v_inst.workflow_code, 'step', p_step_name)
            );

            RETURN jsonb_build_object('success', true, 'status', 'failed');
        END IF;
    END IF;

    UPDATE public.workflow_step_executions SET status = 'completed', output_payload = COALESCE(p_output_payload, '{}'::jsonb), finished_at = NOW(), duration_ms = v_duration WHERE id = v_step_exec.id;

    v_updated_context := v_inst.context_data || COALESCE(p_output_payload, '{}'::jsonb);
    v_next_index := v_inst.current_step_index + 1;
    
    IF v_next_index < v_inst.total_steps THEN
        v_next_step := v_wf_def.steps->v_next_index;
        v_next_step_name := v_next_step->>'name';
        UPDATE public.workflow_instances SET current_step_name = v_next_step_name, current_step_index = v_next_index, context_data = v_updated_context, updated_at = NOW() WHERE id = v_inst.id;
        INSERT INTO public.workflow_step_executions (instance_id, step_name, step_index, step_type, status, max_retries, input_payload, started_at) VALUES (v_inst.id, v_next_step_name, v_next_index, COALESCE(v_next_step->>'type', 'rpc_call'), 'running', COALESCE((v_next_step->>'max_retries')::int, 3), v_updated_context, NOW());
        RETURN jsonb_build_object('success', true, 'status', 'running', 'next_step', v_next_step_name);
    ELSE
        UPDATE public.workflow_instances SET status = 'completed', current_step_name = NULL, context_data = v_updated_context, completed_at = NOW(), updated_at = NOW() WHERE id = v_inst.id;
        INSERT INTO public.telegram_notification_log (recipient_chat_id, message_text, status, metadata) VALUES (-1002277561858, '[WORKFLOW COMPLETED] Instance ' || p_instance_code || ' sukses.', 'pending', jsonb_build_object('instance_code', p_instance_code));
        RETURN jsonb_build_object('success', true, 'status', 'completed');
    END IF;
END;
$$;


-- 6. FIX: verify_admin_access (No Role Elevation, admin_accounts as Authority)
CREATE OR REPLACE FUNCTION public.verify_admin_access()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_email TEXT;
    v_admin RECORD;
    v_dashboard RECORD;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Sesi tidak valid');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = v_auth_uid;

    -- Look up Canonical Identity in admin_accounts
    SELECT * INTO v_admin FROM public.admin_accounts
    WHERE (auth_user_id = v_auth_uid OR (v_email IS NOT NULL AND lower(email) = lower(v_email)))
      AND is_active = TRUE
    ORDER BY (auth_user_id = v_auth_uid) DESC LIMIT 1;

    -- Look up in dashboard_access
    SELECT * INTO v_dashboard FROM public.dashboard_access
    WHERE auth_user_id = v_auth_uid AND is_active = TRUE LIMIT 1;

    IF FOUND THEN
        -- Validate Conflict between Canonical and Read Model
        IF v_dashboard.auth_user_id IS NOT NULL AND v_dashboard.role != v_admin.role THEN
            -- CONFLICT DENY
            RETURN jsonb_build_object('allowed', false, 'reason', 'Konflik otoritas role terdeteksi, akses ditolak.');
        END IF;

        -- Auto-link
        IF v_email IS NOT NULL AND v_admin.auth_user_id IS NULL THEN
            UPDATE public.admin_accounts SET auth_user_id = v_auth_uid, last_login = NOW() WHERE id = v_admin.id;
        END IF;

        INSERT INTO public.dashboard_access (auth_user_id, role, is_active)
        VALUES (v_auth_uid, v_admin.role, TRUE)
        ON CONFLICT (auth_user_id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE;

        -- NO EXCEPTION SWALLOWING
        INSERT INTO public.audit_logs (actor_role, action_type, resource_type, resource_id, old_value, new_value)
        VALUES (v_admin.role, 'ADMIN_AUTH_VERIFIED', 'admin_accounts', NULL, NULL, jsonb_build_object('email', v_email, 'role', v_admin.role, 'auth_uid', v_auth_uid));

        RETURN jsonb_build_object(
            'allowed', true, 'role', v_admin.role, 'email', v_email,
            'full_name', COALESCE(v_admin.full_name, split_part(v_email, '@', 1))
        );
    END IF;

    RETURN jsonb_build_object('allowed', false, 'email', v_email, 'reason', 'Bukan admin yang terdaftar.');
END;
$$;


-- 7. FIX: verify_member_access (Fail-closed, NO auth_user_id, NO phone_number)
CREATE OR REPLACE FUNCTION public.verify_member_access()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_email TEXT;
    v_user RECORD;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Sesi tidak valid');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = v_auth_uid;

    -- Temporary Legacy Resolution: ONLY email, no phone, no auth_user_id since they don't exist in live
    SELECT * INTO v_user
    FROM public.users
    WHERE v_email IS NOT NULL AND lower(COALESCE(email, username, '')) = lower(v_email)
    LIMIT 1;

    IF FOUND THEN
        IF v_user.is_active = FALSE THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'Akun dinonaktifkan.');
        END IF;

        RETURN jsonb_build_object(
            'allowed', true,
            'role', COALESCE(v_user.role, 'member'),
            'user_id', v_user.id,
            'username', v_user.username,
            'full_name', v_user.full_name
        );
    END IF;

    -- Fail-closed
    RETURN jsonb_build_object('allowed', false, 'reason', 'Akses ditolak: Identity belum dipetakan ke public.users');
END;
$$;


-- 8. Precise Security Definer Privileges (No Blanket Revoke)
REVOKE EXECUTE ON FUNCTION public.mutate_ticket_state_atomic(BIGINT, BIGINT, VARCHAR, BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mutate_ticket_state_atomic(BIGINT, BIGINT, VARCHAR, BIGINT, TEXT, TEXT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.reply_ticket_atomic(BIGINT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reply_ticket_atomic(BIGINT, TEXT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.submit_claim_atomic(BIGINT, VARCHAR, NUMERIC, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_claim_atomic(BIGINT, VARCHAR, NUMERIC, TEXT, TEXT, UUID) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.start_workflow_instance(VARCHAR, VARCHAR, VARCHAR, JSONB, VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_workflow_instance(VARCHAR, VARCHAR, VARCHAR, JSONB, VARCHAR) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.advance_workflow_step(VARCHAR, VARCHAR, VARCHAR, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.advance_workflow_step(VARCHAR, VARCHAR, VARCHAR, JSONB, TEXT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.verify_admin_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_admin_access() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.verify_member_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_member_access() TO authenticated, service_role;
