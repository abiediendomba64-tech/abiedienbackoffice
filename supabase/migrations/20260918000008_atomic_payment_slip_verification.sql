-- Atomic payment-slip verification/rejection.
-- The operator identity is resolved from the authenticated Supabase user,
-- then mapped to public.dashboard_access/public.users. The RPC never trusts
-- a client-supplied role or an admin_accounts UUID as payments.verified_by.
-- payments.verified_by references public.users(id), so an operator without a
-- canonical public.users row is rejected rather than writing a mismatched ID.

CREATE OR REPLACE FUNCTION public.verify_payment_slip_atomic(
  p_payment_id bigint,
  p_actor_auth_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_actor_user_id bigint;
  v_actor_role varchar;
  v_old_status varchar;
  v_verified_at timestamptz;
  v_admin_chat_id bigint;
  v_msg text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'UNAUTHORIZED_CALLER: payment verification is backend-only';
  END IF;
  IF p_actor_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED_ACTOR: authenticated actor is required';
  END IF;

  -- Resolve role from the canonical backoffice access record.
  SELECT da.role, da.user_id
    INTO v_actor_role, v_actor_user_id
  FROM public.dashboard_access da
  WHERE da.auth_user_id = p_actor_auth_user_id
    AND da.is_active = true
  ORDER BY da.id
  LIMIT 1;

  -- A dashboard_access row may have a NULL user_id in the current schema.
  -- Resolve the canonical users identity independently by auth_user_id.
  IF v_actor_user_id IS NULL THEN
    SELECT u.id, u.role
      INTO v_actor_user_id, v_actor_role
    FROM public.users u
    WHERE u.auth_user_id = p_actor_auth_user_id
      AND u.status = 'active'
      AND u.role IN ('root','super_admin','admin','dev')
    LIMIT 1;
  END IF;

  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED_ACTOR: operator has no canonical public.users identity';
  END IF;

  IF v_actor_role IS NULL THEN
    SELECT u.role INTO v_actor_role
    FROM public.users u
    WHERE u.id = v_actor_user_id
      AND u.status = 'active';
  END IF;

  IF v_actor_role NOT IN ('root','super_admin','admin','dev') THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: operator role % cannot verify payments', COALESCE(v_actor_role,'NULL');
  END IF;

  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: payment % does not exist', p_payment_id;
  END IF;

  IF v_payment.status = 'verified' THEN
    RETURN jsonb_build_object(
      'success', true,
      'payment_id', p_payment_id,
      'payment_number', v_payment.payment_number,
      'status', 'verified',
      'idempotent', true
    );
  END IF;

  IF v_payment.status <> 'pending' THEN
    RAISE EXCEPTION 'INVALID_STATE: payment status % cannot be verified', v_payment.status;
  END IF;

  v_old_status := v_payment.status;
  v_verified_at := clock_timestamp();

  UPDATE public.payments
  SET status = 'verified',
      verified_by = v_actor_user_id,
      verified_at = v_verified_at,
      updated_at = v_verified_at
  WHERE id = p_payment_id;

  INSERT INTO public.audit_logs (
    actor_id, actor_role, action_type, resource_type, resource_id,
    old_value, new_value, reason, created_at
  ) VALUES (
    v_actor_user_id, v_actor_role, 'VERIFY_PAYMENT', 'payments', p_payment_id::text,
    jsonb_build_object('status', v_old_status),
    jsonb_build_object(
      'status', 'verified',
      'verified_by', v_actor_user_id,
      'verified_at', v_verified_at
    ),
    'Payment slip verified via backoffice',
    v_verified_at
  );

  SELECT ac.chat_id
    INTO v_admin_chat_id
  FROM public.admin_chat_ids ac
  WHERE ac.is_active = true
  ORDER BY ac.chat_id
  LIMIT 1;

  IF v_admin_chat_id IS NOT NULL THEN
    v_msg := format(
      '[PAYMENT VERIFIED] Pembayaran #%s senilai %s %s diverifikasi oleh operator #%s (%s).',
      COALESCE(v_payment.payment_number, p_payment_id::text),
      COALESCE(v_payment.currency, 'IDR'),
      to_char(COALESCE(v_payment.amount, 0), 'FM999,999,999,999'),
      v_actor_user_id,
      v_actor_role
    );

    INSERT INTO public.telegram_notification_log (
      recipient_chat_id, message_text, context_type, context_id,
      status, attempt_count, created_at
    ) VALUES (
      v_admin_chat_id, v_msg, 'payments', p_payment_id::text,
      'queued', 0, v_verified_at
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'payment_number', v_payment.payment_number,
    'status', 'verified'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reject_payment_slip_atomic(
  p_payment_id bigint,
  p_actor_auth_user_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_actor_user_id bigint;
  v_actor_role varchar;
  v_old_status varchar;
  v_clean_reason text;
  v_rejected_at timestamptz;
  v_admin_chat_id bigint;
  v_msg text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'UNAUTHORIZED_CALLER: payment rejection is backend-only';
  END IF;

  v_clean_reason := trim(COALESCE(p_reason, ''));
  IF v_clean_reason = '' THEN
    RAISE EXCEPTION 'VALIDATION_ERROR: rejection reason is required';
  END IF;
  IF p_actor_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED_ACTOR: authenticated actor is required';
  END IF;

  SELECT da.role, da.user_id
    INTO v_actor_role, v_actor_user_id
  FROM public.dashboard_access da
  WHERE da.auth_user_id = p_actor_auth_user_id
    AND da.is_active = true
  ORDER BY da.id
  LIMIT 1;

  IF v_actor_user_id IS NULL THEN
    SELECT u.id, u.role
      INTO v_actor_user_id, v_actor_role
    FROM public.users u
    WHERE u.auth_user_id = p_actor_auth_user_id
      AND u.status = 'active'
      AND u.role IN ('root','super_admin','admin','dev')
    LIMIT 1;
  END IF;

  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED_ACTOR: operator has no canonical public.users identity';
  END IF;

  IF v_actor_role IS NULL THEN
    SELECT u.role INTO v_actor_role
    FROM public.users u
    WHERE u.id = v_actor_user_id
      AND u.status = 'active';
  END IF;

  IF v_actor_role NOT IN ('root','super_admin','admin','dev') THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE: operator role % cannot reject payments', COALESCE(v_actor_role,'NULL');
  END IF;

  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: payment % does not exist', p_payment_id;
  END IF;

  IF v_payment.status = 'rejected' THEN
    RETURN jsonb_build_object(
      'success', true,
      'payment_id', p_payment_id,
      'payment_number', v_payment.payment_number,
      'status', 'rejected',
      'idempotent', true
    );
  END IF;

  IF v_payment.status <> 'pending' THEN
    RAISE EXCEPTION 'INVALID_STATE: payment status % cannot be rejected', v_payment.status;
  END IF;

  v_old_status := v_payment.status;
  v_rejected_at := clock_timestamp();

  UPDATE public.payments
  SET status = 'rejected',
      verification_notes = v_clean_reason,
      verified_by = v_actor_user_id,
      verified_at = v_rejected_at,
      updated_at = v_rejected_at
  WHERE id = p_payment_id;

  INSERT INTO public.audit_logs (
    actor_id, actor_role, action_type, resource_type, resource_id,
    old_value, new_value, reason, created_at
  ) VALUES (
    v_actor_user_id, v_actor_role, 'REJECT_PAYMENT', 'payments', p_payment_id::text,
    jsonb_build_object('status', v_old_status),
    jsonb_build_object(
      'status', 'rejected',
      'rejection_reason', v_clean_reason,
      'verified_by', v_actor_user_id,
      'verified_at', v_rejected_at
    ),
    v_clean_reason,
    v_rejected_at
  );

  SELECT ac.chat_id
    INTO v_admin_chat_id
  FROM public.admin_chat_ids ac
  WHERE ac.is_active = true
  ORDER BY ac.chat_id
  LIMIT 1;

  IF v_admin_chat_id IS NOT NULL THEN
    v_msg := format(
      '[PAYMENT REJECTED] Pembayaran #%s senilai %s %s ditolak oleh operator #%s (%s). Alasan: %s',
      COALESCE(v_payment.payment_number, p_payment_id::text),
      COALESCE(v_payment.currency, 'IDR'),
      to_char(COALESCE(v_payment.amount, 0), 'FM999,999,999,999'),
      v_actor_user_id,
      v_actor_role,
      v_clean_reason
    );

    INSERT INTO public.telegram_notification_log (
      recipient_chat_id, message_text, context_type, context_id,
      status, attempt_count, created_at
    ) VALUES (
      v_admin_chat_id, v_msg, 'payments', p_payment_id::text,
      'queued', 0, v_rejected_at
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'payment_number', v_payment.payment_number,
    'status', 'rejected'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.verify_payment_slip_atomic(bigint, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_payment_slip_atomic(bigint, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.reject_payment_slip_atomic(bigint, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_payment_slip_atomic(bigint, uuid, text)
  TO service_role;
