# Production Reconciliation Report  P0.5 (028 / 029 / 030) vs GitHub vs Live

**Status:** DRAFT — tidak ada perubahan DB / deploy.
**Scope:** project Supabase `pnvnpencatzspkwxspac` / `local source` / `GitHub main`.
**Metode:** inspeksi read-only (CLI `supabase db query --linked`, `migration list`, git lokal). **Tidak ada migration, deploy, atau patch yang dijalankan.**

## Headline

- Production **sudah** mencatat migration `20260924000026` (028), `20260927000029` (029), `20260928000030` (030) — freeze sebelumnya **tidak lagi berlaku terhadap state Supabase saat ini**.
- `public.users.auth_user_id` (**UNIQUE**) dan FK → `auth.users(id) ON DELETE SET NULL` **terkonfirmasi ada di live**.
- Namun **body function live ≠ migration source 029** (bukti `verify_member_access` live tanpa `LIMIT 1`, padahal source 029 memakainya). Ada **deployment/schema drift nyata** antara migration yang tercatat dan fungsi yang benar-benar aktif.
- Karena itu: **jangan jalankan ulang 028/029/030** dari lokal sampai rekonsiliasi selesai.

## A. Verifikasi read-only (first-hand via CLI)

### A1. Migrations tercatat di remote

Dari `supabase migration list --linked` (sebelumnya): semua migration Local == Remote, termasuk `028`, `029`, `030`.

### A2. Constraint `users.auth_user_id` (live)

| constraint | type | definition |
| --- | --- | --- |
| `users_auth_user_id_key` | u | `UNIQUE (auth_user_id)` |
| `users_auth_user_id_fkey` | f | `FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL` |

### A3. Kolom live (information_schema)

- `telegram_notification_log`: `attempt_count, context_id, context_type, created_at, error_code, error_reason, id, last_attempt_at, message_text, recipient_chat_id, sent_at, status, telegram_message_id` — **TIDAK ada `metadata`**.
- `tickets`: **TIDAK ada `customer_telegram_id`**.
- `users`: ada `auth_user_id`, `phone_encrypted`, `telegram_id` — **TIDAK ada `phone_number`**.

### A4. Referensi body fungsi live (pg_get_functiondef)

| function | ref `customer_telegram_id` | ref `telegram_notification_log` | ref `metadata` | ref `LIMIT 1` |
| --- | --- | --- | --- | --- |
| `reply_ticket_atomic` | 2760 | 2642 | 2110 | 0 |
| `advance_workflow_step` | 0 | 2339 | 2424 | 1154 |
| `verify_member_access` | 0 | 0 | 0 | **0** |
| `verify_admin_access` | 0 | 0 | 0 | 727 |
| `link_identity` | 0 | 0 | 0 | 0 |

**Interpretasi:**

- Live `reply_ticket_atomic` memakai `customer_telegram_id` + `telegram_notification_log(... metadata)` → **kolom tidak ada di live** → potensi gagal runtime di jalur notifikasi.
- Live `advance_workflow_step` memakai `telegram_notification_log(... metadata)` → kolom tidak ada → dead-end runtime.
- Live `verify_member_access` **tidak memuat `LIMIT 1`**, sedangkan source **lokal 029** memuatnya (L167, L183) → **live ≠ source 029** (drift migration-to-function).

## B. State GitHub `main` (git lokal, HEAD = origin/main = `78afb09`)

| Item | Hasil |
| --- | --- |
| Branch `main` == `origin/main` | Ya (`78afb09`) |
| Commit p0.5 di history | `200c036 feat: p0.5 cors explicit whitelist, identity bridge migration, and vite build fix` |
| `.github/workflows/staging-drift-check.yml` | **TIDAK tracked** → tidak ada di `main` |
| `deploy-cloudflare.yml` masih `supabase db push` pada push `main` | Ya (ada step "Deploy Supabase Migrations") |

## C. Klasifikasi temuan (gabungan: CLI read-only + sumber lokal + inspeksi live user)

| # | Temuan | Severity | Bukti |
| --- | --- | --- | --- |
| 1 | Production sudah 028/029/030; freeze lama tak berlaku | 🔴 CRITICAL | CLI: migration list |
| 2 | CORS live `backoffice-api-v3` refleksi arbitrary + credentials true | 🔴 HIGH | Inspeksi live user (function v16) — perlu konfirmasi source |
| 3 | CORS live `telegram-auth` wildcard `*` | 🔴 HIGH | Inspeksi live user (function v20) — perlu konfirmasi source |
| 4 | `reply_ticket_atomic` → `telegram_notification_log.metadata` + `customer_telegram_id` (keduanya tak ada) | 🔴 CRITICAL | CLI: schema + pg_get_functiondef |
| 5 | `advance_workflow_step` → `telegram_notification_log.metadata` (tak ada) | 🔴 HIGH | CLI: schema + pg_get_functiondef |
| 6 | `link_identity()` audit non-atomic (fire-and-forget) | 🔴 HIGH | Sumber lokal 030 + inspeksi live |
| 7 | `verify_member_access()` fallback `LIMIT 1` tanpa guard one-to-one | 🟠 MEDIUM | Sumber lokal 029 |
| 8 | `verify_admin_access` authority/read-model ambigu + auto-link/side effect | 🔴 HIGH | Inspeksi live user + sumber |
| 9 | Frontend `verifyMemberAccess()` fail-open | 🔴 HIGH | Sumber lokal `src/lib/auth.ts` |
| 10 | `registerMember()` `phone_number` + tanpa `telegram_id` (NOT NULL) → false-success | 🔴 HIGH | CLI schema + sumber lokal |
| 11 | Browser memakai `auth.admin.*` + campur id | 🔴 HIGH | Sumber lokal `src/lib/auth.ts` |
| 12 | `POST /tickets` di belakang generic route `if(routes[p])` | 🟠 MEDIUM | Sumber lokal `backoffice-api-v3` |
| 13 | Route `/audit`, `/notifications`, dll. tanpa capability check ketat | 🔴 HIGH | Sumber lokal `backoffice-api-v3` |
| 14 | `/admin promote` / `demote` / `block` / `unblock` hanya butuh `admin.access` | 🔴 HIGH | Sumber lokal `telegram-auth` |
| 15 | Registrasi Telegram langsung `active/member` tanpa approval | 🟠 MEDIUM | Sumber lokal `telegram-auth` |
| 16 | CI auto `db push` pada push `main` | 🔴 CRITICAL | Sumber lokal `deploy-cloudflare.yml` |
| 17 | `staging-drift-check.yml` tidak ada di `main` | ⚠️ HIGH | git lokal: tidak tracked |

