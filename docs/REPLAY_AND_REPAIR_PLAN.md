# Replay & Repair Plan — Migration Chain 001–011

> Status: DRAFT for review. No real migration file has been modified at this stage.
> This document records (a) the corrected audit findings, and (b) the proposed,
> contract-preserving repair for the one confirmed blocker (B1) before a live
> replay is attempted on a throwaway DB.

---

## 1. Corrected Audit Findings (supersedes earlier notes)

| ID | File | Finding | Verdict |
|----|------|---------|---------|
| B1 | `20260905000003_supabase_schema.sql` | `CREATE TABLE users / tickets / …` without `IF NOT EXISTS` and without `public.` prefix, after 001 already created `public.*` → **relation already exists** on fresh replay. Same for duplicate `CREATE INDEX idx_*` (no `IF NOT EXISTS`). `users_select_own` policy references `user_id`, a column that does **not** exist on `users`. It is a legacy "SQL Editor" script, not chain-safe. | **BLOCKER — must fix** |
| B2 | `004` / `009` `v_ticket RECORD;` | `RECORD` is a documented PL/pgSQL **record variable** type. Not a defect. | Retracted |
| B3 | `004` / `009` `to_jsonb(t)` | `to_jsonb(anyelement)` is a **built-in** PostgreSQL function. Not a defect. | Retracted |

**Bottom line:** the chain's only confirmed replay defect is **`003`**. 004–011 reference objects that 004–011 create, and `RECORD`/`to_jsonb` are valid SQL.

## 2. Root Cause Why `003` Exists

`003` was authored as a standalone "run in SQL Editor" schema — a duplicate of 001's DDL. It was **never** meant to sit in the same migration chain after 001. It adds no unique object 001 doesn't already provide except the `uuid-ossp` extension. Keeping it as-is breaks `supabase db reset` on a fresh DB.

## 3. Proposed Repair Strategy (contract-preserving, traceable)

Because it is a checked-in migration, we do **not** silently drop history. Recommended order:

1. **Freeze contract** first (`docs/SCHEMA_CONTRACT.md`) — done above.
2. **Neutralize `003`** so it only performs idempotent non-conflicting work, keeping the two extensions. All tables/indexes/policies 003 declared already exist identically from 001; the **deny-by-default** contract (001: "no client-role policies in baseline") is preserved by removing 003's obsolete client policies.
3. **Live replay** on a throwaway DB (`supabase db reset` on a scratch/local profile, NOT the linked `.temp` remote) → schema-diff against the contract.
4. Only after the diff is clean, apply to the shared project.

### Draft `003` replacement (for review — do not merge yet)

```sql
-- ============ REVISED 20260905000003_supabase_schema.sql ============
-- WHY: the original re-declared users/tickets/... and duplicate indexes
-- (failing fresh replay after 001) and created an invalid policy
-- (users_select_own referenced `user_id`, which users does not have).
-- All of those objects are already provided by 001_initial_schema.sql.
-- This revision keeps only the idempotent, non-conflicting pieces the
-- chain genuinely needs, and preserves the deny-by-default RLS contract
-- (no client-role policies in the baseline).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- NOTE: No CREATE TABLE / CREATE INDEX / CREATE POLICY here.
-- Those are owned by 001_initial_schema.sql and must not be re-declared.
```
## 4. Live Replay Checklist (throwaway DB, NOT linked remote)

```text
fresh scratch DB
  → apply 001 … 011 (after 003 revision)
  → verify: tables, columns, types, FK, CHECK, indexes, RLS,
            policies, functions, RPC, triggers, seed
  → schema-diff vs docs/SCHEMA_CONTRACT.md
  → run smoke RPC calls:
       backoffice_has_capability('ticket.transition')
       mutate_ticket_state_atomic (auth + service_role paths)
       update_system_control (key-validate + capability + audit)
       submit_claim_atomic (advisory-lock race test)
       create_domain_request_ticket (valid/invalid/duplicate)
  → confirm no duplicate-index / relation-already-exists errors
```

## 5. Additional Risk Register (freeze before touching anything further)

| Risk | Finding | Status |
|------|---------|--------|
| `system_controls_read USING (true)` (008) | Permissive SELECT on emergency flags; `anon` may read | ⚠️ confirm intended |
| `submit_claim_atomic` granted to `authenticated` (010) | Caller not bound to target TG user → any authed account could claim for any TG user | latent (no member auth yet), track |
| Hardcoded super-admin TG IDs (006) | Credentials/IDs in SQL | known (baseline SEC-08), rotate |
| `domain_inventory`/`domain_assignments` operator-read via `member.read` | Validate `member.read` is granted to operator roles | verify |

## 6. Dependency-Order Verification Result

001→011 ordering itself is sound: `dashboard_access`(005) precedes 008/009 uses; `backoffice_has_capability`(009) precedes 011 policies; trigger functions 007 hardens come from 001; `audit_logs.actor_role` exists in 001. The only breakage is **content of 003**, not ordering.