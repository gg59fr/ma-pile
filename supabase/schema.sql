-- Ma Pile: database, photo storage and access rules.
-- Run once in Supabase: SQL Editor › New query › paste › Run.

-- Records -------------------------------------------------------------
create table if not exists public.items (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type        text not null default 'livre'
              check (type in ('livre', 'bd', 'jeu', 'lego', 'objet')),
  status      text not null default 'pile'
              check (status in ('pile', 'cadeau', 'termine', 'telecharge', 'achete', 'abandonne')),
  title       text not null default '',
  creator     text not null default '',
  detail      text not null default '',
  note        text not null default '',
  photo       text,
  source      text,
  cover_from  text,
  created_at  bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at  bigint not null default (extract(epoch from now()) * 1000)::bigint,
  done_at     bigint
);
create index if not exists items_user_idx on public.items (user_id);
create index if not exists items_user_status_idx on public.items (user_id, status);

-- Only the owner reads and writes their own records.
alter table public.items enable row level security;
drop policy if exists "items: read own"   on public.items;
drop policy if exists "items: insert own" on public.items;
drop policy if exists "items: update own" on public.items;
drop policy if exists "items: delete own" on public.items;
create policy "items: read own"   on public.items for select to authenticated using (auth.uid() = user_id);
create policy "items: insert own" on public.items for insert to authenticated with check (auth.uid() = user_id);
create policy "items: update own" on public.items for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "items: delete own" on public.items for delete to authenticated using (auth.uid() = user_id);

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
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos: update own" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
