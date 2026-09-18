-- 20260918000009: cryptographic operator identity binding
-- Binds an existing Auth/admin account to a real Telegram identity only after
-- either Telegram Mini App initData + an authenticated Web session, or a
-- one-time deep-link challenge has proven possession of both identities.

create table if not exists public.telegram_identity_bind_challenges (
  id uuid primary key,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_telegram_identity_bind_challenges_auth
  on public.telegram_identity_bind_challenges(auth_user_id);

create index if not exists idx_telegram_identity_bind_challenges_expiry
  on public.telegram_identity_bind_challenges(expires_at);

alter table public.telegram_identity_bind_challenges enable row level security;

revoke all on public.telegram_identity_bind_challenges from public, anon, authenticated;
grant all on public.telegram_identity_bind_challenges to service_role;

create or replace function public.bind_admin_operator_identity_atomic(
  p_auth_user_id uuid,
  p_telegram_user_id bigint,
  p_method text,
  p_challenge_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_admin public.admin_accounts%rowtype;
  v_dashboard public.dashboard_access%rowtype;
  v_user public.users%rowtype;
  v_existing_by_tg public.users%rowtype;
  v_challenge public.telegram_identity_bind_challenges%rowtype;
  v_username text;
  v_full_name text;
  v_now timestamptz := now();
begin
  if p_auth_user_id is null then
    raise exception 'auth_user_id_required';
  end if;

  if p_telegram_user_id is null or p_telegram_user_id <= 0 then
    raise exception 'telegram_user_id_invalid';
  end if;

  if p_method not in ('init_data', 'deep_link') then
    raise exception 'binding_method_invalid';
  end if;

  if p_method = 'deep_link' and nullif(trim(coalesce(p_challenge_token, '')), '') is null then
    raise exception 'challenge_token_required';
  end if;

  if p_method = 'init_data' and nullif(trim(coalesce(p_challenge_token, '')), '') is not null then
    raise exception 'challenge_token_not_allowed';
  end if;

  select *
    into v_admin
    from public.admin_accounts
   where auth_user_id = p_auth_user_id
     and is_active = true
   for update;

  if not found then
    raise exception 'active_admin_account_not_found';
  end if;

  if v_admin.role not in ('root', 'super_admin', 'admin', 'dev') then
    raise exception 'admin_role_not_bindable';
  end if;

  select *
    into v_dashboard
    from public.dashboard_access
   where auth_user_id = p_auth_user_id
     and is_active = true
   for update;

  if not found then
    raise exception 'dashboard_access_not_provisioned';
  end if;

  if v_dashboard.role <> v_admin.role then
    raise exception 'dashboard_role_mismatch';
  end if;

  if p_method = 'deep_link' then
    select *
      into v_challenge
      from public.telegram_identity_bind_challenges
     where auth_user_id = p_auth_user_id
       and token_hash = encode(extensions.digest(p_challenge_token, 'sha256'), 'hex')
       and consumed_at is null
       and expires_at > v_now
     for update;

    if not found then
      raise exception 'bind_challenge_invalid_or_expired';
    end if;
  end if;

  select *
    into v_existing_by_tg
    from public.users
   where telegram_id = p_telegram_user_id
   for update;

  if found and v_existing_by_tg.auth_user_id is not null
     and v_existing_by_tg.auth_user_id <> p_auth_user_id then
    raise exception 'telegram_identity_already_bound';
  end if;

  select *
    into v_user
    from public.users
   where auth_user_id = p_auth_user_id
   for update;

  if found then
    if v_user.telegram_id <> p_telegram_user_id then
      raise exception 'auth_identity_already_bound_to_different_telegram';
    end if;
  else
    if found and v_existing_by_tg.id is not null then
      v_user := v_existing_by_tg;
    else
      select *
        into v_user
        from public.users
       where lower(coalesce(email, '')) = lower(v_admin.email)
         and auth_user_id is null
       order by created_at asc
       limit 1
       for update;
    end if;

    if v_user.id is null then
      insert into public.users (
        telegram_id,
        username,
        full_name,
        email,
        role,
        status,
        onboarding_status,
        risk_status,
        created_at,
        updated_at,
        auth_user_id
      )
      values (
        p_telegram_user_id,
        null,
        v_admin.full_name,
        v_admin.email,
        v_admin.role,
        'active',
        'COMPLETED',
        'LOW',
        v_now,
        v_now,
        p_auth_user_id
      )
      returning * into v_user;
    else
      update public.users
         set telegram_id = p_telegram_user_id,
             full_name = coalesce(full_name, v_admin.full_name),
             email = coalesce(email, v_admin.email),
             role = v_admin.role,
             status = 'active',
             onboarding_status = 'COMPLETED',
             auth_user_id = p_auth_user_id,
             updated_at = v_now
       where id = v_user.id
      returning * into v_user;
    end if;
  end if;

  if v_user.role <> v_admin.role then
    update public.users
       set role = v_admin.role,
           status = 'active',
           onboarding_status = 'COMPLETED',
           updated_at = v_now
     where id = v_user.id
    returning * into v_user;
  end if;

  update public.dashboard_access
     set user_id = v_user.id,
         role = v_admin.role,
         enabled = true,
         is_active = true,
         updated_at = v_now
   where id = v_dashboard.id;

  update public.admin_accounts
     set telegram_id = p_telegram_user_id,
         updated_at = v_now
   where id = v_admin.id;

  select username, full_name
    into v_username, v_full_name
    from public.users
   where id = v_user.id;

  insert into public.telegram_users (
    telegram_user_id,
    telegram_username,
    display_name,
    email,
    role,
    status,
    linked_user_id,
    updated_at
  )
  values (
    p_telegram_user_id,
    v_username,
    coalesce(v_full_name, v_admin.full_name),
    v_admin.email,
    v_admin.role,
    'active',
    v_user.id,
    v_now
  )
  on conflict (telegram_user_id) do update
    set telegram_username = coalesce(excluded.telegram_username, public.telegram_users.telegram_username),
        display_name = coalesce(excluded.display_name, public.telegram_users.display_name),
        email = excluded.email,
        role = excluded.role,
        status = 'active',
        linked_user_id = excluded.linked_user_id,
        updated_at = v_now;

  if p_method = 'deep_link' then
    update public.telegram_identity_bind_challenges
       set consumed_at = v_now
     where id = v_challenge.id;
  end if;

  insert into public.audit_logs (
    actor_id,
    actor_role,
    action_type,
    resource_type,
    resource_id,
    old_value,
    new_value,
    reason,
    created_at
  )
  values (
    v_user.id,
    v_admin.role,
    'BIND_OPERATOR_IDENTITY',
    'users',
    v_user.id::text,
    jsonb_build_object(
      'telegram_id', case when v_existing_by_tg.id is null then null else v_existing_by_tg.telegram_id end,
      'auth_user_id', p_auth_user_id
    ),
    jsonb_build_object(
      'telegram_id', p_telegram_user_id,
      'auth_user_id', p_auth_user_id,
      'binding_method', p_method
    ),
    'Operator Telegram identity bound after verified proof-of-possession',
    v_now
  );

  return jsonb_build_object(
    'bound', true,
    'user_id', v_user.id,
    'auth_user_id', p_auth_user_id,
    'telegram_user_id', p_telegram_user_id,
    'role', v_admin.role,
    'method', p_method
  );
end;
$$;

revoke all on function public.bind_admin_operator_identity_atomic(uuid,bigint,text,text) from public, anon, authenticated;
grant execute on function public.bind_admin_operator_identity_atomic(uuid,bigint,text,text) to service_role;
