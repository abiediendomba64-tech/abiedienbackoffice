-- ====================================================================
-- MIGRATION: 20260917000017_payment_providers.sql
-- PHASE:      017 Payment Provider Abstraction & Failover
-- DESCRIPTION: Implements multi-gateway abstraction, health probes,
--              automated failover policies, and operator manual controls.
--              Features:
--                1. Capability registration (provider.view, provider.manage, provider.failover)
--                2. public.payment_providers (StarPAGO, GSPay, Manual Bank Transfer)
--                3. public.payment_failover_policies (Automated routing & failover rules)
--                4. public.payment_provider_health_logs (Gateway probe & latency telemetry)
--                5. public.payment_failover_events (Audit history of failover switches)
--                6. Atomic RPCs:
--                   - resolve_active_payment_provider (Dynamic healthy route resolution)
--                   - record_provider_health_probe (Latency/status telemetry & auto-failover trigger)
--                   - trigger_provider_failover (Manual operator switch "Alihkan ke GSPay")
--                   - reset_provider_failover (Manual failback restoration)
--                7. Enhanced create_payment_transaction (Auto-routing via active provider)
--                8. RLS and capability-gated security policies
-- Conventions: pure ASCII, SECURITY DEFINER with search_path='',
--              fail-closed capability gate, immutable audit_logs,
--              and telegram_notification_log queue.
-- ====================================================================

-- 1. CAPABILITY REGISTRATION
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('provider.view',     'Melihat daftar gateway pembayaran dan status kesehatannya', 'finance'),
('provider.manage',   'Kelola gateway pembayaran, priority, dan kredensial ref', 'finance'),
('provider.failover', 'Memicu failover gateway pembayaran secara manual atau mengelola rute failover', 'finance')
ON CONFLICT (code) DO NOTHING;

-- Grant capabilities to operational roles
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'provider.%'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Admin role permissions
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('provider.view', 'provider.failover')
ON CONFLICT (role, capability_code) DO NOTHING;

