# Schema Contract & Roadmap (Phase 013 - 023)

> **Status:** Canonical Data Contract & Implementation Roadmap  
> **Target:** Master Control Center System of Record (Supabase PostgreSQL)  
> **Last Updated:** 2026-09-13 (Phase 013: Website Lifecycle)  
> **Enforcement:** Zero-drift policy. Strict type safety (`BIGINT` for user FKs, typed enums/checks, JSONB for metadata).

---

## 1. Roadmap Migrasi Database (013 s/d 023)

| Migrasi | File / Nama | Status | Cakupan Entitas & Tanggung Jawab |
|---------|-------------|--------|-----------------------------------|
| **013** | `20260913000013_website_lifecycle.sql` | **SELESAI (Aktif)** | `websites`, `website_events`, `website_credentials_ref`, `website_services`, `website_reclaim_rules`, `website_health_checks`, kapabilitas `site.*`, FSM trigger, RPC `transition_website_lifecycle`. |
| **014** | `20260914000014_update_commission_rules.sql` | **SELESAI (Aktif)** | `update_requests`, `commission_rules`, `commission_audit_history`, kapabilitas `commission.*`, FSM trigger, RPC `create_commission_update_request`, `approve_commission_update_request`, `reject_commission_update_request`. |
| **015** | `20260915000015_incident_management.sql` | **SELESAI (Aktif)** | `incidents`, `incident_checks`, `incident_timeline`, kapabilitas `incident.*`, FSM trigger, RPC `create_incident_ticket`, `record_incident_diagnostic_check`, `transition_incident_status`. |
| **016** | `20260916000016_payment_ledger.sql` | **SELESAI (Aktif)** | `payment_accounts`, `payment_transactions`, `payment_ledger_entries`, `payment_settlements`, `user_coin_balances`, kapabilitas `ledger.*`, `settlement.*`, RPC `record_double_entry_ledger`, `create_payment_transaction`, `complete_payment_transaction`. |
| **017** | `20260917000017_payment_providers.sql` | **SELESAI (Aktif)** | `payment_providers`, `payment_failover_policies`, `payment_provider_health_logs`, `payment_failover_events`, kapabilitas `provider.*`, RPC `resolve_active_payment_provider`, `record_provider_health_probe`, `trigger_provider_failover`, `reset_provider_failover`. |
| **018** | `20260918000018_website_health_monitoring.sql` | **SELESAI (Aktif)** | `website_health_probe_configs`, `website_health_probe_batches`, website health counters, kapabilitas `health.*`, RPC `create_health_probe_batch`, `get_websites_pending_health_probe`, `evaluate_website_health`, `complete_health_probe_batch`. |
| **019** | `20260919000019_website_reclaim_automation.sql` | **SELESAI (Aktif)** | `website_reclaim_events`, `website_reclaim_archives`, `website_reclaim_batches`, kapabilitas `reclaim.*`, RPC `evaluate_website_reclaim_eligibility`, `cancel_website_reclaim_warning`, `execute_reclaim_website`, auto-cancel trigger on payment transaction. |
| **020** | `master_workflow_orchestrator` | Antrean (Berikutnya) | Orchestrator end-to-end: Request → Domain → Build → Deploy → Panel → Active → Monitor. |
| **021** | `dashboard_control_center` | Antrean | Schema penunjang UI Dashboard 18 modul, saved filter, operator preference, widget config. |
| **022** | `notification_hardening` | Antrean | Queue engine, template rendering, webhook delivery, retry with exponential backoff. |
| **023** | `reconciliation_and_integrity` | Antrean | Mesin rekonsiliasi harian, audit integrity validator, snapshot balance reconciliation. |

---

## 2. Inventaris Entitas & Spesifikasi Schema (Phase 013)

### 2.1 Tabel `public.websites` (Pusat Lifecycle)

```sql
CREATE TABLE public.websites (
    id BIGSERIAL PRIMARY KEY,
    website_code VARCHAR(50) UNIQUE NOT NULL,
    domain VARCHAR(255),
    domain_inventory_id UUID REFERENCES public.domain_inventory(id) ON DELETE SET NULL,
    owner_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    lifecycle_status VARCHAR(30) NOT NULL DEFAULT 'requested',
    domain_type VARCHAR(10) NOT NULL DEFAULT 'free',
    theme VARCHAR(50),
    theme_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    commission_rate NUMERIC(5,2),
    commission_effective_at TIMESTAMPTZ,
    progress INT NOT NULL DEFAULT 0,
    activated_at TIMESTAMPTZ,
    last_value_at TIMESTAMPTZ,
    reclaim_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_website_lifecycle CHECK (lifecycle_status IN (
        'requested','validating','approved','provisioning','building','deploying',
        'dns_pending','ssl_pending','panel_pending','access_verification',
        'active','degraded','suspended','reclaim_warning','reclaimed'
    )),
    CONSTRAINT valid_website_domain_type CHECK (domain_type IN ('free','paid')),
    CONSTRAINT valid_website_progress CHECK (progress BETWEEN 0 AND 100),
    CONSTRAINT valid_website_commission CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 100))
);
```

