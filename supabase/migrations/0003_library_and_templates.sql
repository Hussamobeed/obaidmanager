create table public.print_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null check (char_length(name) between 2 and 80),
  body text not null default '',
  settings jsonb not null default '{"columns":3,"rows":3,"showProfile":true}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.library_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  storage_path text not null unique,
  mime_type text not null default 'application/octet-stream',
  byte_size bigint not null default 0,
  created_at timestamptz not null default now()
);

alter table public.print_templates enable row level security;
alter table public.library_files enable row level security;
create policy "owners manage templates" on public.print_templates for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "owners manage library metadata" on public.library_files for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

insert into storage.buckets (id, name, public) values ('manuscards-library', 'manuscards-library', false) on conflict (id) do nothing;
create policy "library files are private by path" on storage.objects for select using (bucket_id = 'manuscards-library' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "library uploads are private by path" on storage.objects for insert with check (bucket_id = 'manuscards-library' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "library updates are private by path" on storage.objects for update using (bucket_id = 'manuscards-library' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "library deletes are private by path" on storage.objects for delete using (bucket_id = 'manuscards-library' and (storage.foldername(name))[1] = auth.uid()::text);
