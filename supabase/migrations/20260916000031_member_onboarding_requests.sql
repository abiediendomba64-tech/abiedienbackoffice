-- Migration: 20260916000031_member_onboarding_requests.sql
-- ADDITIVE only — no replay of legacy migrations, no drift touch.
--
-- Purpose: separate NEW member registration from link_identity().
--   - link_identity()  : claim a PRE-PROVISIONED public.users row (existing member).
--   - this table       : a genuinely NEW applicant waits for admin review
--                        (PENDING_REVIEW -> APPROVED -> provision public.users).
-- Contract: auth identity (auth.users) is NOT business membership.

CREATE TABLE IF NOT EXISTS public.member_onboarding_requests (
    id BIGSERIAL PRIMARY KEY,
    auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    telegram_username VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING_REVIEW',
    reviewed_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT member_onboarding_valid_status
        CHECK (status IN ('PENDING_REVIEW','APPROVED','REJECTED')),
    CONSTRAINT member_onboarding_one_pending_per_auth
        UNIQUE (auth_user_id, status)
);
CREATE INDEX IF NOT EXISTS idx_member_onboarding_status
    ON public.member_onboarding_requests (status, created_at);

-- RLS: an authenticated user may insert exactly one request for themselves
-- and read their own request. Everything else is admin/service_role only.
ALTER TABLE public.member_onboarding_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY member_onboarding_insert_own
    ON public.member_onboarding_requests
    FOR INSERT TO authenticated
    WITH CHECK (auth_user_id = auth.uid());

CREATE POLICY member_onboarding_select_own
    ON public.member_onboarding_requests
    FOR SELECT TO authenticated
    USING (auth_user_id = auth.uid());
