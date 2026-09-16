-- ====================================================================
-- MIGRATION: 20260928000030_link_identity_rpc.sql
-- DESCRIPTION: Phase P0.5 — Explicit Identity Linking RPC
--
-- Provides link_identity() as the ONLY sanctioned mutation path for
-- connecting a public.users row to an auth.users row.
--
-- Contract:
--   authenticated JWT
--     ↓
--   verify email_confirmed_at IS NOT NULL
--     ↓
--   verify one-to-one match (no duplicate email either side)
--     ↓
--   UPDATE users.auth_user_id (only if currently NULL)
--     ↓
--   audit log entry
--     ↓
--   return result
--
-- This function is intentionally SEPARATE from verify_member_access().
-- Resolvers must not have identity mutation side effects.
-- ====================================================================

SET lock_timeout    = '5s';
SET statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.link_identity()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid       UUID   := auth.uid();
    v_email          TEXT;
    v_confirmed_at   TIMESTAMPTZ;
    v_auth_dup_count INTEGER;
    v_pub_user       RECORD;
    v_pub_dup_count  INTEGER;
BEGIN
    -- 1. Caller must be authenticated
    IF v_auth_uid IS NULL THEN
        RETURN jsonb_build_object(
            'linked', false,
            'reason', 'auth_required'
        );
    END IF;

    -- 2. Already linked — fast path (idempotent)
    IF EXISTS (
        SELECT 1 FROM public.users WHERE auth_user_id = v_auth_uid
    ) THEN
        RETURN jsonb_build_object(
            'linked', true,
            'reason', 'already_linked'
        );
    END IF;

    -- 3. Fetch auth identity; email must be confirmed
    SELECT email, email_confirmed_at
    INTO   v_email, v_confirmed_at
    FROM   auth.users
    WHERE  id = v_auth_uid;

    IF v_email IS NULL OR trim(v_email) = '' THEN
        RETURN jsonb_build_object(
            'linked', false,
            'reason', 'no_email_on_auth_account'
        );
    END IF;

    IF v_confirmed_at IS NULL THEN
        RETURN jsonb_build_object(
            'linked', false,
            'reason', 'email_not_confirmed'
        );
    END IF;

    -- 4. Ensure uniqueness on auth side (no other auth user shares this email)
    SELECT COUNT(*)
    INTO   v_auth_dup_count
    FROM   auth.users
    WHERE  lower(trim(email)) = lower(trim(v_email))
      AND  id                <> v_auth_uid;

    IF v_auth_dup_count > 0 THEN
        RETURN jsonb_build_object(
            'linked', false,
            'reason', 'duplicate_email_in_auth'
        );
    END IF;

    -- 5. Find the matching public.users row (must be exactly one, unmapped)
    SELECT COUNT(*)
    INTO   v_pub_dup_count
    FROM   public.users
    WHERE  lower(COALESCE(email, '')) = lower(trim(v_email))
      AND  auth_user_id IS NULL;

    IF v_pub_dup_count = 0 THEN
        RETURN jsonb_build_object(
            'linked', false,
            'reason', 'no_matching_public_user'
        );
    END IF;

    IF v_pub_dup_count > 1 THEN
        RETURN jsonb_build_object(
            'linked', false,
            'reason', 'duplicate_email_in_public_users'
        );
    END IF;

    SELECT * INTO v_pub_user
    FROM   public.users
    WHERE  lower(COALESCE(email, '')) = lower(trim(v_email))
      AND  auth_user_id IS NULL
    LIMIT  1;

    -- 6. Write the link (guard: auth_user_id must still be NULL at write time)
    UPDATE public.users
    SET    auth_user_id = v_auth_uid,
           updated_at   = NOW()
    WHERE  id           = v_pub_user.id
      AND  auth_user_id IS NULL;

    IF NOT FOUND THEN
        -- Race condition: another request linked this row between steps 5 and 6
        RETURN jsonb_build_object(
            'linked', false,
            'reason', 'concurrent_link_conflict'
        );
    END IF;

    -- 7. Audit trail (fire-and-forget — failure here does not roll back link)
    BEGIN
        INSERT INTO public.audit_logs (
            actor_role,
            action_type,
            resource_type,
            resource_id,
            reason,
            new_value
        ) VALUES (
            'system',
            'identity_linked',
            'users',
            v_pub_user.id,
            'explicit_link_identity_rpc',
            jsonb_build_object(
                'public_user_id', v_pub_user.id,
                'auth_user_id',   v_auth_uid,
                'email',          lower(trim(v_email)),
                'linked_at',      NOW()
            )
        );
    EXCEPTION WHEN OTHERS THEN
        -- Audit failure is non-fatal; link is already committed
        RAISE WARNING 'link_identity: audit insert failed: %', SQLERRM;
    END;

    RETURN jsonb_build_object(
        'linked',         true,
        'reason',         'linked',
        'public_user_id', v_pub_user.id
    );
END;
$$;

-- Only authenticated users and service_role may call this.
-- anon and PUBLIC cannot trigger identity linking.
REVOKE EXECUTE ON FUNCTION public.link_identity() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.link_identity() TO authenticated, service_role;
