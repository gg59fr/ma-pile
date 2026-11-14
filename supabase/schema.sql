-- Ma Pile: database, photo storage and access rules.
-- Run once in Supabase: SQL Editor › New query › paste › Run.

-- Records -------------------------------------------------------------
create table if not exists public.items (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type        text not null default 'livre'
              check (type in ('livre', 'bd', 'jeu', 'lego', 'objet')),
  status      text not null default 'pile'
              check (status in ('pile', 'cadeau', 'collection', 'parti', 'termine', 'telecharge', 'achete', 'abandonne')),
  title       text not null default '',
  creator     text not null default '',
  detail      text not null default '',
  note        text not null default '',
  photo       text,
  source      text,
  cover_from  text,
  isbn        text,
  pages       integer check (pages is null or pages between 1 and 20000),
  pub_year    integer check (pub_year is null or pub_year between 1000 and 2100),
  publisher   text,
  genre       text check (genre is null or genre in ('polar', 'sf', 'fantasy', 'horreur', 'roman', 'essai', 'jeunesse', 'autre')),
  meta_checked bigint,
  owned       boolean not null default false,
  owned_at    bigint,
  format      text check (format is null or format in ('papier', 'numerique')),
  cond        text check (cond is null or cond in ('boite', 'construit', 'demonte')),
  plays       integer not null default 0 check (plays between 0 and 100000),
  extra       jsonb not null default '{}'::jsonb,
  created_at  bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at  bigint not null default (extract(epoch from now()) * 1000)::bigint,
  done_at     bigint
);
create index if not exists items_user_idx on public.items (user_id);
create index if not exists items_user_status_idx on public.items (user_id, status);
create index if not exists items_user_owned_idx on public.items (user_id) where owned;
create index if not exists items_user_isbn_idx on public.items (user_id, isbn) where isbn is not null;

-- Only the owner reads and writes their own records.
-- New Supabase projects no longer grant table access to signed-in users by default.
grant select, insert, update, delete on table public.items to authenticated;
alter table public.items enable row level security;
drop policy if exists "items: read own"   on public.items;
drop policy if exists "items: insert own" on public.items;
drop policy if exists "items: update own" on public.items;
drop policy if exists "items: delete own" on public.items;
create policy "items: read own"   on public.items for select to authenticated using ((select auth.uid()) = user_id);
create policy "items: insert own" on public.items for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "items: update own" on public.items for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "items: delete own" on public.items for delete to authenticated using ((select auth.uid()) = user_id);

-- Live sync between phone and computer.
do $$ begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null; end $$;

-- Photos --------------------------------------------------------------
-- Public bucket: a photo is readable by its unguessable address (needed later
-- for the shared gift list). Only the owner can add, replace or delete files,
-- and only inside their own folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true;

drop policy if exists "photos: upload own" on storage.objects;
drop policy if exists "photos: update own" on storage.objects;
drop policy if exists "photos: delete own" on storage.objects;
create policy "photos: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "photos: update own" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "photos: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Shared gift list -----------------------------------------------------
-- One shareable list per person, reached by an unguessable token.
create table if not exists public.gift_lists (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  token      text not null unique check (char_length(token) >= 20),
  title      text not null default 'Ma liste cadeaux' check (char_length(title) <= 80),
  created_at timestamptz not null default now()
);
alter table public.gift_lists enable row level security;
drop policy if exists "gift_lists: read own"   on public.gift_lists;
drop policy if exists "gift_lists: insert own" on public.gift_lists;
drop policy if exists "gift_lists: update own" on public.gift_lists;
drop policy if exists "gift_lists: delete own" on public.gift_lists;
create policy "gift_lists: read own"   on public.gift_lists for select to authenticated using ((select auth.uid()) = user_id);
create policy "gift_lists: insert own" on public.gift_lists for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "gift_lists: update own" on public.gift_lists for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "gift_lists: delete own" on public.gift_lists for delete to authenticated using ((select auth.uid()) = user_id);
grant select, insert, update, delete on table public.gift_lists to authenticated;

