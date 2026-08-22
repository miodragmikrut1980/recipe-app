-- Pokreni ovo u Supabase dashboard-u: SQL Editor -> New query
-- (Ako vec imas stare tabele iz prethodne verzije seme, prvo ih obrisi:
--  drop table if exists meal_plan, shopping_lists, recipes cascade;)

-- Domacinstva (porodicne kolekcije): clanovi dele recepte
create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Moje domaćinstvo',
  owner_id uuid references auth.users(id) on delete set null,
  invite_code text not null unique default encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz not null default now()
);

alter table households add column if not exists owner_id uuid references auth.users(id) on delete set null;

-- Profil korisnika: veza ka domacinstvu
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Automatski napravi profil pri registraciji
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists recipes (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete set null,
  title text not null,
  source_url text not null,
  source_platform text not null default 'other',
  thumbnail_url text,
  servings int,
  ingredients jsonb not null default '[]',
  steps jsonb not null default '[]',
  prep_time_minutes int,
  tags jsonb not null default '[]',
  nutrition_per_serving jsonb,
  created_at timestamptz not null default now()
);

create index if not exists recipes_user_idx on recipes (user_id, created_at desc);
create index if not exists recipes_household_idx on recipes (household_id, created_at desc);

create table if not exists meal_plan (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  meal_type text not null,
  recipe_id uuid not null references recipes(id) on delete cascade,
  unique (user_id, date, meal_type)
);

create table if not exists shopping_lists (
  user_id uuid primary key references auth.users(id) on delete cascade,
  items jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

-- RLS: backend koristi service_role (zaobilazi RLS) ali filtrira po user_id
-- u kodu. RLS je ukljucen kao dodatna zastita ako ikad izlozis anon pristup.
alter table recipes enable row level security;
alter table meal_plan enable row level security;
alter table shopping_lists enable row level security;
alter table profiles enable row level security;
alter table households enable row level security;

create policy "recipes_own_or_household" on recipes for select using (
  auth.uid() = user_id or
  household_id in (select household_id from profiles where id = auth.uid())
);
create policy "recipes_insert_own" on recipes for insert with check (auth.uid() = user_id);
create policy "recipes_update_own" on recipes for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "recipes_delete_own" on recipes for delete using (auth.uid() = user_id);
create policy "meal_plan_own" on meal_plan for all using (auth.uid() = user_id);
create policy "shopping_own" on shopping_lists for all using (auth.uid() = user_id);
create policy "profiles_own" on profiles for all using (auth.uid() = id);
create policy "households_member_select" on households for select using (
  id in (select household_id from profiles where id = auth.uid())
);

-- Ocene recepata (1-5) — svaki clan porodice ocenjuje nezavisno, "omiljeni"
-- recepti se racunaju kao oni sa ocenom 4 ili 5
create table if not exists recipe_ratings (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  unique (recipe_id, user_id)
);

-- Push token po korisniku (Expo push notification token). Jedan po korisniku
-- je dovoljno za MVP — ako se prijavi na novom uredjaju, prepisuje stari.
create table if not exists push_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token text not null,
  updated_at timestamptz not null default now()
);

alter table recipe_ratings enable row level security;
alter table push_tokens enable row level security;

create policy "ratings_own" on recipe_ratings for all using (auth.uid() = user_id);
create policy "push_tokens_own" on push_tokens for all using (auth.uid() = user_id);

-- Atomske operacije domaćinstva. Poziva ih samo backend service_role.
create or replace function public.create_household_for_user(p_user_id uuid, p_name text)
returns setof households
language plpgsql security definer set search_path = public
as $$
declare h households;
begin
  if exists (select 1 from profiles where id = p_user_id and household_id is not null) then
    raise exception 'USER_ALREADY_IN_HOUSEHOLD';
  end if;
  insert into households (name, owner_id) values (left(coalesce(nullif(trim(p_name), ''), 'Moje domaćinstvo'), 100), p_user_id) returning * into h;
  update profiles set household_id = h.id where id = p_user_id;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  return next h;
end;
$$;

create or replace function public.join_household_for_user(p_user_id uuid, p_invite_code text)
returns setof households
language plpgsql security definer set search_path = public
as $$
declare h households;
begin
  if exists (select 1 from profiles where id = p_user_id and household_id is not null) then
    raise exception 'USER_ALREADY_IN_HOUSEHOLD';
  end if;
  select * into h from households where invite_code = lower(trim(p_invite_code));
  if h.id is null then raise exception 'INVITE_NOT_FOUND'; end if;
  update profiles set household_id = h.id where id = p_user_id;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  return next h;
