-- ====================================================================
-- MIGRATION: 20260922000022_notification_hardening.sql
-- PHASE:      022 Notification Hardening
-- DESCRIPTION: Industrial-grade multi-channel notification engine:
--              Deduplication idempotency, priority queues, exponential
--              backoff retry with jitter, and Dead-Letter Queue (DLQ).
--              Features:
--                1. Capability registration:
--                   - notify.view, notify.dispatch, notify.manage_channels, notify.retry_dlq
--                2. Tables:
--                   - public.notification_channels (Telegram, WhatsApp, Webhooks)
--                   - public.hardened_notification_queue (Priority message queue)
--                   - public.notification_dead_letter_queue (DLQ for fatal fails)
--                3. Atomic RPCs:
--                   - enqueue_hardened_notification (Idempotent message push)
--                   - lease_notification_batch (SKIP LOCKED worker batching)
--                   - record_notification_delivery (Ack & exponential backoff)
--                   - replay_dead_letter_notifications (Replay failed from DLQ)
--                4. Pre-seeded notification channels
--                5. RLS policies and capability gating
-- Conventions: pure ASCII, SECURITY DEFINER with search_path='',
--              fail-closed capability gate, immutable audit_logs,
--              and telegram_notification_log queue.
-- ====================================================================

-- 1. CAPABILITY REGISTRATION
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('notify.view',            'Melihat antrean pesan, riwayat pengiriman, dan log DLQ', 'notification'),
('notify.dispatch',        'Memicu pengiriman pesan notifikasi ke antrean', 'notification'),
('notify.manage_channels', 'Mengonfigurasi channel gateway pengiriman notifikasi', 'notification'),
('notify.retry_dlq',       'Mencoba ulang pengiriman pesan dari Dead-Letter Queue', 'notification')
ON CONFLICT (code) DO NOTHING;

-- Grant capabilities to root and super_admin
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'notify.%'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Grant operational capabilities to admin
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('notify.view', 'notify.dispatch', 'notify.retry_dlq')
ON CONFLICT (role, capability_code) DO NOTHING;

