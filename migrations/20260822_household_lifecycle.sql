-- v1.5.0: uloge i bezbedan životni ciklus domaćinstva
alter table public.profiles add column if not exists display_name text check(display_name is null or char_length(display_name) between 1 and 80);
alter table public.profiles add column if not exists household_role text not null default 'adult' check(household_role in ('owner','adult','child'));
update public.profiles p set household_role='owner' from public.households h where h.owner_id=p.id and p.household_id=h.id;

create or replace function public.set_household_member_role(p_owner_id uuid,p_member_id uuid,p_role text)
returns void language plpgsql security definer set search_path=public as $$
declare h uuid;
begin
  if p_role not in ('adult','child') then raise exception 'INVALID_HOUSEHOLD_ROLE'; end if;
  select id into h from households where owner_id=p_owner_id;
  if h is null then raise exception 'OWNER_REQUIRED'; end if;
  if p_member_id=p_owner_id then raise exception 'OWNER_ROLE_IMMUTABLE'; end if;
  update profiles set household_role=p_role where id=p_member_id and household_id=h;
  if not found then raise exception 'MEMBER_NOT_FOUND'; end if;
end; $$;

create or replace function public.remove_household_member(p_owner_id uuid,p_member_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare h uuid;
begin
  select id into h from households where owner_id=p_owner_id;
  if h is null then raise exception 'OWNER_REQUIRED'; end if;
  if p_member_id=p_owner_id then raise exception 'OWNER_CANNOT_REMOVE_SELF'; end if;
  update profiles set household_id=null,household_role='adult' where id=p_member_id and household_id=h;
  if not found then raise exception 'MEMBER_NOT_FOUND'; end if;
end; $$;

create or replace function public.transfer_household_ownership(p_owner_id uuid,p_member_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare h uuid;
begin
  select id into h from households where owner_id=p_owner_id for update;
  if h is null then raise exception 'OWNER_REQUIRED'; end if;
  if p_member_id=p_owner_id or not exists(select 1 from profiles where id=p_member_id and household_id=h) then raise exception 'MEMBER_NOT_FOUND'; end if;
  update households set owner_id=p_member_id where id=h;
  update profiles set household_role='adult' where id=p_owner_id;
  update profiles set household_role='owner' where id=p_member_id;
end; $$;

create or replace function public.leave_household_for_user(p_user_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare h uuid; owner uuid; other_count int;
begin
  select household_id into h from profiles where id=p_user_id for update;
  if h is null then return; end if;
  select owner_id into owner from households where id=h for update;
  if owner=p_user_id then
    select count(*) into other_count from profiles where household_id=h and id<>p_user_id;
    if other_count>0 then raise exception 'OWNER_TRANSFER_REQUIRED'; end if;
    delete from households where id=h;
    update profiles set household_id=null,household_role='adult' where id=p_user_id;
  else
    update profiles set household_id=null,household_role='adult' where id=p_user_id;
  end if;
end; $$;

revoke all on function public.set_household_member_role(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.remove_household_member(uuid,uuid) from public,anon,authenticated;
revoke all on function public.transfer_household_ownership(uuid,uuid) from public,anon,authenticated;
revoke all on function public.leave_household_for_user(uuid) from public,anon,authenticated;
grant execute on function public.set_household_member_role(uuid,uuid,text) to service_role;
grant execute on function public.remove_household_member(uuid,uuid) to service_role;
grant execute on function public.transfer_household_ownership(uuid,uuid) to service_role;
grant execute on function public.leave_household_for_user(uuid) to service_role;

create or replace function public.consume_pantry_items(p_user_id uuid,p_changes jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare h uuid; change jsonb; item_id uuid; amount numeric;
begin
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 100 then raise exception 'INVALID_PANTRY_CHANGES'; end if;
  select household_id into h from profiles where id=p_user_id;
  for change in select * from jsonb_array_elements(p_changes) loop
    item_id := (change->>'id')::uuid; amount := (change->>'deduction')::numeric;
    if amount <= 0 or amount > 1000000 then raise exception 'INVALID_PANTRY_DEDUCTION'; end if;
    update pantry_items set quantity=greatest(0,quantity-amount),updated_at=now()
      where id=item_id and ((h is not null and household_id=h) or (h is null and user_id=p_user_id and household_id is null));
    if not found then raise exception 'PANTRY_ITEM_NOT_FOUND'; end if;
  end loop;
end; $$;
revoke all on function public.consume_pantry_items(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.consume_pantry_items(uuid,jsonb) to service_role;

create or replace function public.create_household_for_user(p_user_id uuid,p_name text)
returns setof households language plpgsql security definer set search_path=public as $$
declare h households;
begin
  if exists(select 1 from profiles where id=p_user_id and household_id is not null) then raise exception 'USER_ALREADY_IN_HOUSEHOLD'; end if;
  insert into households(name,owner_id) values(left(coalesce(nullif(trim(p_name),''),'Moje domaćinstvo'),100),p_user_id) returning * into h;
  update profiles set household_id=h.id,household_role='owner' where id=p_user_id;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  return next h;
end; $$;

create or replace function public.join_household_for_user(p_user_id uuid,p_invite_code text)
returns setof households language plpgsql security definer set search_path=public as $$
declare h households;
begin
  if exists(select 1 from profiles where id=p_user_id and household_id is not null) then raise exception 'USER_ALREADY_IN_HOUSEHOLD'; end if;
  select * into h from households where invite_code=lower(trim(p_invite_code));
  if h.id is null then raise exception 'INVITE_NOT_FOUND'; end if;
  update profiles set household_id=h.id,household_role='adult' where id=p_user_id;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  return next h;
end; $$;