### Hijau (PASS, terverifikasi)

- `public.users.auth_user_id` + `UNIQUE` + FK `ON DELETE SET NULL` ✅ (CLI)
- `link_identity()` ada ✅
- `verify_member_access()` tidak lagi menulis `auth_user_id` (source lokal 029) ✅
- `verify_admin_access` anon di-REVOKE (migration 028) ✅
- anon/PUBLIC EXECUTE pada fungsi yang direview sudah dicabut ✅

## C-bis. Verifikasi tambahan live (CLI, read-only)

### Workflow RPC — privilege anon (live, `role_routine_grants`)

| function | anon | authenticated | service_role | PUBLIC |
| --- | --- | --- | --- | --- |
| `cancel_workflow_instance` | ✅ | ✅ | ✅ | ✅ |
| `get_workflow_instance_status` | ✅ | ✅ | ✅ | ✅ |
| `retry_workflow_instance` | ✅ | ✅ | ✅ | ✅ |
| `toggle_dashboard_control_switch` | ✅ | ✅ | ✅ | ✅ |
| `backoffice_has_capability` | ❌ | ✅ | ✅ | n/a |

Keempat workflow RPC adalah `SECURITY DEFINER` tanpa authorization check dan **terbuka ke `anon`/`PUBLIC`** → P0 privilege/mutation exposure (#7/#8/#9/#10). `backoffice_has_capability` tidak terpapar anon.

### Capability model drift (live)

- `backoffice_role_capabilities` punya **dua kolom**: `capability_id` **dan** `capability_code` (drift #11).
- `backoffice_has_capability()` membaca **`capability_id`** (`ref_code=0`) dan berisi **`IF auth.role()='service_role' THEN RETURN TRUE`** (service-role bypass, #12).
- `backoffice-api-v3` `can()` (L223-228) membaca **`capability_code`**.

→ Dua lapisan baca field berbeda untuk capability yang sama → keputusan autorisasi bisa berbeda (authorization drift).

### Koreksi (#23)

File `20260928000030_link_identity_rpc.sql` **tidak dapat dibuktikan ada di `main`** (untracked lokal; remote migration history = applied). Ini memperkuat reconciliation. Ditandai `RECONCILE REQUIRED`.

## D. Stakes & langkah berikut (jangan patch acak)

1. **STOP** automatic migration (`db push`) pada CI, dan audit apakah ada sesi push lain.
2. **Rekonsiliasi** migration source 028/029/030 ↔ live schema ↔ function live (buat baseline diff, bukan langsung jalankan ulang).
3. Perbaiki `reply_ticket_atomic` & `advance_workflow_step` agar memakai kolom live (atau tambah kolom lewat migration berikutnya yang disetujui).
4. `verify_admin_access` : putuskan authority (`admin_accounts`) vs read-model (`dashboard_access`); hapus side-effect.
5. `verify_member_access` : guard one-to-one (0 → deny, 1 → return, >1 → deny).
6. Frontend : `verifyMemberAccess()` fail-closed; `registerMember()` cocokkan schema live; pindahkan `auth.admin.*` ke `/admin/users/...` server-only.
7. Telegram : capability `user.manage` untuk promote/demote/block; hapus auto-active registration bila harus pending-approve.
8. Commit `staging-drift-check.yml` ke `main` dan jadikan gate wajib (manual, tanpa `db push`); set `SUPABASE_STAGING_REF`.
9. Baru lanjut CORS patch + staging test matrix — **tidak sebelum rekonsiliasi 028–030 selesai**.

## E. Keterbatasan laporan

- Source fungsi Edge (Deno) live tidak dapat di-pull via db CLI tanpa access token → klaim #2/#3 diambil dari inspeksi live user; perlu verifikasi ulang terhadap source yang ter-deploy.
- Klaim #8/#12 multi-sumber; finalisasi butuh diff antara source `main` dan function live.

---
**Kesimpulan:** Ya, masih ada bug (beberapa P0/P1), dan **fakta paling krusial: production sudah pada 028–030 sementara function/code aktif masih menyimpan mismatch**. Tunggu rekonsiliasi, jangan patch acak, jangan lanjut staging approval.
