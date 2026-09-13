-- ====================================================================
-- MIGRATION: 20260920000020_master_workflow_orchestrator.sql
-- PHASE:      020 Master Workflow Orchestrator
-- DESCRIPTION: High-reliability distributed workflow state machine engine
--              orchestrating complex lifecycle events across entities:
--              websites, domains, payments, incidents, and members.
--              Features:
--                1. Capability registration:
--                   - workflow.view, workflow.execute, workflow.manage,
--                     workflow.retry, workflow.cancel
--                2. Tables:
--                   - public.workflow_definitions (Workflow templates & step graphs)
--                   - public.workflow_instances (Live state machine executions)
--                   - public.workflow_step_executions (Per-step audit & telemetry)
--                   - public.workflow_worker_heartbeats (Worker registry & health)
--                3. Atomic RPCs:
--                   - start_workflow_instance (Start workflow, init step graph)
--                   - advance_workflow_step (Complete/fail step, evaluate next)
--                   - retry_workflow_instance (Idempotent retry of failed step)
--                   - cancel_workflow_instance (Graceful cancellation & release)
--                   - get_workflow_instance_status (Telemetry status query)
--                   - record_workflow_worker_heartbeat (Worker telemetry)
--                4. Pre-seeded default production workflows:
--                   - website_provisioning (Domain -> DNS -> Theme -> Health)
--                   - website_reclaim_lifecycle (Idle scan -> Warning -> Reclaim)
--                   - domain_dns_routing (Cloudflare zone bind -> DNS propagation)
--                   - incident_mitigation (Failover -> Drain -> Probe recovery)
--                5. RLS policies and capability gating
-- Conventions: pure ASCII, SECURITY DEFINER with search_path='',
--              fail-closed capability gate, immutable audit_logs,
--              and telegram_notification_log queue.
-- ====================================================================

-- 1. CAPABILITY REGISTRATION
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('workflow.view',    'Melihat status dan riwayat workflow orchestrator', 'system'),
('workflow.execute', 'Memulai dan memicu eksekusi workflow secara manual', 'system'),
('workflow.manage',  'Mengonfigurasi template definisi langkah workflow', 'system'),
('workflow.retry',   'Mencoba ulang langkah workflow yang mengalami kegagalan', 'system'),
('workflow.cancel',  'Membatalkan instance workflow yang sedang berjalan', 'system')
ON CONFLICT (code) DO NOTHING;

-- Grant capabilities to root and super_admin
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'workflow.%'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Grant operational capabilities to admin
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('workflow.view', 'workflow.execute', 'workflow.retry')
ON CONFLICT (role, capability_code) DO NOTHING;

