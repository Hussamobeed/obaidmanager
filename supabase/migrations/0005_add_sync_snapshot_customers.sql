-- Stores the lightweight User Manager customer import alongside the active
-- profile snapshot used by the card generator.

alter table public.report_snapshots
  add column if not exists customers jsonb not null default '[]'::jsonb;
