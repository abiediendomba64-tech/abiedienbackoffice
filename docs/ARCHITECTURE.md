# System Architecture — Master Control Center

> **Status:** System of Record Architecture Baseline  
> **Updated:** 2026-09-13 (Phase 013: Website Lifecycle)  
> **Source of Truth Hierarchy:** GitHub (Code) | Supabase (Business State & Ledger) | Cloudflare (Edge Execution) | Dashboard (Control Tower) | Telegram (Intake & Alerts)

---

## 1. Topologi Tiga Pilar Eksekusi

Sistem operasional `abiedienbackoffice` membagi batasan tanggung jawab komputasi ke dalam tiga pilar terpisah tanpa tumpang tindih:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. GITHUB (Code Source of Truth)                                            │
│    - Repository: source code, schema migrations (001-023), CI/CD workflows  │
│    - GitHub Actions: automated tests, linting, build & deployment triggers  │
│    - Aturan: Tidak menyimpan state bisnis atau data dinamis operasional.    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. SUPABASE (Business State & Financial System of Record)                   │
│    - PostgreSQL Database: master tables, constraints, foreign keys          │
│    - State Machines: FSM triggers & atomic SECURITY DEFINER RPCs            │
│    - Financial Ledger: double-entry accounting (payin, payout, settlement)  │
│    - Immutable Audit: audit_logs (append-only trigger protected)            │
│    - Auth & RBAC: public.dashboard_access ↔ backoffice_capabilities         │
│    - Edge Functions: telegram-auth, backoffice-api-v3                       │
│    - Aturan: Satu-satunya sumber kebenaran data bisnis.                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. CLOUDFLARE (Edge Execution & Proxy Layer)                                │
│    - DNS Management: automated records via Cloudflare API v4                │
│    - SSL/TLS: edge encryption, automatic certificate renewal               │
│    - Routing & Proxy: DDoS mitigation, WAF, CDN caching                     │
│    - Web Hosting: Cloudflare Pages for Dashboard & client frontends         │
│    - Aturan: Cloudflare adalah execution engine, BUKAN database.           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Model Identitas & Autorisasi (RBAC)

### 2.1 Identitas Kanonikal (`public.users`)
Semua aktor dalam sistem bermuara pada tabel induk `public.users` dengan primary key bertipe `BIGSERIAL` (`BIGINT`):
- **Member:** Terhubung melalui `public.telegram_users.linked_user_id → public.users.id`.
- **Operator / Staff:** Terhubung melalui `public.dashboard_access.user_id → public.users.id` dengan relasi 1:1 ke `auth.users.id` (UUID).
- **Semua Foreign Key** yang mengidentifikasi pengguna (`owner_user_id`, `actor_id`, `assigned_to`, `requested_by`) bertipe `BIGINT` untuk menjaga integritas relasional tanpa tipe yang terdistorsi.

### 2.2 Autorisasi Berbasis Kapabilitas (Capability-Driven Security)
Autorisasi **tidak pernah** ditentukan oleh pengecekan string role di client. Akses dikunci di layer database melalui sistem kapabilitas:
```sql
-- Pattern Pengecekan di dalam Stored Procedure:
IF NOT public.backoffice_has_capability('site.manage') THEN
    RAISE EXCEPTION 'Access denied: role % lacks site.manage capability', v_actor_role;
END IF;
```

#### Matriks Peran & Kapabilitas Inti:
| Role | Cakupan Kapabilitas |
|------|---------------------|
| `root` | Akses penuh tanpa batas ke semua kapabilitas (`*`). |
| `super_admin` | Akses administratif penuh, manajemen staf, system controls emergency. |
| `admin` | Manajemen operasional situs (`site.*`), domain (`domain.*`), tiket (`ticket.*`). |
| `dev` | Akses diagnosis teknis, deployment log, inspect health checks. |
| `finance` | Akses klaim (`claim.*`), payment gateway (`payment.*`), transaksi ledger (`ledger.*`). |
| `operator` | Penanganan tiket masuk, request antrean awal situs. |
| `member` | Terbatas hanya pada `site.request` dan melihat data miliknya sendiri. |

---

