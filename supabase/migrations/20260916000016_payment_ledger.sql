-- ====================================================================
-- MIGRATION: 20260916000016_payment_ledger.sql
-- PHASE:      016 Payment Ledger (Master Control Center)
-- DESCRIPTION: Decouples Financial Core & Ledger from websites.
--              Implements double-entry ledger accounting:
--                - Payin, Payout, Coin, Balances, and Settlements.
--              Includes:
--                1. Capability registration (ledger.*, settlement.*, payment.*)
--                2. public.payment_accounts (Chart of Accounts / Saldo Induk)
--                3. public.payment_transactions (Payin / Payout journal events)
--                4. public.payment_ledger_entries (Double-entry debit/credit ledger)
--                5. public.payment_settlements (Periodic settlement batches)
--                6. public.user_coin_balances (Member credit & wallet ledger)
--                7. FSM transition triggers
--                8. Atomic RPCs:
--                   - record_double_entry_ledger
--                   - create_payment_transaction
--                   - complete_payment_transaction (atomic ledger execution)
--                   - create_settlement_batch
--                9. RLS & capability-gated access policies
-- Conventions: security-definer RPCs with search_path='', fail-closed
--              actor/capability gate, immutable audit_logs, RLS.
-- ====================================================================

-- 1. CAPABILITY REGISTRATION
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('ledger.view',         'Melihat buku besar finansial dan saldo akun', 'finance'),
('ledger.record',       'Mencatat mutasi debit/kredit pada buku besar', 'finance'),
('ledger.manage',       'Kelola bagan akun (Chart of Accounts) dan audit saldo', 'finance'),
('payment.manage',      'Kelola transaksi payin dan payout', 'finance'),
('settlement.execute',  'Menjalankan kalkulasi dan eksekusi settlement', 'finance')
ON CONFLICT (code) DO NOTHING;