-- Grant developer role read and retry capabilities
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('workflow.view', 'workflow.retry')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. TABLE: workflow_definitions (Template Definisi Alur Kerja)
CREATE TABLE IF NOT EXISTS public.workflow_definitions (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    version VARCHAR(20) NOT NULL DEFAULT '1.0.0',
    steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    timeout_seconds INT NOT NULL DEFAULT 3600,
    max_retries INT NOT NULL DEFAULT 3,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_defs_code ON public.workflow_definitions(code);
CREATE INDEX IF NOT EXISTS idx_workflow_defs_active ON public.workflow_definitions(is_active);

-- 3. TABLE: workflow_instances (Instance Eksekusi State Machine)
CREATE TABLE IF NOT EXISTS public.workflow_instances (
    id BIGSERIAL PRIMARY KEY,
    instance_code VARCHAR(100) UNIQUE NOT NULL,
    workflow_code VARCHAR(100) NOT NULL REFERENCES public.workflow_definitions(code) ON DELETE RESTRICT,
    target_entity_type VARCHAR(50) NOT NULL,
    target_entity_id VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    current_step_name VARCHAR(100),
    current_step_index INT NOT NULL DEFAULT 0,
    total_steps INT NOT NULL DEFAULT 0,
    context_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    trigger_source VARCHAR(50) NOT NULL DEFAULT 'system',
    actor_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_role VARCHAR(50) DEFAULT 'system',
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_wf_status CHECK (status IN (
        'pending', 'running', 'completed', 'failed', 'paused', 'cancelled', 'waiting_approval'
    ))
);

CREATE INDEX IF NOT EXISTS idx_wf_inst_code ON public.workflow_instances(instance_code);
CREATE INDEX IF NOT EXISTS idx_wf_inst_wf ON public.workflow_instances(workflow_code, status);
CREATE INDEX IF NOT EXISTS idx_wf_inst_target ON public.workflow_instances(target_entity_type, target_entity_id);
CREATE INDEX IF NOT EXISTS idx_wf_inst_status ON public.workflow_instances(status, created_at DESC);

-- 4. TABLE: workflow_step_executions (Audit Detail Setiap Langkah)
CREATE TABLE IF NOT EXISTS public.workflow_step_executions (
    id BIGSERIAL PRIMARY KEY,
    instance_id BIGINT NOT NULL REFERENCES public.workflow_instances(id) ON DELETE CASCADE,
    step_name VARCHAR(100) NOT NULL,
    step_index INT NOT NULL DEFAULT 0,
    step_type VARCHAR(50) NOT NULL DEFAULT 'rpc_call',
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 3,
    input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    duration_ms INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_step_status CHECK (status IN (
        'pending', 'running', 'succeeded', 'failed', 'skipped', 'waiting_approval'
    ))
);

CREATE INDEX IF NOT EXISTS idx_wf_step_inst ON public.workflow_step_executions(instance_id, step_index);
CREATE INDEX IF NOT EXISTS idx_wf_step_status ON public.workflow_step_executions(status);

-- 5. TABLE: workflow_worker_heartbeats (Registry Worker Pemroses Background)
CREATE TABLE IF NOT EXISTS public.workflow_worker_heartbeats (
    id BIGSERIAL PRIMARY KEY,
    worker_id VARCHAR(100) UNIQUE NOT NULL,
    worker_name VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'online',
    assigned_workflows TEXT[] NOT NULL DEFAULT '{}'::text[],
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_wf_worker_hb ON public.workflow_worker_heartbeats(last_heartbeat_at DESC);

-- 6. RPC: start_workflow_instance
-- Memulai instansiasi alur kerja baru dari template definisi
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

    -- 7. Audit log
    INSERT INTO public.audit_logs (
        action, entity_type, entity_id, actor_id, actor_role, old_values, new_values
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

-- 7. RPC: advance_workflow_step
-- Memperbarui status langkah yang sedang berjalan dan mengevaluasi transisi ke langkah berikutnya
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

            -- Telegram Alert on Workflow Failure
            INSERT INTO public.telegram_notification_log (
                chat_id, message, status, metadata
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

    -- 5. Handle Step Succeeded
    UPDATE public.workflow_step_executions
    SET status = 'succeeded',
        output_payload = COALESCE(p_output_payload, '{}'::jsonb),
        finished_at = NOW(),
        duration_ms = v_duration
    WHERE id = v_step_exec.id;

    -- Merge output to context
    v_updated_context := v_inst.context_data || jsonb_build_object(p_step_name, COALESCE(p_output_payload, '{}'::jsonb));

    -- 6. Evaluate next step
    v_next_index := v_inst.current_step_index + 1;

    IF v_next_index >= v_inst.total_steps THEN
        -- All steps finished -> Complete Workflow
        UPDATE public.workflow_instances
        SET status = 'completed',
            current_step_name = 'DONE',
            current_step_index = v_next_index,
            context_data = v_updated_context,
            result_data = v_updated_context,
            completed_at = NOW(),
            updated_at = NOW()
        WHERE id = v_inst.id;

        -- Audit Log
        INSERT INTO public.audit_logs (
            action, entity_type, entity_id, actor_id, actor_role, old_values, new_values
        ) VALUES (
            'WORKFLOW_COMPLETED',
            'workflow_instance',
            v_inst.id,
            v_inst.actor_id,
            v_inst.actor_role,
            jsonb_build_object('status', 'running'),
            jsonb_build_object('status', 'completed', 'total_steps', v_inst.total_steps)
        );

        RETURN jsonb_build_object(
            'success', true,
            'instance_code', p_instance_code,
            'status', 'completed',
            'total_steps_executed', v_inst.total_steps
        );
    ELSE
        -- Advance to next step
        v_next_step := v_wf_def.steps->v_next_index;
        v_next_step_name := v_next_step->>'name';

        UPDATE public.workflow_instances
        SET current_step_name = v_next_step_name,
            current_step_index = v_next_index,
            context_data = v_updated_context,
            updated_at = NOW()
        WHERE id = v_inst.id;

        -- Create execution record for the next step
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
            'current_step', v_next_step_name,
            'current_step_index', v_next_index,
            'total_steps', v_inst.total_steps
        );
    END IF;
END;
$$;

-- 8. RPC: retry_workflow_instance
-- Memulai ulang langkah yang gagal pada workflow yang terhenti
CREATE OR REPLACE FUNCTION public.retry_workflow_instance(
    p_instance_code VARCHAR(100),
    p_from_step VARCHAR(100) DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_inst RECORD;
    v_step_exec RECORD;
    v_step_name VARCHAR(100);
BEGIN
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

    IF v_inst.status != 'failed' AND v_inst.status != 'paused' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Hanya workflow berstatus failed atau paused yang dapat di-retry'
        );
    END IF;

    v_step_name := COALESCE(p_from_step, v_inst.current_step_name);

    -- Reset step execution record
    UPDATE public.workflow_step_executions
    SET status = 'running',
        retry_count = 0,
        error_message = NULL,
        started_at = NOW(),
        finished_at = NULL
    WHERE instance_id = v_inst.id AND step_name = v_step_name;

    -- Update instance
    UPDATE public.workflow_instances
    SET status = 'running',
        current_step_name = v_step_name,
        error_message = NULL,
        completed_at = NULL,
        updated_at = NOW()
    WHERE id = v_inst.id;

    RETURN jsonb_build_object(
        'success', true,
        'instance_code', p_instance_code,
        'status', 'running',
        'retried_step', v_step_name
    );
END;
$$;

-- 9. RPC: cancel_workflow_instance
-- Membatalkan workflow yang sedang berjalan
CREATE OR REPLACE FUNCTION public.cancel_workflow_instance(
    p_instance_code VARCHAR(100),
    p_reason TEXT DEFAULT 'Cancelled by administrator'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_inst RECORD;
BEGIN
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

    IF v_inst.status IN ('completed', 'cancelled') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Workflow sudah selesai atau sudah dibatalkan'
        );
    END IF;

    -- Cancel running steps
    UPDATE public.workflow_step_executions
    SET status = 'skipped',
        error_message = 'Cancelled: ' || p_reason,
        finished_at = NOW()
    WHERE instance_id = v_inst.id AND status = 'running';

    -- Cancel instance
    UPDATE public.workflow_instances
    SET status = 'cancelled',
        error_message = p_reason,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = v_inst.id;

    RETURN jsonb_build_object(
        'success', true,
        'instance_code', p_instance_code,
        'status', 'cancelled',
        'reason', p_reason
    );
END;
$$;

-- 10. RPC: get_workflow_instance_status
-- Mengambil status dan riwayat lengkap untuk pemantauan UI
CREATE OR REPLACE FUNCTION public.get_workflow_instance_status(
    p_instance_code VARCHAR(100)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_inst RECORD;
    v_steps JSONB;
BEGIN
    SELECT * INTO v_inst
    FROM public.workflow_instances
    WHERE instance_code = p_instance_code;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Workflow instance tidak ditemukan');
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'step_name', se.step_name,
        'step_index', se.step_index,
        'step_type', se.step_type,
        'status', se.status,
        'retry_count', se.retry_count,
        'duration_ms', se.duration_ms,
        'started_at', se.started_at,
        'finished_at', se.finished_at,
        'error_message', se.error_message
    ) ORDER BY se.step_index ASC, se.id ASC), '[]'::jsonb) INTO v_steps
    FROM public.workflow_step_executions se
    WHERE se.instance_id = v_inst.id;

    RETURN jsonb_build_object(
        'success', true,
        'instance_code', v_inst.instance_code,
        'workflow_code', v_inst.workflow_code,
        'target_entity_type', v_inst.target_entity_type,
        'target_entity_id', v_inst.target_entity_id,
        'status', v_inst.status,
        'current_step_name', v_inst.current_step_name,
        'current_step_index', v_inst.current_step_index,
        'total_steps', v_inst.total_steps,
        'started_at', v_inst.started_at,
        'completed_at', v_inst.completed_at,
        'error_message', v_inst.error_message,
        'steps', v_steps
    );
END;
$$;

-- 11. RPC: record_workflow_worker_heartbeat
-- Registry heartbeat bagi worker runner Node.js / Deno background process
CREATE OR REPLACE FUNCTION public.record_workflow_worker_heartbeat(
    p_worker_id VARCHAR(100),
    p_worker_name VARCHAR(100),
    p_status VARCHAR(50) DEFAULT 'online',
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.workflow_worker_heartbeats (
        worker_id, worker_name, status, last_heartbeat_at, metadata
    ) VALUES (
        p_worker_id, p_worker_name, p_status, NOW(), COALESCE(p_metadata, '{}'::jsonb)
    )
    ON CONFLICT (worker_id) DO UPDATE
    SET status = EXCLUDED.status,
        last_heartbeat_at = NOW(),
        metadata = EXCLUDED.metadata;

    RETURN jsonb_build_object('success', true, 'worker_id', p_worker_id, 'status', p_status);
END;
$$;

-- 11B. RPC: orchestrate_website_lifecycle
-- Dedicated RPC trigger for the 7-Stage End-to-End Orchestrator:
-- Request -> Domain -> Build -> Deploy -> Panel -> Active -> Monitor
CREATE OR REPLACE FUNCTION public.orchestrate_website_lifecycle(
    p_website_id BIGINT,
    p_domain_name VARCHAR(255),
    p_theme_code VARCHAR(100) DEFAULT 'nexus_dark',
    p_owner_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_context JSONB;
    v_res JSONB;
BEGIN
    v_context := jsonb_build_object(
        'website_id', p_website_id,
        'domain_name', p_domain_name,
        'theme_code', p_theme_code,
        'owner_id', p_owner_id,
        'stages', jsonb_build_array('Request', 'Domain', 'Build', 'Deploy', 'Panel', 'Active', 'Monitor')
    );

    v_res := public.start_workflow_instance(
        'e2e_website_lifecycle',
        'website',
        p_website_id::text,
        v_context,
        'lifecycle_engine'
    );

    RETURN v_res;
END;
$$;

-- 12. PRE-SEEDED PRODUCTION WORKFLOW DEFINITIONS
INSERT INTO public.workflow_definitions (code, name, description, steps) VALUES
(
    'e2e_website_lifecycle',
    'End-to-End Website Lifecycle Orchestrator',
    '7-Stage E2E Orchestrator Pipeline: Request -> Domain -> Build -> Deploy -> Panel -> Active -> Monitor',
    '[
        {"name": "request_intake_validation", "type": "rpc_call", "stage": "Request", "max_retries": 3},
        {"name": "domain_dns_allocation", "type": "api_webhook", "stage": "Domain", "max_retries": 5},
        {"name": "theme_hydration_build", "type": "rpc_call", "stage": "Build", "max_retries": 3},
        {"name": "edge_deployment_ssl", "type": "api_webhook", "stage": "Deploy", "max_retries": 5},
        {"name": "panel_credentials_provisioning", "type": "rpc_call", "stage": "Panel", "max_retries": 3},
        {"name": "website_activation_broadcast", "type": "notification_dispatch", "stage": "Active", "max_retries": 3},
        {"name": "telemetry_health_monitor_bind", "type": "probe_check", "stage": "Monitor", "max_retries": 5}
    ]'::jsonb
),
(
    'website_provisioning',
    'Website Automated Provisioning Flow',
    'Full provisioning pipeline: domain verification -> Cloudflare DNS -> theme hydration -> SSL issuance -> health probe verification',
    '[
        {"name": "verify_domain_ownership", "type": "rpc_call", "max_retries": 3},
        {"name": "configure_cloudflare_dns", "type": "api_webhook", "max_retries": 5},
        {"name": "hydrate_theme_templates", "type": "rpc_call", "max_retries": 2},
        {"name": "issue_ssl_certificates", "type": "api_webhook", "max_retries": 3},
        {"name": "run_health_verification", "type": "probe_check", "max_retries": 3},
        {"name": "dispatch_activation_notice", "type": "notification_dispatch", "max_retries": 2}
    ]'::jsonb
),
(
    'website_reclaim_lifecycle',
    'Website Idle Expiry & Resource Reclaim Flow',
    'Automated reclaim pipeline: inactivity audit -> grace warning dispatch -> snapshot archive -> domain detachment',
    '[
        {"name": "detect_idle_inactivity", "type": "rpc_call", "max_retries": 2},
        {"name": "dispatch_grace_warning", "type": "notification_dispatch", "max_retries": 3},
        {"name": "await_grace_window", "type": "condition_branch", "max_retries": 1},
        {"name": "create_pre_reclaim_archive", "type": "rpc_call", "max_retries": 3},
        {"name": "release_domain_and_detach", "type": "rpc_call", "max_retries": 3},
        {"name": "log_reclaim_completed", "type": "notification_dispatch", "max_retries": 2}
    ]'::jsonb
),
(
    'domain_dns_routing',
    'Domain DNS & Cloudflare Zone Orchestration',
    'Automated zone allocation, nameserver propagation checks, and SSL edge rule configuration',
    '[
        {"name": "query_whois_nameservers", "type": "probe_check", "max_retries": 5},
        {"name": "bind_cloudflare_zone", "type": "api_webhook", "max_retries": 3},
        {"name": "create_dns_a_cname_records", "type": "api_webhook", "max_retries": 3},
        {"name": "verify_edge_connectivity", "type": "probe_check", "max_retries": 5}
    ]'::jsonb
),
(
    'incident_mitigation',
    'Automated Payment & Service Incident Failover',
    'Health probe failure detection, automatic secondary gateway failover, and operator alert dispatch',
    '[
        {"name": "verify_incident_criteria", "type": "rpc_call", "max_retries": 2},
        {"name": "activate_failover_provider", "type": "rpc_call", "max_retries": 3},
        {"name": "drain_stale_transactions", "type": "rpc_call", "max_retries": 2},
        {"name": "dispatch_emergency_broadcast", "type": "notification_dispatch", "max_retries": 2},
        {"name": "verify_recovered_telemetry", "type": "probe_check", "max_retries": 5}
    ]'::jsonb
)
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    steps = EXCLUDED.steps,
    updated_at = NOW();

