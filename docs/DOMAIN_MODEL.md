# Abiedien Backoffice — Master Control Center / Domain Model

> **Status:** Baseline reconciliation (audit of repo vs. operational blueprint)
> **Principle:** The *operational conversation* is the source of business requirements.
> The repo + Supabase schema is the **audit object**, not the blueprint.
> **Design rule (non-negotiable):** A status must NEVER be set to `Completed` because an
> operator typed it. `Completed` means **execution succeeded + verification succeeded +
> audit recorded**. The database is the single source of truth; chat/Telegram is only a
> notification & control surface.

This document is the **1:1 business → technical mapping** enforced by `abiedienbackoffice`.
Every flow specifies the full chain, and marks what the current repo already models (`✅`)
versus what is partial (`🟠`) or missing (`❌`), based on a line-by-line schema audit.

```
Business intent → Dashboard menu → API route → AuthZ capability →
Business rule (table/RPC/trigger) → DB state machine → Audit event → Telegram event
```

---

## 0. Architecture (locked)

```
                    MASTER CONTROL CENTER (Dashboard = execution machine)
                                     │
              ┌──────────────────────┼──────────────────────┐
          OPERATIONS            FINANCE                SYSTEM
              │                      │                      │
     Web / Domain / Ticket    Pay / Claim / Ledger   Audit / API / Deploy / Health
              │                      │                      │
                                     ▼
                              BUSINESS ENGINE
              (Workflow · Rules · Events · RBAC)  ← single source of truth
                                     │
                              BACKOFFICE API (backoffice-api-v3)
                                     │
                 ┌───────────────────┼───────────────────┐
                 ▼                   ▼                   ▼
              SUPABASE            PAYMENT CORE        CLOUDFLARE
        (PG + Auth + RPC +   (providers + failover)  (DNS/edge/Pages; NO business logic)
         Storage + Realtime)
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
                 GITHUB           EVENTS/AUDIT      NOTIFICATION
            (source + CI/CD)    (immutable)        (Telegram/Alert)
```

- **GITHUB** = source code, migrations, edge functions, tests, CI/CD. Not an operational database.
- **CLOUDFLARE** = DNS, SSL/TLS, proxy, caching, Pages deployment. **No business logic lives here.**
- **SUPABASE** = system of record: operational data, auth, RBAC, RPC, storage, realtime.
- **NOTIFICATION** = every important event emits an event → dashboard/Telegram/alert.
  Telegram is **not** the database of record.

---

## 1. Primary entity map (current schema)

| Domain concept | Current table(s) | Gaps |
|---|---|---|
| User / Member / Staff | `users`, `telegram_users`, `dashboard_access`, `admin_accounts` | 🟠 3 parallel identity tables |
| Website | `tickets(category=domain_request)`, `users.domain_name`, `domain_assignments` | ❌ **no `websites` entity/state machine** |
| Domain | `domain_inventory`, `domain_assignments`, `create_domain_request_ticket` | 🟠 no DNS/CF automation, no reclaim |
| Ticket / Workflow | `tickets`, `ticket_events`, `mutate_ticket_state_atomic` | ✅ FSM + event sourcing |
| Claim / Settlement | `claims`, `submit_claim_atomic`, `check_claim_rate_limit` | 🟠 claims exist; settlement ledger ❌ |
| Payment | `payments` | 🟠 table only; ledger/providers/reconciliation ❌ |
| Update / Commission | — | ❌ `update_requests`, `commission_rules` missing |
| Value / Deposit | — | ❌ transaction ledger missing |
| Incident / Diagnosis | `tickets` (reused) | ❌ structured check timeline missing |
| Audit | `audit_logs` + immutable trigger | ✅ who/what/before/after/when/why |
| RBAC / Team | `backoffice_capabilities`, `backoffice_role_capabilities`, `backoffice_has_capability` | ✅ capability gate |
| Notifications | `telegram_notification_log` | ✅ event log for Telegram |
| Emergency / Kill-switch | `system_controls` | ✅ (RLS read policy `USING(true)` to review) |

---

## 2. Flow A — Website lifecycle (FANTERA56 example)

> Chat: "FANTERA56 → valida `.asia` → free → biru → build → completed → /backoffice → user/pass → monitor → 7 days idle → reclaim"

