-- ====================================================================
-- MIGRATION: 20260927000029_p0_5_identity_bridge.sql
-- DESCRIPTION: Phase P0.5 Identity Bridge
--              1. Adds public.users.auth_user_id linking to auth.users(id)
--              2. Backfills users with matching email
--              3. Upgrades verify_member_access RPC to O(1) auth_user_id lookup with auto-linking fallback
--              4. Applies strict Security Definer access matrix
-- ====================================================================

-- 1. Add auth_user_id column & index to public.users
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'auth_user_id'
    ) THEN
        ALTER TABLE public.users
        ADD COLUMN auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_auth_user_id ON public.users(auth_user_id);

-- 2. Backfill existing public.users where email matches auth.users
UPDATE public.users u
SET auth_user_id = au.id
FROM auth.users au
WHERE u.auth_user_id IS NULL
  AND u.email IS NOT NULL
  AND lower(trim(u.email)) = lower(trim(au.email));

-- 3. Upgrade verify_member_access with O(1) indexed lookup & auto-linking
CREATE OR REPLACE FUNCTION public.verify_member_access()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_email TEXT;
    v_user RECORD;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'Sesi autentikasi tidak valid.');
    END IF;

    -- 1. Direct O(1) indexed lookup via auth_user_id
    SELECT * INTO v_user
    FROM public.users
    WHERE auth_user_id = v_auth_uid
    LIMIT 1;

    -- 2. Fallback to email resolution + auto-link if not yet mapped
    IF NOT FOUND THEN
        SELECT email INTO v_email FROM auth.users WHERE id = v_auth_uid;

        IF v_email IS NOT NULL AND trim(v_email) <> '' THEN
            SELECT * INTO v_user
            FROM public.users
            WHERE lower(COALESCE(email, username, '')) = lower(trim(v_email))
            LIMIT 1;

            -- If matched, auto-link auth_user_id for future fast lookups
            IF FOUND THEN
                UPDATE public.users
                SET auth_user_id = v_auth_uid,
                    updated_at = NOW()
                WHERE id = v_user.id
                  AND auth_user_id IS NULL;
            END IF;
        END IF;
    END IF;

    -- 3. Evaluate active status
    IF v_user.id IS NOT NULL THEN
        IF v_user.status = 'banned' OR v_user.status = 'suspended' THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'Akun member dinonaktifkan atau diblokir.');
        END IF;

        RETURN jsonb_build_object(
            'allowed', true,
            'role', COALESCE(v_user.role, 'member'),
            'user_id', v_user.id,
            'username', v_user.username,
            'full_name', v_user.full_name
        );
    END IF;

    -- 4. Fail-closed if no identity mapping exists
    RETURN jsonb_build_object(
        'allowed', false,
        'reason', 'Akses ditolak: Akun belum terdaftar sebagai member terverifikasi.'
    );
END;
$$;

-- 4. Strict Privileges
REVOKE EXECUTE ON FUNCTION public.verify_member_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_member_access() TO authenticated, service_role;