-- Reservations: nobody reads this table directly, not even the list owner (the surprise).
-- Visitors go through the functions below. (The advisor notes "RLS enabled, no policy"
-- and "public can execute SECURITY DEFINER function": both are intended here.)
create table if not exists public.reservations (
  item_id    text primary key references public.items(id) on delete cascade,
  secret     text not null,
  created_at timestamptz not null default now()
);
alter table public.reservations enable row level security;
revoke all on table public.reservations from anon, authenticated;

-- Public read of a list: only gift items, only public fields (never the private note).
create or replace function public.gift_list(p_token text)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'title', g.title,
    'items', coalesce((
      select json_agg(json_build_object(
        'id', i.id, 'type', i.type, 'title', i.title, 'creator', i.creator,
        'detail', i.detail, 'photo', i.photo, 'reserved', r.item_id is not null)
        order by i.created_at)
      from public.items i
      left join public.reservations r on r.item_id = i.id
      where i.user_id = g.user_id and i.status = 'cadeau'), '[]'::json))
  from public.gift_lists g
  where g.token = p_token;
$$;

create or replace function public.reserve_gift(p_token text, p_item text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_secret text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not exists (
    select 1 from public.items i join public.gift_lists g on g.user_id = i.user_id
    where g.token = p_token and i.id = p_item and i.status = 'cadeau') then
    raise exception 'not_found';
  end if;
  insert into public.reservations (item_id, secret) values (p_item, v_secret)
  on conflict (item_id) do nothing;
  if not found then raise exception 'already_reserved'; end if;
  return v_secret;
end $$;

create or replace function public.unreserve_gift(p_token text, p_item text, p_secret text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from public.reservations r
  using public.items i, public.gift_lists g
  where r.item_id = p_item and r.secret = p_secret
    and i.id = r.item_id and g.user_id = i.user_id and g.token = p_token;
  return found;
end $$;

revoke all on function public.gift_list(text), public.reserve_gift(text, text), public.unreserve_gift(text, text, text) from public;
grant execute on function public.gift_list(text), public.reserve_gift(text, text), public.unreserve_gift(text, text, text) to anon, authenticated;

-- Drop default privileges the app never uses (TRUNCATE would bypass row-level security).
revoke truncate, trigger, references on table public.items, public.gift_lists, public.reservations from anon, authenticated;

-- Lego catalog -----------------------------------------------------------
-- Every Lego set from Rebrickable's free CSV downloads (about 28 600 sets, ~14 MB with indexes),
-- refreshed by the lego-catalog-sync edge function (supabase/functions/lego-catalog-sync).
-- Images are links to Rebrickable's CDN, nothing is stored. Barcodes (ean, upc) are not in
-- those downloads: the columns stay empty until another source fills them.
create extension if not exists pg_trgm with schema extensions;
create table if not exists public.lego_sets (
  set_num    text primary key,
  num        text generated always as (split_part(set_num, '-', 1)) stored,
  name       text not null,
  year       integer,
  theme      text,
  theme_path text,
  pieces     integer,
  img        text,
  ean        text[] not null default '{}',
  upc        text[] not null default '{}',
  updated_at timestamptz not null default now()
);
create index if not exists lego_sets_num_idx   on public.lego_sets (num text_pattern_ops);
create index if not exists lego_sets_theme_idx on public.lego_sets (theme);
create index if not exists lego_sets_ean_idx   on public.lego_sets using gin (ean);
create index if not exists lego_sets_name_trgm on public.lego_sets using gin (name extensions.gin_trgm_ops);
alter table public.lego_sets enable row level security;
drop policy if exists "lego_sets: read" on public.lego_sets;
create policy "lego_sets: read" on public.lego_sets for select to authenticated using (true);

-- One row: when the catalog was last refreshed (the function waits 6 hours between runs).
create table if not exists public.lego_sync (
  id     integer primary key default 1 check (id = 1),
  ran_at timestamptz,
  rows   integer
);
alter table public.lego_sync enable row level security;   -- no policy: only the server function touches it

grant select on table public.lego_sets to authenticated;
grant select, insert, update on table public.lego_sets, public.lego_sync to service_role;
revoke truncate, trigger, references on table public.lego_sets, public.lego_sync from anon, authenticated;
