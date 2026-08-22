-- Pokrenuti jednom na postojećem Supabase projektu pre deploy-a nove verzije.
begin;

alter table public.households add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table public.households alter column invite_code set default encode(gen_random_bytes(16), 'hex');
alter table public.households enable row level security;

drop policy if exists "recipes_update_own" on public.recipes;
create policy "recipes_update_own" on public.recipes for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "households_member_select" on public.households;
create policy "households_member_select" on public.households for select using (
  id in (select household_id from public.profiles where id = auth.uid())
);

create or replace function public.create_household_for_user(p_user_id uuid, p_name text)
returns setof public.households
language plpgsql security definer set search_path = public
as $$
declare h public.households;
begin
  if exists (select 1 from public.profiles where id = p_user_id and household_id is not null) then
    raise exception 'USER_ALREADY_IN_HOUSEHOLD';
  end if;
  insert into public.households (name, owner_id)
    values (left(coalesce(nullif(trim(p_name), ''), 'Moje domaćinstvo'), 100), p_user_id)
    returning * into h;
  update public.profiles set household_id = h.id where id = p_user_id;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  return next h;
end;
$$;

create or replace function public.join_household_for_user(p_user_id uuid, p_invite_code text)
returns setof public.households
language plpgsql security definer set search_path = public
as $$
declare h public.households;
begin
  if exists (select 1 from public.profiles where id = p_user_id and household_id is not null) then
    raise exception 'USER_ALREADY_IN_HOUSEHOLD';
  end if;
  select * into h from public.households where invite_code = lower(trim(p_invite_code));
  if h.id is null then raise exception 'INVITE_NOT_FOUND'; end if;
  update public.profiles set household_id = h.id where id = p_user_id;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  return next h;
end;
$$;

revoke all on function public.create_household_for_user(uuid, text) from public, anon, authenticated;
revoke all on function public.join_household_for_user(uuid, text) from public, anon, authenticated;
grant execute on function public.create_household_for_user(uuid, text) to service_role;
grant execute on function public.join_household_for_user(uuid, text) to service_role;

commit;
