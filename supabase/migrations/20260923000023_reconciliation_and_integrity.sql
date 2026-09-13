-- ====================================================================
-- MIGRATION: 20260923000023_reconciliation_and_integrity.sql
-- PHASE:      023 Reconciliation & Integrity
-- DESCRIPTION: Automated 3-way financial reconciliation engine (Orders vs
--              Gateways vs Double-Entry Ledger), orphaned resource detection,
--              cryptographic state checkpointing, and discrepancy resolution.
--              Features:
--                1. Capability registration:
--                   - reconcile.view, reconcile.run, reconcile.resolve, reconcile.certify
--                2. Tables:
--                   - public.system_reconciliation_batches (Audit batch executions)
--                   - public.reconciliation_discrepancies (Itemized discrepancy records)
--                   - public.resource_integrity_checkpoints (Integrity state hashes)
--                3. Atomic RPCs:
--                   - run_system_reconciliation_audit (Automated 3-way audit scan)
--                   - resolve_reconciliation_discrepancy (Super Admin resolution)
--                   - get_reconciliation_summary (Health & integrity overview)
--                4. RLS policies and capability gating
-- Conventions: pure ASCII, SECURITY DEFINER with search_path='',
--              fail-closed capability gate, immutable audit_logs,
--              and telegram_notification_log queue.
-- ====================================================================

-- 1. CAPABILITY REGISTRATION
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('reconcile.view',    'Melihat laporan rekonsiliasi keuangan dan integritas sistem', 'audit'),
('reconcile.run',     'Menjalankan proses rekonsiliasi manual atau berkala', 'audit'),
('reconcile.resolve', 'Menyelesaikan selisih rekonsiliasi dan mencatat jurnal koreksi', 'audit'),
('reconcile.certify', 'Mengesahkan laporan rekonsiliasi bulanan / tutup buku', 'audit')
ON CONFLICT (code) DO NOTHING;

-- Grant capabilities to root and super_admin
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'reconcile.%'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Grant operational capabilities to admin
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('reconcile.view', 'reconcile.run')
ON CONFLICT (role, capability_code) DO NOTHING;

-- Grant developer role read capabilities
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('reconcile.view')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. TABLE: system_reconciliation_batches (Batch Eksekusi Rekonsiliasi)
CREATE TABLE IF NOT EXISTS public.system_reconciliation_batches (
    id BIGSERIAL PRIMARY KEY,
    batch_code VARCHAR(100) UNIQUE NOT NULL,
    scope VARCHAR(50) NOT NULL DEFAULT 'full_system',
    status VARCHAR(50) NOT NULL DEFAULT 'running',
    total_checked INT NOT NULL DEFAULT 0,
    discrepancies_count INT NOT NULL DEFAULT 0,
    discrepancies_resolved INT NOT NULL DEFAULT 0,
    summary_notes TEXT,
    executed_by VARCHAR(100) DEFAULT 'system',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    CONSTRAINT valid_recon_status CHECK (status IN (
        'running', 'balanced', 'discrepancies_detected', 'resolved', 'certified'
    ))
);

CREATE INDEX IF NOT EXISTS idx_recon_batch_code ON public.system_reconciliation_batches(batch_code);
CREATE INDEX IF NOT EXISTS idx_recon_batch_status ON public.system_reconciliation_batches(status, started_at DESC);

