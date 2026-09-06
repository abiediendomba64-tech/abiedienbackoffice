-- ====================================================================
-- MIGRATION: 20260906000005_dashboard_access_and_auth_integrity.sql
-- DESCRIPTION: Hardened dashboard access mapping with 1-to-1 unique index on auth_user_id
-- ====================================================================

-- 1. Create dashboard_access mapping table
CREATE TABLE IF NOT EXISTS public.dashboard_access (
    id BIGSERIAL PRIMARY KEY,
    auth_user_id UUID NOT NULL,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT valid_dashboard_role CHECK (role IN ('admin', 'super_admin'))
);

-- 2. Strictly enforce 1-to-1 mapping for each Supabase Auth User
-- This prevents .maybeSingle() query collision in backend Edge Functions
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_access_auth_user_id 
ON public.dashboard_access(auth_user_id);

CREATE INDEX IF NOT EXISTS idx_dashboard_access_user_id 
ON public.dashboard_access(user_id);

CREATE INDEX IF NOT EXISTS idx_dashboard_access_role_active 
ON public.dashboard_access(role, is_active);

-- 3. Enable RLS on dashboard_access
ALTER TABLE public.dashboard_access ENABLE ROW LEVEL SECURITY;

-- 4. Policy: Operators can only read their own dashboard mapping
DROP POLICY IF EXISTS dashboard_access_select_own ON public.dashboard_access;
CREATE POLICY dashboard_access_select_own ON public.dashboard_access
    FOR SELECT
    USING (auth.uid() = auth_user_id);

-- 5. Policy: Only super_admin can insert / update dashboard permissions
DROP POLICY IF EXISTS dashboard_access_manage_super_admin ON public.dashboard_access;
CREATE POLICY dashboard_access_manage_super_admin ON public.dashboard_access
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.dashboard_access da
            WHERE da.auth_user_id = auth.uid()
              AND da.role = 'super_admin'
              AND da.is_active = TRUE
        )
    );
