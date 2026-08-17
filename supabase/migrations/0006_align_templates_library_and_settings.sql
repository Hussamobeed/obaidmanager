-- Aligns the deployed V2 schema with the API currently used by the frontend.
-- This migration is additive: it creates missing tables and columns, backfills
-- library ownership metadata, and does not delete existing data.

begin;

-- The deployed V2 library table uses owner_id. The API also stores user_id and
-- card-generation metadata, so add those compatibility columns safely.
alter table public.library_files
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists file_type text,
  add column if not exists customer text,
  add column if not exists profile text,
  add column if not exists prefix text,
  add column if not exists number_count integer;

update public.library_files
set user_id = owner_id
where user_id is null and owner_id is not null;

update public.library_files
set file_type = coalesce(file_type, 'txt'),
    number_count = coalesce(number_count, 0)
where file_type is null or number_count is null;

alter table public.library_files
  alter column file_type set default 'txt',
  alter column number_count set default 0;

create index if not exists idx_library_files_user_id
  on public.library_files (user_id, created_at desc);

-- Per-profile print templates consumed by the template editor.
create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  profile text,
  layout jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.templates enable row level security;
create index if not exists idx_templates_user_id
  on public.templates (user_id, created_at desc);
create index if not exists idx_templates_user_profile
  on public.templates (user_id, profile);

-- Settings and saved presets used elsewhere in the frontend.
create table if not exists public.app_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table if not exists public.presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  settings jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
alter table public.presets enable row level security;
create index if not exists idx_presets_user_id
  on public.presets (user_id, created_at desc);

-- Export history is written when a stored script is executed on a router.
create table if not exists public.export_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  router_id uuid references public.routers(id) on delete set null,
  library_file_id uuid references public.library_files(id) on delete set null,
  status text not null,
  message text,
  created_at timestamptz not null default now()
);

alter table public.export_history enable row level security;
create index if not exists idx_export_history_user_id
  on public.export_history (user_id, created_at desc);

-- The API uses the service-role client and applies user scoping itself; these
-- policies also permit a user to manage their own metadata through Supabase.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'templates' and policyname = 'templates_owner_access') then
    create policy templates_owner_access on public.templates for all
      using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_settings' and policyname = 'settings_owner_access') then
    create policy settings_owner_access on public.app_settings for all
      using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'presets' and policyname = 'presets_owner_access') then
    create policy presets_owner_access on public.presets for all
      using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'export_history' and policyname = 'export_history_owner_access') then
    create policy export_history_owner_access on public.export_history for all
      using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

commit;
