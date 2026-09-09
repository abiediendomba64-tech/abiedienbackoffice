# System Architecture — Abiedien Backoffice

> **Status**: BASELINE AUDIT — Local Only. Not deployed to production.
> **Last Updated**: 2026-09-10

---

## 1. Platform Overview

```
GitHub (source control)
        │
        ▼
Supabase (PostgreSQL + Auth + Edge Functions)
        │
        ├── telegram-auth  (Edge Function)
        └── backoffice-api (Edge Function)
                │
                ├── Cloudflare Pages (WebApp / Backoffice UI)
                └── Telegram Bot (command/input channel only)
```

---

## 2. Identity Architecture

### Canonical Identity Model

```
Telegram User
      │
      ▼
telegram_users
  .telegram_user_id (external key)
  .linked_user_id ──────────────► public.users.id (BIGSERIAL)
  .role             (presentation metadata only)
  .status           (pending / active / blocked)

Staff / Operator
      │
      ▼
auth.users (Supabase Auth)
  .id (UUID)
      │
      ▼
dashboard_access
  .auth_user_id → auth.users.id
  .role          (admin / dev / super_admin / root)
  .is_active
```

### What is `public.users`?

`public.users` is the **canonical business identity** for ALL system entities:
- Members linked from `telegram_users.linked_user_id`
- Staff linked from `dashboard_access.user_id`
- FK target for: `tickets`, `claims`, `domain_assignments`, `audit_logs`

`users.id` is `BIGSERIAL` (NOT UUID). This is a critical FK contract: all references must use `BIGINT`.

---

## 3. Authorization Architecture

### Rule: DB Capability, Not Code Map

Authorization is enforced **server-side only** via:

```
backoffice_capabilities (code, description, category)
backoffice_role_capabilities (role, capability_code)
backoffice_has_capability(p_code VARCHAR) → BOOLEAN  [SECURITY DEFINER]
```

Code-side role/capability maps are **presentation metadata only** (for routing/menu display). They are NOT authorization gates.

### Capability Gate Pattern

```sql
IF NOT public.backoffice_has_capability('some.capability') THEN
    RAISE EXCEPTION 'Access denied';
END IF;
```

### Deny by Default

All tables have RLS enabled. No public/anon policies exist on sensitive tables. Default: **DENY**.

---

## 4. Ticket FSM

Defined in: `20260905000001_initial_schema.sql` + `20260905000004_atomic_ticket_mutation_and_fsm.sql`

```
Valid statuses: draft, pending, assigned, waiting_member,
                in_progress, escalated, resolved, closed,
                rejected, cancelled
```

**No `open` status exists. Do not use it.**

### Valid FSM Transitions (enforced in `mutate_ticket_state_atomic`)

```
draft        → pending, cancelled
pending      → assigned, in_progress, rejected, cancelled
assigned     → in_progress, waiting_member, escalated, rejected, cancelled
in_progress  → waiting_member, escalated, resolved, cancelled
waiting_member → in_progress, resolved, cancelled
escalated    → in_progress, resolved, closed
resolved     → closed, in_progress
closed       → (only super_admin/root can reopen)
```

`mutate_ticket_state_atomic` is the ONLY authorized path for ticket state mutation.

---

## 5. Domain Pipeline Architecture

### Separation of Concerns

| Layer | Table | Responsibility |
|-------|-------|----------------|
| Request | `tickets` (category=domain_request) | CS workflow, audit trail |
| Resource | `domain_inventory` | Platform-owned domain assets |
| Lifecycle | `domain_assignments` | Ownership + provisioning state |

### Domain Request Flow

```
/req_domain domain.com
      │
      ▼
identity resolve (telegram_users → users.id)
      │
      ▼
format validation
      │
      ▼
duplicate active request check
      │
      ▼
CREATE TICKET (status=pending, category=domain_request)
      │
      ▼
Admin Review Queue
      │
      ▼
Global Domain Availability Check (RDAP + DNS + internal inventory)
      │
      ├── NOT AVAILABLE → reject ticket
      └── AVAILABLE
            │
            ▼
        admin approves
            │
            ▼
        reserve domain_inventory
            │
            ▼
        create domain_assignments (status=pending → reviewing → approved)
            │
            ▼
        provisioning → dns_pending → active
```

**CRITICAL**: `domain_inventory` is NEVER touched during `/req_domain`. Only after admin approval.

### Domain Assignment FSM (enforced by trigger)

```
pending → reviewing, rejected, cancelled
reviewing → approved, rejected, cancelled
approved → provisioning, cancelled
provisioning → dns_pending, rejected, cancelled
dns_pending → active, provisioning, rejected, cancelled
active → released, revoked
rejected, cancelled, released, revoked → TERMINAL (no further transition)
```

---

## 6. Notification Architecture

Table: `telegram_notification_log`

```
status: queued → sending → sent
                       → failed (retry via attempt_count + error_code)
```

Idempotency: check `context_type` + `context_id` + `status=sent` before re-queuing.

Delivery: Edge Functions only (service_role). No client-side access.

---

## 7. Migration Chain

| File | Phase | Key Output |
|------|-------|------------|
| 001_initial_schema | Baseline | users, tickets, payments, audit_logs |
| 002_contract_hardening | Hardening | constraints |
| 003_supabase_schema | Supabase extensions | auth integration |
| 004_atomic_ticket_mutation_and_fsm | Ticket FSM | mutate_ticket_state_atomic, ticket_events, backoffice_capabilities |
| 005_dashboard_access_and_auth_integrity | Staff auth | dashboard_access |
| 006_telegram_users_claims_and_audit | Telegram + Claims | telegram_users, claims, admin_chat_ids (seed) |
| 007_security_remediation_p0 | Security | REVOKE, RLS hardening, search_path='' |
| 008_system_controls | Emergency controls | system_controls, update_system_control RPC |
| 009_capability_alignment | Authorization | backoffice_has_capability, prevent actor spoofing |
| 010_identity_unification | Identity | telegram_users.linked_user_id, submit_claim_atomic |
| 011_domain_pipeline | Domain | domain_inventory, domain_assignments, telegram_notification_log, create_domain_request_ticket |

---

## 8. Known Issues (Audit Findings)

See `docs/INTEGRITY_FINAL.md` for detailed findings and status.
