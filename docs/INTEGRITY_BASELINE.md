# INTEGRITY BASELINE REPORT (PHASE 0)
**System Integrity, Architecture Inventory, & Vulnerability Audit**
*Target: Sande Bot & Enterprise Backoffice*
*Date: 2026-09-09*

---

## 1. Architecture Map

```text
                                  [ TELEGRAM ECOSYSTEM ]
                                             │
               ┌─────────────────────────────┴─────────────────────────────┐
               ▼                                                           ▼
      Telegram Bot Webhook                                        Telegram Mini App
  (supabase/functions/telegram-auth)                            (abiedienbackoffice.pages.dev)
               │                                                           │
               │ initData HMAC-SHA256                                      │ window.Telegram.WebApp
               ▼                                                           ▼
       [ EDGE FUNCTION LAYER ]                                     [ FRONTEND LAYER ]
   • telegram-auth (Port: 54321)                                  • React 18 + Vite (SPA)
   • backoffice-api-v3 (Port: 54321)                             • Monolithic src/App.tsx (9.2k lines)
               │                                                 • src/lib/api.ts (DoH, mock data)
               │ Service Role / JWT                                        │
               ▼                                                           ▼
                                  [ SUPABASE POSTGRESQL ]
                                (Project: pnvnpencatzspkwxspac)
               ┌───────────────────────────────────────────────────────────┐
               │ Core Tables:                                              │
               │  • users (canonical business identity)                    │
               │  • telegram_users (external TG identity - SPLIT)          │
               │  • dashboard_access (operator auth mapping)               │
               │  • tickets, ticket_messages, ticket_events (FSM)           │
               │  • backoffice_capabilities, backoffice_role_capabilities  │
               │  • claims, payments, forum_topics                         │
               │  • system_controls (emergency flags)                      │
               │  • audit_logs (immutable event log)                       │
               │  • telegram_bot_settings, admin_chat_ids (credentials)    │
               └───────────────────────────────────────────────────────────┘
```

---

## 2. Identity Flow (Current Split vs Canonical Target)

### Current Architecture (Broken / Split Identity)
```text
[ Telegram User ] ──► telegram_users (telegram_user_id BIGINT) ──┐
                                                                  ├─► SPLIT: Tidak ada FK
[ Internal System ] ──► users (id BIGSERIAL, telegram_id BIGINT) ─┘   Dua tabel menentukan role!

[ Dashboard Staff ] ──► auth.users (UUID) ──► dashboard_access (auth_user_id UUID, user_id BIGINT)
```

### Target Architecture (Phase B)
```text
Telegram Account
       │ (telegram_user_id)
       ▼
telegram_users
       │ linked_user_id (FK)
       ▼
  public.users  ◄─── [CANONICAL BUSINESS IDENTITY]
       │
       ├── Member Data: tickets, domain_inventory, claims, payments
       │
       └── Staff Identity:
                ▲
                │ user_id
         dashboard_access ◄─── auth.users (Supabase Auth Session)
                │
                ▼
         backoffice_role_capabilities ──► [CAPABILITY ENFORCEMENT]
```

### Lifecycle Status:
- `UNKNOWN`: User Telegram pertama kali chat, belum ada di DB.
- `GUEST`: Record ada di `telegram_users`, `status = 'pending'`, `role = 'guest'`, `linked_user_id = NULL`.
- `REGISTERED`: Form registrasi masuk, `users` record terbuat (`onboarding_status = 'PENDING_REVIEW'`), `telegram_users.linked_user_id` ditautkan.
- `PENDING_REVIEW`: Menunggu admin review kelayakan.
- `MEMBER_ACTIVE`: `users.status = 'active'`, `users.onboarding_status = 'APPROVED'`, memiliki akses penuh ke fitur member.
- `STAFF`: Pengguna Supabase Auth dengan record aktif di `dashboard_access` (`role`: `admin`, `dev`, `super_admin`, `root`).

---

## 3. Auth Flow & Vulnerability Matrix

### A. Telegram Mini App Authentication
- **Current Flow**:
  1. Mini App membaca `window.Telegram.WebApp.initData`.
  2. Dikirim via `POST /functions/v1/telegram-auth/verify-init-data`.
  3. Backend memverifikasi tanda tangan HMAC-SHA256 menggunakan `TELEGRAM_BOT_TOKEN`.
  4. Backend mencari kecocokan di `telegram_users` dan `dashboard_access`.
- **Status**: Validasi server-side HMAC aktif di `telegram-auth/index.ts`.