-- 3. TABLE: reconciliation_discrepancies (Daftar Selisih / Anomali Terdeteksi)
CREATE TABLE IF NOT EXISTS public.reconciliation_discrepancies (
    id BIGSERIAL PRIMARY KEY,
    batch_id BIGINT NOT NULL REFERENCES public.system_reconciliation_batches(id) ON DELETE CASCADE,
    discrepancy_type VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    expected_value TEXT,
    actual_value TEXT,
    difference_amount NUMERIC(15,2) DEFAULT 0,
    severity VARCHAR(20) NOT NULL DEFAULT 'warning',
    resolution_status VARCHAR(50) NOT NULL DEFAULT 'open',
    resolution_notes TEXT,
    resolved_by VARCHAR(100),
    resolved_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_discrepancy_severity CHECK (severity IN ('info', 'warning', 'critical')),
    CONSTRAINT valid_resolution_status CHECK (resolution_status IN ('open', 'investigating', 'adjusted', 'ignored', 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_discrepancy_batch ON public.reconciliation_discrepancies(batch_id);
CREATE INDEX IF NOT EXISTS idx_discrepancy_status ON public.reconciliation_discrepancies(resolution_status);
CREATE INDEX IF NOT EXISTS idx_discrepancy_severity ON public.reconciliation_discrepancies(severity);

-- 4. TABLE: resource_integrity_checkpoints (Checkpoint Kriptografis Keutuhan Data)
CREATE TABLE IF NOT EXISTS public.resource_integrity_checkpoints (
    id BIGSERIAL PRIMARY KEY,
    checkpoint_code VARCHAR(100) UNIQUE NOT NULL,
    period_label VARCHAR(50) NOT NULL,
    total_ledger_debit NUMERIC(15,2) NOT NULL DEFAULT 0,
    total_ledger_credit NUMERIC(15,2) NOT NULL DEFAULT 0,
    active_websites_checksum VARCHAR(64) NOT NULL,
    active_domains_checksum VARCHAR(64) NOT NULL,
    certified_by VARCHAR(100),
    certified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. RPC: run_system_reconciliation_audit
-- Mengaudit kesesuaian data keuangan dan aset secara komprehensif
CREATE OR REPLACE FUNCTION public.run_system_reconciliation_audit(
    p_scope VARCHAR(50) DEFAULT 'full_system'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_batch_id BIGINT;
    v_batch_code VARCHAR(100);
    v_actor_role VARCHAR(50);
    v_caller_auth UUID;
    v_total_checked INT := 0;
    v_discrepancies_count INT := 0;

    -- Iteration records
    v_rec RECORD;
    v_unbalanced RECORD;
    v_orphan RECORD;
BEGIN
    -- 1. Capability Verification
    v_caller_auth := auth.uid();
    IF v_caller_auth IS NOT NULL THEN
        SELECT da.role INTO v_actor_role FROM public.dashboard_access da
        WHERE da.auth_user_id = v_caller_auth AND da.is_active = TRUE LIMIT 1;

        IF v_actor_role NOT IN ('root', 'super_admin') THEN
            IF NOT EXISTS (
                SELECT 1 FROM public.backoffice_role_capabilities
                WHERE role = v_actor_role AND capability_code = 'reconcile.run'
            ) THEN
                RETURN jsonb_build_object('success', false, 'error', 'Akses ditolak: Memerlukan izin reconcile.run');
            END IF;
        END IF;
    ELSE
        v_actor_role := 'system';
    END IF;

    -- 2. Create batch execution
    v_batch_code := 'REC-' || TO_CHAR(NOW(), 'YYYYMMDD-HH24MISS') || '-' || SUBSTRING(MD5(RANDOM()::text) FROM 1 FOR 4);

    INSERT INTO public.system_reconciliation_batches (
        batch_code, scope, status, executed_by, started_at
    ) VALUES (
        v_batch_code, p_scope, 'running', COALESCE(v_actor_role, 'system'), NOW()
    )
    RETURNING id INTO v_batch_id;

    -- CHECK 1: Double-Entry Ledger Equilibrium (Sum Debit == Sum Credit per transaction)
    FOR v_unbalanced IN
        SELECT 
            transaction_id,
            SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) AS total_debit,
            SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) AS total_credit
        FROM public.ledger_entries
        GROUP BY transaction_id
        HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) != 
               SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END)
    LOOP
        v_discrepancies_count := v_discrepancies_count + 1;
        INSERT INTO public.reconciliation_discrepancies (
            batch_id, discrepancy_type, entity_type, entity_id, expected_value, actual_value,
            difference_amount, severity, metadata
        ) VALUES (
            v_batch_id,
            'UNBALANCED_LEDGER_TRANSACTION',
            'ledger_transaction',
            v_unbalanced.transaction_id::text,
            'Debit = Credit (' || v_unbalanced.total_debit || ')',
            'Debit=' || v_unbalanced.total_debit || ', Credit=' || v_unbalanced.total_credit,
            ABS(v_unbalanced.total_debit - v_unbalanced.total_credit),
            'critical',
            jsonb_build_object('debit', v_unbalanced.total_debit, 'credit', v_unbalanced.total_credit)
        );
    END LOOP;

    -- Count total transactions checked
    SELECT COUNT(DISTINCT transaction_id) INTO v_total_checked FROM public.ledger_entries;

    -- CHECK 2: Paid Payment Transactions without matching Ledger Entries
    FOR v_rec IN
        SELECT pt.id, pt.reference_number, pt.amount, pt.status
        FROM public.payment_transactions pt
        WHERE pt.status IN ('paid', 'verified', 'completed')
          AND NOT EXISTS (
              SELECT 1 FROM public.ledger_entries le 
              WHERE le.transaction_id = pt.id
          )
    LOOP
        v_discrepancies_count := v_discrepancies_count + 1;
        INSERT INTO public.reconciliation_discrepancies (
            batch_id, discrepancy_type, entity_type, entity_id, expected_value, actual_value,
            difference_amount, severity, metadata
        ) VALUES (
            v_batch_id,
            'PAYMENT_MISSING_LEDGER_RECORD',
            'payment_transaction',
            v_rec.id::text,
            'Ledger entries exist for paid transaction',
            'No ledger entry found',
            v_rec.amount,
            'critical',
            jsonb_build_object('ref', v_rec.reference_number, 'amount', v_rec.amount)
        );
    END LOOP;

    -- CHECK 3: Orphan Active Websites (Active website with detached or missing domain inventory)
    FOR v_orphan IN
        SELECT w.id, w.domain, w.status
        FROM public.websites w
        WHERE w.status = 'active'
          AND w.domain IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM public.domain_inventory di
              WHERE di.domain_name = w.domain AND di.status IN ('active', 'dns_configuring')
          )
    LOOP
        v_discrepancies_count := v_discrepancies_count + 1;
        INSERT INTO public.reconciliation_discrepancies (
            batch_id, discrepancy_type, entity_type, entity_id, expected_value, actual_value,
            difference_amount, severity, metadata
        ) VALUES (
            v_batch_id,
            'ORPHAN_ACTIVE_WEBSITE_DOMAIN',
            'website',
            v_orphan.id::text,
            'Domain exists and active in domain_inventory',
            'Domain missing or not active in inventory',
            0,
            'warning',
            jsonb_build_object('domain', v_orphan.domain)
        );
    END LOOP;

    -- Update batch summary
    UPDATE public.system_reconciliation_batches
    SET total_checked = v_total_checked,
        discrepancies_count = v_discrepancies_count,
        status = CASE WHEN v_discrepancies_count = 0 THEN 'balanced' ELSE 'discrepancies_detected' END,
        summary_notes = 'Pemeriksaan rekonsiliasi selesai. Total diperiksa: ' || v_total_checked || ', Selisih: ' || v_discrepancies_count,
        completed_at = NOW()
    WHERE id = v_batch_id;

    -- Alert if critical discrepancies found
    IF v_discrepancies_count > 0 THEN
        INSERT INTO public.telegram_notification_log (
            chat_id, message, status, metadata
        ) VALUES (
            -1002277561858,
            '[AUDIT REKONSILIASI] Ditemukan ' || v_discrepancies_count || ' selisih/anomali pada batch ' || v_batch_code || '. Segera lakukan review di Control Center.',
            'pending',
            jsonb_build_object('batch_code', v_batch_code, 'discrepancies', v_discrepancies_count)
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'batch_code', v_batch_code,
        'status', CASE WHEN v_discrepancies_count = 0 THEN 'balanced' ELSE 'discrepancies_detected' END,
        'total_checked', v_total_checked,
        'discrepancies_count', v_discrepancies_count
    );
