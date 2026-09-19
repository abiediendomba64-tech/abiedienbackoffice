-- Step 3 financial/RLS hardening: close direct browser mutation paths and add the missing atomic claim rejection path.
ALTER TABLE public.claims DROP CONSTRAINT IF EXISTS valid_claim_status;
ALTER TABLE public.claims ADD CONSTRAINT valid_claim_status CHECK (status IN ('pending','reviewing','approved','rejected','settled'));

DROP POLICY IF EXISTS claims_admin_manage ON public.claims;
DROP POLICY IF EXISTS claims_member_insert ON public.claims;
CREATE POLICY claims_member_insert ON public.claims FOR INSERT TO authenticated
WITH CHECK (submitted_by = auth.uid() AND EXISTS (
  SELECT 1 FROM public.users u WHERE u.id = user_id AND u.auth_user_id = auth.uid() AND u.status = 'active'
));
DROP POLICY IF EXISTS claims_select_own ON public.claims;
CREATE POLICY claims_select_own ON public.claims FOR SELECT TO authenticated USING (submitted_by = auth.uid());

DROP POLICY IF EXISTS payment_transactions_member_read ON public.payment_transactions;
CREATE POLICY payment_transactions_member_read ON public.payment_transactions FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = payment_transactions.user_id AND u.auth_user_id = auth.uid()));

DROP POLICY IF EXISTS payments_member_read ON public.payments;
CREATE POLICY payments_member_read ON public.payments FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = payments.user_id AND u.auth_user_id = auth.uid()));

REVOKE INSERT, UPDATE, DELETE ON public.payment_ledger_entries FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.payment_transactions FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.claims FROM anon, authenticated;
REVOKE UPDATE, DELETE ON public.payments FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.reject_claim_atomic(
  p_claim_id uuid, p_actor_id bigint, p_actor_role varchar, p_rejection_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_claim public.claims%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Unauthorized: claim rejection is backend-only'; END IF;
  IF p_actor_id IS NULL OR p_actor_role IS NULL THEN RAISE EXCEPTION 'Invalid rejection actor'; END IF;
  IF NULLIF(trim(COALESCE(p_rejection_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  SELECT * INTO v_claim FROM public.claims WHERE id=p_claim_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim % not found',p_claim_id; END IF;
  IF v_claim.status='rejected' THEN RETURN jsonb_build_object('success',true,'already_rejected',true,'claim_id',p_claim_id,'status','rejected'); END IF;
  IF v_claim.status NOT IN ('pending','reviewing') THEN RAISE EXCEPTION 'Claim % cannot be rejected from status %',p_claim_id,v_claim.status; END IF;
  UPDATE public.claims SET status='rejected', rejection_reason=trim(p_rejection_reason), reviewed_by=p_actor_id, reviewed_at=NOW(), updated_at=NOW() WHERE id=p_claim_id;
  INSERT INTO public.audit_logs(actor_id,actor_role,action_type,resource_type,resource_id,old_value,new_value,reason)
  VALUES(p_actor_id,p_actor_role,'REJECT_CLAIM','claims',p_claim_id::text,
    jsonb_build_object('claim_id',p_claim_id,'status',v_claim.status),
    jsonb_build_object('claim_id',p_claim_id,'status','rejected','rejection_reason',trim(p_rejection_reason)),
    trim(p_rejection_reason));
  INSERT INTO public.telegram_notification_log(recipient_chat_id,message_text,context_type,context_id,status)
  VALUES(COALESCE(v_claim.telegram_user_id,0),format('Klaim %s ditolak. Alasan: %s.',COALESCE(v_claim.claim_number,p_claim_id::text),trim(p_rejection_reason)),'claim',p_claim_id::text,'queued');
  RETURN jsonb_build_object('success',true,'claim_id',p_claim_id,'status','rejected');
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.reject_claim_atomic(uuid,bigint,varchar,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_claim_atomic(uuid,bigint,varchar,text) TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_payment_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $function$
BEGIN RAISE EXCEPTION 'payment_ledger_entries is append-only; create a reversal entry instead of %', TG_OP; END;
$function$;
REVOKE EXECUTE ON FUNCTION public.prevent_payment_ledger_mutation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_payment_ledger_mutation() TO service_role;
