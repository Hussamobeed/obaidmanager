-- SABA Manager cloud feature extension.
-- Apply after 20260817130000_profiles_customers_schema.sql.

alter table public.routers
  add column if not exists routeros_version text,
  add column if not exists board_name text,
  add column if not exists last_connected_at timestamptz;

create table public.um_catalogs (
  router_id uuid primary key references public.routers(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  router_version text,
  profiles jsonb not null default '[]'::jsonb,
  customers jsonb not null default '[]'::jsonb,
  synced_at timestamptz not null default now()
);

create table public.um_batches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  router_id uuid not null references public.routers(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 160),
  router_version text,
  profile text not null,
  customer text,
  comment text,
  card_count integer not null check (card_count > 0),
  print_options jsonb not null default '{}'::jsonb,
  public_metadata jsonb not null default '{}'::jsonb,
  credentials_encrypted text not null,
  script_storage_path text,
  pdf_storage_path text,
  import_status text not null default 'pending' check (import_status in ('pending', 'importing', 'failed', 'imported')),
  import_checkpoint jsonb not null default '{}'::jsonb,
  imported_count integer not null default 0 check (imported_count >= 0),
  import_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index um_batches_owner_created_at on public.um_batches (owner_id, created_at desc);
create index um_batches_router_status on public.um_batches (router_id, import_status, created_at desc);

create table public.report_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  router_id uuid not null references public.routers(id) on delete cascade,
  report_type text not null check (report_type in ('userman-report', 'sessions', 'old-cards')),
  date_from date,
  date_to date,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  cursor jsonb not null default '{}'::jsonb,
  processed_rows integer not null default 0 check (processed_rows >= 0),
  total_rows integer,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index report_jobs_owner_created_at on public.report_jobs (owner_id, created_at desc);
create index report_jobs_router_status on public.report_jobs (router_id, status, created_at desc);

create table public.report_rows (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.report_jobs(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  row_number integer not null,
  identity_key text not null,
  row_data jsonb not null,
  created_at timestamptz not null default now(),
  unique (job_id, row_number),
  unique (job_id, identity_key)
);

create index report_rows_job_number on public.report_rows (job_id, row_number);
create index report_rows_owner_job on public.report_rows (owner_id, job_id);

alter table public.um_catalogs enable row level security;
alter table public.um_batches enable row level security;
alter table public.report_jobs enable row level security;
alter table public.report_rows enable row level security;

create policy um_catalogs_owner_access on public.um_catalogs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy um_batches_owner_access on public.um_batches
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy report_jobs_owner_access on public.report_jobs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy report_rows_owner_access on public.report_rows
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

insert into storage.buckets (id, name, public)
values ('saba-artifacts', 'saba-artifacts', false)
on conflict (id) do nothing;

create policy saba_artifacts_select_own_files on storage.objects
  for select using (
    bucket_id = 'saba-artifacts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy saba_artifacts_insert_own_files on storage.objects
  for insert with check (
    bucket_id = 'saba-artifacts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy saba_artifacts_delete_own_files on storage.objects
  for delete using (
    bucket_id = 'saba-artifacts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
