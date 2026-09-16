-- ====================================================================
-- MIGRATION: 20260927000029_p0_5_identity_bridge.sql
-- DESCRIPTION: Phase P0.5 Identity Bridge — Schema + Read-Only Resolver
--              1. Adds public.users.auth_user_id with named constraints
--              2. Collision-safe email backfill (confirmed + unique-on-email)
--              3. Read-only verify_member_access() — no side effects
--              4. Strict Security Definer access matrix
--
-- IMPORTANT: Auto-link is NOT in this function.
--            Identity linking happens via link_identity() — migration 030.
-- ====================================================================

-- Prevent lock contention on a heavily-referenced table
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- ────────────────────────────────────────────────────────────────────
-- 1. Add auth_user_id column (named constraint only — UNIQUE already
--    creates an index; an explicit CREATE INDEX would be redundant)
--
-- PostgreSQL does not support ADD CONSTRAINT IF NOT EXISTS for UNIQUE/FK.
-- Each step is guarded individually via pg_constraint / information_schema.
-- ────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    -- 1a. Column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'users'
          AND column_name  = 'auth_user_id'
    ) THEN
        ALTER TABLE public.users ADD COLUMN auth_user_id UUID;
    END IF;

    -- 1b. Unique constraint (creates backing index implicitly)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.users'::regclass
          AND conname  = 'users_auth_user_id_key'
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT users_auth_user_id_key
            UNIQUE (auth_user_id);
    END IF;

    -- 1c. Foreign key (separate from unique for clarity in drift reviews)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.users'::regclass
          AND conname  = 'users_auth_user_id_fkey'
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT users_auth_user_id_fkey
            FOREIGN KEY (auth_user_id)
            REFERENCES auth.users(id)
            ON DELETE SET NULL;
    END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- 2. Collision-safe email backfill
--
-- Strategy: group by norm_email, keep only emails that appear exactly
-- once (HAVING count(*) = 1) — then join to source table to recover
-- the actual UUID. max()/min() do not exist for UUID in PostgreSQL.
--
-- auth_unique  : one confirmed auth row per norm_email
-- public_unique: one unmapped public row per norm_email
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
    v_matched INTEGER;
    v_skipped INTEGER;
BEGIN
    WITH
    -- Step 1: find norm_emails that are unique on the auth side (confirmed)
    auth_dedup AS (
        SELECT lower(trim(email)) AS norm_email
        FROM   auth.users
        WHERE  email              IS NOT NULL
          AND  trim(email)        <> ''
          AND  email_confirmed_at IS NOT NULL
        GROUP BY lower(trim(email))
        HAVING count(*) = 1
    ),
    -- Step 2: recover the single auth.users row for each unique email
    auth_unique AS (
        SELECT au.id AS auth_user_id, d.norm_email
        FROM   auth_dedup d
        JOIN   auth.users au
          ON   lower(trim(au.email)) = d.norm_email
         AND   au.email_confirmed_at IS NOT NULL
    ),
    -- Step 3: find norm_emails that are unique on the public side (unmapped)
    pub_dedup AS (
        SELECT lower(trim(email)) AS norm_email
        FROM   public.users
        WHERE  auth_user_id IS NULL
          AND  email        IS NOT NULL
          AND  trim(email)  <> ''
        GROUP BY lower(trim(email))
        HAVING count(*) = 1
    ),
    -- Step 4: recover the single public.users row for each unique email
    public_unique AS (
        SELECT pu.id AS public_user_id, d.norm_email
        FROM   pub_dedup d
        JOIN   public.users pu
          ON   lower(trim(COALESCE(pu.email, ''))) = d.norm_email
         AND   pu.auth_user_id IS NULL
    )
    UPDATE public.users AS u
    SET    auth_user_id = a.auth_user_id,
           updated_at   = NOW()
    FROM   auth_unique   AS a
    JOIN   public_unique AS p USING (norm_email)
    WHERE  u.id          = p.public_user_id
      AND  u.auth_user_id IS NULL;

    GET DIAGNOSTICS v_matched = ROW_COUNT;

    -- Count ambiguous auth emails (skipped)
    SELECT COUNT(DISTINCT lower(trim(email)))
    INTO   v_skipped
    FROM   auth.users
    WHERE  email IS NOT NULL AND email_confirmed_at IS NOT NULL
    GROUP  BY lower(trim(email))
    HAVING COUNT(*) > 1;

    RAISE NOTICE 'P0.5 backfill: matched=%, skipped_ambiguous_auth_emails=%',
                 v_matched, COALESCE(v_skipped, 0);
END $$;


-- ────────────────────────────────────────────────────────────────────
-- 3. Read-only verify_member_access()
--
-- Contract:
--   JWT → resolve canonical identity → return authorization result
--
-- Must NOT mutate any row. Identity linking is handled by link_identity()
-- which is defined in migration 030.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_member_access()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_auth_uid UUID := auth.uid();
    v_email    TEXT;
    v_user     RECORD;
BEGIN
    IF v_auth_uid IS NULL THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason',  'Sesi autentikasi tidak valid.'
        );
    END IF;

    -- 1. O(1) primary path: direct auth_user_id lookup
    SELECT * INTO v_user
    FROM   public.users
    WHERE  auth_user_id = v_auth_uid
    LIMIT  1;

    -- 2. Read-only email fallback (transition period, pre-linking)
    --    Requires: email confirmed, no existing mapping on the public row.
    --    Does NOT write. Call link_identity() to persist the link.
    IF NOT FOUND THEN
        SELECT email INTO v_email
        FROM   auth.users
        WHERE  id                = v_auth_uid
          AND  email_confirmed_at IS NOT NULL;

        IF v_email IS NOT NULL AND trim(v_email) <> '' THEN
            SELECT * INTO v_user
            FROM   public.users
            WHERE  lower(COALESCE(email, '')) = lower(trim(v_email))
              AND  auth_user_id IS NULL   -- skip rows claimed by another auth user
            LIMIT  1;
        END IF;
    END IF;

    -- 3. Evaluate active status
    IF v_user.id IS NOT NULL THEN
        IF v_user.status IN ('banned', 'suspended') THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'reason',  'Akun member dinonaktifkan atau diblokir.'
            );
        END IF;

        RETURN jsonb_build_object(
            'allowed',   true,
            'role',      COALESCE(v_user.role, 'member'),
            'user_id',   v_user.id,
            'username',  v_user.username,
            'full_name', v_user.full_name
        );
    END IF;

    -- 4. Fail-closed: no identity mapping found
    RETURN jsonb_build_object(
        'allowed', false,
        'reason',  'Akses ditolak: Akun belum terdaftar sebagai member terverifikasi.'
    );
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 4. Strict privilege matrix
-- ────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.verify_member_access() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.verify_member_access() TO authenticated, service_role;