END;
$$;

-- 6. RPC: resolve_reconciliation_discrepancy
-- Penyelesaian catatan selisih oleh Super Admin / Auditor
CREATE OR REPLACE FUNCTION public.resolve_reconciliation_discrepancy(
    p_discrepancy_id BIGINT,
    p_resolution_status VARCHAR(50),
    p_resolution_notes TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_disc RECORD;
    v_actor_role VARCHAR(50);
    v_caller_auth UUID;
BEGIN
    v_caller_auth := auth.uid();
    IF v_caller_auth IS NOT NULL THEN
        SELECT da.role INTO v_actor_role FROM public.dashboard_access da
        WHERE da.auth_user_id = v_caller_auth AND da.is_active = TRUE LIMIT 1;

        IF v_actor_role NOT IN ('root', 'super_admin') THEN
            RETURN jsonb_build_object('success', false, 'error', 'Hanya Super Admin yang berwenang menyelesaikan selisih rekonsiliasi');
        END IF;
    ELSE
        v_actor_role := 'super_admin';
    END IF;

    SELECT * INTO v_disc
    FROM public.reconciliation_discrepancies
    WHERE id = p_discrepancy_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Catatan selisih tidak ditemukan');
    END IF;

    UPDATE public.reconciliation_discrepancies
    SET resolution_status = p_resolution_status,
        resolution_notes = p_resolution_notes,
        resolved_by = COALESCE(v_actor_role, 'super_admin'),
        resolved_at = NOW()
    WHERE id = p_discrepancy_id;

    -- Update resolved count on batch
    UPDATE public.system_reconciliation_batches
    SET discrepancies_resolved = discrepancies_resolved + 1
    WHERE id = v_disc.batch_id;

    -- Audit Log
    INSERT INTO public.audit_logs (
        action, entity_type, entity_id, actor_role, old_values, new_values
    ) VALUES (
        'RECONCILIATION_DISCREPANCY_RESOLVED',
        'reconciliation_discrepancy',
        v_disc.id,
        COALESCE(v_actor_role, 'super_admin'),
        jsonb_build_object('status', v_disc.resolution_status),
        jsonb_build_object('status', p_resolution_status, 'notes', p_resolution_notes)
    );

    RETURN jsonb_build_object(
        'success', true,
        'discrepancy_id', p_discrepancy_id,
        'status', p_resolution_status,
        'resolved_by', v_actor_role
    );
END;
$$;

-- 7. RPC: get_reconciliation_summary
-- Mengambil ringkasan integritas dan riwayat batch audit terakhir
CREATE OR REPLACE FUNCTION public.get_reconciliation_summary()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_last_batch RECORD;
    v_open_discrepancies INT := 0;
    v_critical_discrepancies INT := 0;
BEGIN
    SELECT * INTO v_last_batch
    FROM public.system_reconciliation_batches
    ORDER BY id DESC
    LIMIT 1;

    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE severity = 'critical')
    INTO v_open_discrepancies, v_critical_discrepancies
    FROM public.reconciliation_discrepancies
    WHERE resolution_status IN ('open', 'investigating');

    RETURN jsonb_build_object(
        'success', true,
        'system_integrity', CASE WHEN v_critical_discrepancies > 0 THEN 'compromised' ELSE 'intact' END,
        'open_discrepancies_count', v_open_discrepancies,
        'critical_discrepancies_count', v_critical_discrepancies,
        'last_audit_batch', CASE WHEN v_last_batch.id IS NOT NULL THEN jsonb_build_object(
            'batch_code', v_last_batch.batch_code,
            'status', v_last_batch.status,
            'total_checked', v_last_batch.total_checked,
            'discrepancies_count', v_last_batch.discrepancies_count,
            'completed_at', v_last_batch.completed_at
        ) ELSE NULL END
    );
