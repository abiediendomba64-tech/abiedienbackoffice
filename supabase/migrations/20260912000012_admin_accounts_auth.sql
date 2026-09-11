-- ====================================================================
-- MIGRATION: 20260912000012_admin_accounts_auth.sql
-- DESCRIPTION: Admin accounts table for multi-auth login system
--              Supports: Email/Password, Magic Link, Telegram+Email
--              Roles: super_admin, dev, admin
-- ====================================================================

-- 1. Admin accounts table (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.admin_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin', 'dev', 'admin')),
    telegram_id BIGINT,
    full_name TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login TIMESTAMPTZ,
    created_by BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_admin_accounts_email ON public.admin_accounts(email);
CREATE INDEX IF NOT EXISTS idx_admin_accounts_role ON public.admin_accounts(role);
CREATE INDEX IF NOT EXISTS idx_admin_accounts_telegram_id ON public.admin_accounts(telegram_id);

-- 3. Row Level Security
ALTER TABLE public.admin_accounts ENABLE ROW LEVEL SECURITY;

-- Only authenticated admins can read admin accounts
DROP POLICY IF EXISTS admin_accounts_read ON public.admin_accounts;
CREATE POLICY admin_accounts_read ON public.admin_accounts
    FOR SELECT
    USING (
        public.backoffice_has_capability('dashboard.access')
    );

-- Only super_admin can insert/update/delete
DROP POLICY IF EXISTS admin_accounts_write ON public.admin_accounts;
CREATE POLICY admin_accounts_write ON public.admin_accounts
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.admin_accounts aa
            WHERE aa.auth_user_id = auth.uid()
            AND aa.role = 'super_admin'
            AND aa.is_active = true
        )
    );

-- 4. Function to update last login timestamp
CREATE OR REPLACE FUNCTION public.update_admin_last_login()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.last_login IS DISTINCT FROM OLD.last_login THEN
        UPDATE public.admin_accounts
        SET last_login = NEW.last_login, updated_at = NOW()
        WHERE auth_user_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

-- 5. Grant permissions
GRANT SELECT ON public.admin_accounts TO authenticated;
GRANT ALL ON public.admin_accounts TO service_role;
