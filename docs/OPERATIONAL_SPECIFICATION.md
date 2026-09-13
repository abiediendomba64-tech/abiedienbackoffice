# Master Control Center — Operational Specification & Execution Blueprint

> **Status:** Operational Specification (Phase 1 Baseline)  
> **Source of Truth:** Operational Chat & Audit Synthesis → Supabase System of Record  
> **Golden Principle:** Blueprint bukan diagram konseptual; ia adalah spesifikasi operasional yang mengendalikan Dashboard Control Center, di mana setiap tombol memiliki jejak tak terputus hingga database, API, authorization, audit log, dan notifikasi.

---

## 1. Topologi Arsitektur 5-Layer

Sistem dibangun di atas pemisahan peran yang tegas agar state bisnis tidak terpecah dan percakapan operasional tidak berkembang menjadi instruksi manual yang rentan hilang:

```text
                 MASTER CONTROL CENTER (Dashboard UI)
                                  │
                                  ▼
                     AUTOMATION / WORKFLOW ENGINE
                         (backoffice-api-v3)
                                  │
                                  ▼
                      SUPABASE SYSTEM OF RECORD
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
      State Machine         Financial Ledger        Audit Log
       (Atomic RPC)          (Double Entry)        (Immutable)
            │                     │                     │
            └─────────────────────┼─────────────────────┘
                                  ▼
                        EVENT & INTEGRATION
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
     NOTIFICATION          CLOUDFLARE EDGE       GITHUB CI/CD
    (Telegram Alerts)     (DNS/SSL/Routing)     (Build & Deploy)
```

### Pemisahan Tanggung Jawab (Separation of Concerns)

1. **GitHub (Source of Truth untuk Kode):**
   - Menyimpan seluruh source code, migrasi SQL, API Edge Functions, komponen Dashboard, script otomasi, dan CI/CD pipeline.
   - *Bukan tempat menyimpan runtime state atau data operasional.*

2. **Supabase (System of Record untuk State Bisnis):**
   - Menjadi satu-satunya sumber kebenaran data bisnis: users, websites, tickets, claims, payment ledger, incident checks, domains, RBAC capabilities, dan audit trail.
   - State transition dikawal oleh **PL/pgSQL Trigger & Atomic SECURITY DEFINER RPC**.

3. **Cloudflare (Execution & Edge Layer):**
   - Mengelola DNS record, sertifikat SSL/TLS, reverse proxy, routing, Edge caching, dan hosting frontend (Cloudflare Pages).
   - *Cloudflare bukan database. Cloudflare tidak menyimpan state bisnis atau logika bisnis.*

4. **Dashboard (Master Control Center):**
   - Bukan sekadar "admin panel" CRUD biasa, melainkan control tower operasional tempat staf mengeksekusi workflow dengan autorisasi berbasis kapabilitas (RBAC).

5. **Telegram (Command Intake & Notification Surface):**
   - Telegram berfungsi sebagai saluran notifikasi instan dan pintu masuk perintah awal (command intake).
   - Chat teks di Telegram diparse menjadi structured intent dan dieksekusi melalui API/RPC. *Chat bukan tempat menyimpan state transaksi.*

---

## 2. Aturan Emas Dashboard Control Center (The Golden Chain)

Setiap tombol dan aksi di Dashboard **wajib** memiliki rantai eksekusi lengkap yang terverifikasi dari hulu ke hilir:

```text
  [ Dashboard Button Click ]
              │
              ▼
  [ UI Action & Payload Validation ]
              │
              ▼
  [ API Route Call (backoffice-api) ]
              │
              ▼
  [ Authentication (Supabase Auth JWT) ]
              │
              ▼
  [ Capability Check (backoffice_has_capability) ]
              │
              ▼
  [ Business Rule & Pre-condition Check ]
              │
              ▼
  [ Atomic RPC / Database Transaction ]
              │
              ▼
  [ State Machine Transition (FSM Trigger) ]
              │
              ▼
  [ Immutable Audit Log (audit_logs) ]
              │
              ▼
  [ Event Sourcing Record (website_events / etc.) ]
              │
              ▼
  [ Notification Event Dispatched (Telegram / Webhook) ]
              │
              ▼
  [ UI State Optimistic/Realtime Update ]
```

