-- ============ REVISED 20260905000003_supabase_schema.sql ============
-- WHY: the original re-declared users/tickets/... and duplicate indexes
-- (failing fresh replay after 001) and created an invalid policy
-- (users_select_own referenced `user_id`, which users does not have).
-- All of those objects are already provided by 001_initial_schema.sql.
-- This revision keeps only the idempotent, non-conflicting pieces the
-- chain genuinely needs, and preserves the deny-by-default RLS contract
-- (no client-role policies in the baseline).
-- Traceability: original file (158 lines, SQL-Editor style DDL) superseded
-- per docs/REPLAY_AND_REPAIR_PLAN.md B1 and docs/SCHEMA_CONTRACT.md B1.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- NOTE: No CREATE TABLE / CREATE INDEX / CREATE POLICY here.
-- Those are owned by 001_initial_schema.sql and must not be re-declared.
