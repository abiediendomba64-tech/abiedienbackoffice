-- ============ SCHEMA DDL ============
-- Jalankan di Supabase SQL Editor

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ========== 1. USERS TABLE ==========
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    full_name VARCHAR(255),
    email VARCHAR(255),
    phone_encrypted BYTEA,
    role VARCHAR(50) NOT NULL DEFAULT 'new_user',
    domain_name VARCHAR(255),
    domain_verified BOOLEAN DEFAULT FALSE,
    verification_token VARCHAR(255),
    verification_expiry TIMESTAMP,
    status VARCHAR(50) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT valid_role CHECK (role IN ('new_user', 'member', 'admin', 'dev', 'super_admin')),
    CONSTRAINT valid_status CHECK (status IN ('active', 'suspended', 'banned'))
);

-- ========== 2. TICKETS TABLE ==========
CREATE TABLE tickets (
    id BIGSERIAL PRIMARY KEY,
    ticket_number VARCHAR(20) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
    category VARCHAR(100) NOT NULL,
    priority VARCHAR(50) DEFAULT 'medium',
    status VARCHAR(50) DEFAULT 'pending',
    title VARCHAR(255),
    description TEXT,
    collected_data JSONB,
    resolution_notes TEXT,
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT valid_priority CHECK (priority IN ('urgent', 'high', 'medium', 'low')),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'assigned', 'in_progress', 'resolved', 'closed', 'rejected'))
);

-- ========== 3. TICKET MESSAGES TABLE ==========
CREATE TABLE ticket_messages (
    id BIGSERIAL PRIMARY KEY,
    ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ========== 4. CONVERSATION STATES TABLE ==========
CREATE TABLE conversation_states (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    intent VARCHAR(100),
    active_ticket_id BIGINT REFERENCES tickets(id),
    last_topic VARCHAR(100),
    collected_data JSONB,
    waiting_for VARCHAR(100),
    state VARCHAR(50),
    last_interaction TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT valid_state CHECK (state IN (
        'idle', 'awaiting_domain', 'awaiting_reason', 'awaiting_amount',
        'awaiting_confirmation', 'in_ticket', 'complete'
    ))
);

-- ========== 5. PAYMENTS TABLE ==========
CREATE TABLE payments (
    id BIGSERIAL PRIMARY KEY,
    payment_number VARCHAR(20) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(12, 2) NOT NULL,
    payment_method VARCHAR(50),
    proof_url TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    verified_by BIGINT REFERENCES users(id),
    verification_notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    verified_at TIMESTAMP
);

-- ========== 6. FORUM TOPICS TABLE ==========
CREATE TABLE forum_topics (
    id BIGSERIAL PRIMARY KEY,
    topic_number VARCHAR(20) UNIQUE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id),
    category VARCHAR(100),
    title VARCHAR(255),
    description TEXT,
    is_locked BOOLEAN DEFAULT FALSE,
    is_pinned BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ========== 7. AUDIT LOGS TABLE (IMMUTABLE) ==========
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor_id BIGINT REFERENCES users(id),
    action_type VARCHAR(100),
    resource_type VARCHAR(100),
    resource_id BIGINT,
    old_value JSONB,
    new_value JSONB,
    ip_address INET,
    created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE audit_logs DISABLE TRIGGER ALL;
CREATE RULE audit_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;

-- ========== INDEXES ==========
CREATE INDEX idx_users_telegram_id ON users(telegram_id);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_tickets_user_id ON tickets(user_id);
CREATE INDEX idx_tickets_assigned_to ON tickets(assigned_to);
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_priority ON tickets(priority);
CREATE INDEX idx_tickets_created_at ON tickets(created_at DESC);
CREATE INDEX idx_ticket_messages_ticket_id ON ticket_messages(ticket_id);
CREATE INDEX idx_conversation_states_user_id ON conversation_states(user_id);
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- ========== ROW LEVEL SECURITY (RLS) ==========
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select_own ON users FOR SELECT
    USING (auth.uid()::bigint = user_id OR
           (SELECT role FROM users WHERE id = auth.uid()::bigint) IN ('admin', 'super_admin'));

CREATE POLICY tickets_select_own ON tickets FOR SELECT
    USING (user_id = auth.uid()::bigint OR
           assigned_to = auth.uid()::bigint OR
           (SELECT role FROM users WHERE id = auth.uid()::bigint) IN ('admin', 'super_admin'));

CREATE POLICY audit_select_admin ON audit_logs FOR SELECT
    USING ((SELECT role FROM users WHERE id = auth.uid()::bigint) IN ('admin', 'super_admin'));

CREATE POLICY audit_no_update ON audit_logs FOR UPDATE USING (false);
CREATE POLICY audit_no_delete ON audit_logs FOR DELETE USING (false);

-- ✅ Supabase schema ready for deployment