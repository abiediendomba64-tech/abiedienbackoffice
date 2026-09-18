-- Financial integrity hardening for claim payout:
-- approval creates the payable liability; settlement is the only step that
-- reduces the bank asset. A database approval must never be reported as a
-- successful bank transfer.
--
-- Existing canonical accounts:
--   5001-EXPENSE-GATEWAY  = expense
--   2002-PENDING-PAYOUT   = payout liability
--   1002-BANK-SETTLEMENT  = bank asset
--
-- This migration deliberately does not change member coin balances.

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
  v_expense_account bigint;
  v_pending_payout_account bigint;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: claim approval is backend-only';
  END IF;
  IF p_actor_id IS NULL OR p_actor_role IS NULL THEN
    RAISE EXCEPTION 'Invalid approval actor';
  END IF;

  SELECT * INTO v_claim
  FROM public.claims
  WHERE id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim % not found', p_claim_id;
  END IF;

  IF v_claim.user_id = p_actor_id THEN
    RAISE EXCEPTION 'Self-disbursement is prohibited for claim %', p_claim_id;
  END IF;

  IF v_claim.status = 'approved' THEN
    SELECT * INTO v_existing_tx
    FROM public.payment_transactions
    WHERE metadata->>'claim_id' = p_claim_id::text
    ORDER BY id DESC
    LIMIT 1;

    IF v_existing_tx.id IS NULL THEN
      RAISE EXCEPTION 'Claim % is approved but has no linked payout transaction; refusing silent repair', p_claim_id;
    END IF;

    RETURN jsonb_build_object(
      'success', true,
      'already_approved', true,
      'claim_id', p_claim_id,
      'transaction_id', v_existing_tx.id,
      'transaction_code', v_existing_tx.transaction_code,
      'status', 'approved',
      'settlement_status', COALESCE(v_existing_tx.metadata->>'settlement_status','awaiting_disbursement')
    );
  END IF;

  IF v_claim.status NOT IN ('pending','reviewing') THEN
    RAISE EXCEPTION 'Claim % cannot be approved from status %', p_claim_id, v_claim.status;
  END IF;

  v_payout := COALESCE(v_claim.payout_amount, floor(COALESCE(v_claim.amount,0) * 0.75));
  IF v_payout <= 0 THEN
    RAISE EXCEPTION 'Claim payout amount must be greater than zero';
  END IF;

  SELECT id INTO v_expense_account
  FROM public.payment_accounts
  WHERE account_code = '5001-EXPENSE-GATEWAY' AND is_active
  FOR UPDATE;

  SELECT id INTO v_pending_payout_account
  FROM public.payment_accounts
  WHERE account_code = '2002-PENDING-PAYOUT' AND is_active
  FOR UPDATE;

  IF v_expense_account IS NULL OR v_pending_payout_account IS NULL THEN
    RAISE EXCEPTION 'Required expense/pending-payout ledger accounts are missing';
  END IF;

  v_tx_code := 'TXN-CLM-' ||
    to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' ||
    substr(replace(p_claim_id::text,'-',''),1,8);

  INSERT INTO public.payment_transactions (
    transaction_code, user_id, transaction_type, amount, fee_amount, net_amount,
    currency, provider_code, provider_reference, payment_method, status, metadata
  ) VALUES (
    v_tx_code, v_claim.user_id, 'payout', v_payout, 0, v_payout,
    'IDR', 'manual', NULL, 'bank_transfer', 'pending',
    jsonb_build_object(
      'source','claim_approval',
      'claim_id',p_claim_id,
      'bank',v_claim.bank,
      'account_number',v_claim.account_number,
      'settlement_status','awaiting_disbursement'
    )
  )
  RETURNING id INTO v_tx_id;

  PERFORM public.record_double_entry_ledger(
    v_tx_id,
    v_expense_account,
    v_pending_payout_account,
    v_payout,
    COALESCE(p_notes, 'Claim approved; payable awaiting disbursement'),
    p_actor_id
  );

  UPDATE public.claims
  SET status='approved',
      reviewed_by=p_actor_id,
      reviewed_at=NOW(),
      updated_at=NOW(),
      notes=COALESCE(p_notes,notes)
  WHERE id=p_claim_id;

  INSERT INTO public.audit_logs (
    actor_id, actor_role, action_type, resource_type, resource_id,
    old_value, new_value, reason
  ) VALUES (
    p_actor_id, p_actor_role, 'APPROVE_CLAIM', 'claims', NULL,
    jsonb_build_object('claim_id',p_claim_id,'status',v_claim.status),
    jsonb_build_object(
      'claim_id',p_claim_id,
      'status','approved',
      'payout_amount',v_payout,
      'transaction_id',v_tx_id,
      'settlement_status','awaiting_disbursement'
    ),
    p_notes
  );

  INSERT INTO public.telegram_notification_log (
    recipient_chat_id, message_text, context_type, context_id, status
  ) VALUES (
    COALESCE(v_claim.telegram_user_id,0),
    format(
      'Klaim %s disetujui. Nilai payout Rp %s menunggu proses transfer bank.',
      COALESCE(v_claim.claim_number,p_claim_id::text),
      to_char(v_payout,'FM999,999,999,990')
    ),
    'claim',
    p_claim_id::text,
    'queued'
  );

  RETURN jsonb_build_object(
    'success',true,
    'claim_id',p_claim_id,
    'transaction_id',v_tx_id,
    'transaction_code',v_tx_code,
    'payout_amount',v_payout,
    'status','approved',
    'settlement_status','awaiting_disbursement'
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.approve_claim_atomic(uuid,bigint,varchar,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_claim_atomic(uuid,bigint,varchar,text)
  TO service_role;


-- Settlement is a separate, explicitly authorized operation. It requires the
-- external transfer/provider reference and only then moves the liability to bank.
CREATE OR REPLACE FUNCTION public.settle_claim_payout_atomic(
  p_claim_id uuid,
  p_actor_id bigint,
  p_actor_role varchar,
  p_provider_reference varchar,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_claim public.claims%ROWTYPE;
  v_tx public.payment_transactions%ROWTYPE;
  v_pending_payout_account bigint;
  v_bank_account bigint;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: payout settlement is backend-only';
  END IF;
  IF p_actor_id IS NULL OR p_actor_role IS NULL THEN
    RAISE EXCEPTION 'Invalid settlement actor';
  END IF;
  IF NULLIF(trim(COALESCE(p_provider_reference,'')),'') IS NULL THEN
    RAISE EXCEPTION 'Bank/provider transfer reference is required';
  END IF;

  SELECT * INTO v_claim
  FROM public.claims
  WHERE id=p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim % not found',p_claim_id;
  END IF;
  IF v_claim.user_id = p_actor_id THEN
    RAISE EXCEPTION 'Self-disbursement is prohibited for claim %', p_claim_id;
  END IF;

  SELECT * INTO v_tx
  FROM public.payment_transactions
  WHERE metadata->>'claim_id'=p_claim_id::text
  ORDER BY id DESC
  LIMIT 1
  FOR UPDATE;

  IF v_tx.id IS NULL THEN
    RAISE EXCEPTION 'No payout transaction found for claim %',p_claim_id;
  END IF;

  -- Idempotent retry: a previously settled claim returns success instead of
  -- being rejected by the phase guard.
  IF v_claim.status='settled'
     AND (COALESCE(v_tx.metadata->>'settlement_status','')='settled' OR v_tx.status='completed') THEN
    RETURN jsonb_build_object(
      'success',true,'already_settled',true,'claim_id',p_claim_id,
      'transaction_id',v_tx.id,'transaction_code',v_tx.transaction_code,'status','completed'
    );
  END IF;

  IF v_claim.status <> 'approved' THEN
    RAISE EXCEPTION 'Claim % must be approved before settlement; current status %',p_claim_id,v_claim.status;
  END IF;

  IF COALESCE(v_tx.metadata->>'settlement_status','awaiting_disbursement')='settled'
     OR v_tx.status='completed' THEN
    RETURN jsonb_build_object(
      'success',true,
      'already_settled',true,
      'claim_id',p_claim_id,
      'transaction_id',v_tx.id,
      'transaction_code',v_tx.transaction_code,
      'status','completed'
    );
  END IF;

  IF v_tx.status NOT IN ('pending','processing') THEN
    RAISE EXCEPTION 'Payout transaction % cannot be settled from status %',v_tx.id,v_tx.status;
  END IF;

  SELECT id INTO v_pending_payout_account
  FROM public.payment_accounts
  WHERE account_code='2002-PENDING-PAYOUT' AND is_active
  FOR UPDATE;

  SELECT id INTO v_bank_account
  FROM public.payment_accounts
  WHERE account_code='1002-BANK-SETTLEMENT' AND is_active
  FOR UPDATE;

  IF v_pending_payout_account IS NULL OR v_bank_account IS NULL THEN
    RAISE EXCEPTION 'Required pending-payout/bank ledger accounts are missing';
  END IF;

  PERFORM public.record_double_entry_ledger(
    v_tx.id,
    v_pending_payout_account,
    v_bank_account,
    v_tx.amount,
    COALESCE(p_notes,'Payout bank transfer settled'),
    p_actor_id
  );

  UPDATE public.claims
  SET status='settled', updated_at=NOW()
  WHERE id=p_claim_id;

  UPDATE public.payment_transactions
  SET status='completed',
      provider_reference=trim(p_provider_reference),
      completed_at=NOW(),
      updated_at=NOW(),
      metadata=metadata || jsonb_build_object(
        'settlement_status','settled',
        'settled_at',NOW(),
        'settled_by',p_actor_id
      )
  WHERE id=v_tx.id;

  INSERT INTO public.audit_logs (
    actor_id,actor_role,action_type,resource_type,resource_id,
    old_value,new_value,reason
  ) VALUES (
    p_actor_id,p_actor_role,'SETTLE_CLAIM_PAYOUT','claims',p_claim_id::text,
    jsonb_build_object(
      'claim_id',p_claim_id,
      'transaction_id',v_tx.id,
      'status',v_tx.status,
      'settlement_status',COALESCE(v_tx.metadata->>'settlement_status','awaiting_disbursement')
    ),
    jsonb_build_object(
      'claim_id',p_claim_id,
      'transaction_id',v_tx.id,
      'status','completed',
      'settlement_status','settled',
      'provider_reference',trim(p_provider_reference)
    ),
    p_notes
  );

  INSERT INTO public.telegram_notification_log (
    recipient_chat_id,message_text,context_type,context_id,status
  ) VALUES (
    COALESCE(v_claim.telegram_user_id,0),
    format(
      'Payout klaim %s telah ditandai selesai. Referensi transfer: %s.',
      COALESCE(v_claim.claim_number,p_claim_id::text),
      trim(p_provider_reference)
    ),
    'claim',
    p_claim_id::text,
    'queued'
  );

  RETURN jsonb_build_object(
    'success',true,
    'claim_id',p_claim_id,
    'transaction_id',v_tx.id,
    'transaction_code',v_tx.transaction_code,
    'status','completed',
    'settlement_status','settled',
    'provider_reference',trim(p_provider_reference)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.settle_claim_payout_atomic(uuid,bigint,varchar,varchar,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_claim_payout_atomic(uuid,bigint,varchar,varchar,text)
  TO service_role;


-- Ledger is append-only. Corrections must be represented by reversal entries,
-- never UPDATE/DELETE existing journal lines.
CREATE OR REPLACE FUNCTION public.prevent_payment_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'payment_ledger_entries is append-only; create a reversal entry instead of %',
    TG_OP;
END;
$function$;

DROP TRIGGER IF EXISTS trg_payment_ledger_entries_immutable
  ON public.payment_ledger_entries;
CREATE TRIGGER trg_payment_ledger_entries_immutable
BEFORE UPDATE OR DELETE ON public.payment_ledger_entries
FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_ledger_mutation();

REVOKE EXECUTE ON FUNCTION public.prevent_payment_ledger_mutation()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_payment_ledger_mutation()
  TO service_role;
