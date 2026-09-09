-- ====================================================================
-- MIGRATION: 20260910000011_domain_pipeline_and_notifications.sql
-- DESCRIPTION: Phase C — Domain System Pipeline & Notification Tracking:
--              1. public.domain_inventory (Official platform domain asset registry)
--              2. public.domain_assignments (Domain ownership records linked to users)
--              3. public.telegram_notification_log (Factual notification status tracking)
--              4. public.create_domain_request_ticket (Canonical ticket-based domain workflow)
-- ====================================================================

-- 1. Table: domain_inventory
CREATE TABLE IF NOT EXISTS public.domain_inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_name VARCHAR(255) UNIQUE NOT NULL,
    tld VARCHAR(30) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'available',
    registrar VARCHAR(100),
    cloudflare_zone_id VARCHAR(100),
    dns_status VARCHAR(50) NOT NULL DEFAULT 'unconfigured',
    assigned_to_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    registered_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_domain_inventory_status CHECK (status IN ('available', 'reserved', 'assigned', 'suspended')),
    CONSTRAINT valid_dns_status CHECK (dns_status IN ('unconfigured', 'pending_verification', 'active', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_domain_inventory_status ON public.domain_inventory(status);
CREATE INDEX IF NOT EXISTS idx_domain_inventory_assigned_user ON public.domain_inventory(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_domain_inventory_tld ON public.domain_inventory(tld);

-- 2. Table: domain_assignments
CREATE TABLE IF NOT EXISTS public.domain_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_id UUID NOT NULL REFERENCES public.domain_inventory(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    ticket_id BIGINT REFERENCES public.tickets(id) ON DELETE SET NULL,
    assigned_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at TIMESTAMPTZ,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    notes TEXT,

    CONSTRAINT valid_assignment_status CHECK (status IN ('active', 'released', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_domain_assignments_user_id ON public.domain_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_domain_assignments_inventory ON public.domain_assignments(inventory_id);
CREATE INDEX IF NOT EXISTS idx_domain_assignments_ticket_id ON public.domain_assignments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_domain_assignments_status ON public.domain_assignments(status);

-- 3. Table: telegram_notification_log
CREATE TABLE IF NOT EXISTS public.telegram_notification_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_chat_id BIGINT NOT NULL,
    message_text TEXT NOT NULL,
    context_type VARCHAR(50), -- 'ticket', 'domain', 'claim', 'system', 'auth'
    context_id VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    attempt_count INT NOT NULL DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    telegram_message_id BIGINT,
    error_code VARCHAR(100),
    error_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_notification_status CHECK (status IN ('queued', 'sending', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_tel_notif_status ON public.telegram_notification_log(status);
CREATE INDEX IF NOT EXISTS idx_tel_notif_recipient ON public.telegram_notification_log(recipient_chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tel_notif_context ON public.telegram_notification_log(context_type, context_id);

-- 4. Canonical Domain Request Stored Procedure via Tickets
CREATE OR REPLACE FUNCTION public.create_domain_request_ticket(
    p_telegram_user_id BIGINT,
    p_requested_domain VARCHAR(255),
    p_request_type VARCHAR(50) DEFAULT 'new',
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id BIGINT;
    v_clean_domain VARCHAR(255);
    v_tld VARCHAR(30);
    v_new_ticket_id BIGINT;
    v_ticket_number VARCHAR(20);
BEGIN
    -- Normalize and clean domain string
    v_clean_domain := lower(trim(p_requested_domain));
    v_clean_domain := regexp_replace(v_clean_domain, '^https?://', '');
    v_clean_domain := regexp_replace(v_clean_domain, '/.*$', '');

    IF v_clean_domain NOT LIKE '%.%' OR length(v_clean_domain) < 4 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'INVALID_DOMAIN_SYNTAX',
            'message', 'Format nama domain tidak valid.'
        );
    END IF;

    -- Extract TLD
    v_tld := substring(v_clean_domain from '\.([a-z0-9-]+)$');

    -- Resolve canonical internal user
    SELECT linked_user_id INTO v_user_id
    FROM public.telegram_users
    WHERE telegram_user_id = p_telegram_user_id;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'UNREGISTERED_USER',
            'message', 'Akun Telegram belum terdaftar sebagai member resmi. Silakan selesaikan registrasi terlebih dahulu.'
        );
    END IF;

    -- Create canonical ticket record
    INSERT INTO public.tickets (
        user_id,
        category,
        priority,
        status,
        title,
        description,
        collected_data
    ) VALUES (
        v_user_id,
        'domain_request',
        'medium',
        'pending',
        'Domain Request: ' || v_clean_domain,
        COALESCE(p_notes, 'Permintaan pemrosesan domain via sistem bot.'),
        jsonb_build_object(
            'requested_domain', v_clean_domain,
            'tld', v_tld,
            'request_type', p_request_type,
            'telegram_user_id', p_telegram_user_id
        )
    )
    RETURNING id, ticket_number INTO v_new_ticket_id, v_ticket_number;

    -- Record lifecycle transition event
    INSERT INTO public.ticket_events (
        ticket_id,
        actor_id,
        actor_role,
        event_type,
        old_status,
        new_status,
        notes,
        metadata
    ) VALUES (
        v_new_ticket_id,
        v_user_id,
        'member',
        'STATUS_CHANGE',
        'draft',
        'pending',
        'Pengajuan domain order baru diajukan oleh member.',
        jsonb_build_object('domain', v_clean_domain, 'tld', v_tld)
    );

    RETURN jsonb_build_object(
        'success', true,
        'ticket_id', v_new_ticket_id,
        'ticket_number', v_ticket_number,
        'domain', v_clean_domain,
        'status', 'pending',
        'user_id', v_user_id
    );
END;
$$;

-- 5. Row Level Security Configuration
ALTER TABLE public.domain_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_notification_log ENABLE ROW LEVEL SECURITY;

-- telegram_notification_log is strictly service_role only (Default Deny for client)
-- No public/anon/authenticated policies needed.

-- domain_inventory: Operators with member.read capability can view
DROP POLICY IF EXISTS domain_inventory_operator_read ON public.domain_inventory;
CREATE POLICY domain_inventory_operator_read ON public.domain_inventory
    FOR SELECT
    USING (
        public.backoffice_has_capability('member.read')
    );

-- domain_assignments: Operators with member.read capability can view
DROP POLICY IF EXISTS domain_assignments_operator_read ON public.domain_assignments;
CREATE POLICY domain_assignments_operator_read ON public.domain_assignments
    FOR SELECT
    USING (
        public.backoffice_has_capability('member.read')
    );

-- Revoke function execute from PUBLIC and anon
REVOKE EXECUTE ON FUNCTION public.create_domain_request_ticket(BIGINT, VARCHAR, VARCHAR, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_domain_request_ticket(BIGINT, VARCHAR, VARCHAR, TEXT) TO authenticated, service_role;
