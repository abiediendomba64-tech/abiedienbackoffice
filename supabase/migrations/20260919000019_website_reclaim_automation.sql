-- ====================================================================
-- MIGRATION: 20260919000019_website_reclaim_automation.sql
-- PHASE:      019 Website Reclaim & Expiry Automation
-- DESCRIPTION: Implements inactivity detection (7 days idle), 48-hour
--              grace period warning, automated cancel on financial activity,
--              snapshot archiving, and clean resource detachment on reclaim.
--              Features:
--                1. Capability registration (reclaim.view, reclaim.execute, reclaim.manage)
--                2. public.website_reclaim_events (Audit trail of warning & reclaim events)
--                3. public.website_reclaim_archives (Pre-reclaim configuration snapshots)
--                4. public.website_reclaim_batches (Runner / worker batch tracking)
--                5. Atomic RPCs:
--                   - evaluate_website_reclaim_eligibility (Scan idle sites & expire grace periods)
--                   - cancel_website_reclaim_warning (Auto/manual recovery from warning to active)
--                   - execute_reclaim_website (Archive snapshot, release domain, detach services)
--                6. Auto-recovery trigger: completed transactions cancel reclaim warning
--                7. RLS policies and capability gating
-- Conventions: pure ASCII, SECURITY DEFINER with search_path='',
--              fail-closed capability gate, immutable audit_logs,
--              and telegram_notification_log queue.
-- ====================================================================

-- 1. CAPABILITY REGISTRATION
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('reclaim.view',    'Melihat status antrean website idle dan peringatan penarikan', 'ops'),
('reclaim.execute', 'Menjalankan evaluasi batch atau penarikan manual website', 'ops'),
('reclaim.manage',  'Mengatur kebijakan ambang batas idle dan durasi grace period', 'ops')
ON CONFLICT (code) DO NOTHING;

-- Grant capabilities to operational roles
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'reclaim.%'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Admin role permissions
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('reclaim.view', 'reclaim.execute')
ON CONFLICT (role, capability_code) DO NOTHING;

