-- v1.3.1: atomska kontrola dnevnog AI budžeta.
begin;

create table if not exists public.ai_usage_daily (
  usage_date date not null default current_date,
  scope text not null check (char_length(scope) between 1 and 80),
  credits_used integer not null default 0 check (credits_used >= 0),
  requests integer not null default 0 check (requests >= 0),
  updated_at timestamptz not null default now(),
  primary key (usage_date, scope)
);

create index if not exists ai_usage_daily_updated_idx on public.ai_usage_daily(updated_at);
alter table public.ai_usage_daily enable row level security;
revoke all on table public.ai_usage_daily from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_usage_daily to service_role;

create or replace function public.claim_ai_budget(
  p_user_id uuid,
  p_cost integer,
  p_user_limit integer,
  p_global_limit integer
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  user_scope text := 'user:' || p_user_id::text;
  global_used integer;
  user_used integer;
begin
  if p_user_id is null or p_cost not between 1 and 20 or p_user_limit < 1 or p_global_limit < 1 then
    raise exception 'INVALID_AI_BUDGET_ARGUMENTS';
  end if;

  insert into public.ai_usage_daily(usage_date, scope) values(current_date, 'global') on conflict do nothing;
  insert into public.ai_usage_daily(usage_date, scope) values(current_date, user_scope) on conflict do nothing;

  select credits_used into global_used
    from public.ai_usage_daily where usage_date=current_date and scope='global' for update;
  select credits_used into user_used
    from public.ai_usage_daily where usage_date=current_date and scope=user_scope for update;

  if global_used + p_cost > p_global_limit then raise exception 'AI_DAILY_GLOBAL_LIMIT'; end if;
  if user_used + p_cost > p_user_limit then raise exception 'AI_DAILY_USER_LIMIT'; end if;

  update public.ai_usage_daily
    set credits_used=credits_used+p_cost, requests=requests+1, updated_at=now()
    where usage_date=current_date and scope='global';
  update public.ai_usage_daily
    set credits_used=credits_used+p_cost, requests=requests+1, updated_at=now()
    where usage_date=current_date and scope=user_scope;

  return jsonb_build_object(
    'userCredits', user_used+p_cost,
    'userLimit', p_user_limit,
    'globalCredits', global_used+p_cost,
    'globalLimit', p_global_limit
  );
end;
$$;

revoke all on function public.claim_ai_budget(uuid, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_ai_budget(uuid, integer, integer, integer) to service_role;

commit;
