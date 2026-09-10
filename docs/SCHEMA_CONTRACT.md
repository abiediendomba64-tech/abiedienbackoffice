# Schema Contract — Frozen Final State (Phase B target)

> Status: DRAFT for review. Not yet proven by live replay.
> Derived from: `supabase/migrations/20260905000001` … `…00011` + `docs/ARCHITECTURE.md`.
> Purpose: the **diff target** that a fresh `001→011` replay must reproduce exactly.
> Rule: no new table/column/field is added just because the frontend "needs" it.

---

## 1. Canonical Table Inventory (23 tables)

| # | Table | Responsibility | Created in | Status enum |
|---|--------|----------------|------------|-------------|
| 1 | `users` | Canonical business identity (BIGINT PK) | 001 | role: new_user/member/admin/dev/super_admin/root · status: active/suspended/banned · onboarding: PENDING_REVIEW/APPROVED/REJECTED/QUARANTINED · risk: LOW/MEDIUM/HIGH/CRITICAL |
| 2 | `tickets` | CS/domain workflow (single FSM) | 001 | draft/pending/assigned/waiting_member/in_progress/escalated/resolved/closed/rejected/cancelled |
| 3 | `ticket_messages` | Ticket message history | 001 | sender_type: member/admin/dev/super_admin/root/system |
| 4 | `conversation_states` | Bot per-user FSM scratch | 001 | idle/awaiting_domain/awaiting_reason/awaiting_amount/awaiting_confirmation/in_ticket/complete |
| 5 | `payments` | Payment + verification | 001 | pending/verified/rejected/cancelled |
| 6 | `web_requests` | Legacy web domain requests | 001 | (legacy; see note §7) |
| 7 | `forum_topics` | Forum topics | 001 | — |
| 8 | `forum_comments` | Forum comments | 001 | — |
| 9 | `audit_logs` | **Immutable** event log | 001 | up/delete blocked by trigger `audit_logs_immutable` |
| 10 | `risk_events` | Risk scoring signals | 001 | — |
| 11 | `notifications` | Legacy notification table | 001 | type default info |
| 12 | `ticket_events` | Ticket transition event sourcing | 004 | — |
| 13 | `backoffice_capabilities` | Capability registry (code PK) | 004 | — |
| 14 | `backoffice_role_capabilities` | role→capability map (PK role, cap_code) | 004 | — |
| 15 | `dashboard_access` | Operator auth mapping (auth_user_id UUID ↔ user_id BIGINT) | 005 | role: admin/dev/super_admin/root; is_active |
| 16 | `telegram_users` | External TG identity; `linked_user_id`→users.id | 006+010 | role: guest/member/admin/dev/super_admin; status: pending/active/blocked |
| 17 | `admin_chat_ids` | Admin chat credential map | 006 | — |
| 18 | `claims` | Private claim storage; `user_id`→users.id (010) | 006+010 | pending/reviewing/approved/rejected/paid + terminal |
| 19 | `telegram_updates` | Raw webhook log | 006 | — |
| 20 | `system_controls` | Emergency flags (id in emergency_flags/maintenance_mode/rate_limits) | 008 | — |
| 21 | `domain_inventory` | Platform-owned domain asset (NO user FK) | 011 | available/reserved/assigned/suspended; dns: unconfigured/pending_verification/active/error |
| 22 | `domain_assignments` | Ownership + provisioning; `inventory_id` NULL-able; `user_id` RESTRICT | 011 | pending/reviewing/approved/provisioning/dns_pending/active/rejected/cancelled/released/revoked |
| 23 | `telegram_notification_log` | Notification delivery tracking | 011 | queued/sending/sent/failed |
---

## 2. Key FK / Identity Contract

```text
telegram_users.telegram_user_id  (external, UNIQUE)
      └─ linked_user_id ──────────────► users.id  (canonical)
claims.telegram_user_id ──► telegram_users
claims.user_id ───────────► users.id          (added 010)
dashboard_access.auth_user_id ──► auth.users.id   (1:1 unique idx)
dashboard_access.user_id ────────► users.id
tickets.user_id / .assigned_to ──► users.id
domain_assignments.user_id ──► users.id  (ON DELETE RESTRICT)
domain_assignments.inventory_id ──► domain_inventory.id (NULL-able)
```
**`users.id` is BIGSERIAL — every FK to it must be BIGINT.** No UUID drift allowed.

