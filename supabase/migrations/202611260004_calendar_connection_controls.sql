create function public.control_calendar_connection(owner_id uuid, connection uuid, operation text)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  if operation = 'disconnect' then
    delete from public.calendar_connections
      where id = connection and user_id = owner_id;
  elsif operation = 'pause' then
    update public.calendar_connections
      set status = 'paused', sync_lease_until = null, sync_lease_id = null
      where id = connection and user_id = owner_id and status in ('pending', 'healthy', 'degraded');
  elsif operation = 'resume' then
    update public.calendar_connections
      set status = 'pending', next_sync_at = now(), sync_failures = 0
      where id = connection and user_id = owner_id and status = 'paused';
  else
    return false;
  end if;
  return found;
end;
$$;

revoke execute on function public.control_calendar_connection(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.control_calendar_connection(uuid, uuid, text) to service_role;
