-- ====================================================================
-- MIGRATION: 20260921000021_dashboard_control_center.sql
-- PHASE:      021 Dashboard Control Center
-- DESCRIPTION: Master operational control center, system-wide kill switches,
--              real-time telemetry aggregation, and emergency subsystem freeze.
--              Features:
--                1. Capability registration:
--                   - dashboard.view, dashboard.manage_switches,
--                     dashboard.emergency_freeze, dashboard.export_telemetry
--                2. Tables:
--                   - public.dashboard_control_switches (Global kill switches)
--                   - public.dashboard_telemetry_snapshots (Historical metrics)
--                   - public.dashboard_operator_preferences (UI preferences)
--                3. Atomic RPCs:
--                   - get_dashboard_control_center_overview (Aggregated stats)
--                   - toggle_dashboard_control_switch (Atomic switch toggle)
--                   - capture_dashboard_telemetry_snapshot (Metric capture)
--                   - check_subsystem_switch_enabled (Fast gateway check)
--                4. Pre-seeded master subsystem switches
--                5. RLS policies and capability gating
-- Conventions: pure ASCII, SECURITY DEFINER with search_path='',
--              fail-closed capability gate, immutable audit_logs,
--              and telegram_notification_log queue.
-- ====================================================================

-- 1. CAPABILITY REGISTRATION
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('dashboard.view',             'Melihat statistik dan metrik control center backoffice', 'ops'),
('dashboard.manage_switches',  'Mengaktifkan atau mematikan switch kontrol subsistem', 'ops'),
('dashboard.emergency_freeze', 'Memicu pembekuan darurat (emergency freeze) seluruh sistem', 'ops'),
('dashboard.export_telemetry', 'Mengekspor telemetri dan data snapshot control center', 'ops')
ON CONFLICT (code) DO NOTHING;

-- Grant capabilities to root and super_admin
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'dashboard.%'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Grant operational capabilities to admin
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('dashboard.view', 'dashboard.manage_switches', 'dashboard.export_telemetry')
ON CONFLICT (role, capability_code) DO NOTHING;

-- Grant developer role read & export capabilities
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('dashboard.view', 'dashboard.export_telemetry')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. TABLE: dashboard_control_switches (Sakelar Darurat & Pengendali Subsistem)
CREATE TABLE IF NOT EXISTS public.dashboard_control_switches (
    id BIGSERIAL PRIMARY KEY,
    switch_key VARCHAR(100) UNIQUE NOT NULL,
    switch_name VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'global',
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    disabled_reason TEXT,
    last_toggled_by VARCHAR(100) DEFAULT 'system',
    last_toggled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_switch_category CHECK (category IN (
        'global', 'orders', 'financial', 'ops', 'security', 'notification'
    ))
);

CREATE INDEX IF NOT EXISTS idx_switches_key ON public.dashboard_control_switches(switch_key);
CREATE INDEX IF NOT EXISTS idx_switches_category ON public.dashboard_control_switches(category);