-- Dev role permissions
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('provider.view')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. TABLE: payment_providers (Master Gateway Pembayaran)
CREATE TABLE IF NOT EXISTS public.payment_providers (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    payment_methods TEXT[] NOT NULL DEFAULT '{"qris"}',
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    priority INT NOT NULL DEFAULT 1,
    consecutive_failures INT NOT NULL DEFAULT 0,
    max_consecutive_failures INT NOT NULL DEFAULT 3,
    avg_latency_ms INT NOT NULL DEFAULT 0,
    success_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 100.00,
    secret_vault_ref VARCHAR(255),
    endpoint_url TEXT,
    webhook_url TEXT,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_health_ping_at TIMESTAMPTZ,
    last_status_change_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_provider_status CHECK (status IN ('active', 'degraded', 'maintenance', 'offline', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_payment_providers_code ON public.payment_providers(code);
CREATE INDEX IF NOT EXISTS idx_payment_providers_status ON public.payment_providers(status);
CREATE INDEX IF NOT EXISTS idx_payment_providers_priority ON public.payment_providers(priority);

-- Seed Payment Providers
INSERT INTO public.payment_providers (
    code, name, description, payment_methods, status, priority, max_consecutive_failures, secret_vault_ref, config
) VALUES
(
    'starpago',
    'StarPAGO Gateway (Primary)',
    'Gateway pembayaran utama untuk QRIS dan Virtual Account otomatis',
    ARRAY['qris', 'va'],
    'active',
    1,
    3,
    'vault:secret/payment/starpago_api_key',
    '{"qris_fee_percent": 0.70, "va_fee_fixed": 4000, "timeout_seconds": 30}'::jsonb
),
(
    'gspay',
    'GSPay Gateway (Backup / Failover)',
    'Gateway pembayaran sekunder berkecepatan tinggi untuk rute failover QRIS dan H2H',
    ARRAY['qris', 'h2h'],
    'active',
    2,
    3,
    'vault:secret/payment/gspay_api_key',
    '{"qris_fee_percent": 0.75, "h2h_fee_fixed": 3500, "timeout_seconds": 25}'::jsonb
),
(
    'manual',
    'Manual Bank Transfer',
    'Rute pembayaran manual transfer bank konfirmasi operator',
    ARRAY['bank_transfer', 'manual'],
    'active',
    99,
    10,
    'vault:secret/payment/manual_bank_key',
    '{"verification": "manual_operator", "timeout_hours": 24}'::jsonb
)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    payment_methods = EXCLUDED.payment_methods,
    config = EXCLUDED.config;

-- 3. TABLE: payment_failover_policies (Kebijakan Failover Gateway)
CREATE TABLE IF NOT EXISTS public.payment_failover_policies (
    id BIGSERIAL PRIMARY KEY,
    payment_method VARCHAR(50) UNIQUE NOT NULL,
    primary_provider_id BIGINT NOT NULL REFERENCES public.payment_providers(id) ON DELETE RESTRICT,
    fallback_provider_id BIGINT NOT NULL REFERENCES public.payment_providers(id) ON DELETE RESTRICT,
    current_active_provider_id BIGINT NOT NULL REFERENCES public.payment_providers(id) ON DELETE RESTRICT,
    trigger_condition VARCHAR(50) NOT NULL DEFAULT 'consecutive_failures',
    failure_threshold INT NOT NULL DEFAULT 3,
    latency_threshold_ms INT NOT NULL DEFAULT 5000,
    is_auto_failover_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    is_failover_active BOOLEAN NOT NULL DEFAULT FALSE,
    last_failover_at TIMESTAMPTZ,
    failover_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT diff_providers CHECK (primary_provider_id <> fallback_provider_id),
    CONSTRAINT valid_trigger_condition CHECK (trigger_condition IN ('consecutive_failures', 'maintenance', 'high_latency', 'manual_only'))
);

CREATE INDEX IF NOT EXISTS idx_failover_policies_method ON public.payment_failover_policies(payment_method);
CREATE INDEX IF NOT EXISTS idx_failover_policies_active ON public.payment_failover_policies(is_failover_active);

-- Seed Policies for QRIS & VA
DO $$
DECLARE
    v_starpago_id BIGINT;
    v_gspay_id BIGINT;
BEGIN
    SELECT id INTO v_starpago_id FROM public.payment_providers WHERE code = 'starpago';
    SELECT id INTO v_gspay_id FROM public.payment_providers WHERE code = 'gspay';

    IF v_starpago_id IS NOT NULL AND v_gspay_id IS NOT NULL THEN
        INSERT INTO public.payment_failover_policies (
            payment_method, primary_provider_id, fallback_provider_id, current_active_provider_id, failure_threshold
        ) VALUES
        ('qris', v_starpago_id, v_gspay_id, v_starpago_id, 3),
        ('va',   v_starpago_id, v_gspay_id, v_starpago_id, 3)
        ON CONFLICT (payment_method) DO NOTHING;
    END IF;
END $$;

-- 4. TABLE: payment_provider_health_logs (Telemetri Probe Gateway)
CREATE TABLE IF NOT EXISTS public.payment_provider_health_logs (
    id BIGSERIAL PRIMARY KEY,
    provider_id BIGINT NOT NULL REFERENCES public.payment_providers(id) ON DELETE CASCADE,
    check_status VARCHAR(20) NOT NULL,
    latency_ms INT NOT NULL DEFAULT 0,
    http_status INT,
    error_code VARCHAR(100),
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_health_status CHECK (check_status IN ('pass', 'degraded', 'fail'))
);

CREATE INDEX IF NOT EXISTS idx_provider_health_provider ON public.payment_provider_health_logs(provider_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_health_status ON public.payment_provider_health_logs(check_status);

-- 5. TABLE: payment_failover_events (Audit Trail Riwayat Failover)
CREATE TABLE IF NOT EXISTS public.payment_failover_events (
    id BIGSERIAL PRIMARY KEY,
    policy_id BIGINT REFERENCES public.payment_failover_policies(id) ON DELETE SET NULL,
    payment_method VARCHAR(50) NOT NULL,
    from_provider_id BIGINT NOT NULL REFERENCES public.payment_providers(id) ON DELETE RESTRICT,
    to_provider_id BIGINT NOT NULL REFERENCES public.payment_providers(id) ON DELETE RESTRICT,
    trigger_type VARCHAR(50) NOT NULL,
    reason TEXT NOT NULL,
    actor_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_role VARCHAR(50),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_failover_trigger CHECK (trigger_type IN (
        'auto_consecutive_failures', 'auto_maintenance', 'auto_high_latency', 'manual_operator', 'manual_restore'
    ))
);

CREATE INDEX IF NOT EXISTS idx_failover_events_method ON public.payment_failover_events(payment_method, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_failover_events_type ON public.payment_failover_events(trigger_type);

-- 6. ATOMIC RPC: resolve_active_payment_provider
CREATE OR REPLACE FUNCTION public.resolve_active_payment_provider(
    p_payment_method VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_policy RECORD;
    v_provider RECORD;
    v_is_failover BOOLEAN := FALSE;
BEGIN
    -- Check policy for requested method
    SELECT * INTO v_policy
    FROM public.payment_failover_policies
    WHERE payment_method = lower(trim(p_payment_method));

    IF FOUND THEN
        -- Check current active provider in policy
        SELECT * INTO v_provider
        FROM public.payment_providers
        WHERE id = v_policy.current_active_provider_id;

        IF FOUND AND v_provider.status IN ('active', 'degraded') THEN
            v_is_failover := v_policy.is_failover_active;
            RETURN jsonb_build_object(
                'success', true,
                'payment_method', p_payment_method,
                'provider_id', v_provider.id,
                'provider_code', v_provider.code,
                'provider_name', v_provider.name,
                'status', v_provider.status,
                'is_failover', v_is_failover,
                'priority', v_provider.priority,
                'avg_latency_ms', v_provider.avg_latency_ms,
                'config', v_provider.config
            );
        END IF;
    END IF;

    -- Fallback: Pick highest priority provider that supports this payment method and is active
    SELECT * INTO v_provider
    FROM public.payment_providers
    WHERE p_payment_method = ANY(payment_methods)
      AND status IN ('active', 'degraded')
    ORDER BY priority ASC, avg_latency_ms ASC
    LIMIT 1;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'success', true,
            'payment_method', p_payment_method,
            'provider_id', v_provider.id,
            'provider_code', v_provider.code,
            'provider_name', v_provider.name,
            'status', v_provider.status,
            'is_failover', false,
            'priority', v_provider.priority,
            'avg_latency_ms', v_provider.avg_latency_ms,
            'config', v_provider.config
        );
    END IF;

    -- Fallback to manual if nothing else matches
    SELECT * INTO v_provider
    FROM public.payment_providers
    WHERE code = 'manual';

    IF FOUND THEN
        RETURN jsonb_build_object(
            'success', true,
            'payment_method', p_payment_method,
            'provider_id', v_provider.id,
            'provider_code', v_provider.code,
            'provider_name', v_provider.name,
            'status', v_provider.status,
            'is_failover', false,
            'priority', v_provider.priority,
            'avg_latency_ms', v_provider.avg_latency_ms,
            'config', v_provider.config
        );
    END IF;

    RETURN jsonb_build_object(
        'success', false,
        'message', format('No available payment provider for method: %s', p_payment_method)
    );
END;
$$;

-- 7. ATOMIC RPC: record_provider_health_probe
CREATE OR REPLACE FUNCTION public.record_provider_health_probe(
    p_provider_code VARCHAR,
    p_check_status VARCHAR,
    p_latency_ms INT DEFAULT 0,
    p_http_status INT DEFAULT 200,
    p_error_code VARCHAR DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_provider RECORD;
    v_new_failures INT;
    v_new_avg_latency INT;
    v_new_status VARCHAR(30);
    v_policy RECORD;
    v_fallback RECORD;
    v_auto_failover_triggered BOOLEAN := FALSE;
BEGIN
    SELECT * INTO v_provider
    FROM public.payment_providers
    WHERE code = lower(trim(p_provider_code))
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'message', format('Provider %s not found', p_provider_code)
        );
    END IF;

    -- Calculate metrics
    IF p_check_status = 'pass' THEN
        v_new_failures := 0;
        IF v_provider.avg_latency_ms > 0 THEN
            v_new_avg_latency := ((v_provider.avg_latency_ms * 4) + p_latency_ms) / 5;
        ELSE
            v_new_avg_latency := p_latency_ms;
        END IF;

        IF v_provider.status IN ('degraded', 'offline') THEN
            -- Recover status to active
            v_new_status := 'active';
        ELSE
            v_new_status := v_provider.status;
        END IF;
    ELSE
        -- Failure or degradation
        v_new_failures := v_provider.consecutive_failures + 1;
        v_new_avg_latency := GREATEST(v_provider.avg_latency_ms, p_latency_ms);

        IF v_new_failures >= v_provider.max_consecutive_failures THEN
            v_new_status := 'offline';
        ELSIF p_check_status = 'degraded' OR v_new_failures >= 2 THEN
            v_new_status := 'degraded';
        ELSE
            v_new_status := v_provider.status;
        END IF;
    END IF;

    -- Update provider record
    UPDATE public.payment_providers
    SET consecutive_failures = v_new_failures,
        avg_latency_ms = v_new_avg_latency,
        status = v_new_status,
        last_health_ping_at = NOW(),
        last_status_change_at = CASE WHEN status <> v_new_status THEN NOW() ELSE last_status_change_at END,
        updated_at = NOW()
    WHERE id = v_provider.id;

    -- Record log
    INSERT INTO public.payment_provider_health_logs (
        provider_id, check_status, latency_ms, http_status, error_code, error_message, metadata
    ) VALUES (
        v_provider.id, p_check_status, p_latency_ms, p_http_status, p_error_code, p_error_message, p_metadata
    );

    -- Check if auto-failover should trigger
    -- Condition: consecutive failures reached threshold AND provider is primary in an active policy
    IF v_new_failures >= v_provider.max_consecutive_failures THEN
        FOR v_policy IN
            SELECT p.*
            FROM public.payment_failover_policies p
            WHERE p.primary_provider_id = v_provider.id
              AND p.is_auto_failover_enabled = TRUE
              AND p.is_failover_active = FALSE
            FOR UPDATE
        LOOP
            SELECT * INTO v_fallback
            FROM public.payment_providers
            WHERE id = v_policy.fallback_provider_id;

            IF FOUND AND v_fallback.status IN ('active', 'degraded') THEN
                -- Trigger failover
                UPDATE public.payment_failover_policies
                SET current_active_provider_id = v_fallback.id,
                    is_failover_active = TRUE,
                    last_failover_at = NOW(),
                    failover_reason = format('Auto-failover: %s gagal berturut-turut (%s/%s). Dialihkan ke %s.',
                                             v_provider.name, v_new_failures, v_policy.failure_threshold, v_fallback.name),
                    updated_at = NOW()
                WHERE id = v_policy.id;

                -- Record event
                INSERT INTO public.payment_failover_events (
                    policy_id, payment_method, from_provider_id, to_provider_id,
                    trigger_type, reason, actor_role, metadata
                ) VALUES (
                    v_policy.id, v_policy.payment_method, v_provider.id, v_fallback.id,
                    'auto_consecutive_failures',
                    format('Kegagalan berturut-turut %s kali pada %s (Latency: %s ms, Error: %s)',
                           v_new_failures, v_provider.name, p_latency_ms, COALESCE(p_error_message, 'Timeout/Error')),
                    'system',
                    jsonb_build_object(
                        'latency_ms', p_latency_ms,
                        'http_status', p_http_status,
                        'consecutive_failures', v_new_failures
                    )
                );

                -- Immutable audit log
                INSERT INTO public.audit_logs (
                    actor_role, action_type, resource_type, resource_id, old_value, new_value
                ) VALUES (
                    'system',
                    'PAYMENT_PROVIDER_AUTO_FAILOVER',
                    'payment_failover_policies',
                    v_policy.id,
                    jsonb_build_object('active_provider', v_provider.code, 'is_failover', false),
                    jsonb_build_object('active_provider', v_fallback.code, 'is_failover', true, 'reason', v_policy.failover_reason)
                );

                -- Queue priority telegram notification
                INSERT INTO public.telegram_notification_log (
                    recipient_chat_id, message_text, context_type, context_id, status
                ) VALUES (
                    0,
                    format('[ALERT FAILOVER] Gateway %s OFFLINE (%s kegagalan berturut-turut). Rute [%s] dialihkan otomatis ke %s. Transaksi in-flight lama tetap diproses di gateway asal.',
                           v_provider.name, v_new_failures, upper(v_policy.payment_method), v_fallback.name),
                    'provider_failover',
                    v_policy.payment_method,
                    'queued'
                );

                v_auto_failover_triggered := TRUE;
            END IF;
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'provider_code', p_provider_code,
        'status', v_new_status,
        'consecutive_failures', v_new_failures,
        'avg_latency_ms', v_new_avg_latency,
        'auto_failover_triggered', v_auto_failover_triggered
    );
END;
$$;

-- 8. ATOMIC RPC: trigger_provider_failover (Manual Operator Action "Alihkan ke GSPay")
CREATE OR REPLACE FUNCTION public.trigger_provider_failover(
    p_payment_method VARCHAR,
    p_target_provider_code VARCHAR,
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
    v_policy RECORD;
    v_target RECORD;
    v_source RECORD;
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
                  AND bc.code = 'provider.failover'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks provider.failover capability', v_actor_role;
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

    -- Lookup policy
    SELECT * INTO v_policy
    FROM public.payment_failover_policies
    WHERE payment_method = lower(trim(p_payment_method))
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Policy for payment method % not found', p_payment_method;
    END IF;

    -- Lookup target provider
    SELECT * INTO v_target
    FROM public.payment_providers
    WHERE code = lower(trim(p_target_provider_code));

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target provider % not found', p_target_provider_code;
    END IF;

    IF v_target.status = 'disabled' THEN
        RAISE EXCEPTION 'Target provider % is currently disabled', p_target_provider_code;
    END IF;

    -- Source provider is current active
    SELECT * INTO v_source
    FROM public.payment_providers
    WHERE id = v_policy.current_active_provider_id;

    -- Apply switch
    UPDATE public.payment_failover_policies
    SET current_active_provider_id = v_target.id,
        is_failover_active = (v_target.id <> v_policy.primary_provider_id),
        last_failover_at = NOW(),
        failover_reason = p_reason,
        updated_at = NOW()
    WHERE id = v_policy.id;

    -- Record failover event
    INSERT INTO public.payment_failover_events (
        policy_id, payment_method, from_provider_id, to_provider_id,
        trigger_type, reason, actor_id, actor_role, metadata
    ) VALUES (
        v_policy.id, v_policy.payment_method, v_source.id, v_target.id,
        'manual_operator', p_reason, v_actor_user_id, v_actor_role,
        jsonb_build_object(
            'from_code', v_source.code,
            'to_code', v_target.code,
            'manual_override', true
        )
    );

    -- Immutable audit log
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id, COALESCE(v_actor_role, 'operator'),
        'PAYMENT_PROVIDER_MANUAL_FAILOVER',
        'payment_failover_policies',
        v_policy.id,
        jsonb_build_object('active_provider', v_source.code, 'is_failover', v_policy.is_failover_active),
        jsonb_build_object('active_provider', v_target.code, 'is_failover', (v_target.id <> v_policy.primary_provider_id), 'reason', p_reason)
    );

    -- Priority telegram alert
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, context_type, context_id, status
    ) VALUES (
        0,
        format('[MANUAL FAILOVER] Rute pembayaran [%s] dialihkan manual ke [%s] oleh operator (%s). Alasan: %s. Transaksi in-flight lama tetap diproses di gateway asal.',
               upper(p_payment_method), v_target.name, COALESCE(v_actor_role, 'operator'), p_reason),
        'provider_failover',
        v_policy.payment_method,
        'queued'
    );

    RETURN jsonb_build_object(
        'success', true,
        'payment_method', p_payment_method,
        'from_provider', v_source.code,
        'to_provider', v_target.code,
        'is_failover_active', (v_target.id <> v_policy.primary_provider_id),
        'switched_at', NOW()
    );
END;
$$;

-- 9. ATOMIC RPC: reset_provider_failover (Manual Failback Restoration)
CREATE OR REPLACE FUNCTION public.reset_provider_failover(
    p_payment_method VARCHAR,
    p_actor_id BIGINT DEFAULT NULL,
    p_notes TEXT DEFAULT 'Manual failback restoration by operator'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor_user_id BIGINT;
    v_actor_role VARCHAR(50);
    v_policy RECORD;
    v_primary RECORD;
    v_current RECORD;
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
                  AND bc.code = 'provider.failover'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks provider.failover capability', v_actor_role;
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

    -- Lookup policy
    SELECT * INTO v_policy
    FROM public.payment_failover_policies
    WHERE payment_method = lower(trim(p_payment_method))
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Policy for payment method % not found', p_payment_method;
    END IF;

    -- Primary provider
    SELECT * INTO v_primary
    FROM public.payment_providers
    WHERE id = v_policy.primary_provider_id;

    -- Current active provider
    SELECT * INTO v_current
    FROM public.payment_providers
    WHERE id = v_policy.current_active_provider_id;

    -- Reset primary status if was offline
    UPDATE public.payment_providers
    SET status = 'active',
        consecutive_failures = 0,
        updated_at = NOW()
    WHERE id = v_primary.id;

    -- Restore policy to primary
    UPDATE public.payment_failover_policies
    SET current_active_provider_id = v_primary.id,
        is_failover_active = FALSE,
        failover_reason = NULL,
        updated_at = NOW()
    WHERE id = v_policy.id;

    -- Record event
    INSERT INTO public.payment_failover_events (
        policy_id, payment_method, from_provider_id, to_provider_id,
        trigger_type, reason, actor_id, actor_role, metadata
    ) VALUES (
        v_policy.id, v_policy.payment_method, v_current.id, v_primary.id,
        'manual_restore', p_notes, v_actor_user_id, v_actor_role,
        jsonb_build_object('restored_to_primary', true)
    );

    -- Immutable audit log
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id, COALESCE(v_actor_role, 'operator'),
        'PAYMENT_PROVIDER_RESTORED',
        'payment_failover_policies',
        v_policy.id,
        jsonb_build_object('active_provider', v_current.code, 'is_failover', true),
        jsonb_build_object('active_provider', v_primary.code, 'is_failover', false, 'notes', p_notes)
    );

    -- Telegram notification
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, context_type, context_id, status
    ) VALUES (
        0,
        format('[FAILOVER RESTORED] Rute pembayaran [%s] telah dipulihkan kembali ke gateway utama [%s] oleh %s.',
               upper(p_payment_method), v_primary.name, COALESCE(v_actor_role, 'operator')),
        'provider_failover',
        v_policy.payment_method,
        'queued'
    );

    RETURN jsonb_build_object(
        'success', true,
        'payment_method', p_payment_method,
        'restored_provider', v_primary.code,
        'is_failover_active', false,
        'restored_at', NOW()
    );
END;
$$;

-- 10. ENHANCED RPC: create_payment_transaction with auto-route resolution
CREATE OR REPLACE FUNCTION public.create_payment_transaction(
    p_user_id BIGINT,
    p_transaction_type VARCHAR(30),
    p_amount NUMERIC,
    p_fee NUMERIC DEFAULT 0.00,
    p_website_id BIGINT DEFAULT NULL,
    p_provider_code VARCHAR(50) DEFAULT 'auto',
    p_provider_ref VARCHAR(100) DEFAULT NULL,
    p_payment_method VARCHAR(50) DEFAULT 'qris',
    p_metadata JSONB DEFAULT '{}'::jsonb,
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
    v_new_tx_id BIGINT;
    v_tx_code VARCHAR(50);
    v_net NUMERIC(18,2);
    v_resolved_provider JSONB;
    v_effective_provider_code VARCHAR(50);
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
                  AND bc.code = 'payment.manage'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks payment.manage capability', v_actor_role;
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

    -- Validate user
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id) THEN
        RAISE EXCEPTION 'User with ID % does not exist', p_user_id;
    END IF;

    -- Resolve provider if set to 'auto' or 'active'
    IF p_provider_code IS NULL OR p_provider_code IN ('auto', 'active', 'default') THEN
        v_resolved_provider := public.resolve_active_payment_provider(p_payment_method);
        IF (v_resolved_provider->>'success')::boolean = TRUE THEN
            v_effective_provider_code := v_resolved_provider->>'provider_code';
        ELSE
            v_effective_provider_code := 'manual';
        END IF;
    ELSE
        v_effective_provider_code := p_provider_code;
    END IF;

    -- Generate transaction code
    v_tx_code := 'TXN-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0');
    v_net := p_amount - COALESCE(p_fee, 0.00);

    -- Insert into payment_transactions
    INSERT INTO public.payment_transactions (
        transaction_code, user_id, website_id, transaction_type,
        amount, fee_amount, net_amount, provider_code, provider_reference,
        payment_method, status, metadata
    ) VALUES (
        v_tx_code, p_user_id, p_website_id, p_transaction_type,
        p_amount, COALESCE(p_fee, 0.00), v_net, v_effective_provider_code, p_provider_ref,
        p_payment_method, 'pending',
        p_metadata || jsonb_build_object('resolved_route', v_effective_provider_code)
    ) RETURNING id INTO v_new_tx_id;

    -- Insert into audit_logs
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id, COALESCE(v_actor_role, 'system'),
        'PAYMENT_TRANSACTION_CREATED', 'payment_transactions', v_new_tx_id,
        NULL,
        jsonb_build_object(
            'tx_code', v_tx_code,
            'type', p_transaction_type,
            'amount', p_amount,
            'user_id', p_user_id,
            'provider', v_effective_provider_code,
            'method', p_payment_method
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'transaction_id', v_new_tx_id,
        'transaction_code', v_tx_code,
        'provider_code', v_effective_provider_code,
        'amount', p_amount,
        'net_amount', v_net,
        'status', 'pending',
        'created_at', NOW()
    );
END;
$$;

-- 11. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.payment_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_failover_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_provider_health_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_failover_events ENABLE ROW LEVEL SECURITY;

-- Service role has unrestricted access
DROP POLICY IF EXISTS service_role_payment_providers ON public.payment_providers;
CREATE POLICY service_role_payment_providers ON public.payment_providers
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_failover_policies ON public.payment_failover_policies;
CREATE POLICY service_role_failover_policies ON public.payment_failover_policies
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_provider_health ON public.payment_provider_health_logs;
CREATE POLICY service_role_provider_health ON public.payment_provider_health_logs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_failover_events ON public.payment_failover_events;
CREATE POLICY service_role_failover_events ON public.payment_failover_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated operators with provider.view can read
DROP POLICY IF EXISTS operator_read_payment_providers ON public.payment_providers;
CREATE POLICY operator_read_payment_providers ON public.payment_providers
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'provider.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_failover_policies ON public.payment_failover_policies;
CREATE POLICY operator_read_failover_policies ON public.payment_failover_policies
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'provider.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_provider_health ON public.payment_provider_health_logs;
CREATE POLICY operator_read_provider_health ON public.payment_provider_health_logs
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'provider.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_failover_events ON public.payment_failover_events;
CREATE POLICY operator_read_failover_events ON public.payment_failover_events
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'provider.view' OR da.role IN ('root', 'super_admin'))
        )
    );
