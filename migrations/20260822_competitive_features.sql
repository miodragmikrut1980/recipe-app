-- v1.4.0: zajednička ostava i kupovina, sinhronizovani favoriti i lokalne ponude

create table if not exists public.pantry_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references public.households(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  normalized_name text not null check (char_length(normalized_name) between 1 and 200),
  quantity numeric(12,3) not null default 1 check (quantity >= 0 and quantity <= 1000000),
  unit text not null default '' check (char_length(unit) <= 40),
  category text not null default 'Ostalo' check (char_length(category) <= 80),
  location text not null default 'Ostava' check (location in ('Ostava','Frižider','Zamrzivač')),
  expires_on date,
  updated_at timestamptz not null default now()
);
create index if not exists pantry_items_user_idx on public.pantry_items(user_id, updated_at desc);
create index if not exists pantry_items_household_idx on public.pantry_items(household_id, updated_at desc);
create index if not exists pantry_items_normalized_idx on public.pantry_items(normalized_name);

create table if not exists public.recipe_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id, recipe_id)
);

create table if not exists public.shared_shopping_lists (
  scope_id uuid primary key,
  owner_user_id uuid references auth.users(id) on delete cascade,
  household_id uuid references public.households(id) on delete cascade,
  items jsonb not null default '[]'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  check ((household_id is not null and owner_user_id is null) or (household_id is null and owner_user_id is not null))
);

create or replace function public.bump_shared_shopping_revision()
returns trigger language plpgsql as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists shared_shopping_revision on public.shared_shopping_lists;
create trigger shared_shopping_revision before update on public.shared_shopping_lists for each row execute function public.bump_shared_shopping_revision();

-- Sačuvaj postojeću listu. Ako više članova ulazi u isti household scope,
-- koristi najskorije ažuriranu listu kao početno zajedničko stanje.
insert into public.shared_shopping_lists(scope_id, owner_user_id, household_id, items, updated_at)
select distinct on (coalesce(p.household_id, s.user_id))
  coalesce(p.household_id, s.user_id),
  case when p.household_id is null then s.user_id else null end,
  p.household_id,
  s.items,
  s.updated_at
from public.shopping_lists s
left join public.profiles p on p.id=s.user_id
order by coalesce(p.household_id, s.user_id), s.updated_at desc
on conflict(scope_id) do nothing;

create table if not exists public.market_offers (
  id uuid primary key default gen_random_uuid(),
  market text not null check (char_length(market) between 1 and 100),
  product_name text not null check (char_length(product_name) between 1 and 200),
  normalized_name text not null check (char_length(normalized_name) between 1 and 200),
  price_cents integer not null check (price_cents > 0),
  currency text not null default 'RSD' check (currency = 'RSD'),
  unit_label text not null default 'kom' check (char_length(unit_label) <= 40),
  source_url text check (char_length(source_url) <= 2048),
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null,
  created_at timestamptz not null default now(),
  check (valid_until > valid_from)
);
create index if not exists market_offers_lookup_idx on public.market_offers(normalized_name, valid_until);

alter table public.pantry_items enable row level security;
alter table public.recipe_favorites enable row level security;
alter table public.shared_shopping_lists enable row level security;
alter table public.market_offers enable row level security;

drop policy if exists pantry_household_select on public.pantry_items;
create policy pantry_household_select on public.pantry_items for select using (
  auth.uid() = user_id or household_id in (select household_id from public.profiles where id = auth.uid())
);
drop policy if exists pantry_household_write on public.pantry_items;
create policy pantry_household_write on public.pantry_items for all using (
  auth.uid() = user_id or household_id in (select household_id from public.profiles where id = auth.uid())
) with check (
  auth.uid() = user_id or household_id in (select household_id from public.profiles where id = auth.uid())
);
drop policy if exists favorites_own on public.recipe_favorites;
create policy favorites_own on public.recipe_favorites for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists shared_shopping_access on public.shared_shopping_lists;
create policy shared_shopping_access on public.shared_shopping_lists for select using (
  owner_user_id = auth.uid() or household_id in (select household_id from public.profiles where id = auth.uid())
);
drop policy if exists market_offers_read on public.market_offers;
create policy market_offers_read on public.market_offers for select using (valid_from <= now() and valid_until > now());

revoke all on public.pantry_items, public.recipe_favorites, public.market_offers from public, anon, authenticated;
grant select, insert, update, delete on public.pantry_items, public.recipe_favorites, public.shared_shopping_lists to service_role;
grant select, insert, update, delete on public.market_offers to service_role;
revoke insert, update, delete on public.shared_shopping_lists from public, anon, authenticated;
grant select on public.shared_shopping_lists to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='shared_shopping_lists'
  ) then
    alter publication supabase_realtime add table public.shared_shopping_lists;
  end if;
end $$;
