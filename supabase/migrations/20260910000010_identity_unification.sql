-- ====================================================================
-- MIGRATION: 20260910000010_identity_unification.sql
-- DESCRIPTION: Phase B — Identity Unification:
--              1. Link telegram_users to canonical public.users(id) via linked_user_id
--              2. Add canonical user_id foreign key to public.claims
--              3. Atomic transaction-locked claim submission & rate-limiting engine
-- ====================================================================

-- 1. Link telegram_users to canonical public.users
ALTER TABLE public.telegram_users 
    ADD COLUMN IF NOT EXISTS linked_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_telegram_users_linked_user_id 
    ON public.telegram_users(linked_user_id);

-- Backfill link if users already exist with matching telegram_id
UPDATE public.telegram_users tu
SET linked_user_id = u.id, updated_at = NOW()
FROM public.users u
WHERE tu.telegram_user_id = u.telegram_id
  AND tu.linked_user_id IS NULL;

-- 2. Link claims to canonical public.users
ALTER TABLE public.claims
    ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_claims_user_id 
    ON public.claims(user_id);

-- Backfill claims.user_id from telegram_users.linked_user_id
UPDATE public.claims c
SET user_id = tu.linked_user_id, updated_at = NOW()
FROM public.telegram_users tu
WHERE c.telegram_user_id = tu.telegram_user_id
  AND c.user_id IS NULL
  AND tu.linked_user_id IS NOT NULL;

-- 3. Atomic Claim Submission Function with Transactional Advisory Lock
-- Guarantees race-free check-and-insert for claim limits
CREATE OR REPLACE FUNCTION public.submit_claim_atomic(
    p_telegram_user_id BIGINT,
    p_claim_type VARCHAR(100),
    p_amount NUMERIC(14, 2),
    p_notes TEXT,
    p_evidence_path TEXT,
    p_submitted_by UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_canonical_user_id BIGINT;
    v_recent_count INT;
    v_active_exists BOOLEAN;
    v_new_claim_id UUID;
    v_caller_auth_id UUID := auth.uid();
BEGIN
    -- Input validation
    IF p_evidence_path IS NULL OR length(trim(p_evidence_path)) < 3 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'INVALID_EVIDENCE',
            'message', 'Bukti transfer / evidence file path wajib dilampirkan.'
        );
    END IF;

    -- A. Transactional Advisory Lock: prevents concurrent race conditions for this user
    -- Hash of the telegram user id guarantees that requests from the same user are serialized
    PERFORM pg_advisory_xact_lock(hashtext('claim_lock_' || p_telegram_user_id::text));

    -- B. Lookup canonical internal user identity
    SELECT linked_user_id INTO v_canonical_user_id
    FROM public.telegram_users
    WHERE telegram_user_id = p_telegram_user_id;

    -- C. Atomic Rate Limit Check: max 3 claims submitted per 24 hours
    SELECT COUNT(*) INTO v_recent_count
    FROM public.claims
    WHERE telegram_user_id = p_telegram_user_id
      AND created_at >= NOW() - INTERVAL '24 hours';

    IF v_recent_count >= 3 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'RATE_LIMIT_EXCEEDED',
            'message', 'Batas maksimal 3 klaim per 24 jam tercapai. Silakan coba kembali besok.'
        );
    END IF;

    -- D. Check for existing in-flight claim of the same type
    SELECT EXISTS(
        SELECT 1 FROM public.claims
        WHERE telegram_user_id = p_telegram_user_id
          AND claim_type = p_claim_type
          AND status IN ('pending', 'reviewing')
    ) INTO v_active_exists;

    IF v_active_exists THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'ACTIVE_CLAIM_EXISTS',
            'message', 'Anda sudah memiliki pengajuan klaim aktif yang masih dalam antrean review.'
        );
    END IF;

    -- E. Atomic Insert
    INSERT INTO public.claims (
        user_id,
        telegram_user_id,
        submitted_by,
        claim_type,
        amount,
        notes,
        evidence_path,
        status
    ) VALUES (
        v_canonical_user_id,
        p_telegram_user_id,
        COALESCE(p_submitted_by, v_caller_auth_id),
        p_claim_type,
        p_amount,
        p_notes,
        p_evidence_path,
        'pending'
    )
    RETURNING id INTO v_new_claim_id;

    -- F. Record Audit Log
    INSERT INTO public.audit_logs (
        actor_id,
        actor_role,
        action_type,
        resource_type,
        resource_id,
        old_value,
        new_value
    ) VALUES (
        v_canonical_user_id,
        'member',
        'CLAIM_SUBMITTED',
        'claims',
        1,
        jsonb_build_object('telegram_user_id', p_telegram_user_id),
        jsonb_build_object(
            'claim_id', v_new_claim_id,
            'claim_type', p_claim_type,
            'amount', p_amount,
            'user_id', v_canonical_user_id
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'claim_id', v_new_claim_id,
        'status', 'pending',
        'user_id', v_canonical_user_id,
        'created_at', NOW()
    );
END;
$$;

-- 4. Update check_claim_rate_limit with advisory lock
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
    PERFORM pg_advisory_xact_lock(hashtext('claim_lock_' || p_telegram_user_id::text));

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

-- Revoke execute from PUBLIC and anon
REVOKE EXECUTE ON FUNCTION public.submit_claim_atomic(BIGINT, VARCHAR, NUMERIC, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_claim_atomic(BIGINT, VARCHAR, NUMERIC, TEXT, TEXT, UUID) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.check_claim_rate_limit(BIGINT, VARCHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_claim_rate_limit(BIGINT, VARCHAR) TO authenticated, service_role;
