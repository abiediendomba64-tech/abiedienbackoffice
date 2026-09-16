-- Migration: 20260916000032_operational_lists.sql
-- ADDITIVE only. Replaces localStorage-backed mock arrays with server tables.
-- Transitional read model: typed columns (id, status) + full shape in `data`
-- JSONB. Column-splitting normalization can follow once consumers stabilize.

CREATE TABLE IF NOT EXISTS public.domain_order_requests (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_domain_order_requests_status ON public.domain_order_requests (status);

CREATE TABLE IF NOT EXISTS public.member_domain_inventories (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active',
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.technical_rescue_cases (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'investigating',
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: authenticated operators/members read and write operational lists.
-- Writes are the canonical server state; no localStorage authority anymore.
ALTER TABLE public.domain_order_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_domain_inventories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.technical_rescue_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY domain_orders_authenticated_all
    ON public.domain_order_requests FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

CREATE POLICY member_inventories_authenticated_all
    ON public.member_domain_inventories FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

CREATE POLICY technical_cases_authenticated_all
    ON public.technical_rescue_cases FOR ALL TO authenticated
    USING (true) WITH CHECK (true);
