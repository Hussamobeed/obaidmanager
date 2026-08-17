-- Safe forward migration for the deployed V2 (owner_id) schema.
-- It preserves existing routers and RLS policies while adding the connection
-- fields required by the router management API.

begin;

alter table public.routers
  add column if not exists host text,
  add column if not exists port integer not null default 8728,
  add column if not exists username text,
  add column if not exists password_encrypted text,
  add column if not exists ssl_enabled boolean not null default false,
  add column if not exists is_default boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

alter table public.routers
  alter column port set default 8728,
  alter column ssl_enabled set default false,
  alter column is_default set default false,
  alter column updated_at set default now();

create index if not exists idx_routers_owner_id on public.routers (owner_id);

commit;