end;
$$;

revoke all on function public.create_household_for_user(uuid, text) from public, anon, authenticated;
revoke all on function public.join_household_for_user(uuid, text) from public, anon, authenticated;
grant execute on function public.create_household_for_user(uuid, text) to service_role;
grant execute on function public.join_household_for_user(uuid, text) to service_role;

-- Idempotency i atomske operacije planiranja (v1.3.0)
create table if not exists idempotency_keys (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation text not null check (char_length(operation) between 1 and 80),
  key text not null check (char_length(key) between 8 and 128),
  status text not null check (status in ('processing', 'completed')),
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, operation, key)
);
create index if not exists idempotency_keys_updated_idx on idempotency_keys(updated_at);
alter table idempotency_keys enable row level security;
revoke all on table idempotency_keys from public, anon, authenticated;
grant select, insert, update, delete on table idempotency_keys to service_role;

create or replace function public.claim_idempotency_key(p_user_id uuid,p_operation text,p_key text)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare inserted_count int; existing idempotency_keys;
begin
  if char_length(p_operation) not between 1 and 80 or char_length(p_key) not between 8 and 128 then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;
  delete from idempotency_keys where user_id=p_user_id and operation=p_operation and key=p_key and updated_at<now()-interval '24 hours';
  insert into idempotency_keys(user_id,operation,key,status) values(p_user_id,p_operation,p_key,'processing') on conflict do nothing;
  get diagnostics inserted_count=row_count;
  if inserted_count=1 then return jsonb_build_object('state','started'); end if;
  select * into existing from idempotency_keys where user_id=p_user_id and operation=p_operation and key=p_key;
  if existing.status='completed' then return jsonb_build_object('state','completed','response',existing.response); end if;
  return jsonb_build_object('state','processing');
end; $$;

drop function if exists public.upsert_meal_plan_entries(uuid, jsonb);
create or replace function public.upsert_meal_plan_entries(p_user_id uuid, p_entries jsonb, p_operation text, p_key text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare item jsonb; saved meal_plan; result jsonb := '[]'::jsonb; household uuid; rid uuid; meal text; meal_date date;
begin
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) not between 1 and 42 then raise exception 'INVALID_PLAN_ENTRIES'; end if;
  select household_id into household from profiles where id = p_user_id;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  for item in select value from jsonb_array_elements(p_entries) loop
    rid := (item->>'recipeId')::uuid; meal := item->>'mealType'; meal_date := (item->>'date')::date;
    if meal not in ('breakfast', 'lunch', 'dinner') then raise exception 'INVALID_MEAL_TYPE'; end if;
    if not exists (select 1 from recipes r where r.id = rid and (r.user_id = p_user_id or (household is not null and r.household_id = household))) then raise exception 'RECIPE_NOT_ACCESSIBLE'; end if;
    insert into meal_plan(user_id,date,meal_type,recipe_id) values(p_user_id,meal_date,meal,rid)
      on conflict(user_id,date,meal_type) do update set recipe_id=excluded.recipe_id returning * into saved;
    result := result || jsonb_build_array(to_jsonb(saved));
  end loop;
  if p_key is not null then
    update idempotency_keys set status='completed',response=jsonb_build_object('entries',result),updated_at=now()
      where user_id=p_user_id and operation=p_operation and key=p_key and status='processing';
    if not found then raise exception 'IDEMPOTENCY_CLAIM_NOT_FOUND'; end if;
  end if;
  return result;
end; $$;

