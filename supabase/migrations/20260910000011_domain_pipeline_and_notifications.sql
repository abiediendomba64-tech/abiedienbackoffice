-- ====================================================================
-- MIGRATION: 20260910000011_domain_pipeline_and_notifications.sql
-- DESCRIPTION: Phase C — Domain System Pipeline & Notification Tracking:
--              1. public.domain_inventory (Official platform domain asset registry)
--              2. public.domain_assignments (Domain ownership records linked to users)
--              3. public.telegram_notification_log (Factual notification status tracking)
--              4. public.create_domain_request_ticket (Canonical ticket-based domain workflow)
--
-- LIFECYCLE MAPPING (Correction):
-- 1. Ticket FSM state remains canonical for support workflow (tickets.status).
-- 2. domain_inventory stores platform-owned domain resource state (available, reserved, assigned, suspended).
-- 3. domain_assignments stores ownership and explicit provisioning lifecycle:
--    ('pending', 'reviewing', 'approved', 'provisioning', 'dns_pending', 'active', 'rejected', 'cancelled', 'released', 'revoked')
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
    -- NOTE: Domain ownership is tracked exclusively in domain_assignments.
    -- No direct user FK here to avoid denormalization and state drift.
    registered_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_domain_inventory_status CHECK (status IN ('available', 'reserved', 'assigned', 'suspended')),
    CONSTRAINT valid_dns_status CHECK (dns_status IN ('unconfigured', 'pending_verification', 'active', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_domain_inventory_status ON public.domain_inventory(status);
CREATE INDEX IF NOT EXISTS idx_domain_inventory_tld ON public.domain_inventory(tld);

-- 2. Table: domain_assignments
CREATE TABLE IF NOT EXISTS public.domain_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_id UUID REFERENCES public.domain_inventory(id) ON DELETE RESTRICT,
    -- inventory_id is nullable: assignment record may exist before a specific inventory item is reserved
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    -- RESTRICT not CASCADE: losing a user must not silently delete provisioning history
    ticket_id BIGINT REFERENCES public.tickets(id) ON DELETE SET NULL,
    assigned_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at TIMESTAMPTZ,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    notes TEXT,

    CONSTRAINT valid_assignment_status CHECK (status IN (
        'pending', 'reviewing', 'approved', 'provisioning', 'dns_pending', 
        'active', 'rejected', 'cancelled', 'released', 'revoked'
    ))
);

CREATE INDEX IF NOT EXISTS idx_domain_assignments_user_id ON public.domain_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_domain_assignments_inventory ON public.domain_assignments(inventory_id);
CREATE INDEX IF NOT EXISTS idx_domain_assignments_ticket_id ON public.domain_assignments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_domain_assignments_status ON public.domain_assignments(status);

-- 2.1 State Transition Validation for domain_assignments
CREATE OR REPLACE FUNCTION public.validate_domain_assignment_transition()
RETURNS TRIGGER AS $$
BEGIN
    -- Allow no-op updates
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    -- Enforce valid FSM transitions
    IF OLD.status = 'pending' AND NEW.status NOT IN ('reviewing', 'rejected', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from pending to %', NEW.status;
    END IF;
    IF OLD.status = 'reviewing' AND NEW.status NOT IN ('approved', 'rejected', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from reviewing to %', NEW.status;
    END IF;
    IF OLD.status = 'approved' AND NEW.status NOT IN ('provisioning', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from approved to %', NEW.status;
    END IF;
    IF OLD.status = 'provisioning' AND NEW.status NOT IN ('dns_pending', 'rejected', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from provisioning to %', NEW.status;
    END IF;
    IF OLD.status = 'dns_pending' AND NEW.status NOT IN ('active', 'provisioning', 'rejected', 'cancelled') THEN
        RAISE EXCEPTION 'Invalid transition from dns_pending to %', NEW.status;
    END IF;
    IF OLD.status = 'active' AND NEW.status NOT IN ('released', 'revoked') THEN
        RAISE EXCEPTION 'Invalid transition from active to %', NEW.status;
    END IF;
    IF OLD.status IN ('rejected', 'cancelled', 'released', 'revoked') THEN
        RAISE EXCEPTION 'Cannot transition from terminal state %', OLD.status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_domain_assignment_transition ON public.domain_assignments;
CREATE TRIGGER trg_validate_domain_assignment_transition
BEFORE UPDATE ON public.domain_assignments
FOR EACH ROW
EXECUTE FUNCTION public.validate_domain_assignment_transition();

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
    v_inventory_id UUID;
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

    -- Atomic duplicate guard: reject if an active request for this domain already exists for this user.
    -- Prevents spam: member sending /req_domain planet34 multiple times in quick succession.
    IF EXISTS (
        SELECT 1 FROM public.tickets
        WHERE user_id = v_user_id
          AND category = 'domain_request'
          AND status IN ('pending', 'assigned', 'in_progress', 'escalated', 'waiting_member')
          AND (collected_data->>'requested_domain') = v_clean_domain
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'DUPLICATE_REQUEST',
            'message', 'Anda sudah memiliki permintaan domain aktif untuk ' || v_clean_domain || '. Tunggu hingga permintaan sebelumnya selesai diproses.'
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

    -- Explicitly DO NOT insert into domain_inventory or domain_assignments here.
    -- Reservation and assignment happen during admin review/provisioning phase.

    -- Record lifecycle transition event
    -- actor_role resolved from users.role; default to 'member' if resolution fails (e.g., new_user transitioning)
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
        COALESCE((SELECT role FROM public.users WHERE id = v_user_id), 'member'),
        'STATUS_CHANGE',
        'draft',
        'pending',
        'Pengajuan domain order baru diajukan oleh member.',
        jsonb_build_object('domain', v_clean_domain, 'tld', v_tld, 'telegram_user_id', p_telegram_user_id)
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
-- No member-facing read policy: members see their domain status via domain_assignments
DROP POLICY IF EXISTS domain_inventory_operator_read ON public.domain_inventory;
CREATE POLICY domain_inventory_operator_read ON public.domain_inventory
    FOR SELECT
    USING (
        public.backoffice_has_capability('member.read')
    );

-- domain_assignments: Operators can manage; members can read their own records
DROP POLICY IF EXISTS domain_assignments_operator_read ON public.domain_assignments;
CREATE POLICY domain_assignments_operator_read ON public.domain_assignments
    FOR SELECT
    USING (
        public.backoffice_has_capability('member.read')
    );

-- Member self-read: a member can see their own domain assignment records.
-- This requires the member to be authenticated via Supabase Auth and have their
-- auth.uid() linked to a public.users.id via dashboard_access or a future member session.
-- NOTE: Until member Supabase Auth sessions are implemented, this policy is a placeholder.
-- Members access their data via service_role (Edge Function / Telegram bot), not direct client.
DROP POLICY IF EXISTS domain_assignments_member_self_read ON public.domain_assignments;
CREATE POLICY domain_assignments_member_self_read ON public.domain_assignments
    FOR SELECT
    USING (
        -- Placeholder: will be effective once members have Supabase Auth sessions
        -- For now, member data access is via service_role (Edge Functions)
        FALSE
    );

-- Revoke function execute from PUBLIC and anon
REVOKE EXECUTE ON FUNCTION public.create_domain_request_ticket(BIGINT, VARCHAR, VARCHAR, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_domain_request_ticket(BIGINT, VARCHAR, VARCHAR, TEXT) TO authenticated, service_role;
