-- Production reconciliation: the canonical onboarding table is present in source history but
-- is absent from the currently inspected production schema. Keep this guard additive.
CREATE TABLE IF NOT EXISTS public.member_onboarding_requests (
  id BIGSERIAL PRIMARY KEY,
  auth_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  telegram_username VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING_REVIEW',
  reviewed_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT member_onboarding_valid_status CHECK (status IN ('PENDING_REVIEW','APPROVED','REJECTED')),
  CONSTRAINT member_onboarding_one_pending_per_auth UNIQUE (auth_user_id, status)
);
CREATE INDEX IF NOT EXISTS idx_member_onboarding_status ON public.member_onboarding_requests(status, created_at);
ALTER TABLE public.member_onboarding_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_onboarding_insert_own ON public.member_onboarding_requests;
CREATE POLICY member_onboarding_insert_own ON public.member_onboarding_requests FOR INSERT TO authenticated WITH CHECK (auth_user_id = auth.uid());
DROP POLICY IF EXISTS member_onboarding_select_own ON public.member_onboarding_requests;
CREATE POLICY member_onboarding_select_own ON public.member_onboarding_requests FOR SELECT TO authenticated USING (auth_user_id = auth.uid());

-- Atomic member onboarding review. Provisioning occurs only after admin decision
-- and a canonical Telegram identity can be resolved.
CREATE OR REPLACE FUNCTION public.review_member_onboarding_atomic(
  p_request_id bigint,p_decision varchar,p_actor_id bigint,p_actor_role varchar,p_rejection_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_req public.member_onboarding_requests%ROWTYPE; v_user public.users%ROWTYPE; v_tg public.telegram_users%ROWTYPE; v_decision varchar:=upper(trim(p_decision));
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'Unauthorized: onboarding review is backend-only'; END IF;
 IF p_actor_id IS NULL OR p_actor_role IS NULL THEN RAISE EXCEPTION 'Invalid approval actor'; END IF;
 IF v_decision NOT IN ('APPROVED','REJECTED') THEN RAISE EXCEPTION 'Invalid onboarding decision'; END IF;
 IF v_decision='REJECTED' AND NULLIF(trim(COALESCE(p_rejection_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
 SELECT * INTO v_req FROM public.member_onboarding_requests WHERE id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Onboarding request % not found',p_request_id; END IF;
 IF v_req.status<>'PENDING_REVIEW' THEN RAISE EXCEPTION 'Request % is already %',p_request_id,v_req.status; END IF;
 SELECT * INTO v_tg FROM public.telegram_users WHERE lower(COALESCE(email,''))=lower(v_req.email) OR (NULLIF(trim(COALESCE(v_req.telegram_username,'')),'') IS NOT NULL AND lower(COALESCE(telegram_username,''))=lower(trim(v_req.telegram_username))) ORDER BY updated_at DESC LIMIT 1;
 IF v_decision='REJECTED' THEN
   UPDATE public.member_onboarding_requests SET status='REJECTED',reviewed_by=p_actor_id,reviewed_at=NOW(),rejection_reason=trim(p_rejection_reason),updated_at=NOW() WHERE id=p_request_id;
   INSERT INTO public.audit_logs(actor_id,actor_role,action_type,resource_type,resource_id,old_value,new_value,reason) VALUES(p_actor_id,p_actor_role,'REJECT_MEMBER_ONBOARDING','member_onboarding_requests',p_request_id,jsonb_build_object('status','PENDING_REVIEW'),jsonb_build_object('status','REJECTED','reason',trim(p_rejection_reason)),trim(p_rejection_reason));
   IF v_tg.telegram_user_id IS NOT NULL THEN INSERT INTO public.telegram_notification_log(recipient_chat_id,message_text,context_type,context_id,status) VALUES(COALESCE(v_tg.telegram_chat_id,v_tg.telegram_user_id),format('Pengajuan member Anda ditolak. Alasan: %s',trim(p_rejection_reason)),'member_onboarding',p_request_id::text,'queued'); END IF;
   RETURN jsonb_build_object('success',true,'request_id',p_request_id,'status','REJECTED');
 END IF;
 IF v_tg.telegram_user_id IS NULL THEN RAISE EXCEPTION 'Telegram identity belum terhubung untuk applicant %',v_req.email; END IF;
 SELECT * INTO v_user FROM public.users WHERE auth_user_id=v_req.auth_user_id FOR UPDATE;
 IF NOT FOUND THEN SELECT * INTO v_user FROM public.users WHERE telegram_id=v_tg.telegram_user_id FOR UPDATE; END IF;
 IF v_user.id IS NULL THEN
   INSERT INTO public.users(telegram_id,username,full_name,email,role,status,onboarding_status,auth_user_id) VALUES(v_tg.telegram_user_id,v_tg.telegram_username,v_req.full_name,v_req.email,'member','active','COMPLETED',v_req.auth_user_id) RETURNING * INTO v_user;
 ELSE
   UPDATE public.users SET telegram_id=v_tg.telegram_user_id,username=COALESCE(v_tg.telegram_username,username),full_name=v_req.full_name,email=v_req.email,role='member',status='active',onboarding_status='COMPLETED',auth_user_id=v_req.auth_user_id,updated_at=NOW() WHERE id=v_user.id RETURNING * INTO v_user;
 END IF;
 UPDATE public.telegram_users SET linked_user_id=v_user.id,role='member',status='active',updated_at=NOW() WHERE id=v_tg.id;
 UPDATE public.member_onboarding_requests SET status='APPROVED',reviewed_by=p_actor_id,reviewed_at=NOW(),rejection_reason=NULL,updated_at=NOW() WHERE id=p_request_id;
 INSERT INTO public.audit_logs(actor_id,actor_role,action_type,resource_type,resource_id,old_value,new_value) VALUES(p_actor_id,p_actor_role,'APPROVE_MEMBER_ONBOARDING','member_onboarding_requests',p_request_id,jsonb_build_object('status','PENDING_REVIEW'),jsonb_build_object('status','APPROVED','user_id',v_user.id,'telegram_user_id',v_tg.telegram_user_id));
 INSERT INTO public.telegram_notification_log(recipient_chat_id,message_text,context_type,context_id,status) VALUES(COALESCE(v_tg.telegram_chat_id,v_tg.telegram_user_id),'Pengajuan member Anda disetujui. Akun sekarang aktif sebagai Member.','member_onboarding',p_request_id::text,'queued');
 RETURN jsonb_build_object('success',true,'request_id',p_request_id,'status','APPROVED','user_id',v_user.id,'telegram_user_id',v_tg.telegram_user_id);
END;$function$;
REVOKE EXECUTE ON FUNCTION public.review_member_onboarding_atomic(bigint,varchar,bigint,varchar,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_member_onboarding_atomic(bigint,varchar,bigint,varchar,text) TO service_role;
