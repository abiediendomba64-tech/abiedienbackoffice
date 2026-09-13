-- ====================================================================
-- MIGRATION: 20260918000018_website_health_monitoring.sql
-- PHASE:      018 Website Health Monitoring & Automated Probes
-- DESCRIPTION: Implements automated health monitoring engine, probe
--              batching, threshold-based state transitions (active <-> degraded),
--              and telemetry logging with anti-flapping controls.
--              Features:
--                1. Capability registration (health.view, health.probe, health.manage)
--                2. public.websites column enhancements (health_status, consecutive counters)
--                3. public.website_health_probe_configs (Per-website thresholds and throttling)
--                4. public.website_health_probe_batches (Cron runner batch tracking)
--                5. Batch reference link on public.website_health_checks
--                6. Atomic RPCs:
--                   - create_health_probe_batch (Start cron/manual probe batch)
--                   - get_websites_pending_health_probe (Fetch queue of websites due for probe)
--                   - record_website_health_check (Log individual DNS/SSL/HTTP check)
--                   - evaluate_website_health (Threshold evaluation, 3x fail -> degraded, 3x pass -> active)
--                   - complete_health_probe_batch (Finalize batch statistics)
--                7. RLS policies and capability gating
-- Conventions: pure ASCII, SECURITY DEFINER with search_path='',
--              fail-closed capability gate, immutable audit_logs,
--              and telegram_notification_log queue.
-- ====================================================================

-- 1. CAPABILITY REGISTRATION
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('health.view',   'Melihat telemetri probe kesehatan website dan riwayat degradasi', 'ops'),
('health.probe',  'Menjalankan probe kesehatan manual atau batch pemeriksaan', 'ops'),
('health.manage', 'Mengatur konfigurasi ambang batas probe dan kebijakan degradasi', 'ops')
ON CONFLICT (code) DO NOTHING;

-- Grant capabilities to operational roles
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'health.%'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Admin role permissions
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('health.view', 'health.probe')
ON CONFLICT (role, capability_code) DO NOTHING;

-- Dev role permissions
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('health.view', 'health.probe')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. ALTER TABLE: websites (Tambahkan kolom metrik telemetri kesehatan)
ALTER TABLE public.websites
    ADD COLUMN IF NOT EXISTS health_status VARCHAR(20) NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS consecutive_health_failures INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS consecutive_health_passes INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_health_check_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_health_failure_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_health_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS health_probe_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_websites_health_status ON public.websites(health_status);
CREATE INDEX IF NOT EXISTS idx_websites_health_probe ON public.websites(health_probe_enabled, last_health_check_at);

