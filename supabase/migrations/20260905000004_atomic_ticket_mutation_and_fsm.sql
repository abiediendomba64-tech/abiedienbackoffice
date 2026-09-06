-- ====================================================================
-- Enterprise Backoffice - Atomic Ticket Mutation & FSM Engine
-- Baseline: 20260905000001_initial_schema.sql
-- ====================================================================

-- 1. TICKET EVENTS TABLE (Event Sourcing / Transition Log)
CREATE TABLE IF NOT EXISTS public.ticket_events (
    id BIGSERIAL PRIMARY KEY,
    ticket_id BIGINT NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_role VARCHAR(50) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    old_status VARCHAR(30),
    new_status VARCHAR(30) NOT NULL,
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_id ON public.ticket_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_events_created_at ON public.ticket_events(created_at DESC);

-- Enable RLS for ticket_events (service-role only)
ALTER TABLE public.ticket_events ENABLE ROW LEVEL SECURITY;

-- 2. CAPABILITY REGISTRY
CREATE TABLE IF NOT EXISTS public.backoffice_capabilities (
    code VARCHAR(100) PRIMARY KEY,
    description TEXT NOT NULL,
    category VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.backoffice_role_capabilities (
    role VARCHAR(50) NOT NULL,
    capability_code VARCHAR(100) NOT NULL REFERENCES public.backoffice_capabilities(code) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (role, capability_code)
);

-- Seed Standard Capabilities
INSERT INTO public.backoffice_capabilities (code, description, category) VALUES
('ticket.read_own', 'Membaca tiket milik sendiri atau yang di-assign', 'tickets'),
('ticket.read_all', 'Membaca semua tiket lintas sistem', 'tickets'),
('ticket.create', 'Membuat tiket baru', 'tickets'),
('ticket.assign', 'Menetapkan petugas penanganan tiket', 'tickets'),
('ticket.transition', 'Mengubah status siklus tiket', 'tickets'),
('member.read', 'Membaca data member', 'members'),
('member.verify', 'Memverifikasi status domain dan onboarding', 'members'),
('payment.verify', 'Memverifikasi bukti transfer dan transaksi', 'payments'),
('audit.read', 'Membaca audit log sistem', 'audit')
ON CONFLICT (code) DO NOTHING;

-- Seed Role-to-Capability Mapping
INSERT INTO public.backoffice_role_capabilities (role, capability_code) VALUES
-- Member
('member', 'ticket.read_own'),
('member', 'ticket.create'),
-- Dev
('dev', 'ticket.read_own'),
('dev', 'ticket.read_all'),
('dev', 'ticket.transition'),
('dev', 'member.verify'),
-- Admin
('admin', 'ticket.read_own'),
('admin', 'ticket.read_all'),
('admin', 'ticket.create'),
('admin', 'ticket.assign'),
('admin', 'ticket.transition'),
('admin', 'member.read'),
('admin', 'member.verify'),
('admin', 'audit.read'),
-- Super Admin / Root
('super_admin', 'ticket.read_own'),
('super_admin', 'ticket.read_all'),
('super_admin', 'ticket.create'),
('super_admin', 'ticket.assign'),
('super_admin', 'ticket.transition'),
('super_admin', 'member.read'),
('super_admin', 'member.verify'),
('super_admin', 'payment.verify'),
('super_admin', 'audit.read')
ON CONFLICT (role, capability_code) DO NOTHING;

-- 3. ATOMIC FSM TICKET MUTATION RPC FUNCTION
CREATE OR REPLACE FUNCTION public.mutate_ticket_state_atomic(
    p_ticket_id BIGINT,
    p_actor_id BIGINT,
    p_new_status VARCHAR(30),
    p_assigned_to BIGINT DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_resolution_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_ticket RECORD;
    v_actor_role VARCHAR(50);
    v_has_capability BOOLEAN;
    v_is_valid_transition BOOLEAN := FALSE;
    v_old_status VARCHAR(30);
    v_result JSONB;
BEGIN
    -- 1. Fetch current ticket state
    SELECT * INTO v_ticket FROM public.tickets WHERE id = p_ticket_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ticket with id % not found', p_ticket_id;
    END IF;

    v_old_status := v_ticket.status;

    -- 2. Fetch actor role
    SELECT role INTO v_actor_role FROM public.users WHERE id = p_actor_id;
    IF v_actor_role IS NULL THEN
        RAISE EXCEPTION 'Actor with id % not found', p_actor_id;
    END IF;

    -- 3. Check capability 'ticket.transition'
    SELECT EXISTS (
        SELECT 1 FROM public.backoffice_role_capabilities
        WHERE role = v_actor_role AND capability_code = 'ticket.transition'
    ) INTO v_has_capability;

    IF NOT v_has_capability AND v_actor_role NOT IN ('super_admin', 'root') THEN
        RAISE EXCEPTION 'Actor % with role % lacks ticket.transition capability', p_actor_id, v_actor_role;
    END IF;

    -- 4. Validate Finite State Machine (FSM) Transitions
    IF v_old_status = p_new_status THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'draft' AND p_new_status IN ('pending', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'pending' AND p_new_status IN ('assigned', 'in_progress', 'rejected', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'assigned' AND p_new_status IN ('in_progress', 'waiting_member', 'escalated', 'rejected', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'in_progress' AND p_new_status IN ('waiting_member', 'escalated', 'resolved', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'waiting_member' AND p_new_status IN ('in_progress', 'resolved', 'cancelled') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'escalated' AND p_new_status IN ('in_progress', 'resolved', 'closed') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'resolved' AND p_new_status IN ('closed', 'in_progress') THEN
        v_is_valid_transition := TRUE;
    ELSIF v_old_status = 'closed' AND v_actor_role IN ('super_admin', 'root') THEN
        v_is_valid_transition := TRUE;
    END IF;

    IF NOT v_is_valid_transition THEN
        RAISE EXCEPTION 'Invalid state transition from % to % for ticket %', v_old_status, p_new_status, p_ticket_id;
    END IF;

    -- 5. Atomic State Update
    UPDATE public.tickets
    SET
        status = p_new_status,
        assigned_to = COALESCE(p_assigned_to, assigned_to),
        resolution_notes = CASE WHEN p_new_status = 'resolved' THEN COALESCE(p_resolution_notes, resolution_notes) ELSE resolution_notes END,
        resolved_at = CASE WHEN p_new_status = 'resolved' THEN NOW() ELSE resolved_at END,
        updated_at = NOW()
    WHERE id = p_ticket_id;

    -- 6. Insert Ticket Lifecycle Event
    INSERT INTO public.ticket_events (
        ticket_id, actor_id, actor_role, event_type, old_status, new_status, notes
    ) VALUES (
        p_ticket_id, p_actor_id, v_actor_role, 'STATUS_CHANGE', v_old_status, p_new_status, p_notes
    );

    -- 7. Insert Immutable Audit Log
    INSERT INTO public.audit_logs (
        actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value
    ) VALUES (
        p_actor_id,
        v_actor_role,
        'TICKET_TRANSITION',
        'tickets',
        p_ticket_id,
        jsonb_build_object('status', v_old_status, 'assigned_to', v_ticket.assigned_to),
        jsonb_build_object('status', p_new_status, 'assigned_to', COALESCE(p_assigned_to, v_ticket.assigned_to), 'notes', p_notes)
    );

    -- 8. Return Updated State
    SELECT to_jsonb(t) INTO v_result FROM public.tickets t WHERE t.id = p_ticket_id;
    RETURN v_result;
END;
$$;
