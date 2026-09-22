-- places. — tables in the shared myhub. project, prefixed places_ like the
-- other apps' tables. Every row belongs to the signed-in user.

create table if not exists places_lists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  name       text not null,
  colour     text not null,
  position   int  not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists places_places (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  google_place_id   text,
  name              text not null,
  address           text,
  lat               double precision not null,
  lng               double precision not null,
  type_label        text,
  google_maps_uri   text,
  website           text,
  rating            numeric,
  rating_count      int,
  price_level       text,
  allows_dogs       boolean,
  good_for_children boolean,
  list_ids          uuid[] not null default '{}',
  note              text not null default '',
  done              boolean not null default false,
  visited_on        date,
  my_rating         smallint check (my_rating between 1 and 5),
  visit_note        text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists places_places_user_google_id
  on places_places (user_id, google_place_id) where google_place_id is not null;

-- One row per user per day, counting paid Google requests (place details and
-- nearby searches). Google's free allowance for those is 1,000 a month.
create table if not exists places_usage (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  day     date not null default current_date,
  count   int  not null default 0,
  primary key (user_id, day)
);

alter table places_lists  enable row level security;
alter table places_places enable row level security;
alter table places_usage  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['places_lists', 'places_places', 'places_usage'] loop
    execute format('drop policy if exists "own rows: read" on %I', t);
    execute format('drop policy if exists "own rows: insert" on %I', t);
    execute format('drop policy if exists "own rows: update" on %I', t);
    execute format('drop policy if exists "own rows: delete" on %I', t);
    execute format('create policy "own rows: read"   on %I for select using (auth.uid() = user_id)', t);
    execute format('create policy "own rows: insert" on %I for insert with check (auth.uid() = user_id)', t);
    execute format('create policy "own rows: update" on %I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('create policy "own rows: delete" on %I for delete using (auth.uid() = user_id)', t);
  end loop;
end $$;

-- Called before every paid Google request. Returns false, and counts nothing,
-- once today's or this month's limit is reached. The limits live here rather
-- than in the page so the page cannot be talked out of them.
create or replace function places_take_google_request()
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid         uuid := auth.uid();
  used_today  int;
  used_month  int;
begin
  if uid is null then return false; end if;
  select coalesce(sum(count), 0) into used_month
    from places_usage where user_id = uid and day >= date_trunc('month', current_date);
  select coalesce(sum(count), 0) into used_today
    from places_usage where user_id = uid and day = current_date;
  if used_today >= 25 or used_month >= 700 then return false; end if;
  insert into places_usage (user_id, day, count) values (uid, current_date, 1)
    on conflict (user_id, day) do update set count = places_usage.count + 1;
  return true;
end $$;

create or replace function places_google_usage()
returns table (today int, month int)
language sql
security invoker
set search_path = public
as $$
  select
    coalesce(sum(count) filter (where day = current_date), 0)::int,
    coalesce(sum(count) filter (where day >= date_trunc('month', current_date)), 0)::int
  from places_usage where user_id = auth.uid();
$$;
