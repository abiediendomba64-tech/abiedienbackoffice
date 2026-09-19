-- Function integrity hardening
-- Backend-only mutations are exposed through backoffice-api-v3 (service_role).
REVOKE ALL ON FUNCTION public.record_double_entry_ledger(bigint, bigint, bigint, numeric, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_double_entry_ledger(bigint, bigint, bigint, numeric, text, bigint) TO service_role;

REVOKE ALL ON FUNCTION public.transition_website_lifecycle(bigint, varchar, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_website_lifecycle(bigint, varchar, text, bigint) TO service_role;