### B. Backoffice Login (`backoffice-api-v3`)
- **P0 Backdoor Ditemukan**:
  - `backoffice-api-v3/index.ts` baris 104–115:
    ```ts
    if (b.password === 'Abiedien@2026' || b.password.length >= 6) {
      return wrap(json({
        access_token: 'super_admin_direct_' + Date.now(),
        refresh_token: 'refresh_' + Date.now(),
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        user: { id: '00000000-0000-0000-0000-000000000000', email: b.email }
      }), req);
    }
    ```
  - `backoffice-api-v3/index.ts` baris 136: endpoint `/refresh` mengembalikan token sintetis `super_admin_refreshed_*` tanpa verifikasi.
- **P0 Fallback Super Admin Session**:
  - `backoffice-api-v3/index.ts` baris 172–178: saat query user gagal, endpoint `/session` secara otomatis mengembalikan profil palsu `{ id: 1, username: 'superadmin', role: 'super_admin' }`.

---

## 4. Telegram Flow & Command Registry

File: `supabase/functions/telegram-auth/index.ts` (1,268 baris)

| Command / Handler | Target Role | Action & Risk Assessment |
|---|:---:|---|
| `/start`, `/menu` | Public | Menampilkan salam & keyboard menu sesuai role. |
| `REG#<token>` | Guest | Pendaftaran token onboarding. |
| `/reqdomain <domain>` | Member | Cek DoH Google. Mengirim notifikasi teks ke admin. **Tidak membuat record DB**. |
| `/whois <domain>` | Public | Cek DoH NS record via Google Public DNS. Sering false positive. |
| `/claim` | Member | Membuka flow submit klaim bukti gaji. |
| `/reregister` | Member | Form pendaftaran ulang. |
| `/forum` | Public | Mengirim link invite komunitas. |
| `/status` | Member | Menampilkan status akun dan domain terdaftar. |
| `/login` | Staff | Mengirim magic link login dashboard. |
| `/ticket` | Member | Daftar tiket bantuan aktif. |
| `/admin help` | Super Admin | Bantuan perintah admin. |
| `/admin claims` | Super Admin | List 5 klaim pending. |
| `/admin domain_requests` | Super Admin | List 10 domain request pending. |
| `/admin domain_assign` | Super Admin | Assign domain ke member. |
| `/admin domain_reject` | Super Admin | Tolak domain request. |
| `/admin promote/demote` | Super Admin | Ubah role di `telegram_users` (sebelumnya tanpa audit log). |
| `/admin block/unblock` | Super Admin | Blokir/aktifkan user Telegram. |

**Idempotency Flaw**: Tabel `telegram_updates` sudah ada di database, tetapi webhook handler tidak melakukan `INSERT ... ON CONFLICT DO NOTHING` terhadap `update_id`. Webhook Telegram yang di-retry dapat menyebabkan side effect ganda.

---

## 5. Ticket Flow (FSM Engine)

Baseline: `20260905000004_atomic_ticket_mutation_and_fsm.sql`

```text
                 ┌───────────────┐
                 │     DRAFT     │
                 └───────┬───────┘
                         │
                         ▼
                 ┌───────────────┐
      ┌─────────►│    PENDING    │──────────┐
      │          └───────┬───────┘          │
      │                  │                  ▼
      │                  ▼          ┌───────────────┐
      │          ┌───────────────┐  │   REJECTED    │
      │          │   ASSIGNED    │  └───────────────┘
      │          └───────┬───────┘          ▲
      │                  │                  │
      │                  ▼                  │
      │          ┌───────────────┐          │
      │          │  IN_PROGRESS  ├──────────┘
      │          └───────┬───────┘
      │                  │
      │         ┌────────┴────────┐
      │         ▼                 ▼
      │ ┌───────────────┐ ┌───────────────┐
      │ │WAITING_MEMBER │ │   ESCALATED   │
      │ └───────┬───────┘ └───────┬───────┘
      │         │                 │
      │         └────────┬────────┘
      │                  │
      │                  ▼
      │          ┌───────────────┐
      └──────────┤   RESOLVED    │
                 └───────┬───────┘
                         │
                         ▼
                 ┌───────────────┐
                 │    CLOSED     │
                 └───────────────┘
```

**Kerentanan Sebelumnya (P0)**:
- Fungsi `mutate_ticket_state_atomic` menerima `p_actor_id` dari client. Jika client mengirim ID admin lain, database percaya dan mencatat role serta audit log atas nama admin tersebut.
- Telah diperbaiki pada draft migrasi 009: identitas actor diwajibkan ditarik langsung dari session `auth.uid()`.