drop function if exists public.save_generated_recipes_and_plan(uuid, jsonb, jsonb);
create or replace function public.save_generated_recipes_and_plan(p_user_id uuid, p_recipes jsonb, p_entries jsonb, p_operation text, p_key text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare item jsonb; saved_recipe recipes; saved_plan meal_plan; recipes_result jsonb := '[]'::jsonb; entries_result jsonb := '[]'::jsonb; household uuid; rid uuid; meal text; meal_date date;
begin
  if jsonb_typeof(p_recipes) <> 'array' or jsonb_array_length(p_recipes) not between 1 and 10 then raise exception 'INVALID_GENERATED_RECIPES'; end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) not between 1 and 28 then raise exception 'INVALID_PLAN_ENTRIES'; end if;
  select household_id into household from profiles where id=p_user_id; if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  for item in select value from jsonb_array_elements(p_recipes) loop
    insert into recipes(id,user_id,household_id,title,source_url,source_platform,thumbnail_url,servings,ingredients,steps,prep_time_minutes,tags,nutrition_per_serving,created_at)
    values((item->>'id')::uuid,p_user_id,household,left(item->>'title',200),left(item->>'source_url',2048),left(coalesce(item->>'source_platform','other'),40),nullif(left(coalesce(item->>'thumbnail_url',''),2048),''),nullif(item->>'servings','')::int,coalesce(item->'ingredients','[]'::jsonb),coalesce(item->'steps','[]'::jsonb),nullif(item->>'prep_time_minutes','')::int,coalesce(item->'tags','[]'::jsonb),item->'nutrition_per_serving',coalesce((item->>'created_at')::timestamptz,now())) returning * into saved_recipe;
    recipes_result := recipes_result || jsonb_build_array(to_jsonb(saved_recipe));
  end loop;
  for item in select value from jsonb_array_elements(p_entries) loop
    rid := (item->>'recipeId')::uuid; meal := item->>'mealType'; meal_date := (item->>'date')::date;
    if meal not in ('breakfast','lunch','dinner') then raise exception 'INVALID_MEAL_TYPE'; end if;
    if not exists(select 1 from recipes r where r.id=rid and r.user_id=p_user_id) then raise exception 'RECIPE_NOT_ACCESSIBLE'; end if;
    insert into meal_plan(user_id,date,meal_type,recipe_id) values(p_user_id,meal_date,meal,rid)
      on conflict(user_id,date,meal_type) do update set recipe_id=excluded.recipe_id returning * into saved_plan;
    entries_result := entries_result || jsonb_build_array(to_jsonb(saved_plan));
  end loop;
  if p_key is not null then
    update idempotency_keys set status='completed',response=jsonb_build_object('entries',entries_result,'recipesFound',jsonb_array_length(recipes_result)),updated_at=now()
      where user_id=p_user_id and operation=p_operation and key=p_key and status='processing';
    if not found then raise exception 'IDEMPOTENCY_CLAIM_NOT_FOUND'; end if;
  end if;
  return jsonb_build_object('recipes',recipes_result,'entries',entries_result);
end; $$;

