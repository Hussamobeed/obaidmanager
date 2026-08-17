-- Obaid Manager baseline schema.
-- This is a clean-schema migration. It intentionally stores only User Manager
-- customers and profiles; individual users and active-session data are not
-- collected, persisted, or exposed by this application.

create extension if not exists pgcrypto;

create table public.routers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null check (char_length(name) between 1 and 100),
  host text not null check (char_length(host) between 1 and 255),
  port integer not null default 8728 check (port between 1 and 65535),
  username text not null check (char_length(username) between 1 and 100),
  password_encrypted text not null,
  ssl_enabled boolean not null default false,
  description text check (description is null or char_length(description) <= 500),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index routers_one_default_per_owner
  on public.routers (owner_id)
  where is_default;

-- A single current snapshot per router is enough for the generator. Profiles
-- and customers are JSON arrays because they are read and refreshed together.
create table public.router_sync_snapshots (
  router_id uuid primary key references public.routers(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  customers jsonb not null default '[]'::jsonb,
  profiles jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create index router_sync_snapshots_owner_id
  on public.router_sync_snapshots (owner_id, updated_at desc);

create table public.library_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  file_type text not null default 'txt' check (file_type in ('txt', 'pdf', 'xlsx', 'mikrotik-script')),
  storage_path text not null unique,
  customer text,
  profile text,
  prefix text,
  number_count integer check (number_count is null or number_count >= 0),
  created_at timestamptz not null default now()
);

create index library_files_user_created_at
  on public.library_files (user_id, created_at desc);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  profile text,
  layout jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index templates_user_created_at
  on public.templates (user_id, created_at desc);
create index templates_user_profile
  on public.templates (user_id, profile);

create table public.app_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table public.presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  settings jsonb not null,
  created_at timestamptz not null default now()
);

create index presets_user_created_at
  on public.presets (user_id, created_at desc);

create table public.export_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  router_id uuid references public.routers(id) on delete set null,
  library_file_id uuid references public.library_files(id) on delete set null,
  status text not null,
  message text,
  created_at timestamptz not null default now()
);

create index export_history_user_created_at
  on public.export_history (user_id, created_at desc);

alter table public.routers enable row level security;
alter table public.router_sync_snapshots enable row level security;
alter table public.library_files enable row level security;
alter table public.templates enable row level security;
alter table public.app_settings enable row level security;
alter table public.presets enable row level security;
alter table public.export_history enable row level security;

create policy routers_owner_access on public.routers
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy router_sync_snapshots_owner_access on public.router_sync_snapshots
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy library_files_owner_access on public.library_files
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy templates_owner_access on public.templates
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy app_settings_owner_access on public.app_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy presets_owner_access on public.presets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy export_history_owner_access on public.export_history
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

insert into storage.buckets (id, name, public)
values ('library', 'library', false)
on conflict (id) do nothing;

create policy library_storage_select_own_files on storage.objects
  for select using (
    bucket_id = 'library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy library_storage_insert_own_files on storage.objects
  for insert with check (
    bucket_id = 'library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy library_storage_update_own_files on storage.objects
  for update using (
    bucket_id = 'library'
    and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy library_storage_delete_own_files on storage.objects
  for delete using (
    bucket_id = 'library'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