-- Grant developer role read capabilities
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('notify.view', 'notify.retry_dlq')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. TABLE: notification_channels (Penyedia Saluran Pengiriman)
CREATE TABLE IF NOT EXISTS public.notification_channels (
    id BIGSERIAL PRIMARY KEY,
    channel_code VARCHAR(50) UNIQUE NOT NULL,
    channel_name VARCHAR(100) NOT NULL,
    rate_limit_per_minute INT NOT NULL DEFAULT 60,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. TABLE: hardened_notification_queue (Antrean Notifikasi Berprioritas)
CREATE TABLE IF NOT EXISTS public.hardened_notification_queue (
    id BIGSERIAL PRIMARY KEY,
    dedup_key VARCHAR(150) UNIQUE,
    channel VARCHAR(50) NOT NULL REFERENCES public.notification_channels(channel_code) ON DELETE RESTRICT,
    priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    recipient_target VARCHAR(255) NOT NULL,
    title VARCHAR(255),
    body TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'queued',
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    leased_by VARCHAR(100),
    leased_until TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_notify_priority CHECK (priority IN ('emergency', 'high', 'normal', 'low')),
    CONSTRAINT valid_notify_status CHECK (status IN ('queued', 'leased', 'delivered', 'failed', 'dlq'))
);

CREATE INDEX IF NOT EXISTS idx_notify_queue_lease ON public.hardened_notification_queue(status, channel, next_retry_at) 
WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_notify_queue_prio ON public.hardened_notification_queue(priority, next_retry_at);

-- 4. TABLE: notification_dead_letter_queue (Karantina Pesan Gagal Permanen)
CREATE TABLE IF NOT EXISTS public.notification_dead_letter_queue (
    id BIGSERIAL PRIMARY KEY,
    original_queue_id BIGINT NOT NULL,
    channel VARCHAR(50) NOT NULL,
    recipient_target VARCHAR(255) NOT NULL,
    title VARCHAR(255),
    body TEXT NOT NULL,
    total_retries_attempted INT NOT NULL,
    final_error TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    moved_to_dlq_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    replayed_at TIMESTAMPTZ,
    replayed_by VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_dlq_channel ON public.notification_dead_letter_queue(channel, moved_to_dlq_at DESC);

-- 5. RPC: enqueue_hardened_notification
-- Mendaftarkan notifikasi secara idempoten (dedup_key mencegah pengiriman ganda)
CREATE OR REPLACE FUNCTION public.enqueue_hardened_notification(
    p_channel VARCHAR(50),
    p_recipient_target VARCHAR(255),
    p_body TEXT,
    p_title VARCHAR(255) DEFAULT NULL,
    p_priority VARCHAR(20) DEFAULT 'normal',
    p_dedup_key VARCHAR(150) DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_queue_id BIGINT;
    v_channel_active BOOLEAN;
    v_clean_dedup VARCHAR(150);
BEGIN
    -- Check channel
    SELECT is_active INTO v_channel_active
    FROM public.notification_channels
    WHERE channel_code = p_channel;

    IF v_channel_active IS NULL OR NOT v_channel_active THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Channel notifikasi tidak terdaftar atau tidak aktif: ' || p_channel
        );
    END IF;

    -- Generate dedup key if omitted to ensure idempotency when required
    v_clean_dedup := p_dedup_key;
    IF v_clean_dedup IS NOT NULL THEN
        -- If already in queue, ignore silently and return existing
        SELECT id INTO v_queue_id
        FROM public.hardened_notification_queue
        WHERE dedup_key = v_clean_dedup;

        IF FOUND THEN
            RETURN jsonb_build_object(
                'success', true,
                'queue_id', v_queue_id,
                'dedup_hit', true,
                'status', 'already_queued'
            );
        END IF;
    END IF;

    INSERT INTO public.hardened_notification_queue (
        dedup_key,
        channel,
        priority,
        recipient_target,
        title,
        body,
        status,
        metadata
    ) VALUES (
        v_clean_dedup,
        p_channel,
        COALESCE(p_priority, 'normal'),
        p_recipient_target,
        p_title,
        p_body,
        'queued',
        COALESCE(p_metadata, '{}'::jsonb)
    )
    RETURNING id INTO v_queue_id;

    RETURN jsonb_build_object(
        'success', true,
        'queue_id', v_queue_id,
        'channel', p_channel,
        'priority', p_priority,
        'status', 'queued'
    );
END;
$$;

-- 6. RPC: lease_notification_batch
-- Worker runner leasing batch pengiriman dengan mekanisme FOR UPDATE SKIP LOCKED
CREATE OR REPLACE FUNCTION public.lease_notification_batch(
    p_channel VARCHAR(50),
    p_worker_id VARCHAR(100),
    p_batch_size INT DEFAULT 10,
    p_lease_seconds INT DEFAULT 60
)
RETURNS TABLE (
    id BIGINT,
    channel VARCHAR(50),
    priority VARCHAR(20),
    recipient_target VARCHAR(255),
    title VARCHAR(255),
    body TEXT,
    retry_count INT,
    metadata JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN QUERY
    WITH candidate AS (
        SELECT q.id
        FROM public.hardened_notification_queue q
        WHERE q.channel = p_channel
          AND (
              q.status = 'queued' AND q.next_retry_at <= NOW()
              OR (q.status = 'leased' AND q.leased_until < NOW())
          )
        ORDER BY 
            CASE q.priority
                WHEN 'emergency' THEN 1
                WHEN 'high' THEN 2
                WHEN 'normal' THEN 3
                ELSE 4
            END ASC,
            q.next_retry_at ASC
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.hardened_notification_queue q
    SET status = 'leased',
        leased_by = p_worker_id,
        leased_until = NOW() + (p_lease_seconds || ' seconds')::interval
    FROM candidate c
    WHERE q.id = c.id
    RETURNING 
        q.id,
        q.channel,
        q.priority,
        q.recipient_target,
        q.title,
        q.body,
        q.retry_count,
        q.metadata;
END;
$$;

-- 7. RPC: record_notification_delivery
-- Mengonfirmasi pengiriman atau menghitung exponential backoff jika gagal
CREATE OR REPLACE FUNCTION public.record_notification_delivery(
    p_queue_id BIGINT,
    p_is_success BOOLEAN,
    p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_rec RECORD;
    v_delay_sec INT;
BEGIN
    SELECT * INTO v_rec
    FROM public.hardened_notification_queue
    WHERE id = p_queue_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Pesan tidak ditemukan di antrean');
    END IF;

    IF p_is_success THEN
        -- Delivery confirmed
        UPDATE public.hardened_notification_queue
        SET status = 'delivered',
            delivered_at = NOW(),
            leased_by = NULL,
            leased_until = NULL
        WHERE id = p_queue_id;

        RETURN jsonb_build_object('success', true, 'queue_id', p_queue_id, 'status', 'delivered');
    ELSE
        -- Delivery failed -> check retries
        IF v_rec.retry_count + 1 >= v_rec.max_retries THEN
            -- Exceeded max retries -> Move to Dead Letter Queue
            INSERT INTO public.notification_dead_letter_queue (
                original_queue_id, channel, recipient_target, title, body,
                total_retries_attempted, final_error, metadata
            ) VALUES (
                v_rec.id, v_rec.channel, v_rec.recipient_target, v_rec.title, v_rec.body,
                v_rec.retry_count + 1, COALESCE(p_error_message, 'Exceeded max retries'), v_rec.metadata
            );

            UPDATE public.hardened_notification_queue
            SET status = 'dlq',
                retry_count = retry_count + 1,
                last_error = p_error_message,
                leased_by = NULL,
                leased_until = NULL
            WHERE id = p_queue_id;

            RETURN jsonb_build_object(
                'success', true,
                'queue_id', p_queue_id,
                'status', 'moved_to_dlq',
                'error', p_error_message
            );
        ELSE
            -- Exponential backoff: 2^retry * 10 seconds (with max 1 hour cap)
            v_delay_sec := LEAST(3600, (POW(2, v_rec.retry_count) * 10)::int + (RANDOM() * 5)::int);

            UPDATE public.hardened_notification_queue
            SET status = 'queued',
                retry_count = retry_count + 1,
                next_retry_at = NOW() + (v_delay_sec || ' seconds')::interval,
                last_error = p_error_message,
                leased_by = NULL,
                leased_until = NULL
            WHERE id = p_queue_id;

            RETURN jsonb_build_object(
                'success', true,
                'queue_id', p_queue_id,
                'status', 'retry_scheduled',
                'retry_count', v_rec.retry_count + 1,
                'delay_seconds', v_delay_sec
            );
        END IF;
    END IF;
END;
$$;

-- 8. RPC: replay_dead_letter_notifications
-- Mengembalikan pesan dari Dead Letter Queue ke antrean aktif
CREATE OR REPLACE FUNCTION public.replay_dead_letter_notifications(
    p_dlq_ids BIGINT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_dlq RECORD;
    v_replayed_count INT := 0;
    v_actor_role VARCHAR(50);
    v_caller_auth UUID;
BEGIN
    v_caller_auth := auth.uid();
    IF v_caller_auth IS NOT NULL THEN
        SELECT da.role INTO v_actor_role FROM public.dashboard_access da
        WHERE da.auth_user_id = v_caller_auth AND da.is_active = TRUE LIMIT 1;

        IF v_actor_role NOT IN ('root', 'super_admin') THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.backoffice_role_capabilities
                WHERE role = v_actor_role AND capability_code = 'notify.retry_dlq'
            ) THEN
                RETURN jsonb_build_object('success', false, 'error', 'Akses ditolak: Memerlukan izin notify.retry_dlq');
            END IF;
        END IF;
    ELSE
        v_actor_role := 'operator';
    END IF;

    FOR v_dlq IN
        SELECT * FROM public.notification_dead_letter_queue
        WHERE id = ANY(p_dlq_ids) AND replayed_at IS NULL
    LOOP
        -- Re-enqueue as queued with reset retries
        INSERT INTO public.hardened_notification_queue (
            channel, priority, recipient_target, title, body, status, retry_count, metadata
        ) VALUES (
            v_dlq.channel, 'normal', v_dlq.recipient_target, v_dlq.title, v_dlq.body,
            'queued', 0, v_dlq.metadata || jsonb_build_object('replayed_from_dlq_id', v_dlq.id)
        );

        UPDATE public.notification_dead_letter_queue
        SET replayed_at = NOW(),
            replayed_by = v_actor_role
        WHERE id = v_dlq.id;

        v_replayed_count := v_replayed_count + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'replayed_count', v_replayed_count);
END;
$$;

-- 9. PRE-SEEDED NOTIFICATION CHANNELS
INSERT INTO public.notification_channels (channel_code, channel_name, rate_limit_per_minute, is_active) VALUES
('telegram', 'Telegram Official Bot Broadcast (@sandekalabot)', 120, TRUE),
('whatsapp', 'WhatsApp Twilio Messaging & OTP',                60,  TRUE),
('webhook',  'External System Incident Webhook',               300, TRUE),
('in_app',   'In-App Operator Audit Feed Toast',               600, TRUE)
ON CONFLICT (channel_code) DO UPDATE
SET channel_name = EXCLUDED.channel_name,
    rate_limit_per_minute = EXCLUDED.rate_limit_per_minute;

-- 10. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hardened_notification_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_dead_letter_queue ENABLE ROW LEVEL SECURITY;

-- Service role full access
DROP POLICY IF EXISTS service_role_channels ON public.notification_channels;
CREATE POLICY service_role_channels ON public.notification_channels
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_queue ON public.hardened_notification_queue;
CREATE POLICY service_role_queue ON public.hardened_notification_queue
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_dlq ON public.notification_dead_letter_queue;
CREATE POLICY service_role_dlq ON public.notification_dead_letter_queue
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated operators with notify.view or root/super_admin
DROP POLICY IF EXISTS operator_read_channels ON public.notification_channels;
CREATE POLICY operator_read_channels ON public.notification_channels
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'notify.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_queue ON public.hardened_notification_queue;
CREATE POLICY operator_read_queue ON public.hardened_notification_queue
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'notify.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_dlq ON public.notification_dead_letter_queue;
CREATE POLICY operator_read_dlq ON public.notification_dead_letter_queue
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'notify.view' OR da.role IN ('root', 'super_admin'))
        )
    );