### 2.2 Tabel `public.website_events` (Event Sourcing Timeline)

```sql
CREATE TABLE public.website_events (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL REFERENCES public.websites(id) ON DELETE CASCADE,
    actor_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    actor_role VARCHAR(50),
    event_type VARCHAR(50) NOT NULL,
    old_status VARCHAR(30),
    new_status VARCHAR(30) NOT NULL,
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 2.3 Tabel `public.website_credentials_ref` (Secret Reference Vault)

```sql
CREATE TABLE public.website_credentials_ref (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL UNIQUE REFERENCES public.websites(id) ON DELETE CASCADE,
    panel_url TEXT,
    username TEXT,
    secret_ref VARCHAR(255),
    delivery_channel VARCHAR(30),
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 2.4 Tabel `public.website_services` (Edge & Provider Service Tracking)

```sql
CREATE TABLE public.website_services (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL REFERENCES public.websites(id) ON DELETE CASCADE,
    service_type VARCHAR(50) NOT NULL, -- 'dns', 'ssl', 'pages', 'proxy', 'panel', 'waf'
    provider VARCHAR(50) NOT NULL DEFAULT 'cloudflare',
    service_ref VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'pending', -- 'pending', 'active', 'degraded', 'error'
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_website_service UNIQUE (website_id, service_type)
);
```

### 2.5 Tabel `public.website_reclaim_rules` (Kebijakan Penarikan)

```sql
CREATE TABLE public.website_reclaim_rules (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL UNIQUE REFERENCES public.websites(id) ON DELETE CASCADE,
    idle_threshold_days INT NOT NULL DEFAULT 7,
    warning_grace_hours INT NOT NULL DEFAULT 48,
    min_value_threshold NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    auto_reclaim BOOLEAN NOT NULL DEFAULT FALSE,
    last_evaluated_at TIMESTAMPTZ,
    evaluation_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 2.6 Tabel `public.website_health_checks` (Probe Telemetri Diagnostik)

```sql
CREATE TABLE public.website_health_checks (
    id BIGSERIAL PRIMARY KEY,
    website_id BIGINT NOT NULL REFERENCES public.websites(id) ON DELETE CASCADE,
    check_type VARCHAR(30) NOT NULL, -- 'dns', 'ssl', 'http', 'api', 'auth', 'payment', 'panel'
    status VARCHAR(20) NOT NULL, -- 'pass', 'warn', 'fail'
    latency_ms INT,
    response_code INT,
    error_message TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_health_check_status CHECK (status IN ('pass', 'warn', 'fail'))
);
```

---

## 3. Kontrak Stored Procedure / RPC

### 3.1 `public.transition_website_lifecycle`
Fungsi atomik yang menjadi satu-satunya jalur resmi transisi lifecycle website:

```sql
FUNCTION public.transition_website_lifecycle(
    p_website_id BIGINT,
    p_new_status VARCHAR(30),
    p_notes TEXT DEFAULT NULL,
    p_actor_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
```

#### Kontrak Return JSONB:
```json
{
  "success": true,
  "website_id": 105,
  "from": "approved",
  "to": "provisioning",
  "updated_at": "2026-09-13T01:15:00Z"
}
```

#### Error Handling & Exceptions:
- `Access denied: no active operator account` (Caller authenticated tidak terdaftar di `dashboard_access`)
- `Access denied: role % lacks site.manage capability` (Role caller tidak memiliki hak kelola situs)
- `Website % not found` (ID situs tidak valid)
- `Invalid transition [old_status] -> [new_status]` (FSM trigger menggagalkan transisi yang melanggar aturan)

---

## 4. Matriks Uji Validasi Kontrak 8-Titik (Non-Negotiable)

Sebelum migrasi di-deploy ke production Supabase, seluruh 8 titik rantai operasional wajib diverifikasi:

```text
[1] Database DDL    : Tabel terpasang dengan constraint & index valid.
[2] FSM Trigger     : Transisi status ilegal melempar exception PL/pgSQL.
[3] Stored Proc/RPC : transition_website_lifecycle berjalan atomik dengan search_path=''.
[4] RBAC Gate       : backoffice_has_capability('site.manage') menolak role tanpa izin.
[5] Audit Logging   : Record baru otomatis tercipta di audit_logs dan website_events.
[6] Cloudflare Sync : Edge services sinkron tanpa data business state di Cloudflare.
[7] CI/CD Health    : tsc --noEmit (0 error) & vite build (exit code 0).
[8] Notification    : Event payload siap dikirim ke telegram_notification_log.
```

---
*Dokumen ini merupakan kontrak teknis yang mengikat untuk seluruh fase pengembangan database abiedienbackoffice.*