### Contoh Kasus: Tombol "Approve 75%"
- ❌ **Salah:** Frontend memanggil `UPDATE websites SET commission_rate = 75`.
- ✅ **Benar:**
  1. Operator klik **"Approve 75%"** pada request `UR-2026-0901`.
  2. Frontend mengirim payload ke `/api/v3/updates/approve` dengan token JWT operator.
  3. API memverifikasi akun operator di `dashboard_access` dan kapabilitas `commission.approve`.
  4. API memanggil RPC `approve_update_request(p_request_id, p_effective_date)`.
  5. RPC menjalankan transaksi atomik:
     - Mengunci baris `update_requests` (`FOR UPDATE`).
     - Memverifikasi status request berada pada state `reviewing`.
     - Mengubah status request menjadi `approved` lalu `scheduled` / `effective`.
     - Mengupdate record `websites.commission_rate = 75.00` dan `commission_effective_at`.
     - Memasukkan log ke `audit_logs` (old_rate: 60, new_rate: 75, approver: user_id).
     - Menembakkan event ke antrean notifikasi `telegram_notification_log`.
  6. Bot Telegram mengirimkan alert konfirmasi ke grup operasional: *"Commission rate Paman73 resmi diupdate ke 75% efektif per [tanggal]"*.

---

## 3. Spesifikasi Domain Utama

### 3.1 Website Lifecycle (Pusat Ekosistem Operasional)

Tabel `websites` bukan tabel terisolasi, melainkan entitas jangkar dari seluruh layanan:

```text
                                  WEBSITE LIFECYCLE FSM
                                            │
        ┌───────────────────────────────────┴───────────────────────────────────┐
        ▼                                                                       ▼
   [ REQUESTED ] ──► [ VALIDATING ] ──► [ APPROVED ] ──► [ PROVISIONING ] ──► [ BUILDING ]
                                                                                │
        ┌───────────────────────────────────────────────────────────────────────┘
        ▼
   [ DEPLOYING ] ──► [ DNS_PENDING ] ──► [ SSL_PENDING ] ──► [ PANEL_PENDING ]
                                                                     │
        ┌────────────────────────────────────────────────────────────┘
        ▼
   [ ACCESS_VERIFICATION ] ──► [ ACTIVE ] ──┐
                                  ▲         │ (Degraded health / Non-payment)
                                  │         ▼
                                  ├── [ DEGRADED ]
                                  │         │
                                  │         ▼
                                  ├── [ SUSPENDED ]
                                  │         │ (7 days no value / inactive)
                                  │         ▼
                                  └── [ RECLAIM_WARNING ]
                                            │ (Grace period expired)
                                            ▼
                                      [ RECLAIMED ] (Terminal)
```

#### Struktur Entitas Terkait Website:
1. `websites`: Master data website, status FSM, tema, konfigurasi, komisi, tanggal aktivasi, nilai terakhir (`last_value_at`), target tanggal reclaim (`reclaim_at`).
2. `website_events`: Event sourcing yang mencatat histori perpindahan status beserta aktor, catatan, dan metadata JSONB.
3. `website_services`: Relasi layanan pihak ketiga (Cloudflare DNS, SSL edge, Pages deployment, backoffice panel URL).
4. `website_credentials_ref`: Referensi rahasia (secret-manager reference) untuk credential panel. **Plaintext password dilarang keras disimpan di tabel!**
5. `website_health_checks`: Hasil automated health check per website (DNS, SSL, HTTP, API, Auth, Payment).
6. `website_reclaim_rules`: Aturan otomatisasi penarikan website (misal: 7 hari tanpa value → notifikasi warning → grace period 48 jam → status reclaimed).

---

### 3.2 Update & Commission Workflow ("Update 75%")

Setiap perubahan persentase komisi, pergantian nama, atau modifikasi parameter kritis harus melalui siklus formal `update_requests`:

```text
[ USER/OPERATOR CHAT ]
         │
         ▼
[ CREATE UPDATE_REQUEST ] ──► [ REVIEWING ] ──► [ APPROVED ] ──► [ EFFECTIVE ]
                                     │
                                     └──► [ REJECTED ]
```

- **Field Inti:** `website_id`, `requested_by`, `current_rate`, `target_rate`, `reason`, `status`, `approved_by`, `effective_at`.
- **Integritas:** Angka persentase komisi ditentukan oleh database secara atomik, bukan nilai bebas yang dikirim dari input form client.

---

### 3.3 Payment Core & Provider Failover

Memisahkan sistem finansial dari website untuk mencegah ketergantungan rapuh:

```text
                             PAYMENT CORE ENGINE
                                      │
             ┌────────────────────────┴────────────────────────┐
             ▼                                                 ▼
     PAYMENT PROVIDERS                                   PAYMENT LEDGER
   - StarPAGO (QRIS / VA)                             - Double-Entry Records
   - GSPay (QRIS / H2H)                               - Payin / Payout
   - Health Monitor & Latency                         - Settlement & Coin
             │                                                 │
             ▼                                                 ▼
   [ AUTOMATIC FAILOVER ]                              [ RECONCILIATION ]
   Provider A DOWN ──► Auto-switch to Provider B       Daily matching with
   (Log Audit + Telegram Alert: "Alihkan ke GSPay")    Bank/Provider reports
```

- **Failover Policy:** Jika gateway utama (misal: StarPAGO) mengalami kegagalan 3 kali berturut-turut atau berstatus `maintenance`, sistem secara otomatis mengalihkan rute transaksi baru ke gateway sekunder (misal: GSPay), mencatat kejadian ke `audit_logs`, dan mengirim alert prioritas ke grup Telegram finance.