---

## 6. Domain Flow (Current vs Real Execution)

### Kondisi Saat Ini (Simulation / Disconnected)
- **Telegram `/reqdomain`**: hanya mengecek NS di Google DoH (`dns.google/resolve?name=...&type=NS`) dan mem-blast pesan teks ke admin Telegram. Tidak ada record database di tabel manapun.
- **Backoffice Frontend (`src/App.tsx`)**:
  - `DomainOrdersView`: membaca array mock `INITIAL_DOMAIN_ORDERS` dari state lokal.
  - `MemberInventoryView`: membaca array mock `INITIAL_MEMBER_INVENTORIES`.
  - Mutasi status ACC/Reject hanya mengubah React state & `localStorage`.
- **Edge Function `backoffice-api-v3`**:
  - Route `/domains` mengarah ke tabel `web_requests` (bukan tabel inventory).

### Target Arsitektur (Phase C & D)
1. **Global Domain Check Service (`checkDomain`)**:
   - Satu pipeline tunggal untuk Bot, WebApp, dan Backoffice.
   - Lapisan: Syntax Normalization ➔ RDAP Lookup ➔ DNS Resolution ➔ Cloudflare Zone Check ➔ Internal Inventory.
   - Menghilangkan asumsi salah: NXDOMAIN bukan berarti otomatis platform-owned atau aman.
2. **Database Integration**:
   - `domain_inventory`: tabel aset resmi platform.
   - `tickets` (`category = 'domain_request'`): tiket pengerjaan.
   - `domain_assignments`: relasi kepemilikan domain oleh `public.users.id`.

---

## 7. Payment & Claim Flow

### Database State
- Tabel `public.payments`: skema enterprise (0 rows di remote).
- Tabel `public.claims`: mencatat `telegram_user_id`, `submitted_by` (UUID), `evidence_path`, `amount`, `status`.
- Bucket storage: `claim-evidence` (private).

### Kerentanan Rate Limit (Migration 006)
- Fungsi `check_claim_rate_limit(p_telegram_user_id, p_claim_type)` hanya menjalankan dua query `SELECT`:
  1. `SELECT COUNT(*) WHERE created_at >= NOW() - INTERVAL '24 hours'`
  2. `SELECT EXISTS(SELECT 1 WHERE status IN ('pending', 'reviewing'))`
- **Race Condition**: Tidak ada transaction lock (`FOR UPDATE` atau `pg_advisory_xact_lock`). Dua request paralel yang dikirim dalam milidetik yang sama akan lolos bersamaan.

---

## 8. Current Deployment Flow (CI/CD)

File: `.github/workflows/deploy-cloudflare.yml`
- **Trigger**: Push ke `main` atau `master`.
- **Langkah-langkah**:
  1. `npm ci || npm install` ⚠️ (Anti-pattern: fallback menyembunyikan lockfile drift).
  2. `npm run build` ➔ `wrangler pages deploy dist`.
  3. `supabase db push` ⚠️ (Langsung mendorong seluruh migrasi tanpa dry-run atau approval gate).
  4. `supabase functions deploy` (Deploy semua edge functions otomatis).
- **Kekurangan Kritis**:
  - Tidak ada linting (`npm run lint`).
  - Tidak ada TypeScript typecheck (`tsc --noEmit`).
  - Tidak ada automated negative tests.

---

## 9. Master Inventory: Known Drift

1. **Column Name Mismatch**:
   `backoffice-api-v3/index.ts` baris 44 memanggil `.select('id,user_id,role,enabled,expires_at')` pada `dashboard_access`. Namun kolom di database migrasi 005 & 006 bernama `is_active`, bukan `enabled`!
2. **Table Name Mismatch**:
   `backoffice-api-v3/index.ts` baris 304 melakukan insert ke `telegram_notifications`, padahal tabel yang ada di remote database adalah `notifications`.
3. **Route Mapping Drift**:
   Route `/domains` di `backoffice-api-v3` di-proxy ke tabel `web_requests` (0 rows), sementara frontend mengelola domain order via state lokal.
4. **Idempotency Abandonment**:
   Tabel `telegram_updates` tersedia di remote DB (memiliki 48 rows historis), tetapi kode bot saat ini tidak mencatat `update_id` baru.
5. **Role Hierarchy Drift**:
   `dashboard_access` (migrasi 005) membatasi `role IN ('admin', 'super_admin')`, memblokir `dev` dan `root` yang sudah sah di tabel `users` (migrasi 001).

