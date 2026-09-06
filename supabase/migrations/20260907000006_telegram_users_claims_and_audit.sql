-- ====================================================================
-- MIGRATION: 20260907000006_telegram_users_claims_and_audit.sql
-- DESCRIPTION: Hierarchical Telegram Bot Schema, Strict Roles, Private Claims Storage & Audit
-- ====================================================================

-- 1. Table: telegram_users
ALTER TABLE IF EXISTS public.dashboard_access ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS public.telegram_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_user_id BIGINT UNIQUE NOT NULL,
    telegram_chat_id BIGINT,
    telegram_username VARCHAR(255),
    display_name VARCHAR(255),
    email VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'guest',
    assigned_admin_id BIGINT,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_tg_role CHECK (role IN ('guest', 'member', 'admin', 'dev', 'super_admin')),
    CONSTRAINT valid_tg_status CHECK (status IN ('pending', 'active', 'blocked'))
);

CREATE INDEX IF NOT EXISTS idx_telegram_users_user_id ON public.telegram_users(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_telegram_users_role_status ON public.telegram_users(role, status);
CREATE INDEX IF NOT EXISTS idx_telegram_users_assigned_admin ON public.telegram_users(assigned_admin_id);

-- 2. Table: admin_chat_ids
CREATE TABLE IF NOT EXISTS public.admin_chat_ids (
    telegram_user_id BIGINT PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    display_name VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default Super Admin list
INSERT INTO public.admin_chat_ids (telegram_user_id, chat_id, display_name, is_active)
VALUES 
    (7862805424, 7862805424, 'Super Admin Abied', true),
    (8625074832, 8625074832, 'Super Admin 2', true),
    (8627900503, 8627900503, 'Super Admin 3', true),
    (8849114090, 8849114090, 'Bot Admin Master', true)
ON CONFLICT (telegram_user_id) DO UPDATE 
SET is_active = EXCLUDED.is_active, updated_at = NOW();

-- Also seed into telegram_users with active super_admin role
INSERT INTO public.telegram_users (telegram_user_id, telegram_chat_id, display_name, role, status)
VALUES 
    (7862805424, 7862805424, 'Super Admin Abied', 'super_admin', 'active'),
    (8625074832, 8625074832, 'Super Admin 2', 'super_admin', 'active'),
    (8627900503, 8627900503, 'Super Admin 3', 'super_admin', 'active'),
    (8849114090, 8849114090, 'Bot Admin Master', 'super_admin', 'active')
ON CONFLICT (telegram_user_id) DO UPDATE 
SET role = 'super_admin', status = 'active', updated_at = NOW();

-- 3. Table: claims
CREATE TABLE IF NOT EXISTS public.claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_user_id BIGINT NOT NULL REFERENCES public.telegram_users(telegram_user_id) ON DELETE CASCADE,
    submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    assigned_admin_id BIGINT,
    claim_type VARCHAR(100) NOT NULL DEFAULT 'salary',
    amount NUMERIC(14, 2),
    notes TEXT,
    evidence_path TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    reviewed_by BIGINT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_claim_status CHECK (status IN ('pending', 'reviewing', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_claims_telegram_user_id ON public.claims(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON public.claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_assigned_admin ON public.claims(assigned_admin_id);
CREATE INDEX IF NOT EXISTS idx_claims_created_at ON public.claims(created_at DESC);

-- 4. Table: telegram_updates (Idempotency control)
CREATE TABLE IF NOT EXISTS public.telegram_updates (
    update_id BIGINT PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_telegram_updates_received ON public.telegram_updates(received_at DESC);

-- 5. Row Level Security (RLS) Configuration
ALTER TABLE public.telegram_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_chat_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_updates ENABLE ROW LEVEL SECURITY;

-- Policy: telegram_users
DROP POLICY IF EXISTS telegram_users_admin_all ON public.telegram_users;
CREATE POLICY telegram_users_admin_all ON public.telegram_users
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            WHERE da.auth_user_id = auth.uid()
              AND da.role IN ('admin', 'super_admin')
              AND da.is_active = TRUE
        )
    );

-- Policy: claims
DROP POLICY IF EXISTS claims_select_own ON public.claims;
CREATE POLICY claims_select_own ON public.claims
    FOR SELECT
    USING (
        submitted_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.dashboard_access da
            WHERE da.auth_user_id = auth.uid()
              AND da.role IN ('admin', 'super_admin')
              AND da.is_active = TRUE
        )
    );

DROP POLICY IF EXISTS claims_admin_manage ON public.claims;
CREATE POLICY claims_admin_manage ON public.claims
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            WHERE da.auth_user_id = auth.uid()
              AND da.role IN ('admin', 'super_admin')
              AND da.is_active = TRUE
        )
    );

-- 6. Atomic Rate Limiting Function for Claims
CREATE OR REPLACE FUNCTION public.check_claim_rate_limit(p_telegram_user_id BIGINT, p_claim_type VARCHAR)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_recent_count INT;
    v_active_exists BOOLEAN;
BEGIN
    -- Check total claims submitted in the last 24 hours (max 3)
    SELECT COUNT(*) INTO v_recent_count
    FROM public.claims
    WHERE telegram_user_id = p_telegram_user_id
      AND created_at >= NOW() - INTERVAL '24 hours';

    IF v_recent_count >= 3 THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'Batas maksimal 3 klaim per 24 jam tercapai. Silakan coba kembali besok.'
        );
    END IF;

    -- Check if there is an active pending/reviewing claim of the same type
    SELECT EXISTS(
        SELECT 1 FROM public.claims
        WHERE telegram_user_id = p_telegram_user_id
          AND claim_type = p_claim_type
          AND status IN ('pending', 'reviewing')
    ) INTO v_active_exists;

    IF v_active_exists THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'Anda sudah memiliki pengajuan klaim aktif yang masih dalam antrean review.'
        );
    END IF;

    RETURN jsonb_build_object('allowed', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_claim_rate_limit(BIGINT, VARCHAR) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_claim_rate_limit(BIGINT, VARCHAR) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_claim_rate_limit(BIGINT, VARCHAR) TO service_role;

-- Create private bucket for claim-evidence
INSERT INTO storage.buckets (id, name, public)
VALUES ('claim-evidence', 'claim-evidence', false)
ON CONFLICT (id) DO NOTHING;