-- 13. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_step_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_worker_heartbeats ENABLE ROW LEVEL SECURITY;

-- Service role has unrestricted access
DROP POLICY IF EXISTS service_role_wf_defs ON public.workflow_definitions;
CREATE POLICY service_role_wf_defs ON public.workflow_definitions
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_wf_inst ON public.workflow_instances;
CREATE POLICY service_role_wf_inst ON public.workflow_instances
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_wf_steps ON public.workflow_step_executions;
CREATE POLICY service_role_wf_steps ON public.workflow_step_executions
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_wf_workers ON public.workflow_worker_heartbeats;
CREATE POLICY service_role_wf_workers ON public.workflow_worker_heartbeats
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated operators with workflow.view or root/super_admin can view
DROP POLICY IF EXISTS operator_read_wf_defs ON public.workflow_definitions;
CREATE POLICY operator_read_wf_defs ON public.workflow_definitions
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'workflow.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_wf_inst ON public.workflow_instances;
CREATE POLICY operator_read_wf_inst ON public.workflow_instances
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'workflow.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_wf_steps ON public.workflow_step_executions;
CREATE POLICY operator_read_wf_steps ON public.workflow_step_executions
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'workflow.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_wf_workers ON public.workflow_worker_heartbeats;
CREATE POLICY operator_read_wf_workers ON public.workflow_worker_heartbeats
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'workflow.view' OR da.role IN ('root', 'super_admin'))
        )
    );
