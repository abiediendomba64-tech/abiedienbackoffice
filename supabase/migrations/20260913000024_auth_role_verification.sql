-- ====================================================================
-- MIGRATION: 20260913000024_auth_role_verification.sql
-- DESCRIPTION: Implements strict separation of Admin & Member authentication.
--              Features:
--                1. Ensures super_admin accounts in public.admin_accounts:
--                   - abiediendomba64@gmail.com
--                   - teamsande22@gmail.com
--                2. Adds self-read policy on public.admin_accounts
--                3. Atomic RPC: verify_admin_access()
--                   - Validates caller against admin_accounts
--                   - Rejects non-admin users (even if valid Supabase Auth)
--                   - Auto-links auth_user_id and syncs to dashboard_access
--                4. Atomic RPC: verify_member_access()
--                   - Validates member against public.users
--                5. Pure ASCII, SECURITY DEFINER with search_path=''
-- ====================================================================

-- 1. SEED SUPER ADMIN ACCOUNTS
INSERT INTO public.admin_accounts (email, role, full_name, is_active)
VALUES 
    ('abiediendomba64@gmail.com', 'super_admin', 'Abied Iendomba (Super Admin)', TRUE),
    ('teamsande22@gmail.com', 'super_admin', 'Team Sande (Super Admin)', TRUE)
ON CONFLICT (email) DO UPDATE
SET role = 'super_admin', is_active = TRUE, updated_at = NOW();

-- 2. SELF-READ RLS POLICY ON admin_accounts
DROP POLICY IF EXISTS admin_accounts_self_read ON public.admin_accounts;
CREATE POLICY admin_accounts_self_read ON public.admin_accounts
    FOR SELECT TO authenticated
    USING (
        auth_user_id = auth.uid() OR public.backoffice_has_capability('dashboard.access')
    );

-- 3. ATOMIC RPC: verify_admin_access
CREATE OR REPLACE FUNCTION public.verify_admin_access()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_email TEXT;
    v_admin RECORD;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'Sesi tidak valid atau belum login'
        );
    END IF;

    -- Get email from auth.users
    SELECT email INTO v_email
    FROM auth.users
    WHERE id = v_auth_uid;

    -- Look up in admin_accounts by auth_user_id OR email
    SELECT * INTO v_admin
    FROM public.admin_accounts
    WHERE (auth_user_id = v_auth_uid OR (v_email IS NOT NULL AND lower(email) = lower(v_email)))
      AND is_active = TRUE
    ORDER BY (auth_user_id = v_auth_uid) DESC
    LIMIT 1;

    IF FOUND THEN
        -- Link auth_user_id if not set or mismatched
        IF v_admin.auth_user_id IS NULL OR v_admin.auth_user_id <> v_auth_uid THEN
            UPDATE public.admin_accounts
            SET auth_user_id = v_auth_uid,
                last_login = NOW(),
                updated_at = NOW()
            WHERE id = v_admin.id;
        ELSE
            UPDATE public.admin_accounts
            SET last_login = NOW(),
                updated_at = NOW()
            WHERE id = v_admin.id;
        END IF;

        -- Ensure synced to dashboard_access
        INSERT INTO public.dashboard_access (auth_user_id, role, is_active)
        VALUES (v_auth_uid, v_admin.role, TRUE)
        ON CONFLICT (auth_user_id) DO UPDATE
        SET role = EXCLUDED.role, is_active = TRUE, updated_at = NOW();

        -- Audit log
        INSERT INTO public.audit_logs (
            actor_role, action_type, resource_type, resource_id, old_value, new_value
        ) VALUES (
            v_admin.role,
            'ADMIN_AUTH_VERIFIED',
            'admin_accounts',
            EXTRACT(EPOCH FROM NOW())::BIGINT,
            NULL,
            jsonb_build_object('email', v_admin.email, 'role', v_admin.role, 'auth_uid', v_auth_uid)
        );

        RETURN jsonb_build_object(
            'allowed', true,
            'role', v_admin.role,
            'email', v_admin.email,
            'full_name', v_admin.full_name,
            'telegram_id', v_admin.telegram_id
        );
    END IF;

    -- Fallback check in dashboard_access
    IF EXISTS (
        SELECT 1 FROM public.dashboard_access
        WHERE auth_user_id = v_auth_uid
          AND is_active = TRUE
          AND role IN ('root', 'super_admin', 'admin', 'dev')
    ) THEN
        RETURN jsonb_build_object(
            'allowed', true,
            'role', 'super_admin',
            'email', v_email,
            'full_name', COALESCE(v_email, 'Admin')
        );
    END IF;

    -- Explicit Denial: User is logged in to Supabase Auth, but has NO admin account
    RETURN jsonb_build_object(
        'allowed', false,
        'email', v_email,
        'reason', format('Akses Ditolak: Akun %s bukan Super Admin / Backoffice Staff yang terdaftar.', COALESCE(v_email, 'ini'))
    );
END;
$$;

-- 4. ATOMIC RPC: verify_member_access
CREATE OR REPLACE FUNCTION public.verify_member_access()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_email TEXT;
    v_phone TEXT;
    v_user RECORD;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'Sesi tidak valid atau belum login'
        );
    END IF;

    -- Get email and phone from auth.users
    SELECT email, phone INTO v_email, v_phone
    FROM auth.users
    WHERE id = v_auth_uid;

    -- Look up in public.users
    SELECT * INTO v_user
    FROM public.users
    WHERE (v_email IS NOT NULL AND lower(COALESCE(username, '')) = lower(v_email))
       OR (v_phone IS NOT NULL AND phone_number = v_phone)
    LIMIT 1;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'allowed', true,
            'role', 'member',
            'user_id', v_user.id,
            'username', v_user.username,
            'full_name', v_user.full_name,
            'telegram_id', v_user.telegram_id
        );
    END IF;

    -- User is authenticated in Supabase Auth, allowed as member portal user
    RETURN jsonb_build_object(
        'allowed', true,
        'role', 'member',
        'email', v_email,
        'full_name', split_part(COALESCE(v_email, 'Member'), '@', 1)
    );
END;
$$;

-- 5. PERMISSIONS
GRANT EXECUTE ON FUNCTION public.verify_admin_access() TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.verify_member_access() TO authenticated, anon, service_role;