| Stage | Business | API | AuthZ | Rule / DB | Audit | Telegram |
|---|---|---|---|---|---|---|
| Request | New site order | `POST /requests` | `site.request` | `requests` (new) | REQUEST_CREATED | 📩 |
| Domain validate | pick name/TLD | `POST /domains/validate` | `domain.validate` | provider lookup | DOMAIN_VALIDATED | 📩 |
| Plan/Theme | free/paid, color | `PATCH /requests/{id}` | `site.configure` | `requests` | REQUEST_UPDATED | — |
| Build | generate site | `POST /requests/{id}/build` | `site.build` | build job | BUILD_STARTED\|DONE | 📩 |
| Deploy | push to CF Pages | `POST /deployments` | `deploy.execute` | deployment record | DEPLOY_STARTED\|DONE | 📩 |
| Panel provision | create panel+creds | `POST /panels` | `panel.provision` | `panels` (new) | PANEL_PROVISIONED | 📩 |
| Access delivery | share creds | secrets only | `panel.access` | vault ref | ACCESS_DELIVERED | 📩 |
| Activation | mark live | `POST /sites/{id}/activate` | `site.activate` | `websites.status=active` | SITE_ACTIVATED | 📩 |
| Monitoring | schedule value checks | `GET /sites/{id}/health` | `monitor.read` | `health_checks` (new) | CHECK_RECORDED | 🚨 on fail |
| Value check | rule engine | `POST /sites/{id}/value` | `monitor.evaluate` | value rules | VALUE_UPDATED | 📩 |
| Active / Reclaim | 7-day idle → grace → reclaim | RPC `reclaim_site` | `site.reclaim` | `websites.status=reclaim` | RECLAIM_INITIATED | 🚨 |

**Required schema (new in Phase 1):** `websites` with explicit state enum + `reclaim` policy trigger.

---

## 3. Flow B — Update / Commission ("Update Tayo36 ke 75%")

> Must become a workflow with who/when/before/after/effective-date → not a frontend number.

**Entity `update_requests`:**
```
id, website_id, requested_by, current_value, target_value, reason,
status, assigned_to, requested_at, processed_at, verified_at
```
**Status machine:** `REQUESTED → VALIDATING → APPROVED → EXECUTING → VERIFIED → COMPLETED | REJECTED`

**Chain (75%):**
```
"Tayo36 75%" → intent{UPDATE_VALUE,target,value}
  → POST /sites/{id}/commission      cap site.commission.update
  → rule: commission_rules           cap site.commission.approve
  → RPC update_commission (transaction)  → db=source of truth
  → AUDIT commission.updated (before/after/effective_at)
  → TELEGRAM commission.update
```

**Required schema (new):** `update_requests`, `commission_rules`, RPC entry points.

---

## 4. Flow C — Claim / Payout ("proses tapi tidak masuk rekening")

`claims` already exists. Must be extended to distinguish settlement states:

| Existing | Required addition |
|---|---|
| `pending / reviewing / approved / rejected / cancelled / paid` | `payment_created / payment_sent / payment_confirmed / payment_failed / payment_reconciliation_required` |

**Chain:** CLAIM_REQUEST → VALIDATE → CALCULATE (commission_rule) → APPROVAL → PAYMENT QUEUE → PAYMENT → RECONCILIATION → COMPLETED. All transitions via RPC (`submit_claim_atomic` exists; add `approve_claim`, `mark_paid`, `flag_reconciliation`).

---

## 5. Flow D — Payment core (Balance / Payin / Payout / Coin / Settlement)

**`payments` exists but is transaction-light.** Phase-2 additions:
- `payment_ledger` (immutable double-entry: payin/payout/coin/topup/settlement)
- `payment_providers` (id, name, type, priority, status, health_status, maintenance, credentials_ref)
- **Failover rule:** active provider → health check → fail → next provider (QRIS maintenance → "alihkan ke GSPay") — provider selection in backend, not frontend.

---

## 6. Flow E — Incident & diagnosis (KARANG56 "panel gak bisa dibuka")

**`incidents` (new)** + `incident_checks` timeline:
```
REPORTED → TRIAGED → INVESTIGATING → FIXING → VERIFYING → RESOLVED
```
Each check: (DNS/SSL/Cloudflare/Server/Auth/API/DB/Payment) → `PASS | FAIL` + timestamp →
appended to timeline → audit + notify. No more "lagi dicek bos" — the timeline is the record.