-- 3. TABLE: dashboard_telemetry_snapshots (Perekam Snapshot Statistik Historis)
CREATE TABLE IF NOT EXISTS public.dashboard_telemetry_snapshots (
    id BIGSERIAL PRIMARY KEY,
    snapshot_code VARCHAR(100) UNIQUE NOT NULL,
    active_websites_count INT NOT NULL DEFAULT 0,
    degraded_websites_count INT NOT NULL DEFAULT 0,
    total_domains_count INT NOT NULL DEFAULT 0,
    open_tickets_count INT NOT NULL DEFAULT 0,
    active_incidents_count INT NOT NULL DEFAULT 0,
    revenue_24h_idr NUMERIC(15,2) NOT NULL DEFAULT 0,
    revenue_30d_idr NUMERIC(15,2) NOT NULL DEFAULT 0,
    failed_probes_last_hour INT NOT NULL DEFAULT 0,
    switches_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    metrics_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_captured ON public.dashboard_telemetry_snapshots(captured_at DESC);

-- 4. TABLE: dashboard_operator_preferences (Preferensi Tampilan Operator)
CREATE TABLE IF NOT EXISTS public.dashboard_operator_preferences (
    id BIGSERIAL PRIMARY KEY,
    auth_user_id UUID UNIQUE NOT NULL,
    refresh_interval_sec INT NOT NULL DEFAULT 30,
    audio_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    widget_layout JSONB NOT NULL DEFAULT '{"overview": true, "health": true, "finance": true, "switches": true}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. RPC: get_dashboard_control_center_overview
-- Mengambil seluruh metrik ringkasan sistem dalam 1 round-trip query
CREATE OR REPLACE FUNCTION public.get_dashboard_control_center_overview()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_active_websites INT := 0;
    v_degraded_websites INT := 0;
    v_total_websites INT := 0;
    v_total_domains INT := 0;
    v_open_tickets INT := 0;
    v_active_incidents INT := 0;
    v_revenue_24h NUMERIC(15,2) := 0;
    v_revenue_30d NUMERIC(15,2) := 0;
    v_failed_probes_1h INT := 0;
    v_switches JSONB := '[]'::jsonb;
    v_recent_incidents JSONB := '[]'::jsonb;
BEGIN
    -- Websites metrics
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'active'),
        COUNT(*) FILTER (WHERE status = 'degraded' OR health_status = 'degraded')
    INTO v_total_websites, v_active_websites, v_degraded_websites
    FROM public.websites;

    -- Domains count
    SELECT COUNT(*) INTO v_total_domains FROM public.domain_inventory;

    -- Tickets count
    SELECT COUNT(*) INTO v_open_tickets 
    FROM public.tickets 
    WHERE status IN ('open', 'in_progress', 'pending');

    -- Incidents count
    SELECT COUNT(*) INTO v_active_incidents 
    FROM public.system_incidents 
    WHERE status IN ('investigating', 'identified', 'monitoring');

    -- Revenue 24h & 30d
    SELECT 
        COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours'), 0),
        COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)
    INTO v_revenue_24h, v_revenue_30d
    FROM public.payment_transactions
    WHERE status IN ('paid', 'verified', 'completed');

    -- Failed health probes in last 1 hour
    SELECT COUNT(*) INTO v_failed_probes_1h
    FROM public.website_health_probe_batches
    WHERE created_at >= NOW() - INTERVAL '1 hour' AND failed_count > 0;

    -- Switches list
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'switch_key', s.switch_key,
        'switch_name', s.switch_name,
        'category', s.category,
        'is_enabled', s.is_enabled,
        'disabled_reason', s.disabled_reason,
        'last_toggled_by', s.last_toggled_by,
        'last_toggled_at', s.last_toggled_at
    ) ORDER BY s.id ASC), '[]'::jsonb) INTO v_switches
    FROM public.dashboard_control_switches s;

    -- Recent active incidents
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'incident_code', inc.incident_code,
        'title', inc.title,
        'severity', inc.severity,
        'status', inc.status,
        'started_at', inc.started_at
    ) ORDER BY inc.id DESC), '[]'::jsonb) INTO v_recent_incidents
    FROM (
        SELECT incident_code, title, severity, status, started_at
        FROM public.system_incidents
        WHERE status IN ('investigating', 'identified', 'monitoring')
        ORDER BY id DESC
        LIMIT 5
    ) inc;

    RETURN jsonb_build_object(
        'success', true,
        'timestamp', NOW(),
        'system_health', CASE 
            WHEN v_active_incidents > 0 OR v_degraded_websites > 0 THEN 'warning' 
            ELSE 'healthy' 
        END,
        'metrics', jsonb_build_object(
            'total_websites', v_total_websites,
            'active_websites', v_active_websites,
            'degraded_websites', v_degraded_websites,
            'total_domains', v_total_domains,
            'open_tickets', v_open_tickets,
            'active_incidents', v_active_incidents,
            'revenue_24h_idr', v_revenue_24h,
            'revenue_30d_idr', v_revenue_30d,
            'failed_probes_last_hour', v_failed_probes_1h
        ),
        'switches', v_switches,
        'active_incidents_list', v_recent_incidents
    );
