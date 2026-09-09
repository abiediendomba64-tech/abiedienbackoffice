-- =================================================================
-- MIGRATION: 20260909000007_security_remediation_p0.sql
-- DESCRIPTION: Phase A — Security Remediation:
--              1. Revoke public/anon/authenticated access to secret tables
--              2. Enforce strict service-role isolation with RLS Default Deny
--              3. Clean up obsolete/permissive policies (no dummy policies)
--              4. Harden search_path on stored procedures with search_path = ''
--              5. Zero duplicate indexes
-- =================================================================

-- 1. Cabut SELURUH hak akses public/anon/authenticated ke tabel internal & credential bot
REVOKE ALL ON TABLE public.telegram_bot_settings FROM anon, authenticated, PUBLIC;
REVOKE ALL ON TABLE public.telegram_chat_histories FROM anon, authenticated, PUBLIC;
REVOKE ALL ON TABLE public.admin_chat_ids FROM anon, authenticated, PUBLIC;
REVOKE ALL ON TABLE public.telegram_updates FROM anon, authenticated, PUBLIC;

-- 2. Drop semua RLS policy yang permissive atau obsolete
-- Tidak ada dummy policy (seperti auth.uid() IS NOT NULL AND FALSE)
DROP POLICY IF EXISTS "Allow read access to bot settings" ON public.telegram_bot_settings;
DROP POLICY IF EXISTS "Allow update for admin" ON public.telegram_bot_settings;
DROP POLICY IF EXISTS "Allow users to read their own chat history" ON public.telegram_chat_histories;
DROP POLICY IF EXISTS "Allow users to insert their own chat history" ON public.telegram_chat_histories;
DROP POLICY IF EXISTS "chat_history_own_read" ON public.telegram_chat_histories;

-- 3. Pastikan RLS tetap ENABLED
-- Dengan RLS enabled dan ketiadaan policy untuk client, PostgREST menerapkan DEFAULT DENY.
-- Hanya backend / Edge Functions dengan SUPABASE_SERVICE_ROLE_KEY yang dapat mengakses lewat bypass RLS.
ALTER TABLE public.telegram_bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_chat_histories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_chat_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_updates ENABLE ROW LEVEL SECURITY;

-- 4. Harden search_path pada fungsi-fungsi sensitif dengan search_path = ''
-- Mencegah search-path hijacking/poisoning attacks
ALTER FUNCTION public.prevent_audit_log_mutation() SET search_path = '';
ALTER FUNCTION public.set_updated_at() SET search_path = '';
ALTER FUNCTION public.set_ticket_number() SET search_path = '';
ALTER FUNCTION public.set_payment_number() SET search_path = '';
ALTER FUNCTION public.set_topic_number() SET search_path = '';