---

## 3. Secured Stored Procedures / RPC (service_role/authenticated)

| Function | Grant (EXECUTE) | Notes |
|----------|-----------------|-------|
| `mutate_ticket_state_atomic` | authenticated, service_role (PUBLIC/anon revoked) | Actor spoof-secured in 009; **only authorized ticket transition path** |
| `update_system_control` | authenticated, service_role | FOR UPDATE row lock; capability `system.manage_controls` |
| `check_claim_rate_limit` | authenticated, service_role | advisory lock (010) |
| `submit_claim_atomic` | authenticated, service_role | advisory lock; canonical user resolution |
| `backoffice_current_access` | authenticated, service_role | SECURITY DEFINER; non-recursive |
| `backoffice_has_capability` | authenticated, service_role | Unity capability gate |
| `create_domain_request_ticket` | authenticated, service_role | Creates `tickets` only; **never touches inventory/assignment** |
| trigger `validate_domain_assignment_transition` | n/a | FSM enforcement |

**Capability-gate pattern (not code maps):**
```sql
IF NOT public.backoffice_has_capability('ticket.transition') THEN RAISE ...; END IF;
```
Telegram command / WebApp route / UI button are **not** authorization — backend capability check is.

---

## 4. Seed Data (baseline)
- `backoffice_capabilities` (004): ticket.read_own, ticket.read_all, ticket.create, ticket.assign, ticket.transition, member.read, member.verify, payment.verify, audit.read; (009) telegram.send_notification, dashboard.access; (008) system.manage_controls.
- `backoffice_role_capabilities`: member, dev, admin, super_admin, root mappings (dev intentionally limited).
- `admin_chat_ids` / `telegram_users`: 4 hardcoded super-admin TG IDs (006) — **flagged: must be rotated**, secret-adjacent.
- `system_controls.emergency_flags` (008): payment_frozen, login_frozen, withdrawals_frozen, claims_frozen, bot_maintenance = false.
- Storage bucket `claim-evidence` (private, 006).
---

## 5. RLS Posture (default-DENY vs permissive — freeze these decisions)

| Table/Policy | Decision |
|--------------|----------|
| secret tables (`telegram_bot_settings`, `telegram_chat_histories`, `admin_chat_ids`, `telegram_updates`) | service_role only; PUBLIC/anon REVOKEd (007) |
| most RLS-enabled tables | ENABLE RLS + **no client policies** (001 baseline, service_role path) |
| `system_controls_read … USING (true)` (008) | ⚠️ **permissive SELECT** — confirm whether `anon` may read emergency flags |
| `domain_assignments_member_self_read … USING (FALSE)` (011) | ⚠️ **placeholder** — members have no Supabase Auth session yet; not effective |
| `domain_inventory_operator_read` / `domain_assignments_operator_read` | via `member.read` capability |

---

## 6. Known Chain Defects to fix before live replay

| ID | File | Defect | Severity |
|----|------|--------|----------|
| B1 | `003_supabase_schema.sql` | Re-creates `users/tickets/…` (no IF NOT EXISTS / no public.) → duplicate-relation **fail on fresh replay**; duplicates indexes; invalid policy `users_select_own` refs nonexistent `user_id` column | **BLOCKER** |
| (retracted) | `004`/`009` `v_ticket RECORD` | RECORD is a valid PL/pgSQL record variable — NOT a defect | — |
| (retracted) | `004`/`009` `to_jsonb(t)` | built-in function — NOT a defect | — |

---

## 7. Notes / Open Decisions
- `web_requests` (001) overlaps `tickets(category='domain_request')` + `domain_assignments`; freeze whether it stays or is deprecated (011 intentionally routes domain through `tickets`).
- `notifications` (001) overlaps `telegram_notification_log` (011); freeze which is canonical.
- No member-facing Supabase Auth session exists → any "member self-read via auth.uid()" policy is a placeholder by definition.