---

## 10. Master Inventory: Known Simulation (Fake Success)

1. **`TelegramBotSimulator`** (`src/App.tsx:5600–5670`): Mock chat sandbox berbasis `setTimeout` dan keyword matching lokal.
2. **`/broadcast` Endpoint** (`backoffice-api-v3:346–349`): Mengembalikan `{ success: true, broadcasted_to: ... }` seketika tanpa melakukan pengiriman pesan.
3. **`/bot-status` Endpoint** (`backoffice-api-v3:267–269`): Mengembalikan `{ status: 'ACTIVE' }` tanpa memanggil Telegram `getWebhookInfo`.
4. **Mock Asset Arrays** (`src/lib/api.ts`):
   - `INITIAL_DOMAIN_ORDERS` (10 dummy orders).
   - `INITIAL_MEMBER_INVENTORIES` (12 dummy domains).
   - `INITIAL_TECHNICAL_CASES` (dummy tickets).
   - `INITIAL_BANNER_ASSETS` (dummy CDN probes).
5. **WHOIS Check Heuristic** (`src/lib/api.ts:251`): Menyimpulkan ketersediaan domain hanya dari NXDOMAIN DNS publik.

---

## 11. Master Inventory: Known Security Issues

| ID | Tingkat | Komponen | Deskripsi Kerentanan | Dampak |
|:---:|:---:|---|---|---|
| **SEC-01** | **P0** | `backoffice-api-v3` | Hardcoded password `Abiedien@2026` / `password.length >= 6` bypass auth. | Penyerang dapat login sebagai Super Admin tanpa akun Supabase Auth. |
| **SEC-02** | **P0** | `backoffice-api-v3` | Endpoint `/refresh` mengembalikan token sintetis `super_admin_refreshed_*`. | Bypass autentikasi session. |
| **SEC-03** | **P0** | `backoffice-api-v3` | Fallback user di `/session` mengembalikan `super_admin` jika query DB error. | Fail-Open vulnerability. |
| **SEC-04** | **P0** | `mutate_ticket_state_atomic` | RPC mempercayai `p_actor_id` dari input client. | Actor identity spoofing / privilege escalation. |
| **SEC-05** | **P0** | `telegram_bot_settings` | Token bot & key AI tersimpan di tabel yang sebelumnya dapat diakses public/anon. | Paparan kredensial bot Telegram & AI. |
| **SEC-06** | **P1** | `can()` middleware | Role `root`, `super_admin`, `admin`, `dev` otomatis me-return `true` untuk semua capability. | Menghancurkan batas otorisasi granular. |
| **SEC-07** | **P1** | `dashboard_access` | RLS policy rekursif querying tabel itu sendiri. | Potensi query loop / RLS failure. |
| **SEC-08** | **P1** | `src/lib/api.ts` | Hardcoded admin Telegram ID `['7862805424', '8625074832', '8627900503']`. | Kredensial & ID administratif terekspos ke bundle browser client. |
| **SEC-09** | **P2** | `check_claim_rate_limit` | Tidak ada advisory lock atau row lock pada pengecekan kuota klaim harian. | Race condition / multiple claim submission. |

---

## 12. Remote Database Inventory Snapshot

*Total Tabel di Remote Database: 21 Tabel*
- `public.telegram_users`: 5 rows (data bootstrap super admin)
- `public.admin_chat_ids`: 4 rows
- `public.telegram_updates`: 48 rows
- `public.backoffice_capabilities`: 24 rows
- `public.backoffice_role_capabilities`: 46 rows
- `public.audit_logs`: 1 row
- `public.telegram_bot_settings`: 1 row (perlu sanitasi/rotasi)
- `public.users`: 0 rows
- `public.tickets`: 0 rows
- `public.ticket_messages`: 0 rows
- `public.ticket_events`: 0 rows
- `public.claims`: 0 rows
- `public.dashboard_access`: 0 rows
- `public.payments`: 0 rows
- `public.conversation_states`: 0 rows
- `public.forum_topics`: 0 rows
- `public.forum_comments`: 0 rows
- `public.risk_events`: 0 rows
- `public.web_requests`: 0 rows
- `public.telegram_chat_histories`: 0 rows
- `public.notifications`: 0 rows

---

**STATUS BASELINE: SELESAI.**
Tidak ada kode sumber (source code) yang diubah selama Phase 0. Dokumen ini menjadi dasar verifikasi mutlak untuk Phase A hingga Phase P.