-- 3. TABLE: website_health_probe_configs (Konfigurasi Ambang Batas Per Website)
CREATE TABLE IF NOT EXISTS public.website_health_probe_configs (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT UNIQUE NOT NULL REFERENCES public.websites(id) ON DELETE CASCADE,
    probe_interval_minutes INT NOT NULL DEFAULT 5,
    failure_threshold_for_degrade INT NOT NULL DEFAULT 3,
    pass_threshold_for_recovery INT NOT NULL DEFAULT 3,
    http_timeout_seconds INT NOT NULL DEFAULT 10,
    expected_http_status INT NOT NULL DEFAULT 200,
    check_dns BOOLEAN NOT NULL DEFAULT TRUE,
    check_ssl BOOLEAN NOT NULL DEFAULT TRUE,
    check_http BOOLEAN NOT NULL DEFAULT TRUE,
    check_api BOOLEAN NOT NULL DEFAULT TRUE,
    alert_throttle_minutes INT NOT NULL DEFAULT 60,
    last_alert_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_probe_configs_website ON public.website_health_probe_configs(website_id);

-- 4. TABLE: website_health_probe_batches (Pelacak Eksekusi Runner / Cron Batch)
CREATE TABLE IF NOT EXISTS public.website_health_probe_batches (
    id BIGSERIAL PRIMARY KEY,
    batch_code VARCHAR(50) UNIQUE NOT NULL,
    trigger_type VARCHAR(30) NOT NULL DEFAULT 'cron',
    total_websites INT NOT NULL DEFAULT 0,
    healthy_count INT NOT NULL DEFAULT 0,
    degraded_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms INT,
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT valid_batch_status CHECK (status IN ('running', 'completed', 'failed')),
    CONSTRAINT valid_trigger_type CHECK (trigger_type IN ('cron', 'manual', 'incident_diagnostic'))
);

CREATE INDEX IF NOT EXISTS idx_probe_batches_code ON public.website_health_probe_batches(batch_code);
CREATE INDEX IF NOT EXISTS idx_probe_batches_status ON public.website_health_probe_batches(status);
CREATE INDEX IF NOT EXISTS idx_probe_batches_started ON public.website_health_probe_batches(started_at DESC);

-- 5. ALTER TABLE: website_health_checks (Tambahkan relasi ke probe batch)
ALTER TABLE public.website_health_checks
    ADD COLUMN IF NOT EXISTS batch_id BIGINT REFERENCES public.website_health_probe_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_health_checks_batch ON public.website_health_checks(batch_id);

-- 6. ATOMIC RPC: create_health_probe_batch
CREATE OR REPLACE FUNCTION public.create_health_probe_batch(
    p_trigger_type VARCHAR DEFAULT 'cron',
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
    v_batch_id BIGINT;
    v_batch_code VARCHAR(50);
    v_total_targets INT;
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
                  AND bc.code = 'health.probe'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks health.probe capability', v_actor_role;
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

    -- Count active probe targets
    SELECT COUNT(*) INTO v_total_targets
    FROM public.websites
    WHERE health_probe_enabled = TRUE
      AND lifecycle_status IN ('active', 'degraded', 'access_verification', 'reclaim_warning');

    -- Generate batch code
    v_batch_code := 'PROBE-' || TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS') || '-' || LPAD(FLOOR(RANDOM() * 1000)::TEXT, 3, '0');

    -- Insert batch record
    INSERT INTO public.website_health_probe_batches (
        batch_code, trigger_type, total_websites, status, summary
    ) VALUES (
        v_batch_code, p_trigger_type, v_total_targets, 'running',
        jsonb_build_object('initiated_by', COALESCE(v_actor_role, 'system'), 'target_count', v_total_targets)
    ) RETURNING id INTO v_batch_id;

    RETURN jsonb_build_object(
        'success', true,
        'batch_id', v_batch_id,
        'batch_code', v_batch_code,
        'trigger_type', p_trigger_type,
        'total_targets', v_total_targets,
        'started_at', NOW()
    );
END;
$$;

-- 7. ATOMIC RPC: get_websites_pending_health_probe
CREATE OR REPLACE FUNCTION public.get_websites_pending_health_probe(
    p_limit INT DEFAULT 50
)
RETURNS TABLE (
    website_id BIGINT,
    website_code VARCHAR(50),
    domain VARCHAR(255),
    lifecycle_status VARCHAR(30),
    health_status VARCHAR(20),
    consecutive_failures INT,
    consecutive_passes INT,
    last_check_at TIMESTAMPTZ,
    check_dns BOOLEAN,
    check_ssl BOOLEAN,
    check_http BOOLEAN,
    check_api BOOLEAN,
    timeout_seconds INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    SELECT
        w.id AS website_id,
        w.website_code,
        w.domain,
        w.lifecycle_status,
        w.health_status,
        w.consecutive_health_failures AS consecutive_failures,
        w.consecutive_health_passes AS consecutive_passes,
        w.last_health_check_at AS last_check_at,
        COALESCE(cfg.check_dns, TRUE) AS check_dns,
        COALESCE(cfg.check_ssl, TRUE) AS check_ssl,
        COALESCE(cfg.check_http, TRUE) AS check_http,
        COALESCE(cfg.check_api, TRUE) AS check_api,
        COALESCE(cfg.http_timeout_seconds, 10) AS timeout_seconds
    FROM public.websites w
    LEFT JOIN public.website_health_probe_configs cfg ON cfg.website_id = w.id
    WHERE w.health_probe_enabled = TRUE
      AND w.domain IS NOT NULL
      AND w.lifecycle_status IN ('active', 'degraded', 'access_verification', 'reclaim_warning')
    ORDER BY w.last_health_check_at ASC NULLS FIRST
    LIMIT p_limit;
END;
$$;

-- 8. ATOMIC RPC: record_website_health_check
CREATE OR REPLACE FUNCTION public.record_website_health_check(
    p_website_id BIGINT,
    p_check_type VARCHAR(30),
    p_status VARCHAR(20),
    p_latency_ms INT DEFAULT 0,
    p_response_code INT DEFAULT 200,
    p_error_message TEXT DEFAULT NULL,
    p_details JSONB DEFAULT '{}'::jsonb,
    p_batch_id BIGINT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_check_id BIGINT;
BEGIN
    INSERT INTO public.website_health_checks (
        website_id, check_type, status, latency_ms,
        response_code, error_message, details, batch_id, checked_at
    ) VALUES (
        p_website_id, p_check_type, p_status, p_latency_ms,
        p_response_code, p_error_message, p_details, p_batch_id, NOW()
    ) RETURNING id INTO v_check_id;

    RETURN v_check_id;
END;
$$;

-- 9. ATOMIC RPC: evaluate_website_health (Threshold Engine: 3 Fail -> Degraded, 3 Pass -> Active)
CREATE OR REPLACE FUNCTION public.evaluate_website_health(
    p_website_id BIGINT,
    p_overall_passed BOOLEAN,
    p_summary_details JSONB DEFAULT '{}'::jsonb,
    p_batch_id BIGINT DEFAULT NULL,
    p_actor_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_site RECORD;
    v_cfg RECORD;
    v_fail_threshold INT := 3;
    v_pass_threshold INT := 3;
    v_throttle_mins INT := 60;
    v_new_failures INT;
    v_new_passes INT;
    v_new_health VARCHAR(20);
    v_lifecycle_changed BOOLEAN := FALSE;
    v_previous_lifecycle VARCHAR(30);
    v_target_lifecycle VARCHAR(30);
    v_send_alert BOOLEAN := FALSE;
    v_alert_text TEXT;
BEGIN
    -- Load site details
    SELECT * INTO v_site
    FROM public.websites
    WHERE id = p_website_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', format('Website %s not found', p_website_id));
    END IF;

    -- Load custom config if exists
    SELECT * INTO v_cfg
    FROM public.website_health_probe_configs
    WHERE website_id = p_website_id;

    IF FOUND THEN
        v_fail_threshold := COALESCE(v_cfg.failure_threshold_for_degrade, 3);
        v_pass_threshold := COALESCE(v_cfg.pass_threshold_for_recovery, 3);
        v_throttle_mins  := COALESCE(v_cfg.alert_throttle_minutes, 60);
    END IF;

    v_previous_lifecycle := v_site.lifecycle_status;

    IF p_overall_passed = FALSE THEN
        -- Failure branch
        v_new_failures := v_site.consecutive_health_failures + 1;
        v_new_passes   := 0;

        IF v_new_failures >= 5 THEN
            v_new_health := 'down';
        ELSIF v_new_failures >= v_fail_threshold THEN
            v_new_health := 'degraded';
        ELSE
            v_new_health := v_site.health_status;
        END IF;

        -- Threshold reached: Auto-transition active -> degraded
        IF v_new_failures >= v_fail_threshold AND v_previous_lifecycle = 'active' THEN
            v_target_lifecycle := 'degraded';
            v_lifecycle_changed := TRUE;

            -- Update website lifecycle status
            UPDATE public.websites
            SET lifecycle_status = 'degraded'
            WHERE id = p_website_id;

            -- Event Sourcing Timeline
            INSERT INTO public.website_events (
                website_id, actor_role, event_type, old_status, new_status, notes, metadata
            ) VALUES (
                p_website_id, 'system', 'HEALTH_DEGRADATION',
                'active', 'degraded',
                format('Degradasi otomatis: %s kali gagal probe berturut-turut.', v_new_failures),
                jsonb_build_object(
                    'consecutive_failures', v_new_failures,
                    'probe_summary', p_summary_details,
                    'batch_id', p_batch_id
                )
            );

            -- Audit log
            INSERT INTO public.audit_logs (
                actor_role, action_type, resource_type, resource_id, old_value, new_value
            ) VALUES (
                'system', 'WEBSITE_DEGRADED_BY_HEALTH_PROBE', 'websites', p_website_id,
                jsonb_build_object('lifecycle_status', 'active', 'failures', v_site.consecutive_health_failures),
                jsonb_build_object('lifecycle_status', 'degraded', 'failures', v_new_failures, 'summary', p_summary_details)
            );

            -- Check alert throttle
            IF v_cfg.last_alert_sent_at IS NULL OR v_cfg.last_alert_sent_at < (NOW() - (v_throttle_mins || ' minutes')::INTERVAL) THEN
                v_send_alert := TRUE;
            END IF;

            IF v_send_alert THEN
                v_alert_text := format('[ALERT DEGRADED] Website %s (%s) mengalami %s kegagalan probe kesehatan berturut-turut. Lifecycle dialihkan otomatis ke DEGRADED!',
                                       v_site.website_code, COALESCE(v_site.domain, '-'), v_new_failures);

                INSERT INTO public.telegram_notification_log (
                    recipient_chat_id, message_text, context_type, context_id, status
                ) VALUES (
                    0, v_alert_text, 'website_health', v_site.website_code, 'queued'
                );

                -- Update config throttle
                IF FOUND THEN
                    UPDATE public.website_health_probe_configs
                    SET last_alert_sent_at = NOW()
                    WHERE website_id = p_website_id;
                END IF;
            END IF;
        END IF;

    ELSE
        -- Success branch
        v_new_passes   := v_site.consecutive_health_passes + 1;
        v_new_failures := 0;
        v_new_health   := 'healthy';

        -- Recovery threshold reached: Auto-recover degraded -> active
        IF v_new_passes >= v_pass_threshold AND v_previous_lifecycle = 'degraded' THEN
            v_target_lifecycle := 'active';
            v_lifecycle_changed := TRUE;

            -- Update website lifecycle status
            UPDATE public.websites
            SET lifecycle_status = 'active'
            WHERE id = p_website_id;

            -- Event Sourcing Timeline
            INSERT INTO public.website_events (
                website_id, actor_role, event_type, old_status, new_status, notes, metadata
            ) VALUES (
                p_website_id, 'system', 'HEALTH_RECOVERY',
                'degraded', 'active',
                format('Pemulihan otomatis: %s kali probe sukses berturut-turut.', v_new_passes),
                jsonb_build_object(
                    'consecutive_passes', v_new_passes,
                    'probe_summary', p_summary_details,
                    'batch_id', p_batch_id
                )
            );

            -- Audit log
            INSERT INTO public.audit_logs (
                actor_role, action_type, resource_type, resource_id, old_value, new_value
            ) VALUES (
                'system', 'WEBSITE_RECOVERED_BY_HEALTH_PROBE', 'websites', p_website_id,
                jsonb_build_object('lifecycle_status', 'degraded'),
                jsonb_build_object('lifecycle_status', 'active', 'consecutive_passes', v_new_passes)
            );

            -- Send Telegram recovery announcement
            v_alert_text := format('[ALERT RECOVERED] Website %s (%s) telah pulih setelah %s probe sukses berturut-turut. Lifecycle kembali ACTIVE.',
                                   v_site.website_code, COALESCE(v_site.domain, '-'), v_new_passes);

            INSERT INTO public.telegram_notification_log (
                recipient_chat_id, message_text, context_type, context_id, status
            ) VALUES (
                0, v_alert_text, 'website_health', v_site.website_code, 'queued'
            );
        END IF;
    END IF;

    -- Update website health counters
    UPDATE public.websites
    SET
        health_status = v_new_health,
        consecutive_health_failures = v_new_failures,
        consecutive_health_passes = v_new_passes,
        last_health_check_at = NOW(),
        last_health_failure_at = CASE WHEN p_overall_passed = FALSE THEN NOW() ELSE last_health_failure_at END,
        last_health_summary = p_summary_details,
        updated_at = NOW()
    WHERE id = p_website_id;

    RETURN jsonb_build_object(
        'success', true,
        'website_id', p_website_id,
        'website_code', v_site.website_code,
        'health_status', v_new_health,
        'consecutive_failures', v_new_failures,
        'consecutive_passes', v_new_passes,
        'lifecycle_status', COALESCE(v_target_lifecycle, v_previous_lifecycle),
        'lifecycle_changed', v_lifecycle_changed
    );
END;
$$;

-- 10. ATOMIC RPC: complete_health_probe_batch
CREATE OR REPLACE FUNCTION public.complete_health_probe_batch(
    p_batch_id BIGINT,
    p_healthy_count INT,
    p_degraded_count INT,
    p_failed_count INT,
    p_summary JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_batch RECORD;
    v_duration INT;
BEGIN
    SELECT * INTO v_batch
    FROM public.website_health_probe_batches
    WHERE id = p_batch_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', format('Batch %s not found', p_batch_id));
    END IF;

    v_duration := EXTRACT(EPOCH FROM (NOW() - v_batch.started_at)) * 1000;

    UPDATE public.website_health_probe_batches
    SET
        healthy_count = p_healthy_count,
        degraded_count = p_degraded_count,
        failed_count = p_failed_count,
        status = 'completed',
        completed_at = NOW(),
        duration_ms = v_duration,
        summary = p_summary,
        total_websites = (p_healthy_count + p_degraded_count + p_failed_count)
    WHERE id = p_batch_id;

    RETURN jsonb_build_object(
        'success', true,
        'batch_id', p_batch_id,
        'status', 'completed',
        'healthy', p_healthy_count,
        'degraded', p_degraded_count,
        'failed', p_failed_count,
        'duration_ms', v_duration,
        'completed_at', NOW()
    );
END;
$$;

-- 11. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.website_health_probe_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_health_probe_batches ENABLE ROW LEVEL SECURITY;

-- Service role unrestricted access
DROP POLICY IF EXISTS service_role_probe_configs ON public.website_health_probe_configs;
CREATE POLICY service_role_probe_configs ON public.website_health_probe_configs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_probe_batches ON public.website_health_probe_batches;
CREATE POLICY service_role_probe_batches ON public.website_health_probe_batches
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated operators with health.view can read configs
DROP POLICY IF EXISTS operator_read_probe_configs ON public.website_health_probe_configs;
CREATE POLICY operator_read_probe_configs ON public.website_health_probe_configs
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'health.view' OR da.role IN ('root', 'super_admin'))
        )
    );

-- Authenticated operators with health.view can read probe batches
DROP POLICY IF EXISTS operator_read_probe_batches ON public.website_health_probe_batches;
CREATE POLICY operator_read_probe_batches ON public.website_health_probe_batches
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'health.view' OR da.role IN ('root', 'super_admin'))
        )
    );
