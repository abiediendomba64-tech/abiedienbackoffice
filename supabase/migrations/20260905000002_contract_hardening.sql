-- Enterprise Support Bot - Contract hardening after 001_initial_schema.sql
-- Fresh-production baseline must be established by 001 before this file is used.
-- No production DDL is executed by this repository change.

-- Remediation selected after DB + repository + deployment-bundle audit:
-- public.rls_auto_enable() is unused by current application/database paths.
-- Exact signature is zero arguments and must be referenced explicitly if removal is performed.
DROP FUNCTION IF EXISTS public.rls_auto_enable();

-- Payment contract hardening: the canonical field set is enforced by 001.
-- Compatibility names such as proof_file_id, proof_url, admin_notes, and payment_method
-- must not be reintroduced into the domain contract.

-- Ticket contract hardening: description is canonical; ticket_messages.message is retained
-- intentionally as message-history content and must not be renamed.
