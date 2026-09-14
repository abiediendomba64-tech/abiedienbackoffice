-- Migration 20260926000028_p0_canonical_fixes.sql

-- 1. FIX: mutate_ticket_state_atomic (B, C, D)
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

    -- Strict FSM Check
    IF v_old_status = 'pending' AND p_new_status IN ('in_progress', 'resolved', 'closed') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'in_progress' AND p_new_status IN ('resolved', 'closed', 'pending') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'resolved' AND p_new_status IN ('closed', 'in_progress') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'closed' AND p_new_status IN ('in_progress') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = p_new_status THEN
        -- Allow updating assignee or notes without state change
        v_is_valid_transition := TRUE;
    END IF;

    IF NOT v_is_valid_transition THEN
        RAISE EXCEPTION 'Invalid state transition from % to %', v_old_status, p_new_status;
    END IF;

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

    -- Record Event (STATUS_CHANGED)
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

    -- Record Audit Log (No swallow)
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

-- 2. FIX: start_workflow_instance (H, I)
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
    -- 1. Capability Verification
    v_caller_auth := auth.uid();
    IF v_caller_auth IS NOT NULL THEN
        SELECT da.role, da.id INTO v_actor_role, v_actor_id
        FROM public.dashboard_access da
        WHERE da.auth_user_id = v_caller_auth AND da.is_active = TRUE
        LIMIT 1;

        IF v_actor_role IS NULL THEN
            SELECT u.role, u.id INTO v_actor_role, v_actor_id
            FROM public.users u
            WHERE u.auth_user_id = v_caller_auth
            LIMIT 1;
        END IF;

        IF v_actor_role NOT IN ('root', 'super_admin') THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.backoffice_role_capabilities
                WHERE role = v_actor_role AND capability_code = 'workflow.execute'
            ) THEN
                RETURN jsonb_build_object(
                    'success', false,
                    'error', 'Akses ditolak: Memerlukan izin workflow.execute'
                );
            END IF;
        END IF;
    ELSE
        v_actor_role := 'system';
    END IF;

    -- 2. Lookup Workflow Definition
    SELECT * INTO v_wf_def
    FROM public.workflow_definitions
    WHERE code = p_workflow_code AND is_active = TRUE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Definisi workflow tidak ditemukan atau tidak aktif: ' || p_workflow_code
        );
    END IF;

    v_steps_count := jsonb_array_length(v_wf_def.steps);
    IF v_steps_count = 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Workflow tidak memiliki langkah terdaftar.'
        );
    END IF;

    -- 3. Extract first step
    v_first_step := v_wf_def.steps->0;
    v_first_step_name := v_first_step->>'name';

    -- 4. Generate unique instance code
    v_instance_code := 'WF-' || UPPER(p_workflow_code) || '-' || TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS') || '-' || SUBSTRING(MD5(RANDOM()::text) FROM 1 FOR 6);

    -- 5. Insert Workflow Instance
    INSERT INTO public.workflow_instances (
        instance_code,
        workflow_code,
        target_entity_type,
        target_entity_id,
        status,
        current_step_name,
        current_step_index,
        total_steps,
        context_data,
        trigger_source,
        actor_id,
        actor_role,
        started_at
    ) VALUES (
        v_instance_code,
        p_workflow_code,
        p_target_entity_type,
        p_target_entity_id,
        'running',
        v_first_step_name,
        0,
        v_steps_count,
        COALESCE(p_initial_context, '{}'::jsonb),
        p_trigger_source,
        v_actor_id,
        COALESCE(v_actor_role, 'system'),
        NOW()
    )
    RETURNING id INTO v_instance_id;

    -- 6. Insert initial step execution record
    INSERT INTO public.workflow_step_executions (
        instance_id,
        step_name,
        step_index,
        step_type,
        status,
        max_retries,
        input_payload,
        started_at
    ) VALUES (
        v_instance_id,
        v_first_step_name,
        0,
        COALESCE(v_first_step->>'type', 'rpc_call'),
        'running',
        COALESCE((v_first_step->>'max_retries')::int, 3),
        COALESCE(p_initial_context, '{}'::jsonb),
        NOW()
    );

    -- 7. Audit log (schema hardening)
    INSERT INTO public.audit_logs (
        action_type, resource_type, resource_id, actor_id, actor_role, old_value, new_value
    ) VALUES (
        'WORKFLOW_STARTED',
        'workflow_instance',
        v_instance_id,
        v_actor_id,
        COALESCE(v_actor_role, 'system'),
        '{}'::jsonb,
        jsonb_build_object(
            'instance_code', v_instance_code,
            'workflow_code', p_workflow_code,
            'target_type', p_target_entity_type,
            'target_id', p_target_entity_id,
            'first_step', v_first_step_name
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'instance_id', v_instance_id,
        'instance_code', v_instance_code,
        'workflow_code', p_workflow_code,
        'status', 'running',
        'current_step', v_first_step_name,
        'current_step_index', 0,
        'total_steps', v_steps_count
    );
END;
$$;

-- 3. FIX: advance_workflow_step (H, I)
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
    -- 1. Lookup Instance
    SELECT * INTO v_inst
    FROM public.workflow_instances
    WHERE instance_code = p_instance_code
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Instance workflow tidak ditemukan: ' || p_instance_code
        );
    END IF;

    IF v_inst.status NOT IN ('running', 'paused', 'waiting_approval') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Workflow tidak dalam status aktif: saat ini ' || v_inst.status
        );
    END IF;

    -- 2. Lookup Definition
    SELECT * INTO v_wf_def
    FROM public.workflow_definitions
    WHERE code = v_inst.workflow_code;

    -- 3. Lookup Step Execution
    SELECT * INTO v_step_exec
    FROM public.workflow_step_executions
    WHERE instance_id = v_inst.id AND step_name = p_step_name
    ORDER BY id DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Langkah eksekusi tidak ditemukan: ' || p_step_name
        );
    END IF;

    -- Calculate duration
    v_duration := EXTRACT(EPOCH FROM (NOW() - COALESCE(v_step_exec.started_at, NOW()))) * 1000;

    -- 4. Handle Step Failure
    IF p_status = 'failed' THEN
        -- Check if retries remaining
        IF v_step_exec.retry_count < v_step_exec.max_retries THEN
            UPDATE public.workflow_step_executions
            SET retry_count = retry_count + 1,
                error_message = p_error_message,
                finished_at = NOW(),
                duration_ms = v_duration
            WHERE id = v_step_exec.id;

            RETURN jsonb_build_object(
                'success', true,
                'instance_code', p_instance_code,
                'status', 'retry_scheduled',
                'retry_count', v_step_exec.retry_count + 1,
                'max_retries', v_step_exec.max_retries,
                'error', p_error_message
            );
        ELSE
            -- Retries exhausted -> Mark step and instance failed
            UPDATE public.workflow_step_executions
            SET status = 'failed',
                error_message = p_error_message,
                output_payload = COALESCE(p_output_payload, '{}'::jsonb),
                finished_at = NOW(),
                duration_ms = v_duration
            WHERE id = v_step_exec.id;

            UPDATE public.workflow_instances
            SET status = 'failed',
                error_message = p_error_message,
                completed_at = NOW(),
                updated_at = NOW()
            WHERE id = v_inst.id;

            -- Telegram Alert on Workflow Failure (Schema hardened)
            INSERT INTO public.telegram_notification_log (
                recipient_chat_id, message_text, status, metadata
            ) VALUES (
                -1002277561858,
                '[WORKFLOW FAILED] Instance ' || p_instance_code || ' (' || v_inst.workflow_code || ') gagal pada langkah: ' || p_step_name || '. Error: ' || COALESCE(p_error_message, 'Unknown'),
                'pending',
                jsonb_build_object(
                    'instance_code', p_instance_code,
                    'workflow_code', v_inst.workflow_code,
                    'step', p_step_name,
                    'error', p_error_message
                )
            );

            RETURN jsonb_build_object(
                'success', true,
                'instance_code', p_instance_code,
                'status', 'failed',
                'failed_step', p_step_name,
                'error', p_error_message
            );
        END IF;
    END IF;

    -- 5. Step Succeeded -> Update step execution
    UPDATE public.workflow_step_executions
    SET status = 'completed',
        output_payload = COALESCE(p_output_payload, '{}'::jsonb),
        finished_at = NOW(),
        duration_ms = v_duration
    WHERE id = v_step_exec.id;

    -- Merge Context
    v_updated_context := v_inst.context_data || COALESCE(p_output_payload, '{}'::jsonb);

    -- 6. Evaluate Next Step
    v_next_index := v_inst.current_step_index + 1;
    
    IF v_next_index < v_inst.total_steps THEN
        -- Still steps left
        v_next_step := v_wf_def.steps->v_next_index;
        v_next_step_name := v_next_step->>'name';

        -- Update Instance
        UPDATE public.workflow_instances
        SET current_step_name = v_next_step_name,
            current_step_index = v_next_index,
            context_data = v_updated_context,
            updated_at = NOW()
        WHERE id = v_inst.id;

        -- Create next step execution record
        INSERT INTO public.workflow_step_executions (
            instance_id,
            step_name,
            step_index,
            step_type,
            status,
            max_retries,
            input_payload,
            started_at
        ) VALUES (
            v_inst.id,
            v_next_step_name,
            v_next_index,
            COALESCE(v_next_step->>'type', 'rpc_call'),
            'running',
            COALESCE((v_next_step->>'max_retries')::int, 3),
            v_updated_context,
            NOW()
        );

        RETURN jsonb_build_object(
            'success', true,
            'instance_code', p_instance_code,
            'status', 'running',
            'previous_step', p_step_name,
            'next_step', v_next_step_name,
            'next_step_index', v_next_index
        );
    ELSE
        -- No steps left -> Workflow Completed
        UPDATE public.workflow_instances
        SET status = 'completed',
            current_step_name = NULL,
            context_data = v_updated_context,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = v_inst.id;

        -- Telegram Alert on Workflow Success
        INSERT INTO public.telegram_notification_log (
            recipient_chat_id, message_text, status, metadata
        ) VALUES (
            -1002277561858,
            '[WORKFLOW COMPLETED] Instance ' || p_instance_code || ' (' || v_inst.workflow_code || ') selesai dengan sukses.',
            'pending',
            jsonb_build_object(
                'instance_code', p_instance_code,
                'workflow_code', v_inst.workflow_code
            )
        );

        RETURN jsonb_build_object(
            'success', true,
            'instance_code', p_instance_code,
            'status', 'completed',
            'total_steps', v_inst.total_steps
        );
    END IF;