-- Dev role permissions
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('reclaim.view')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. TABLE: website_reclaim_events (Audit Trail Riwayat Event Penarikan)
CREATE TABLE IF NOT EXISTS public.website_reclaim_events (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL REFERENCES public.websites(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    idle_days_detected INT NOT NULL DEFAULT 0,
    grace_hours_allotted INT NOT NULL DEFAULT 48,
    warning_deadline_at TIMESTAMPTZ,
    reason TEXT NOT NULL,
    actor_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_role VARCHAR(50) DEFAULT 'system',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_reclaim_event CHECK (event_type IN (
        'WARNING_ISSUED', 'WARNING_CANCELLED', 'SITE_RECLAIMED', 'GRACE_EXTENDED', 'RECLAIM_MANUAL_CANCEL'
    ))
);

CREATE INDEX IF NOT EXISTS idx_reclaim_events_site ON public.website_reclaim_events(website_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reclaim_events_type ON public.website_reclaim_events(event_type);

-- 3. TABLE: website_reclaim_archives (Arsip Snapshot Sebelum Domain Dilepas)
CREATE TABLE IF NOT EXISTS public.website_reclaim_archives (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL REFERENCES public.websites(id) ON DELETE CASCADE,
    website_code VARCHAR(50) NOT NULL,
    owner_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    domain VARCHAR(255),
    domain_inventory_id UUID REFERENCES public.domain_inventory(id) ON DELETE SET NULL,
    final_progress INT,
    total_active_days INT,
    theme VARCHAR(50),
    services_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    credentials_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    reclaimed_by_role VARCHAR(50) DEFAULT 'system',
    reclaimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reclaim_reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reclaim_archives_site ON public.website_reclaim_archives(website_id);
CREATE INDEX IF NOT EXISTS idx_reclaim_archives_domain ON public.website_reclaim_archives(domain);

-- 4. TABLE: website_reclaim_batches (Pelacak Eksekusi Cron Runner / Worker)
CREATE TABLE IF NOT EXISTS public.website_reclaim_batches (
    id BIGSERIAL PRIMARY KEY,
    batch_code VARCHAR(50) UNIQUE NOT NULL,
    evaluated_count INT NOT NULL DEFAULT 0,
    warnings_issued_count INT NOT NULL DEFAULT 0,
    reclaimed_count INT NOT NULL DEFAULT 0,
    cancelled_warnings_count INT NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms INT,
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT valid_reclaim_batch_status CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_reclaim_batches_code ON public.website_reclaim_batches(batch_code);
CREATE INDEX IF NOT EXISTS idx_reclaim_batches_status ON public.website_reclaim_batches(status);

-- 5. ATOMIC RPC: cancel_website_reclaim_warning (Pemulihan Reclaim Warning -> Active)
CREATE OR REPLACE FUNCTION public.cancel_website_reclaim_warning(
    p_website_id BIGINT,
    p_reason TEXT DEFAULT 'Aktivitas finansial atau perputaran terdeteksi',
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
    v_site RECORD;
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
                  AND bc.code = 'reclaim.execute'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks reclaim.execute capability', v_actor_role;
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

    -- Load site
    SELECT * INTO v_site
    FROM public.websites
    WHERE id = p_website_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', format('Website %s not found', p_website_id));
    END IF;

    IF v_site.lifecycle_status <> 'reclaim_warning' THEN
        RETURN jsonb_build_object('success', false, 'message', format('Website %s is not in reclaim_warning status (current: %s)', p_website_id, v_site.lifecycle_status));
    END IF;

    -- Update website state back to active and reset reclaim_at
    UPDATE public.websites
    SET
        lifecycle_status = 'active',
        reclaim_at = NULL,
        last_value_at = NOW(),
        updated_at = NOW()
    WHERE id = p_website_id;

    -- Immutable event sourcing
    INSERT INTO public.website_events (
        website_id, actor_id, actor_role, event_type, old_status, new_status, notes, metadata
    ) VALUES (
        p_website_id, v_actor_user_id, COALESCE(v_actor_role, 'system'),
        'RECLAIM_WARNING_CANCELLED', 'reclaim_warning', 'active', p_reason,
        jsonb_build_object('reason', p_reason)
    );

    -- Reclaim event record
    INSERT INTO public.website_reclaim_events (
        website_id, event_type, reason, actor_id, actor_role, metadata
    ) VALUES (
        p_website_id, 'WARNING_CANCELLED', p_reason,
        v_actor_user_id, COALESCE(v_actor_role, 'system'),
        jsonb_build_object('previous_reclaim_deadline', v_site.reclaim_at)
    );

    -- Audit log
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id, COALESCE(v_actor_role, 'system'),
        'WEBSITE_RECLAIM_WARNING_CANCELLED', 'websites', p_website_id,
        jsonb_build_object('lifecycle_status', 'reclaim_warning', 'reclaim_at', v_site.reclaim_at),
        jsonb_build_object('lifecycle_status', 'active', 'reclaim_at', NULL, 'reason', p_reason)
    );

    -- Telegram notification
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, context_type, context_id, status
    ) VALUES (
        0,
        format('[RECLAIM DIBATALKAN] Peringatan penarikan website %s (%s) telah dibatalkan. Status kembali ACTIVE. Alasan: %s.',
               v_site.website_code, COALESCE(v_site.domain, '-'), p_reason),
        'website_reclaim', v_site.website_code, 'queued'
    );

    RETURN jsonb_build_object(
        'success', true,
        'website_id', p_website_id,
        'website_code', v_site.website_code,
        'lifecycle_status', 'active',
        'reclaim_at', NULL,
        'restored_at', NOW()
    );
END;
$$;

-- 6. ATOMIC RPC: execute_reclaim_website (Arsipkan Snapshot & Lepas Domain)
CREATE OR REPLACE FUNCTION public.execute_reclaim_website(
    p_website_id BIGINT,
    p_reason TEXT DEFAULT 'Masa tenggang 48 jam berakhir tanpa aktivitas',
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
    v_site RECORD;
    v_services JSONB;
    v_credentials JSONB;
    v_active_days INT := 0;
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
                  AND bc.code = 'reclaim.execute'
           ) THEN
            RAISE EXCEPTION 'Access denied: role % lacks reclaim.execute capability', v_actor_role;
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

    -- Load site
    SELECT * INTO v_site
    FROM public.websites
    WHERE id = p_website_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', format('Website %s not found', p_website_id));
    END IF;

    -- Calculate active days
    IF v_site.activated_at IS NOT NULL THEN
        v_active_days := EXTRACT(DAY FROM (NOW() - v_site.activated_at))::INT;
    END IF;

    -- Collect services snapshot
    SELECT jsonb_agg(to_jsonb(s.*)) INTO v_services
    FROM public.website_services s
    WHERE s.website_id = p_website_id;

    -- Collect credentials snapshot
    SELECT to_jsonb(c.*) INTO v_credentials
    FROM public.website_credentials_ref c
    WHERE c.website_id = p_website_id;

    -- 1. Insert snapshot into website_reclaim_archives
    INSERT INTO public.website_reclaim_archives (
        website_id, website_code, owner_user_id, domain, domain_inventory_id,
        final_progress, total_active_days, theme, services_snapshot,
        credentials_snapshot, reclaimed_by_role, reclaim_reason
    ) VALUES (
        v_site.id, v_site.website_code, v_site.owner_user_id, v_site.domain, v_site.domain_inventory_id,
        v_site.progress, v_active_days, v_site.theme, COALESCE(v_services, '[]'::jsonb),
        COALESCE(v_credentials, '{}'::jsonb), COALESCE(v_actor_role, 'system'), p_reason
    );

    -- 2. Release domain in domain_inventory if linked
    IF v_site.domain_inventory_id IS NOT NULL THEN
        UPDATE public.domain_inventory
        SET status = 'available',
            updated_at = NOW()
        WHERE id = v_site.domain_inventory_id;
    END IF;

    -- 3. Mark services as detached
    UPDATE public.website_services
    SET status = 'detached',
        updated_at = NOW()
    WHERE website_id = p_website_id;

    -- 4. Transition website lifecycle to 'reclaimed'
    UPDATE public.websites
    SET
        lifecycle_status = 'reclaimed',
        domain = NULL,
        domain_inventory_id = NULL,
        reclaim_at = NOW(),
        updated_at = NOW()
    WHERE id = p_website_id;

    -- 5. Immutable event sourcing timeline
    INSERT INTO public.website_events (
        website_id, actor_id, actor_role, event_type, old_status, new_status, notes, metadata
    ) VALUES (
        p_website_id, v_actor_user_id, COALESCE(v_actor_role, 'system'),
        'SITE_RECLAIMED', v_site.lifecycle_status, 'reclaimed', p_reason,
        jsonb_build_object(
            'released_domain', v_site.domain,
            'active_days', v_active_days,
            'reason', p_reason
        )
    );

    -- 6. Reclaim event
    INSERT INTO public.website_reclaim_events (
        website_id, event_type, reason, actor_id, actor_role, metadata
    ) VALUES (
        p_website_id, 'SITE_RECLAIMED', p_reason,
        v_actor_user_id, COALESCE(v_actor_role, 'system'),
        jsonb_build_object('released_domain', v_site.domain)
    );

    -- 7. Audit log
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id, COALESCE(v_actor_role, 'system'),
        'WEBSITE_RECLAIMED', 'websites', p_website_id,
        jsonb_build_object('lifecycle_status', v_site.lifecycle_status, 'domain', v_site.domain),
        jsonb_build_object('lifecycle_status', 'reclaimed', 'released_domain', v_site.domain, 'reason', p_reason)
    );

    -- 8. Telegram priority notification
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, context_type, context_id, status
    ) VALUES (
        0,
        format('[RECLAIM SELESAI] Website %s (%s) telah resmi ditarik oleh sistem. Domain dilepas kembali ke pool inventaris dan konfigurasi telah diarsipkan.',
               v_site.website_code, COALESCE(v_site.domain, '-')),
        'website_reclaim', v_site.website_code, 'queued'
    );

    RETURN jsonb_build_object(
        'success', true,
        'website_id', p_website_id,
        'website_code', v_site.website_code,
        'lifecycle_status', 'reclaimed',
        'released_domain', v_site.domain,
        'reclaimed_at', NOW()
    );
END;
$$;

-- 7. ATOMIC RPC: evaluate_website_reclaim_eligibility (Runner Batch Evaluator)
CREATE OR REPLACE FUNCTION public.evaluate_website_reclaim_eligibility(
    p_dry_run BOOLEAN DEFAULT FALSE,
    p_actor_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_batch_id BIGINT;
    v_batch_code VARCHAR(50);
    v_site RECORD;
    v_rule RECORD;
    v_idle_days INT;
    v_idle_start TIMESTAMPTZ;
    v_threshold_days INT;
    v_grace_hours INT;
    v_evaluated_count INT := 0;
    v_warnings_issued INT := 0;
    v_reclaimed_count INT := 0;
    v_deadline TIMESTAMPTZ;
    v_start_time TIMESTAMPTZ := NOW();
    v_duration INT;
BEGIN
    -- Generate batch
    v_batch_code := 'RECLAIM-' || TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS') || '-' || LPAD(FLOOR(RANDOM() * 1000)::TEXT, 3, '0');

    INSERT INTO public.website_reclaim_batches (
        batch_code, status
    ) VALUES (
        v_batch_code, 'running'
    ) RETURNING id INTO v_batch_id;

    -- A. SCAN ACTIVE SITES FOR INACTIVITY (7 Days Idle)
    FOR v_site IN
        SELECT w.*
        FROM public.websites w
        WHERE w.lifecycle_status = 'active'
        FOR UPDATE
    LOOP
        v_evaluated_count := v_evaluated_count + 1;

        -- Load custom reclaim rule if exists
        SELECT * INTO v_rule
        FROM public.website_reclaim_rules
        WHERE website_id = v_site.id;

        v_threshold_days := COALESCE(v_rule.idle_threshold_days, 7);
        v_grace_hours    := COALESCE(v_rule.warning_grace_hours, 48);

        -- Inactivity anchor: last_value_at -> activated_at -> created_at
        v_idle_start := COALESCE(v_site.last_value_at, v_site.activated_at, v_site.created_at);
        v_idle_days  := EXTRACT(DAY FROM (NOW() - v_idle_start))::INT;

        -- If idle days exceeded threshold
        IF v_idle_days >= v_threshold_days THEN
            v_deadline := NOW() + (v_grace_hours || ' hours')::INTERVAL;

            IF NOT p_dry_run THEN
                -- Transition to reclaim_warning
                UPDATE public.websites
                SET
                    lifecycle_status = 'reclaim_warning',
                    reclaim_at = v_deadline,
                    updated_at = NOW()
                WHERE id = v_site.id;

                -- Record event timeline
                INSERT INTO public.website_events (
                    website_id, actor_role, event_type, old_status, new_status, notes, metadata
                ) VALUES (
                    v_site.id, 'system', 'RECLAIM_WARNING_ISSUED', 'active', 'reclaim_warning',
                    format('Website idle selama %s hari (ambang batas: %s hari). Masa tenggang %s jam diberikan.',
                           v_idle_days, v_threshold_days, v_grace_hours),
                    jsonb_build_object(
                        'idle_days', v_idle_days,
                        'deadline', v_deadline,
                        'batch_id', v_batch_id
                    )
                );

                -- Record reclaim event
                INSERT INTO public.website_reclaim_events (
                    website_id, event_type, idle_days_detected, grace_hours_allotted,
                    warning_deadline_at, reason, actor_role, metadata
                ) VALUES (
                    v_site.id, 'WARNING_ISSUED', v_idle_days, v_grace_hours,
                    v_deadline,
                    format('Inactivity threshold reached: %s days idle', v_idle_days),
                    'system',
                    jsonb_build_object('batch_id', v_batch_id)
                );

                -- Immutable audit log
                INSERT INTO public.audit_logs (
                    actor_role, action_type, resource_type, resource_id, old_value, new_value
                ) VALUES (
                    'system', 'WEBSITE_RECLAIM_WARNING_ISSUED', 'websites', v_site.id,
                    jsonb_build_object('lifecycle_status', 'active'),
                    jsonb_build_object('lifecycle_status', 'reclaim_warning', 'deadline', v_deadline, 'idle_days', v_idle_days)
                );

                -- Queue priority telegram warning alert
                INSERT INTO public.telegram_notification_log (
                    recipient_chat_id, message_text, context_type, context_id, status
                ) VALUES (
                    0,
                    format('[PERINGATAN RECLAIM] Website %s (%s) tidak memiliki perputaran selama %s hari. Masuk masa tenggang 48 jam sebelum ditarik!',
                           v_site.website_code, COALESCE(v_site.domain, '-'), v_idle_days),
                    'website_reclaim', v_site.website_code, 'queued'
                );
            END IF;

            v_warnings_issued := v_warnings_issued + 1;
        END IF;
    END LOOP;

    -- B. SCAN WARNING SITES FOR EXPIRED GRACE PERIOD (Grace period expired -> Reclaim)
    FOR v_site IN
        SELECT w.*
        FROM public.websites w
        WHERE w.lifecycle_status = 'reclaim_warning'
          AND w.reclaim_at IS NOT NULL
          AND w.reclaim_at <= NOW()
        FOR UPDATE
    LOOP
        v_evaluated_count := v_evaluated_count + 1;

        IF NOT p_dry_run THEN
            PERFORM public.execute_reclaim_website(
                v_site.id,
                'Masa tenggang 48 jam berakhir tanpa aktivitas perputaran dana',
                p_actor_id
            );
        END IF;

        v_reclaimed_count := v_reclaimed_count + 1;
    END LOOP;

    -- Finalize batch
    v_duration := EXTRACT(EPOCH FROM (NOW() - v_start_time)) * 1000;

    UPDATE public.website_reclaim_batches
    SET
        evaluated_count = v_evaluated_count,
        warnings_issued_count = v_warnings_issued,
        reclaimed_count = v_reclaimed_count,
        status = 'completed',
        completed_at = NOW(),
        duration_ms = v_duration,
        summary = jsonb_build_object(
            'dry_run', p_dry_run,
            'evaluated', v_evaluated_count,
            'warnings_issued', v_warnings_issued,
            'reclaimed', v_reclaimed_count
        )
    WHERE id = v_batch_id;

    RETURN jsonb_build_object(
        'success', true,
        'batch_id', v_batch_id,
        'batch_code', v_batch_code,
        'dry_run', p_dry_run,
        'evaluated_count', v_evaluated_count,
        'warnings_issued', v_warnings_issued,
        'reclaimed_count', v_reclaimed_count,
        'duration_ms', v_duration,
        'completed_at', NOW()
    );
END;
$$;

-- 8. TRIGGER: Auto-cancel reclaim warning when transactions complete
CREATE OR REPLACE FUNCTION public.trg_auto_cancel_reclaim_on_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Check if transaction has website_id, is completed, and website is in reclaim_warning
    IF NEW.status = 'completed' AND NEW.website_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.websites
            WHERE id = NEW.website_id AND lifecycle_status = 'reclaim_warning'
        ) THEN
            PERFORM public.cancel_website_reclaim_warning(
                NEW.website_id,
                format('Transaksi deposit/omzet berhasil dicatat [%s] sebesar Rp %s',
                       NEW.transaction_code, to_char(NEW.amount, 'FM999,999,999,990'))
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_auto_cancel_reclaim ON public.payment_transactions;
CREATE TRIGGER trg_payment_auto_cancel_reclaim
AFTER UPDATE OF status ON public.payment_transactions
FOR EACH ROW
WHEN (NEW.status = 'completed' AND NEW.website_id IS NOT NULL)
EXECUTE FUNCTION public.trg_auto_cancel_reclaim_on_transaction();

-- 9. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.website_reclaim_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_reclaim_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.website_reclaim_batches ENABLE ROW LEVEL SECURITY;

-- Service role unrestricted access
DROP POLICY IF EXISTS service_role_reclaim_events ON public.website_reclaim_events;
CREATE POLICY service_role_reclaim_events ON public.website_reclaim_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_reclaim_archives ON public.website_reclaim_archives;
CREATE POLICY service_role_reclaim_archives ON public.website_reclaim_archives
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_reclaim_batches ON public.website_reclaim_batches;
CREATE POLICY service_role_reclaim_batches ON public.website_reclaim_batches
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated operators with reclaim.view can read
DROP POLICY IF EXISTS operator_read_reclaim_events ON public.website_reclaim_events;
CREATE POLICY operator_read_reclaim_events ON public.website_reclaim_events
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'reclaim.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_reclaim_archives ON public.website_reclaim_archives;
CREATE POLICY operator_read_reclaim_archives ON public.website_reclaim_archives
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'reclaim.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_reclaim_batches ON public.website_reclaim_batches;
CREATE POLICY operator_read_reclaim_batches ON public.website_reclaim_batches
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'reclaim.view' OR da.role IN ('root', 'super_admin'))
        )
    );