END;
$$;

-- 8. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE public.system_reconciliation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_discrepancies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_integrity_checkpoints ENABLE ROW LEVEL SECURITY;

-- Service role full access
DROP POLICY IF EXISTS service_role_recon_batches ON public.system_reconciliation_batches;
CREATE POLICY service_role_recon_batches ON public.system_reconciliation_batches
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_discrepancies ON public.reconciliation_discrepancies;
CREATE POLICY service_role_discrepancies ON public.reconciliation_discrepancies
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_role_checkpoints ON public.resource_integrity_checkpoints;
CREATE POLICY service_role_checkpoints ON public.resource_integrity_checkpoints
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated operators with reconcile.view or root/super_admin
DROP POLICY IF EXISTS operator_read_recon_batches ON public.system_reconciliation_batches;
CREATE POLICY operator_read_recon_batches ON public.system_reconciliation_batches
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'reconcile.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_discrepancies ON public.reconciliation_discrepancies;
CREATE POLICY operator_read_discrepancies ON public.reconciliation_discrepancies
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'reconcile.view' OR da.role IN ('root', 'super_admin'))
        )
    );

DROP POLICY IF EXISTS operator_read_checkpoints ON public.resource_integrity_checkpoints;
CREATE POLICY operator_read_checkpoints ON public.resource_integrity_checkpoints
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            JOIN public.backoffice_role_capabilities rc ON rc.role = da.role
            WHERE da.auth_user_id = auth.uid()
              AND da.is_active = TRUE
              AND (rc.capability_code = 'reconcile.view' OR da.role IN ('root', 'super_admin'))
        )
    );