END;
$$;


-- 4. FIX: verify_admin_access (J, K)
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
    v_is_whitelist BOOLEAN := FALSE;
    v_final_role VARCHAR(50);
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'Sesi tidak valid atau belum login'
        );
    END IF;

    -- Get email from auth.users
    SELECT email INTO v_email
    FROM auth.users
    WHERE id = v_auth_uid;

    -- Check Super Admin Whitelist
    IF v_email IS NOT NULL AND lower(v_email) IN ('abiediendomba64@gmail.com', 'teamsande22@gmail.com') THEN
        v_is_whitelist := TRUE;
    END IF;

    -- Look up in admin_accounts by auth_user_id OR email
    SELECT * INTO v_admin
    FROM public.admin_accounts
    WHERE (auth_user_id = v_auth_uid OR (v_email IS NOT NULL AND lower(email) = lower(v_email)))
      AND is_active = TRUE
    ORDER BY (auth_user_id = v_auth_uid) DESC
    LIMIT 1;

    IF FOUND OR v_is_whitelist THEN
        v_final_role := CASE WHEN v_is_whitelist THEN 'super_admin' ELSE COALESCE(v_admin.role, 'super_admin') END;

        -- Auto-link auth_user_id in admin_accounts
        IF v_email IS NOT NULL THEN
            UPDATE public.admin_accounts
            SET auth_user_id = v_auth_uid,
                role = v_final_role,
                is_active = TRUE,
                last_login = NOW(),
                updated_at = NOW()
            WHERE lower(email) = lower(v_email);
        END IF;

        -- Sync to dashboard_access (user_id is nullable now)
        INSERT INTO public.dashboard_access (auth_user_id, role, is_active)
        VALUES (
            v_auth_uid, 
            v_final_role, 
            TRUE
        )
        ON CONFLICT (auth_user_id) DO UPDATE
        SET role = EXCLUDED.role, is_active = TRUE, updated_at = NOW();

        -- Audit log (fail-safe)
        BEGIN
            INSERT INTO public.audit_logs (
                actor_role, action_type, resource_type, resource_id, old_value, new_value
            ) VALUES (
                v_final_role,
                'ADMIN_AUTH_VERIFIED',
                'admin_accounts',
                EXTRACT(EPOCH FROM NOW())::BIGINT,
                NULL,
                jsonb_build_object('email', v_email, 'role', v_final_role, 'auth_uid', v_auth_uid)
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;

        RETURN jsonb_build_object(
            'allowed', true,
            'role', v_final_role,
            'email', v_email,
            'full_name', COALESCE(v_admin.full_name, split_part(COALESCE(v_email, 'Super Admin'), '@', 1)),
            'telegram_id', v_admin.telegram_id
        );
    END IF;

    -- Fallback check in dashboard_access (using actual role, not forcing super_admin)
    IF EXISTS (
        SELECT 1 FROM public.dashboard_access
        WHERE auth_user_id = v_auth_uid
          AND is_active = TRUE
          AND role IN ('root', 'super_admin', 'admin', 'dev')
    ) THEN
        SELECT role INTO v_final_role FROM public.dashboard_access WHERE auth_user_id = v_auth_uid AND is_active = TRUE LIMIT 1;
        RETURN jsonb_build_object(
            'allowed', true,
            'role', v_final_role,
            'email', v_email,
            'full_name', COALESCE(v_email, 'Admin')
        );
    END IF;

    -- Explicit Denial: User is logged in to Supabase Auth, but has NO admin account
    RETURN jsonb_build_object(
        'allowed', false,
        'email', v_email,
        'reason', format('Akses Ditolak: Akun %s bukan Admin / Backoffice Staff yang terdaftar.', COALESCE(v_email, 'ini'))
    );
END;
$$;


-- 5. FIX: verify_member_access (J, K)
CREATE OR REPLACE FUNCTION public.verify_member_access()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_email TEXT;
    v_phone TEXT;
    v_user RECORD;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'Sesi tidak valid atau belum login'
        );
    END IF;

    -- Get email and phone from auth.users
    SELECT email, phone INTO v_email, v_phone
    FROM auth.users
    WHERE id = v_auth_uid;

    -- Look up in public.users (MUST BE ACTIVE)
    SELECT * INTO v_user
    FROM public.users
    WHERE (v_email IS NOT NULL AND lower(COALESCE(email, username, '')) = lower(v_email))
       OR (v_phone IS NOT NULL AND phone_number = v_phone)
    LIMIT 1;

    IF FOUND THEN
        IF v_user.is_active = FALSE THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'reason', 'Akun member dinonaktifkan.'
            );
        END IF;

        RETURN jsonb_build_object(
            'allowed', true,
            'role', COALESCE(v_user.role, 'member'),
            'user_id', v_user.id,
            'username', v_user.username,
            'full_name', v_user.full_name,
            'telegram_id', v_user.telegram_id
        );
    END IF;

    -- NOT FOUND -> DO NOT ALLOW BY DEFAULT!
    RETURN jsonb_build_object(
        'allowed', false,
        'role', 'member',
        'email', v_email,
        'reason', 'User ID tidak ditemukan di tabel public.users. Anda tidak memiliki akses member.'
    );
END;
$$;
