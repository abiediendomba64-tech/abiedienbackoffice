-- ====================================================================
-- MIGRATION: 20260914000025_fix_dashboard_access_and_admin_sync.sql
-- DESCRIPTION: Relaxes constraints on dashboard_access and hardens
--              verify_admin_access() RPC to eliminate 401 Unauthorized errors.
--              Features:
--                1. Drop NOT NULL on dashboard_access.user_id so UUID-based
--                   admin_accounts can sync seamlessly without FK collisions.
--                2. Broaden role check constraint on dashboard_access.
--                3. Update verify_admin_access() with super admin whitelist
--                   and robust auto-linking for both auth_user_id and email.
--                4. Ensure super admin records exist in admin_accounts.
--                5. Pure ASCII, idempotent, SECURITY DEFINER.
-- ====================================================================

-- 1. RELAX CONSTRAINTS ON dashboard_access
ALTER TABLE public.dashboard_access 
    ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.dashboard_access 
    DROP CONSTRAINT IF EXISTS valid_dashboard_role;

ALTER TABLE public.dashboard_access 
    ADD CONSTRAINT valid_dashboard_role 
    CHECK (role IN ('root', 'super_admin', 'admin', 'dev', 'operator', 'member'));

-- 2. ENSURE SUPER ADMIN SEED RECORDS
INSERT INTO public.admin_accounts (email, role, full_name, is_active)
VALUES 
    ('abiediendomba64@gmail.com', 'super_admin', 'Abied Iendomba (Super Admin)', TRUE),
    ('teamsande22@gmail.com', 'super_admin', 'Team Sande (Super Admin)', TRUE)
ON CONFLICT (email) DO UPDATE
SET role = 'super_admin', is_active = TRUE, updated_at = NOW();

-- 3. HARDENED ATOMIC RPC: verify_admin_access
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
    v_is_whitelist BOOLEAN := FALSE;
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

    -- Check Super Admin Whitelist
    IF v_email IS NOT NULL AND lower(v_email) IN ('abiediendomba64@gmail.com', 'teamsande22@gmail.com') THEN
        v_is_whitelist := TRUE;
    END IF;

    -- Look up in admin_accounts by auth_user_id OR email
    SELECT * INTO v_admin
    FROM public.admin_accounts
    WHERE (auth_user_id = v_auth_uid OR (v_email IS NOT NULL AND lower(email) = lower(v_email)))
      AND is_active = TRUE
    ORDER BY (auth_user_id = v_auth_uid) DESC
    LIMIT 1;

    IF FOUND OR v_is_whitelist THEN
        -- Auto-link auth_user_id in admin_accounts
        IF v_email IS NOT NULL THEN
            UPDATE public.admin_accounts
            SET auth_user_id = v_auth_uid,
                role = CASE WHEN v_is_whitelist THEN 'super_admin' ELSE COALESCE(v_admin.role, 'super_admin') END,
                is_active = TRUE,
                last_login = NOW(),
                updated_at = NOW()
            WHERE lower(email) = lower(v_email);
        END IF;

        -- Sync to dashboard_access (user_id is nullable now)
        INSERT INTO public.dashboard_access (auth_user_id, role, is_active)
        VALUES (
            v_auth_uid, 
            CASE WHEN v_is_whitelist THEN 'super_admin' ELSE COALESCE(v_admin.role, 'super_admin') END, 
            TRUE
        )
        ON CONFLICT (auth_user_id) DO UPDATE
        SET role = EXCLUDED.role, is_active = TRUE, updated_at = NOW();

        -- Audit log (fail-safe)
        BEGIN
            INSERT INTO public.audit_logs (
                actor_role, action_type, resource_type, resource_id, old_value, new_value
            ) VALUES (
                CASE WHEN v_is_whitelist THEN 'super_admin' ELSE COALESCE(v_admin.role, 'super_admin') END,
                'ADMIN_AUTH_VERIFIED',
                'admin_accounts',
                EXTRACT(EPOCH FROM NOW())::BIGINT,
                NULL,
                jsonb_build_object('email', v_email, 'role', 'super_admin', 'auth_uid', v_auth_uid)
            );
        EXCEPTION WHEN OTHERS THEN
            -- Suppress audit log insert failure to prevent login abort
            NULL;
        END;

        RETURN jsonb_build_object(
            'allowed', true,
            'role', CASE WHEN v_is_whitelist THEN 'super_admin' ELSE COALESCE(v_admin.role, 'super_admin') END,
            'email', v_email,
            'full_name', COALESCE(v_admin.full_name, split_part(COALESCE(v_email, 'Super Admin'), '@', 1)),
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

-- 4. HARDENED ATOMIC RPC: verify_member_access
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
    WHERE (v_email IS NOT NULL AND lower(COALESCE(email, username, '')) = lower(v_email))
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