## 3. Finite State Machines (FSM)

### 3.1 Website Lifecycle FSM (`websites.lifecycle_status`)
Didefinisikan dan ditegakkan oleh trigger `validate_website_lifecycle_transition()`:

```text
  requested ──► validating ──► approved
                                   │
                                   ▼
  deploying ◄── building ◄── provisioning
      │
      ▼
  dns_pending ──► ssl_pending ──► panel_pending ──► access_verification
                                                           │
                                                           ▼
  reclaimed ◄── reclaim_warning ◄── suspended ◄── [ ACTIVE ] ◄──► degraded
```

#### Aturan Transisi:
- Transisi status hanya sah bila melalui fungsi atomik `transition_website_lifecycle()`.
- Status `active` secara otomatis mengunci `activated_at = NOW()`.
- Status `reclaim_warning` dan `reclaimed` mencatat `reclaim_at = NOW()`.
- Setiap transisi otomatis menghasilkan entri kronologis di `public.website_events` dan `public.audit_logs`.

### 3.2 Update Request FSM (`update_requests.status`)
```text
  requested ──► reviewing ──► approved ──► scheduled ──► effective
                     │             │
                     ▼             ▼
                  rejected     cancelled
```

### 3.3 Domain Assignment FSM (`domain_assignments.status`)
```text
  pending ──► reviewing ──► approved ──► provisioning ──► dns_pending ──► active
                 │             │                                            │
                 ▼             ▼                                            ▼
              rejected     cancelled                                  released / revoked
```

---

## 4. Pola Keamanan & Secret Vault (`website_credentials_ref`)

### Prinsip: No Plaintext Credentials in DB
Kredensial panel website (username, password, token API) **dilarang disimpan dalam bentuk teks biasa (plaintext)** di tabel database operasional:
- Tabel `public.website_credentials_ref` hanya menyimpan:
  - `panel_url`: URL login panel (misal: `https://domain.com/backoffice`).
  - `username`: Nama pengguna administratif.
  - `secret_ref`: UUID atau URI referensi ke encrypted secret vault (misal: Supabase Vault / Cloudflare Secrets / HashiCorp Vault).
  - `delivery_channel`: Kanal pengiriman rahasia (misal: `telegram_dm_one_time`).
  - `delivered_at`: Waktu kredensial diserahkan kepada pemilik.

---

## 5. Arsitektur Pemantauan Kesehatan & Insiden

Diagnostik sistematis dilakukan secara berkala dan saat terjadi laporan gangguan (incident triggered):

```text
[ Health Probe / Diagnostic Run ]
               │
  ┌────────────┼────────────┬────────────┬────────────┐
  ▼            ▼            ▼            ▼            ▼
[ DNS ]      [ SSL ]      [ HTTP ]     [ AUTH ]    [ PAYMENT ]
  │            │            │            │            │
  └────────────┴────────────┼────────────┴────────────┘
                            ▼
              Record to website_health_checks
                            │
               ┌────────────┴────────────┐
               ▼                         ▼
         [ All Pass ]              [ Fail Detected ]
         Status: Healthy           Status: Degraded
                                   Auto-create Incident #
                                   Dispatch Telegram Alert
```

---

## 6. Protokol Kontrak Verifikasi Antar-Lapisan

Setiap fitur baru atau migrasi database wajib lolos uji validasi pada 8 titik kontrak:

```text
  1. DB Schema & Constraints (Type safety, NOT NULL, CHECK, Foreign Keys)
  2. Database Stored Procedures & FSM Triggers (PL/pgSQL atomicity)
  3. API Endpoint / Edge Functions (JWT validation, payload parsing)
  4. RBAC Capability Gate (backoffice_has_capability verification)
  5. Dashboard UI Action (Component state, action dispatch, feedback)
  6. Cloudflare Edge Integration (DNS/SSL/Proxy synchronization)
  7. GitHub CI/CD Pipeline (npm run lint, test, build exit 0)
  8. Notification Dispatcher (Telegram notification log delivery)
```

---
*Dokumen ini menjadi acuan struktural utama pengembangan backend dan integrasi sistem Abiedien Backoffice.*