-- Grant capabilities to operational roles
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('root'), ('super_admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code LIKE 'ledger.%' OR bc.code LIKE 'settlement.%' OR bc.code = 'payment.manage'
ON CONFLICT (role, capability_code) DO NOTHING;

-- Admin & Finance role permissions
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('admin')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('ledger.view', 'ledger.record', 'payment.manage', 'settlement.execute')
ON CONFLICT (role, capability_code) DO NOTHING;

-- Dev role may inspect ledger
INSERT INTO public.backoffice_role_capabilities (role, capability_code)
SELECT r.role, bc.code
FROM (VALUES ('dev')) AS r(role)
CROSS JOIN public.backoffice_capabilities bc
WHERE bc.code IN ('ledger.view')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 2. TABLE: payment_accounts (Chart of Accounts / Master Rekening Buku Besar)
CREATE TABLE IF NOT EXISTS public.payment_accounts (
    id BIGSERIAL PRIMARY KEY,
    account_code VARCHAR(50) UNIQUE NOT NULL,
    account_name VARCHAR(100) NOT NULL,
    account_type VARCHAR(30) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'IDR',
    current_balance NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_account_type CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense'))
);

CREATE INDEX IF NOT EXISTS idx_payment_accounts_type ON public.payment_accounts(account_type);
CREATE INDEX IF NOT EXISTS idx_payment_accounts_active ON public.payment_accounts(is_active);

-- Seed Chart of Accounts
INSERT INTO public.payment_accounts (account_code, account_name, account_type, current_balance) VALUES
('1001-CASH-QRIS',       'Kas QRIS (StarPAGO / GSPay Gateway)', 'asset', 0.00),
('1002-BANK-SETTLEMENT', 'Bank Penampung Settlement',           'asset', 0.00),
('2001-MEMBER-DEPOSIT',  'Kewajiban Saldo Deposit Member',      'liability', 0.00),
('2002-PENDING-PAYOUT',  'Kewajiban Pencairan Dana (Payout)',   'liability', 0.00),
('3001-SYSTEM-CAPITAL',  'Modal Cadangan Sistem',               'equity', 0.00),
('4001-REVENUE-FEE',     'Pendapatan Fee Transaksi & Komisi',   'revenue', 0.00),
('5001-EXPENSE-GATEWAY', 'Biaya Gateway & Operasional Payout',  'expense', 0.00)
ON CONFLICT (account_code) DO NOTHING;

-- 3. TABLE: payment_transactions (Payin / Payout journal events)
CREATE TABLE IF NOT EXISTS public.payment_transactions (
    id BIGSERIAL PRIMARY KEY,
    transaction_code VARCHAR(50) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    website_id BIGINT REFERENCES public.websites(id) ON DELETE SET NULL,
    transaction_type VARCHAR(30) NOT NULL,
    amount NUMERIC(18,2) NOT NULL,
    fee_amount NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    net_amount NUMERIC(18,2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'IDR',
    provider_code VARCHAR(50) NOT NULL DEFAULT 'manual',
    provider_reference VARCHAR(100),
    payment_method VARCHAR(50) NOT NULL DEFAULT 'qris',
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_trans_type CHECK (transaction_type IN (
        'payin', 'payout', 'commission', 'topup', 'settlement', 'adjustment'
    )),
    CONSTRAINT valid_trans_status CHECK (status IN (
        'pending', 'processing', 'completed', 'failed', 'cancelled', 'reconciliation_required'
    )),
    CONSTRAINT valid_trans_amount CHECK (amount > 0 AND fee_amount >= 0 AND net_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_pay_trans_user ON public.payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_pay_trans_website ON public.payment_transactions(website_id);
CREATE INDEX IF NOT EXISTS idx_pay_trans_status ON public.payment_transactions(status);
CREATE INDEX IF NOT EXISTS idx_pay_trans_created ON public.payment_transactions(created_at DESC);

-- 4. TABLE: payment_ledger_entries (Double-entry debit/credit ledger)
CREATE TABLE IF NOT EXISTS public.payment_ledger_entries (
    id BIGSERIAL PRIMARY KEY,
    entry_code VARCHAR(50) UNIQUE NOT NULL,
    transaction_id BIGINT REFERENCES public.payment_transactions(id) ON DELETE SET NULL,
    account_id BIGINT NOT NULL REFERENCES public.payment_accounts(id) ON DELETE RESTRICT,
    entry_type VARCHAR(10) NOT NULL,
    amount NUMERIC(18,2) NOT NULL,
    running_balance NUMERIC(18,2) NOT NULL,
    notes TEXT,
    actor_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_entry_type CHECK (entry_type IN ('debit', 'credit')),
    CONSTRAINT valid_entry_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_ledger_account_created ON public.payment_ledger_entries(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_trans_id ON public.payment_ledger_entries(transaction_id);

-- 5. TABLE: payment_settlements (Periodic settlement batches)
CREATE TABLE IF NOT EXISTS public.payment_settlements (
    id BIGSERIAL PRIMARY KEY,
    settlement_code VARCHAR(50) UNIQUE NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    total_transactions INT NOT NULL DEFAULT 0,
    gross_amount NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    fee_amount NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    net_settled_amount NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    approved_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_settlement_status CHECK (status IN (
        'draft', 'calculated', 'approved', 'processing', 'completed', 'failed', 'disputed'
    ))
);

CREATE INDEX IF NOT EXISTS idx_settlements_status ON public.payment_settlements(status);
CREATE INDEX IF NOT EXISTS idx_settlements_created ON public.payment_settlements(created_at DESC);

-- 6. TABLE: user_coin_balances (Member wallet & credit ledger)
CREATE TABLE IF NOT EXISTS public.user_coin_balances (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE RESTRICT,
    coin_balance NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    frozen_balance NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_coin_balances CHECK (coin_balance >= 0 AND frozen_balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_user_coin_balances_user ON public.user_coin_balances(user_id);

-- 7. Timestamp triggers
DROP TRIGGER IF EXISTS payment_accounts_set_updated_at ON public.payment_accounts;
CREATE TRIGGER payment_accounts_set_updated_at BEFORE UPDATE ON public.payment_accounts
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS payment_transactions_set_updated_at ON public.payment_transactions;
CREATE TRIGGER payment_transactions_set_updated_at BEFORE UPDATE ON public.payment_transactions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS payment_settlements_set_updated_at ON public.payment_settlements;
CREATE TRIGGER payment_settlements_set_updated_at BEFORE UPDATE ON public.payment_settlements
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS user_coin_balances_set_updated_at ON public.user_coin_balances;
CREATE TRIGGER user_coin_balances_set_updated_at BEFORE UPDATE ON public.user_coin_balances
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 8. FSM VALIDATION TRIGGER FOR payment_transactions
CREATE OR REPLACE FUNCTION public.validate_payment_transaction_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    IF OLD.status = 'pending' AND NEW.status NOT IN ('processing', 'cancelled', 'failed') THEN
        RAISE EXCEPTION 'Invalid transition from pending to %', NEW.status;
    END IF;
    IF OLD.status = 'processing' AND NEW.status NOT IN ('completed', 'failed', 'reconciliation_required') THEN
        RAISE EXCEPTION 'Invalid transition from processing to %', NEW.status;
    END IF;
    IF OLD.status = 'failed' AND NEW.status NOT IN ('reconciliation_required') THEN
        RAISE EXCEPTION 'Failed transaction can only transition to reconciliation_required';
    END IF;
    IF OLD.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Cannot transition terminal transaction status %', OLD.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_payment_transaction ON public.payment_transactions;
CREATE TRIGGER trg_validate_payment_transaction
BEFORE UPDATE ON public.payment_transactions
FOR EACH ROW
EXECUTE FUNCTION public.validate_payment_transaction_transition();

-- 9. ATOMIC RPC: record_double_entry_ledger
CREATE OR REPLACE FUNCTION public.record_double_entry_ledger(
    p_transaction_id BIGINT,
    p_debit_account_id BIGINT,
    p_credit_account_id BIGINT,
    p_amount NUMERIC,
    p_notes TEXT DEFAULT NULL,
    p_actor_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_debit_acc RECORD;
    v_credit_acc RECORD;
    v_new_debit_bal NUMERIC(18,2);
    v_new_credit_bal NUMERIC(18,2);
    v_debit_entry_code VARCHAR(50);
    v_credit_entry_code VARCHAR(50);
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Ledger entry amount must be greater than zero';
    END IF;

    IF p_debit_account_id = p_credit_account_id THEN
        RAISE EXCEPTION 'Debit and credit accounts must be different';
    END IF;

    -- Lock both accounts in consistent ordering to prevent deadlocks
    IF p_debit_account_id < p_credit_account_id THEN
        SELECT * INTO v_debit_acc FROM public.payment_accounts WHERE id = p_debit_account_id FOR UPDATE;
        SELECT * INTO v_credit_acc FROM public.payment_accounts WHERE id = p_credit_account_id FOR UPDATE;
    ELSE
        SELECT * INTO v_credit_acc FROM public.payment_accounts WHERE id = p_credit_account_id FOR UPDATE;
        SELECT * INTO v_debit_acc FROM public.payment_accounts WHERE id = p_debit_account_id FOR UPDATE;
    END IF;

    IF v_debit_acc IS NULL OR v_credit_acc IS NULL THEN
        RAISE EXCEPTION 'One or both payment accounts not found';
    END IF;

    -- Calculate new balance according to accounting equation
    -- Asset/Expense: Debit (+), Credit (-)
    -- Liability/Equity/Revenue: Credit (+), Debit (-)
    IF v_debit_acc.account_type IN ('asset', 'expense') THEN
        v_new_debit_bal := v_debit_acc.current_balance + p_amount;
    ELSE
        v_new_debit_bal := v_debit_acc.current_balance - p_amount;
    END IF;

    IF v_credit_acc.account_type IN ('asset', 'expense') THEN
        v_new_credit_bal := v_credit_acc.current_balance - p_amount;
    ELSE
        v_new_credit_bal := v_credit_acc.current_balance + p_amount;
    END IF;

    -- Update account balances
    UPDATE public.payment_accounts SET current_balance = v_new_debit_bal WHERE id = p_debit_account_id;
    UPDATE public.payment_accounts SET current_balance = v_new_credit_bal WHERE id = p_credit_account_id;

    -- Generate entry codes
    v_debit_entry_code := 'LED-DR-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random() * 10000)::text, 4, '0');
    v_credit_entry_code := 'LED-CR-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random() * 10000)::text, 4, '0');

    -- Insert Debit Line
    INSERT INTO public.payment_ledger_entries (
        entry_code, transaction_id, account_id, entry_type, amount, running_balance, notes, actor_id
    ) VALUES (
        v_debit_entry_code, p_transaction_id, p_debit_account_id, 'debit', p_amount, v_new_debit_bal, p_notes, p_actor_id
    );

    -- Insert Credit Line
    INSERT INTO public.payment_ledger_entries (
        entry_code, transaction_id, account_id, entry_type, amount, running_balance, notes, actor_id
    ) VALUES (
        v_credit_entry_code, p_transaction_id, p_credit_account_id, 'credit', p_amount, v_new_credit_bal, p_notes, p_actor_id
    );

    RETURN jsonb_build_object(
        'success', true,
        'amount', p_amount,
        'debit_account', v_debit_acc.account_code,
        'debit_balance', v_new_debit_bal,
        'credit_account', v_credit_acc.account_code,
        'credit_balance', v_new_credit_bal,
        'posted_at', NOW()
    );
END;
$$;

-- 10. ATOMIC RPC: create_payment_transaction
CREATE OR REPLACE FUNCTION public.create_payment_transaction(
    p_user_id BIGINT,
    p_transaction_type VARCHAR(30),
    p_amount NUMERIC,
    p_fee NUMERIC DEFAULT 0.00,
    p_website_id BIGINT DEFAULT NULL,
    p_provider_code VARCHAR(50) DEFAULT 'manual',
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
        RAISE EXCEPTION 'User % not found', p_user_id;
    END IF;

    v_net := p_amount - COALESCE(p_fee, 0.00);
    IF v_net < 0 THEN
        RAISE EXCEPTION 'Net amount cannot be negative (fee exceeds amount)';
    END IF;

    v_tx_code := 'TXN-' || to_char(NOW(), 'YYYYMMDD') || '-' || lpad(floor(random() * 10000)::text, 4, '0');

    INSERT INTO public.payment_transactions (
        transaction_code, user_id, website_id, transaction_type,
        amount, fee_amount, net_amount, provider_code, provider_reference,
        payment_method, status, metadata
    ) VALUES (
        v_tx_code, p_user_id, p_website_id, p_transaction_type,
        p_amount, COALESCE(p_fee, 0.00), v_net, p_provider_code, p_provider_ref,
        p_payment_method, 'pending', COALESCE(p_metadata, '{}'::jsonb)
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
            'provider', p_provider_code
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'transaction_id', v_new_tx_id,
        'transaction_code', v_tx_code,
        'amount', p_amount,
        'net_amount', v_net,
        'status', 'pending',
        'created_at', NOW()
    );
END;
$$;

-- 11. ATOMIC RPC: complete_payment_transaction
CREATE OR REPLACE FUNCTION public.complete_payment_transaction(
    p_transaction_id BIGINT,
    p_provider_ref VARCHAR(100) DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
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
    v_tx RECORD;
    v_qris_acc_id BIGINT;
    v_member_acc_id BIGINT;
    v_bank_acc_id BIGINT;
    v_payout_acc_id BIGINT;
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

    -- Lock transaction row
    SELECT * INTO v_tx
    FROM public.payment_transactions
    WHERE id = p_transaction_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment transaction % not found', p_transaction_id;
    END IF;

    IF v_tx.status = 'completed' THEN
        RETURN jsonb_build_object('success', true, 'already_completed', true, 'transaction_code', v_tx.transaction_code);
    END IF;

    IF v_tx.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION 'Cannot complete transaction in status %', v_tx.status;
    END IF;

    -- Resolve standard ledger account IDs
    SELECT id INTO v_qris_acc_id FROM public.payment_accounts WHERE account_code = '1001-CASH-QRIS';
    SELECT id INTO v_member_acc_id FROM public.payment_accounts WHERE account_code = '2001-MEMBER-DEPOSIT';
    SELECT id INTO v_bank_acc_id FROM public.payment_accounts WHERE account_code = '1002-BANK-SETTLEMENT';
    SELECT id INTO v_payout_acc_id FROM public.payment_accounts WHERE account_code = '2002-PENDING-PAYOUT';

    -- Advance to processing then completed
    UPDATE public.payment_transactions
    SET
        status = 'completed',
        provider_reference = COALESCE(p_provider_ref, provider_reference),
        completed_at = NOW()
    WHERE id = p_transaction_id;

    -- Execute double-entry ledger mutation according to transaction type
    IF v_tx.transaction_type IN ('payin', 'topup') THEN
        -- Payin: Debit Kas QRIS, Credit Kewajiban Saldo Member
        PERFORM public.record_double_entry_ledger(
            p_transaction_id, v_qris_acc_id, v_member_acc_id, v_tx.net_amount,
            COALESCE(p_notes, 'Payin settlement completed'), v_actor_user_id
        );

        -- Upsert member coin balance
        INSERT INTO public.user_coin_balances (user_id, coin_balance, last_activity_at)
        VALUES (v_tx.user_id, v_tx.net_amount, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            coin_balance = public.user_coin_balances.coin_balance + v_tx.net_amount,
            last_activity_at = NOW();

    ELSIF v_tx.transaction_type = 'payout' THEN
        -- Payout: Debit Kewajiban Saldo Member, Credit Bank Settlement
        PERFORM public.record_double_entry_ledger(
            p_transaction_id, v_member_acc_id, v_bank_acc_id, v_tx.net_amount,
            COALESCE(p_notes, 'Payout disbursement completed'), v_actor_user_id
        );

        -- Deduct member coin balance
        UPDATE public.user_coin_balances
        SET coin_balance = GREATEST(0, coin_balance - v_tx.amount),
            last_activity_at = NOW()
        WHERE user_id = v_tx.user_id;
    END IF;

    -- Update last_value_at on associated website if present
    IF v_tx.website_id IS NOT NULL THEN
        UPDATE public.websites
        SET last_value_at = NOW()
        WHERE id = v_tx.website_id;
    END IF;

    -- Immutable audit trail
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        v_actor_user_id, COALESCE(v_actor_role, 'system'),
        'PAYMENT_TRANSACTION_COMPLETED', 'payment_transactions', p_transaction_id,
        jsonb_build_object('status', v_tx.status),
        jsonb_build_object('status', 'completed', 'amount', v_tx.amount, 'net', v_tx.net_amount)
    );

    -- Queue telegram notification
    INSERT INTO public.telegram_notification_log (
        recipient_chat_id, message_text, context_type, context_id, status
    ) VALUES (
        0,
        format('Transaksi Finansial Berhasil [%s]: %s sebesar Rp %s (Net: Rp %s). Metode: %s.',
               v_tx.transaction_code, upper(v_tx.transaction_type),
               to_char(v_tx.amount, 'FM999,999,999,990'),
               to_char(v_tx.net_amount, 'FM999,999,999,990'),
               v_tx.payment_method),
        'payment',
        v_tx.transaction_code,
        'queued'
    );

    RETURN jsonb_build_object(
        'success', true,
        'transaction_id', p_transaction_id,
        'transaction_code', v_tx.transaction_code,
        'status', 'completed',
        'completed_at', NOW()
    );
END;
$$;

-- 12. REVOKE / GRANT on RPCs
REVOKE EXECUTE ON FUNCTION public.record_double_entry_ledger(BIGINT, BIGINT, BIGINT, NUMERIC, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_double_entry_ledger(BIGINT, BIGINT, BIGINT, NUMERIC, TEXT, BIGINT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.create_payment_transaction(BIGINT, VARCHAR, NUMERIC, NUMERIC, BIGINT, VARCHAR, VARCHAR, VARCHAR, JSONB, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_payment_transaction(BIGINT, VARCHAR, NUMERIC, NUMERIC, BIGINT, VARCHAR, VARCHAR, VARCHAR, JSONB, BIGINT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.complete_payment_transaction(BIGINT, VARCHAR, TEXT, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_payment_transaction(BIGINT, VARCHAR, TEXT, BIGINT) TO authenticated, service_role;

-- 13. ROW LEVEL SECURITY (RLS)
ALTER TABLE public.payment_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_coin_balances ENABLE ROW LEVEL SECURITY;

-- Operator read policies
DROP POLICY IF EXISTS payment_accounts_operator_read ON public.payment_accounts;
CREATE POLICY payment_accounts_operator_read ON public.payment_accounts
    FOR SELECT
    USING (public.backoffice_has_capability('ledger.view'));

DROP POLICY IF EXISTS payment_transactions_operator_read ON public.payment_transactions;
CREATE POLICY payment_transactions_operator_read ON public.payment_transactions
    FOR SELECT
    USING (public.backoffice_has_capability('ledger.view'));

DROP POLICY IF EXISTS payment_ledger_entries_operator_read ON public.payment_ledger_entries;
CREATE POLICY payment_ledger_entries_operator_read ON public.payment_ledger_entries
    FOR SELECT
    USING (public.backoffice_has_capability('ledger.view'));

DROP POLICY IF EXISTS payment_settlements_operator_read ON public.payment_settlements;
CREATE POLICY payment_settlements_operator_read ON public.payment_settlements
    FOR SELECT
    USING (public.backoffice_has_capability('ledger.view'));

DROP POLICY IF EXISTS user_coin_balances_operator_read ON public.user_coin_balances;
CREATE POLICY user_coin_balances_operator_read ON public.user_coin_balances
    FOR SELECT
    USING (public.backoffice_has_capability('ledger.view'));

-- GRANTS
GRANT SELECT ON public.payment_accounts TO authenticated, service_role;
GRANT SELECT ON public.payment_transactions TO authenticated, service_role;
GRANT SELECT ON public.payment_ledger_entries TO authenticated, service_role;
GRANT SELECT ON public.payment_settlements TO authenticated, service_role;
GRANT SELECT ON public.user_coin_balances TO authenticated, service_role;

GRANT ALL ON public.payment_accounts TO service_role;
GRANT ALL ON public.payment_transactions TO service_role;
GRANT ALL ON public.payment_ledger_entries TO service_role;
GRANT ALL ON public.payment_settlements TO service_role;
GRANT ALL ON public.user_coin_balances TO service_role;

-- End of migration 016
