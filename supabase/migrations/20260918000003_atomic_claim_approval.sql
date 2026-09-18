-- Atomic claim approval: claim state, payout transaction, double-entry ledger,
-- member balance and audit are committed together or not at all.
CREATE OR REPLACE FUNCTION public.approve_claim_atomic(
  p_claim_id uuid,
  p_actor_id bigint,
  p_actor_role varchar,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_claim public.claims%ROWTYPE;
  v_existing_tx public.payment_transactions%ROWTYPE;
  v_tx_id bigint;
  v_tx_code varchar(80);
  v_payout numeric(18,2);
  v_balance numeric(18,2);
  v_deposit_account bigint;
  v_bank_account bigint;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: claim approval is backend-only';
  END IF;
  IF p_actor_id IS NULL OR p_actor_role IS NULL THEN
    RAISE EXCEPTION 'Invalid approval actor';
  END IF;

  SELECT * INTO v_claim FROM public.claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Claim % not found', p_claim_id; END IF;

  IF v_claim.status = 'approved' THEN
    SELECT * INTO v_existing_tx FROM public.payment_transactions
    WHERE metadata->>'claim_id' = p_claim_id::text ORDER BY id DESC LIMIT 1;
    RETURN jsonb_build_object('success', true, 'already_approved', true,
      'claim_id', p_claim_id, 'transaction_id', v_existing_tx.id,
      'transaction_code', v_existing_tx.transaction_code, 'status', 'approved');
  END IF;
  IF v_claim.status NOT IN ('pending','reviewing') THEN
    RAISE EXCEPTION 'Claim % cannot be approved from status %', p_claim_id, v_claim.status;
  END IF;

  v_payout := COALESCE(v_claim.payout_amount, floor(COALESCE(v_claim.amount,0) * 0.75));
  IF v_payout <= 0 THEN RAISE EXCEPTION 'Claim payout amount must be greater than zero'; END IF;

  SELECT id INTO v_deposit_account FROM public.payment_accounts WHERE account_code = '2001-MEMBER-DEPOSIT';
  SELECT id INTO v_bank_account FROM public.payment_accounts WHERE account_code = '1002-BANK-SETTLEMENT';
  IF v_deposit_account IS NULL OR v_bank_account IS NULL THEN
    RAISE EXCEPTION 'Required payout ledger accounts are missing';
  END IF;

  v_tx_code := 'TXN-CLM-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || substr(replace(p_claim_id::text,'-',''),1,8);
  INSERT INTO public.payment_transactions (
    transaction_code, user_id, transaction_type, amount, fee_amount, net_amount,
    currency, provider_code, provider_reference, payment_method, status, metadata
  ) VALUES (
    v_tx_code, v_claim.user_id, 'payout', v_payout, 0, v_payout,
    'IDR', 'manual', NULL, 'bank_transfer', 'completed',
    jsonb_build_object('source','claim_approval','claim_id',p_claim_id,
      'bank',v_claim.bank,'account_number',v_claim.account_number)
  ) RETURNING id INTO v_tx_id;

  PERFORM public.record_double_entry_ledger(
    v_tx_id, v_deposit_account, v_bank_account, v_payout,
    COALESCE(p_notes, 'Claim payout approved'), p_actor_id
  );

  SELECT coin_balance INTO v_balance FROM public.user_coin_balances
  WHERE user_id = v_claim.user_id FOR UPDATE;
  IF v_balance IS NOT NULL THEN
    IF v_balance < v_payout THEN
      RAISE EXCEPTION 'Insufficient member balance for payout: balance %, payout %', v_balance, v_payout;
    END IF;
    UPDATE public.user_coin_balances
    SET coin_balance = coin_balance - v_payout, last_activity_at = NOW()
    WHERE user_id = v_claim.user_id;
  END IF;

  UPDATE public.claims SET status='approved', reviewed_by=p_actor_id,
    reviewed_at=NOW(), updated_at=NOW(), notes=COALESCE(p_notes,notes)
  WHERE id=p_claim_id;

  INSERT INTO public.audit_logs (
    actor_id, actor_role, action_type, resource_type, resource_id, old_value, new_value, reason
  ) VALUES (
    p_actor_id, p_actor_role, 'APPROVE_CLAIM', 'claims', v_tx_id,
    jsonb_build_object('claim_id',p_claim_id,'status',v_claim.status),
    jsonb_build_object('claim_id',p_claim_id,'status','approved','payout_amount',v_payout,'transaction_id',v_tx_id), p_notes
  );

  INSERT INTO public.telegram_notification_log (
    recipient_chat_id, message_text, context_type, context_id, status
  ) VALUES (
    COALESCE(v_claim.telegram_user_id,0),
    format('Klaim %s disetujui. Payout Rp %s diproses ke %s %s.',
      COALESCE(v_claim.claim_number,p_claim_id::text), to_char(v_payout,'FM999,999,999,990'),
      COALESCE(v_claim.bank,'-'), COALESCE(v_claim.account_number,'-')),
    'claim', p_claim_id::text, 'queued'
  );

  RETURN jsonb_build_object('success',true,'claim_id',p_claim_id,
    'transaction_id',v_tx_id,'transaction_code',v_tx_code,'payout_amount',v_payout,'status','approved');
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.approve_claim_atomic(uuid,bigint,varchar,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_claim_atomic(uuid,bigint,varchar,text) TO service_role;

INSERT INTO public.backoffice_capabilities (code, description, category)
VALUES ('claim.manage', 'Review and approve member claims with payout posting', 'claim')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.backoffice_role_capabilities (role, capability_code)
VALUES ('admin','claim.manage'), ('super_admin','claim.manage'), ('root','claim.manage')
ON CONFLICT (role, capability_code) DO NOTHING;