---

### 3.4 Operational Incident Management & Diagnostic Run

Menghilangkan respon spekulatif *"mungkin server restart"* dengan bukti diagnostik sistematis:

```text
[ INCIDENT CREATED ] ──► Run Automated Diagnostic Suite
                                   │
               ┌───────────────────┼───────────────────┐
               ▼                   ▼                   ▼
           [ DNS CHECK ]       [ SSL CHECK ]       [ HTTP CHECK ]
           Query Cloudflare    Verify Expiry/SAN   Status 200 OK
               │                   │                   │
               └───────────────────┼───────────────────┘
                                   │
               ┌───────────────────┼───────────────────┐
               ▼                   ▼                   ▼
           [ API CHECK ]       [ AUTH CHECK ]     [ PAYMENT CHECK ]
           Endpoint ping       Token exchange      Provider ping
                                   │
                                   ▼
                   [ RECORD TO incident_checks ]
                     Pass/Fail Matrix Visualized
```

- Setiap insiden memiliki timeline record di `incident_checks`:
  - `check_type`: `dns`, `ssl`, `http`, `api`, `auth`, `payment`, `panel`.
  - `status`: `pass`, `warn`, `fail`.
  - `response_code`, `latency_ms`, `evidence_json`.
- Diagnosa dibuat berdasarkan bukti telemetri yang valid.

---

## 4. Struktur Navigasi Master Control Center (18 Modul)

Dashboard didesain sebagai kokpit lengkap dengan 18 modul terintegrasi:

| No | Modul | Fungsi Utama | Kapabilitas Kunci |
|----|-------|--------------|-------------------|
| 01 | **Overview** | KPI real-time, status layanan global, ringkasan insiden | `dashboard.access` |
| 02 | **Operations** | Antrean pekerjaan operasional harian, task assignment | `ops.manage` |
| 03 | **Websites** | Master lifecycle website (Requested → Active → Reclaimed) | `site.manage` |
| 04 | **Domain Center** | Inventaris domain, availability checker, konfigurasi DNS | `domain.manage` |
| 05 | **Request Queue** | Antrean registrasi baru & permohonan domain gratis/berbayar | `site.request` |
| 06 | **Update / Commission**| Workflow pengajuan dan persetujuan update rate/konfigurasi | `commission.approve` |
| 07 | **Claim Center** | Validasi dan approval klaim member beserta bukti transaksi | `claim.review` |
| 08 | **Payment Center** | Monitoring payin/payout gateway, saklar manual failover provider | `payment.manage` |
| 09 | **Transaction Ledger** | Buku besar double-entry transaksi, saldo, dan settlement | `ledger.view` |
| 10 | **Incident Center** | Tiket gangguan, diagnostic runner, timeline investigasi | `incident.manage` |
| 11 | **System Health** | Matriks status probe DNS/SSL/Edge/API/DB/Providers | `health.view` |
| 12 | **Deployments** | Trigger & log GitHub Actions CI/CD dan Cloudflare Pages | `deploy.execute` |
| 13 | **Notifications** | Antrean dan log status pengiriman notifikasi Telegram | `telegram.send` |
| 14 | **Members** | Database profil member, riwayat kepemilikan situs, credit | `member.manage` |
| 15 | **Team / RBAC** | Manajemen akun staf, role assignment, audit kapabilitas | `admin.manage` |
| 16 | **Audit Log** | Log kejadian tak dapat diubah (who/what/when/before/after) | `audit.read` |
| 17 | **Reports** | Laporan rekonsiliasi keuangan, performa situs, uptime | `report.export` |
| 18 | **System Controls** | Emergency kill-switch (pembekuan pembayaran/klaim/login) | `system.manage_controls` |

---

## 5. Rencana Pelaksanaan Bertahap (013 s/d 023)

Sesuai urutan implementasi yang disepakati, setiap fase ditutup dengan verifikasi kontrak end-to-end:

```text
[013] Website Lifecycle (Pusat Domain Entity & FSM) ──► SELESAI
[014] Update / Commission Rules (Workflow 75%) ───────► SELESAI
[015] Incident Management (Diagnostic Check Timeline) ──► SELESAI
[016] Payment Ledger (Double-Entry Core) ────────────► SELESAI
[017] Payment Provider Abstraction & Failover ───────► BERIKUTNYA
[018] Website Health Monitoring Probes
[019] Reclaim / Expiry Policy Automation
[020] Master Workflow Orchestration
[021] Dashboard Control Center UI Integration
[022] Notification & Automation Hardening
[023] Reconciliation Engine & Integrity Tests
```

---
*Dokumen ini merupakan referensi resmi bagi seluruh developer, agen AI, dan operator sistem Abiedien Backoffice.*
