-- v1.3.0: idempotency + atomsko generisanje plana i online recepata.
begin;

create table if not exists public.idempotency_keys (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation text not null check (char_length(operation) between 1 and 80),
  key text not null check (char_length(key) between 8 and 128),
  status text not null check (status in ('processing', 'completed')),
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, operation, key)
);

create index if not exists idempotency_keys_updated_idx on public.idempotency_keys(updated_at);
alter table public.idempotency_keys enable row level security;
revoke all on table public.idempotency_keys from public, anon, authenticated;
grant select, insert, update, delete on table public.idempotency_keys to service_role;

create or replace function public.claim_idempotency_key(p_user_id uuid, p_operation text, p_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare inserted_count int; existing public.idempotency_keys;
begin
  if char_length(p_operation) not between 1 and 80 or char_length(p_key) not between 8 and 128 then
    raise exception 'INVALID_IDEMPOTENCY_KEY';
  end if;
  delete from public.idempotency_keys where user_id=p_user_id and operation=p_operation and key=p_key and updated_at < now() - interval '24 hours';
  insert into public.idempotency_keys(user_id,operation,key,status)
    values(p_user_id,p_operation,p_key,'processing') on conflict do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 1 then return jsonb_build_object('state','started'); end if;
  select * into existing from public.idempotency_keys where user_id=p_user_id and operation=p_operation and key=p_key;
  if existing.status = 'completed' then return jsonb_build_object('state','completed','response',existing.response); end if;
  return jsonb_build_object('state','processing');
end;
$$;

drop function if exists public.upsert_meal_plan_entries(uuid, jsonb);
create or replace function public.upsert_meal_plan_entries(p_user_id uuid, p_entries jsonb, p_operation text, p_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  item jsonb;
  saved public.meal_plan;
  result jsonb := '[]'::jsonb;
  household uuid;
  rid uuid;
  meal text;
  meal_date date;
begin
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) not between 1 and 42 then
    raise exception 'INVALID_PLAN_ENTRIES';
  end if;
  select household_id into household from public.profiles where id = p_user_id;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;

  for item in select value from jsonb_array_elements(p_entries)
  loop
    rid := (item->>'recipeId')::uuid;
    meal := item->>'mealType';
    meal_date := (item->>'date')::date;
    if meal not in ('breakfast', 'lunch', 'dinner') then raise exception 'INVALID_MEAL_TYPE'; end if;
    if not exists (
      select 1 from public.recipes r where r.id = rid
      and (r.user_id = p_user_id or (household is not null and r.household_id = household))
    ) then raise exception 'RECIPE_NOT_ACCESSIBLE'; end if;

    insert into public.meal_plan(user_id, date, meal_type, recipe_id)
      values (p_user_id, meal_date, meal, rid)
      on conflict (user_id, date, meal_type) do update set recipe_id = excluded.recipe_id
      returning * into saved;
    result := result || jsonb_build_array(to_jsonb(saved));
  end loop;
  if p_key is not null then
    update public.idempotency_keys set status='completed', response=jsonb_build_object('entries', result), updated_at=now()
      where user_id=p_user_id and operation=p_operation and key=p_key and status='processing';
    if not found then raise exception 'IDEMPOTENCY_CLAIM_NOT_FOUND'; end if;
  end if;
  return result;
end;
$$;

drop function if exists public.save_generated_recipes_and_plan(uuid, jsonb, jsonb);
create or replace function public.save_generated_recipes_and_plan(p_user_id uuid, p_recipes jsonb, p_entries jsonb, p_operation text, p_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  item jsonb;
  saved_recipe public.recipes;
  saved_plan public.meal_plan;
  recipes_result jsonb := '[]'::jsonb;
  entries_result jsonb := '[]'::jsonb;
  household uuid;
  rid uuid;
  meal text;
  meal_date date;
begin
  if jsonb_typeof(p_recipes) <> 'array' or jsonb_array_length(p_recipes) not between 1 and 10 then
    raise exception 'INVALID_GENERATED_RECIPES';
  end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) not between 1 and 28 then
    raise exception 'INVALID_PLAN_ENTRIES';
  end if;
  select household_id into household from public.profiles where id = p_user_id;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;

  for item in select value from jsonb_array_elements(p_recipes)
  loop
    insert into public.recipes(
      id, user_id, household_id, title, source_url, source_platform, thumbnail_url,
      servings, ingredients, steps, prep_time_minutes, tags, nutrition_per_serving, created_at
    ) values (
      (item->>'id')::uuid, p_user_id, household,
      left(item->>'title', 200), left(item->>'source_url', 2048), left(coalesce(item->>'source_platform', 'other'), 40),
      nullif(left(coalesce(item->>'thumbnail_url', ''), 2048), ''), nullif(item->>'servings', '')::int,
      coalesce(item->'ingredients', '[]'::jsonb), coalesce(item->'steps', '[]'::jsonb),
      nullif(item->>'prep_time_minutes', '')::int, coalesce(item->'tags', '[]'::jsonb),
      item->'nutrition_per_serving', coalesce((item->>'created_at')::timestamptz, now())
    ) returning * into saved_recipe;
    recipes_result := recipes_result || jsonb_build_array(to_jsonb(saved_recipe));
  end loop;

  for item in select value from jsonb_array_elements(p_entries)
  loop
    rid := (item->>'recipeId')::uuid;
    meal := item->>'mealType';
    meal_date := (item->>'date')::date;
    if meal not in ('breakfast', 'lunch', 'dinner') then raise exception 'INVALID_MEAL_TYPE'; end if;
    if not exists (select 1 from public.recipes r where r.id = rid and r.user_id = p_user_id) then
      raise exception 'RECIPE_NOT_ACCESSIBLE';
    end if;
    insert into public.meal_plan(user_id, date, meal_type, recipe_id)
      values (p_user_id, meal_date, meal, rid)
      on conflict (user_id, date, meal_type) do update set recipe_id = excluded.recipe_id
      returning * into saved_plan;
    entries_result := entries_result || jsonb_build_array(to_jsonb(saved_plan));
  end loop;

  if p_key is not null then
    update public.idempotency_keys set status='completed',
      response=jsonb_build_object('entries', entries_result, 'recipesFound', jsonb_array_length(recipes_result)), updated_at=now()
      where user_id=p_user_id and operation=p_operation and key=p_key and status='processing';
    if not found then raise exception 'IDEMPOTENCY_CLAIM_NOT_FOUND'; end if;
  end if;
  return jsonb_build_object('recipes', recipes_result, 'entries', entries_result);
end;
$$;

revoke all on function public.upsert_meal_plan_entries(uuid, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.save_generated_recipes_and_plan(uuid, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.claim_idempotency_key(uuid, text, text) from public, anon, authenticated;
grant execute on function public.upsert_meal_plan_entries(uuid, jsonb, text, text) to service_role;
grant execute on function public.save_generated_recipes_and_plan(uuid, jsonb, jsonb, text, text) to service_role;
grant execute on function public.claim_idempotency_key(uuid, text, text) to service_role;

commit;