revoke all on function public.upsert_meal_plan_entries(uuid,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.save_generated_recipes_and_plan(uuid,jsonb,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.claim_idempotency_key(uuid,text,text) from public,anon,authenticated;
grant execute on function public.upsert_meal_plan_entries(uuid,jsonb,text,text) to service_role;
grant execute on function public.save_generated_recipes_and_plan(uuid,jsonb,jsonb,text,text) to service_role;
grant execute on function public.claim_idempotency_key(uuid,text,text) to service_role;

-- Dnevni AI budžet i operativna zaštita (v1.3.1)
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

-- Konkurentske funkcije v1.4.0: ostava, favoriti, zajednička kupovina i ponude
create table if not exists public.pantry_items (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references public.households(id) on delete cascade, name text not null check(char_length(name) between 1 and 200),
  normalized_name text not null check(char_length(normalized_name) between 1 and 200), quantity numeric(12,3) not null default 1 check(quantity>=0 and quantity<=1000000),
  unit text not null default '' check(char_length(unit)<=40), category text not null default 'Ostalo' check(char_length(category)<=80),
  location text not null default 'Ostava' check(location in ('Ostava','Frižider','Zamrzivač')), expires_on date, updated_at timestamptz not null default now()
);
create index if not exists pantry_items_user_idx on public.pantry_items(user_id,updated_at desc);
create index if not exists pantry_items_household_idx on public.pantry_items(household_id,updated_at desc);
create index if not exists pantry_items_normalized_idx on public.pantry_items(normalized_name);

create table if not exists public.recipe_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  created_at timestamptz not null default now(), primary key(user_id,recipe_id)
);

create table if not exists public.shared_shopping_lists (
  scope_id uuid primary key, owner_user_id uuid references auth.users(id) on delete cascade,
  household_id uuid references public.households(id) on delete cascade, items jsonb not null default '[]'::jsonb,
  revision bigint not null default 1, updated_at timestamptz not null default now(),
  check((household_id is not null and owner_user_id is null) or (household_id is null and owner_user_id is not null))
);
create or replace function public.bump_shared_shopping_revision() returns trigger language plpgsql as $$
begin new.revision:=old.revision+1; new.updated_at:=now(); return new; end; $$;
drop trigger if exists shared_shopping_revision on public.shared_shopping_lists;
create trigger shared_shopping_revision before update on public.shared_shopping_lists for each row execute function public.bump_shared_shopping_revision();
insert into public.shared_shopping_lists(scope_id,owner_user_id,household_id,items,updated_at)
select distinct on(coalesce(p.household_id,s.user_id)) coalesce(p.household_id,s.user_id),case when p.household_id is null then s.user_id else null end,p.household_id,s.items,s.updated_at
from public.shopping_lists s left join public.profiles p on p.id=s.user_id
order by coalesce(p.household_id,s.user_id),s.updated_at desc on conflict(scope_id) do nothing;

create table if not exists public.market_offers (
  id uuid primary key default gen_random_uuid(), market text not null check(char_length(market) between 1 and 100),
  product_name text not null check(char_length(product_name) between 1 and 200), normalized_name text not null check(char_length(normalized_name) between 1 and 200),
  price_cents integer not null check(price_cents>0), currency text not null default 'RSD' check(currency='RSD'),
  unit_label text not null default 'kom' check(char_length(unit_label)<=40), source_url text check(char_length(source_url)<=2048),
  valid_from timestamptz not null default now(), valid_until timestamptz not null, created_at timestamptz not null default now(), check(valid_until>valid_from)
);
create index if not exists market_offers_lookup_idx on public.market_offers(normalized_name,valid_until);

alter table public.pantry_items enable row level security;
alter table public.recipe_favorites enable row level security;
alter table public.shared_shopping_lists enable row level security;
alter table public.market_offers enable row level security;
drop policy if exists pantry_household_select on public.pantry_items;
create policy pantry_household_select on public.pantry_items for select using(auth.uid()=user_id or household_id in(select household_id from public.profiles where id=auth.uid()));
drop policy if exists pantry_household_write on public.pantry_items;
create policy pantry_household_write on public.pantry_items for all using(auth.uid()=user_id or household_id in(select household_id from public.profiles where id=auth.uid())) with check(auth.uid()=user_id or household_id in(select household_id from public.profiles where id=auth.uid()));
drop policy if exists favorites_own on public.recipe_favorites;
create policy favorites_own on public.recipe_favorites for all using(auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists shared_shopping_access on public.shared_shopping_lists;
create policy shared_shopping_access on public.shared_shopping_lists for select using(owner_user_id=auth.uid() or household_id in(select household_id from public.profiles where id=auth.uid()));
drop policy if exists market_offers_read on public.market_offers;
create policy market_offers_read on public.market_offers for select using(valid_from<=now() and valid_until>now());
revoke all on public.pantry_items,public.recipe_favorites,public.market_offers from public,anon,authenticated;
revoke insert,update,delete on public.shared_shopping_lists from public,anon,authenticated;
grant select,insert,update,delete on public.pantry_items,public.recipe_favorites,public.shared_shopping_lists,public.market_offers to service_role;
grant select on public.shared_shopping_lists to authenticated;
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='shared_shopping_lists') then
    alter publication supabase_realtime add table public.shared_shopping_lists;
  end if;
end $$;

-- v1.5.0: uloge domaćinstva i potvrđena potrošnja ostave
alter table public.profiles add column if not exists display_name text check(display_name is null or char_length(display_name) between 1 and 80);
alter table public.profiles add column if not exists household_role text not null default 'adult' check(household_role in('owner','adult','child'));
update public.profiles p set household_role='owner' from public.households h where h.owner_id=p.id and p.household_id=h.id;
create or replace function public.create_household_for_user(p_user_id uuid,p_name text) returns setof households language plpgsql security definer set search_path=public as $$
declare h households; begin if exists(select 1 from profiles where id=p_user_id and household_id is not null) then raise exception 'USER_ALREADY_IN_HOUSEHOLD'; end if; insert into households(name,owner_id) values(left(coalesce(nullif(trim(p_name),''),'Moje domaćinstvo'),100),p_user_id) returning * into h; update profiles set household_id=h.id,household_role='owner' where id=p_user_id; if not found then raise exception 'PROFILE_NOT_FOUND'; end if; return next h; end; $$;
create or replace function public.join_household_for_user(p_user_id uuid,p_invite_code text) returns setof households language plpgsql security definer set search_path=public as $$
declare h households; begin if exists(select 1 from profiles where id=p_user_id and household_id is not null) then raise exception 'USER_ALREADY_IN_HOUSEHOLD'; end if; select * into h from households where invite_code=lower(trim(p_invite_code)); if h.id is null then raise exception 'INVITE_NOT_FOUND'; end if; update profiles set household_id=h.id,household_role='adult' where id=p_user_id; if not found then raise exception 'PROFILE_NOT_FOUND'; end if; return next h; end; $$;

create or replace function public.set_household_member_role(p_owner_id uuid,p_member_id uuid,p_role text) returns void language plpgsql security definer set search_path=public as $$
declare h uuid; begin if p_role not in('adult','child') then raise exception 'INVALID_HOUSEHOLD_ROLE'; end if; select id into h from households where owner_id=p_owner_id; if h is null then raise exception 'OWNER_REQUIRED'; end if; if p_member_id=p_owner_id then raise exception 'OWNER_ROLE_IMMUTABLE'; end if; update profiles set household_role=p_role where id=p_member_id and household_id=h; if not found then raise exception 'MEMBER_NOT_FOUND'; end if; end; $$;
create or replace function public.remove_household_member(p_owner_id uuid,p_member_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare h uuid; begin select id into h from households where owner_id=p_owner_id; if h is null then raise exception 'OWNER_REQUIRED'; end if; if p_member_id=p_owner_id then raise exception 'OWNER_CANNOT_REMOVE_SELF'; end if; update profiles set household_id=null,household_role='adult' where id=p_member_id and household_id=h; if not found then raise exception 'MEMBER_NOT_FOUND'; end if; end; $$;
create or replace function public.transfer_household_ownership(p_owner_id uuid,p_member_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare h uuid; begin select id into h from households where owner_id=p_owner_id for update; if h is null then raise exception 'OWNER_REQUIRED'; end if; if p_member_id=p_owner_id or not exists(select 1 from profiles where id=p_member_id and household_id=h) then raise exception 'MEMBER_NOT_FOUND'; end if; update households set owner_id=p_member_id where id=h; update profiles set household_role='adult' where id=p_owner_id; update profiles set household_role='owner' where id=p_member_id; end; $$;
create or replace function public.leave_household_for_user(p_user_id uuid) returns void language plpgsql security definer set search_path=public as $$
declare h uuid; owner uuid; other_count int; begin select household_id into h from profiles where id=p_user_id for update; if h is null then return; end if; select owner_id into owner from households where id=h for update; if owner=p_user_id then select count(*) into other_count from profiles where household_id=h and id<>p_user_id; if other_count>0 then raise exception 'OWNER_TRANSFER_REQUIRED'; end if; delete from households where id=h; update profiles set household_id=null,household_role='adult' where id=p_user_id; else update profiles set household_id=null,household_role='adult' where id=p_user_id; end if; end; $$;
create or replace function public.consume_pantry_items(p_user_id uuid,p_changes jsonb) returns void language plpgsql security definer set search_path=public as $$
declare h uuid; change jsonb; item_id uuid; amount numeric; begin if jsonb_typeof(p_changes)<>'array' or jsonb_array_length(p_changes)>100 then raise exception 'INVALID_PANTRY_CHANGES'; end if; select household_id into h from profiles where id=p_user_id; for change in select * from jsonb_array_elements(p_changes) loop item_id:=(change->>'id')::uuid; amount:=(change->>'deduction')::numeric; if amount<=0 or amount>1000000 then raise exception 'INVALID_PANTRY_DEDUCTION'; end if; update pantry_items set quantity=greatest(0,quantity-amount),updated_at=now() where id=item_id and ((h is not null and household_id=h) or(h is null and user_id=p_user_id and household_id is null)); if not found then raise exception 'PANTRY_ITEM_NOT_FOUND'; end if; end loop; end; $$;
revoke all on function public.set_household_member_role(uuid,uuid,text),public.remove_household_member(uuid,uuid),public.transfer_household_ownership(uuid,uuid),public.leave_household_for_user(uuid),public.consume_pantry_items(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.set_household_member_role(uuid,uuid,text),public.remove_household_member(uuid,uuid),public.transfer_household_ownership(uuid,uuid),public.leave_household_for_user(uuid),public.consume_pantry_items(uuid,jsonb) to service_role;

-- v1.6.0: istorija promena domaćinstva
create table if not exists public.household_activity(
  id uuid primary key default gen_random_uuid(), household_id uuid not null references public.households(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null check(action in('recipe_added','recipe_updated','recipe_removed','pantry_added','pantry_updated','pantry_removed','pantry_consumed','shopping_updated','meal_planned','meal_removed','member_role_changed','member_removed','ownership_transferred')),
  entity_type text not null check(char_length(entity_type) between 1 and 40), entity_id uuid,
  summary text not null check(char_length(summary) between 1 and 240), metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists household_activity_scope_idx on public.household_activity(household_id,created_at desc);
alter table public.household_activity enable row level security;
drop policy if exists household_activity_member_read on public.household_activity;
create policy household_activity_member_read on public.household_activity for select using(household_id in(select household_id from public.profiles where id=auth.uid()));
revoke all on public.household_activity from public,anon,authenticated;
grant select,insert on public.household_activity to service_role;