**Existing reuse:** `tickets`, `ticket_events`, `system_controls` (kill-switch for critical).

---

## 7. Flow F — Health monitoring (detect before the user chats)

New probe table `health_checks(site_id, check_type, status, latency_ms, checked_at)` for
domain/DNS/SSL/cloudflare/api/auth/db/payment/qris/edge-function. Dashboard shows per-site
`●/🔴` matrix; failures auto-create incidents.

---

## 8. Flow G — Auth + RBAC (no more "everyone sees everything")

Already ✅: `dashboard_access` + capabilities. Blueprint target roles must be wired to
capabilities so the UI only exposes allowed menus:
```
super_admin = *,  admin = ops/domains/tickets,  finance = claims/payments/reconciliation,
tech = deployments/dns/incidents/health,  operator = requests/tickets,  member = own sites/claims
```
Add capabilities such as `site.*`, `domain.*`, `payment.*`, `incident.*`, `commission.*`.

---

## 9. Flow H — Audit (already ✅, must be the spine)

Every mutation above MUST emit: `actor_id, action_type, resource_type, resource_id,
old_value, new_value, created_at, ip_address`. Enforced by the `prevent_audit_log_mutation`
trigger (immutable) as today. Audit renders "who/what/before/after/when/why" on the dashboard.

---

## 10. Chat → System (natural-language command surface)

Telegram is a **command intake**: free text → `{intent, target, value, ...}` → validate →
authorize (capability) → execute (RPC, DB=truth) → audit → notify. It is **not** the store
of truth. (See `system_controls`, `submit_claim_atomic` as existing patterns to generalize.)

---

## 11. Master menu (target)

```
01 OVERVIEW  02 OPERATIONS  03 WEBSITES  04 DOMAIN CENTER  05 REQUEST QUEUE
06 UPDATE/COMMISSION  07 CLAIM CENTER  08 PAYMENT CENTER  09 TRANSACTION LEDGER
10 INCIDENT CENTER  11 SYSTEM HEALTH  12 DEPLOYMENTS  13 NOTIFICATIONS
14 MEMBERS  15 TEAM/RBAC  16 AUDIT LOG  17 REPORTS  18 SETTINGS
```

---

## 12. Phase plan (implementation order — each ends with audit + verify)

| # | Migration | Scope |
|---|---|---|
| **013** | ✅ `website_lifecycle` (implemented) | `websites` FSM + `website_events` + `website_credentials_ref` (secret-ref, no plaintext) + `transition_website_lifecycle` RPC (capability-gated, audit + event) + `site.*` capabilities + RLS |
| 014 | `update_requests` + `commission_rules` | Update/Commission workflow (75%) |
| 015 | `incidents` + `incident_checks` | Incident/diagnosis timeline (KARANG56) |
| 016 | `payment_ledger` | Payment core double-entry ledger |
| 017 | `payment_providers` + failover | Provider abstraction ("QRIS down → GSPay") |
| 018 | `health_checks` probes | Pre-emptive health monitoring |
| 019 | `reclaim_site` automation | Reclaim / expiry policy (7-day idle → grace → reclaim) |
| 020 | Master workflow orchestration | Domain→Website→Payment→Panel→Activation→Monitor→Reclaim |
| 021 | Dashboard Control Center | 18-module control-tower UI |
| 022 | Notification / Automation hardening | Event engine (Telegram/Alerts) |
| 023 | Reconciliation + Integrity tests | Recon ledger + end-to-end tests |

**Contract testable per migration (non-negotiable):**
```
DB ↕ RPC ↕ API ↕ RBAC ↕ Dashboard ↕ Cloudflare ↕ GitHub CI/CD ↕ Telegram
```
Every feature must be exercisable end-to-end across this chain, not just a feature added in isolation.

> CI gate for every change: `npm run lint` (0 errors) + `npm run build` (exit 0) +
> migrations dry-run before any remote `db push`.
> Migration 013 depends on 008–011 (capabilities `code` schema, `backoffice_has_capability`,
> `domain_inventory`, `audit_logs`, `set_updated_at`).