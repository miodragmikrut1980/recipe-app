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