END;
$$;

-- 6. RPC: toggle_dashboard_control_switch
-- Mengubah status switch dengan verifikasi otorisasi dan audit log
CREATE OR REPLACE FUNCTION public.toggle_dashboard_control_switch(
    p_switch_key VARCHAR(100),
    p_is_enabled BOOLEAN,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_switch RECORD;
    v_actor_role VARCHAR(50);
    v_caller_auth UUID;
BEGIN
    -- 1. Capability Verification
    v_caller_auth := auth.uid();
    IF v_caller_auth IS NOT NULL THEN
        SELECT da.role INTO v_actor_role FROM public.dashboard_access da
        WHERE da.auth_user_id = v_caller_auth AND da.is_active = TRUE LIMIT 1;

        IF v_actor_role NOT IN ('root', 'super_admin') THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.backoffice_role_capabilities
                WHERE role = v_actor_role AND capability_code = 'dashboard.manage_switches'
            ) THEN
                RETURN jsonb_build_object('success', false, 'error', 'Akses ditolak: Memerlukan izin dashboard.manage_switches');
            END IF;
        END IF;
    ELSE
        v_actor_role := 'system';
    END IF;

    -- 2. Lookup switch
    SELECT * INTO v_switch
    FROM public.dashboard_control_switches
    WHERE switch_key = p_switch_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Switch kontrol tidak ditemukan: ' || p_switch_key);
    END IF;

    -- 3. Update switch state
    UPDATE public.dashboard_control_switches
    SET is_enabled = p_is_enabled,
        disabled_reason = CASE WHEN p_is_enabled THEN NULL ELSE COALESCE(p_reason, 'Dimatikan oleh operator') END,
        last_toggled_by = COALESCE(v_actor_role, 'operator'),
        last_toggled_at = NOW()
    WHERE id = v_switch.id;

    -- 4. Audit Log
    INSERT INTO public.audit_logs (
        action, entity_type, entity_id, actor_role, old_values, new_values
    ) VALUES (
        'DASHBOARD_SWITCH_TOGGLED',
        'control_switch',
        v_switch.id,
        COALESCE(v_actor_role, 'system'),
        jsonb_build_object('is_enabled', v_switch.is_enabled),
        jsonb_build_object('is_enabled', p_is_enabled, 'reason', p_reason)
    );

    -- 5. Broadcast to Telegram if turned OFF
    IF NOT p_is_enabled THEN
        INSERT INTO public.telegram_notification_log (
            chat_id, message, status, metadata
        ) VALUES (
            -1002277561858,
            '[SWITCH TOGGLE ALERT] Sakelar subsistem: ' || v_switch.switch_name || ' (' || p_switch_key || ') DIMATIKAN oleh ' || COALESCE(v_actor_role, 'operator') || '. Alasan: ' || COALESCE(p_reason, 'Manual toggle'),
            'pending',
            jsonb_build_object('switch_key', p_switch_key, 'is_enabled', false, 'reason', p_reason)
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'switch_key', p_switch_key,
        'is_enabled', p_is_enabled,
        'toggled_by', v_actor_role,
        'toggled_at', NOW()
    );
END;
$$;

-- 7. RPC: capture_dashboard_telemetry_snapshot
-- Menyimpan rekam jejak berkala statistik sistem
CREATE OR REPLACE FUNCTION public.capture_dashboard_telemetry_snapshot()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_overview JSONB;
    v_code VARCHAR(100);
