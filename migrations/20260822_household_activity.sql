-- v1.6.0: audit istorija domaćinstva i server-side ograničenja uloga
create table if not exists public.household_activity (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check(action in('recipe_added','recipe_updated','recipe_removed','pantry_added','pantry_updated','pantry_removed','pantry_consumed','shopping_updated','meal_planned','meal_removed','member_role_changed','member_removed','ownership_transferred')),
  entity_type text not null check(char_length(entity_type) between 1 and 40),
  entity_id uuid,
  summary text not null check(char_length(summary) between 1 and 240),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists household_activity_scope_idx on public.household_activity(household_id,created_at desc);
alter table public.household_activity enable row level security;
drop policy if exists household_activity_member_read on public.household_activity;
create policy household_activity_member_read on public.household_activity for select using(household_id in(select household_id from public.profiles where id=auth.uid()));
revoke all on public.household_activity from public,anon,authenticated;
grant select,insert on public.household_activity to service_role;
