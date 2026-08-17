create or replace function public.copy_latest_report_users(p_router_id uuid, p_new_run_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_run_id uuid;
  copied integer;
begin
  select active_run_id into previous_run_id from public.report_snapshots where router_id = p_router_id;
  if previous_run_id is null then return 0; end if;
  insert into public.report_users (
    router_id, run_id, username, profile, price, first_name, comment,
    nas_port, nas_port_id, calling_station_id, called_station_id, last_seen,
    bytes_in, bytes_out, uptime, disabled
  )
  select router_id, p_new_run_id, username, profile, price, first_name, comment,
    nas_port, nas_port_id, calling_station_id, called_station_id, last_seen,
    bytes_in, bytes_out, uptime, disabled
  from public.report_users where run_id = previous_run_id;
  get diagnostics copied = row_count;
  return copied;
end;
$$;

revoke all on function public.copy_latest_report_users(uuid, uuid) from public;