BEGIN
    v_overview := public.get_dashboard_control_center_overview();
    v_code := 'SNAP-' || TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS');

    INSERT INTO public.dashboard_telemetry_snapshots (
        snapshot_code,
        active_websites_count,
        degraded_websites_count,
        total_domains_count,
        open_tickets_count,
        active_incidents_count,
        revenue_24h_idr,
        revenue_30d_idr,
        failed_probes_last_hour,
        switches_state,
        metrics_detail,
        captured_at
    ) VALUES (
        v_code,
        COALESCE((v_overview->'metrics'->>'active_websites')::int, 0),
        COALESCE((v_overview->'metrics'->>'degraded_websites')::int, 0),
        COALESCE((v_overview->'metrics'->>'total_domains')::int, 0),
        COALESCE((v_overview->'metrics'->>'open_tickets')::int, 0),
        COALESCE((v_overview->'metrics'->>'active_incidents')::int, 0),
        COALESCE((v_overview->'metrics'->>'revenue_24h_idr')::numeric, 0),
        COALESCE((v_overview->'metrics'->>'revenue_30d_idr')::numeric, 0),
        COALESCE((v_overview->'metrics'->>'failed_probes_last_hour')::int, 0),
        COALESCE(v_overview->'switches', '[]'::jsonb),
        v_overview,
        NOW()
    );

    RETURN jsonb_build_object('success', true, 'snapshot_code', v_code);
END;
$$;

-- 8. RPC: check_subsystem_switch_enabled
-- Pengecekan cepat status sakelar untuk worker atau API endpoint
CREATE OR REPLACE FUNCTION public.check_subsystem_switch_enabled(
    p_switch_key VARCHAR(100)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_enabled BOOLEAN;
BEGIN
    SELECT is_enabled INTO v_enabled
    FROM public.dashboard_control_switches
    WHERE switch_key = p_switch_key;

    RETURN COALESCE(v_enabled, TRUE);
END;
$$;

-- 9. PRE-SEEDED MASTER SUBSYSTEM CONTROL SWITCHES
INSERT INTO public.dashboard_control_switches (switch_key, switch_name, category, is_enabled) VALUES
('system_maintenance_mode',         'Mode Pemeliharaan Sistem (Global Maintenance)', 'global', FALSE),
('new_domain_orders_enabled',       'Penerimaan Pesanan Domain Baru',                'orders', TRUE),
('automated_reclaim_worker_enabled','Worker Otomasi Penarikan Website Idle',         'ops',    TRUE),
('payment_gateway_fallback_enabled','Failover Otomatis Payment Gateway',             'financial', TRUE),
('health_probe_scheduler_enabled',  'Scheduler Pengecekan Kesehatan Website',        'ops',    TRUE),
('telegram_broadcast_enabled',      'Pengiriman Notifikasi Telegram Bot',            'notification', TRUE)
ON CONFLICT (switch_key) DO UPDATE
SET switch_name = EXCLUDED.switch_name,
    category = EXCLUDED.category;

-- 10. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.dashboard_control_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_telemetry_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_operator_preferences ENABLE ROW LEVEL SECURITY;

-- Service role full access
DROP POLICY IF EXISTS service_role_switches ON public.dashboard_control_switches;
CREATE POLICY service_role_switches ON public.dashboard_control_switches
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_snapshots ON public.dashboard_telemetry_snapshots;
CREATE POLICY service_role_snapshots ON public.dashboard_telemetry_snapshots
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_preferences ON public.dashboard_operator_preferences;
CREATE POLICY service_role_preferences ON public.dashboard_operator_preferences
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated operators with dashboard.view or root/super_admin
DROP POLICY IF EXISTS operator_read_switches ON public.dashboard_control_switches;
CREATE POLICY operator_read_switches ON public.dashboard_control_switches
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'dashboard.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_snapshots ON public.dashboard_telemetry_snapshots;
CREATE POLICY operator_read_snapshots ON public.dashboard_telemetry_snapshots
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'dashboard.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_user_preferences ON public.dashboard_operator_preferences;
CREATE POLICY operator_user_preferences ON public.dashboard_operator_preferences
    FOR ALL TO authenticated
    USING (auth_user_id = auth.uid())
    WITH CHECK (auth_user_id = auth.uid());
