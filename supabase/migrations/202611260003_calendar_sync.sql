create function public.claim_calendar_sync(owner_id uuid, sources public.calendar_provider[])
returns table(id uuid, user_id uuid, provider public.calendar_provider, account_id text,
              sealed_refresh_token text, sync_lease_id uuid, sync_failures integer)
language sql set search_path = ''
as $$
  with due as (
    select c.id from public.calendar_connections c
    join public.calendar_credentials k on k.connection_id = c.id
    where c.user_id = owner_id and c.provider = any(sources)
      and c.status in ('pending', 'healthy', 'degraded')
      and c.next_sync_at <= now() and (c.sync_lease_until is null or c.sync_lease_until <= now())
    order by c.next_sync_at, c.id limit 1 for update of c skip locked
  ), claimed as (
    update public.calendar_connections c
    set sync_lease_id = gen_random_uuid(), sync_lease_until = now() + interval '5 minutes'
    from due where c.id = due.id returning c.*
  )
  select c.id, c.user_id, c.provider, c.account_id, k.sealed_refresh_token,
         c.sync_lease_id, c.sync_failures
    from claimed c join public.calendar_credentials k on k.connection_id = c.id;
$$;

create function public.rotate_calendar_token(connection uuid, lease uuid, sealed_token text)
returns boolean
language plpgsql set search_path = ''
as $$
begin
  perform 1 from public.calendar_connections
    where id = connection and sync_lease_id = lease and sync_lease_until > now() for update;
  if not found then return false; end if;
  update public.calendar_credentials set sealed_refresh_token = sealed_token where connection_id = connection;
  return found;
end;
$$;

create function public.finish_calendar_sync(
  connection uuid, lease uuid, outcome text, delay_seconds integer,
  window_start timestamptz default null, window_end timestamptz default null,
  imported jsonb default null
)
returns void
language plpgsql set search_path = ''
as $$
declare owner public.calendar_connections%rowtype;
begin
  select * into owner from public.calendar_connections
    where id = connection and sync_lease_id = lease and sync_lease_until > now() for update;
  if not found then return; end if;

  if outcome = 'healthy' then
    if window_start is null or window_end is null or window_start >= window_end
      or imported is null or jsonb_typeof(imported) <> 'array' then
      raise exception 'Invalid calendar snapshot';
    end if;

    -- Preserve row IDs for unchanged events and remove only missing events in the fetched window.
    insert into public.calendar_events (
      user_id, connection_id, provider, calendar_id, provider_event_id, ical_uid,
      title, starts_at, ends_at, busy, all_day, private
    )
    select owner.user_id, owner.id, owner.provider, e.calendar_id, e.provider_event_id, e.ical_uid,
      e.title, e.starts_at, e.ends_at, e.busy, e.all_day, e.private
    from jsonb_to_recordset(imported) as e(
      calendar_id text, provider_event_id text, ical_uid text, title text,
      starts_at timestamptz, ends_at timestamptz, busy boolean, all_day boolean, private boolean
    )
    on conflict (connection_id, calendar_id, provider_event_id) do update set
      ical_uid = excluded.ical_uid, title = excluded.title, starts_at = excluded.starts_at,
      ends_at = excluded.ends_at, busy = excluded.busy, all_day = excluded.all_day, private = excluded.private;

    delete from public.calendar_events e where e.connection_id = owner.id
      and e.ends_at > window_start and e.starts_at < window_end
      and not exists (
        select 1 from jsonb_to_recordset(imported) as i(calendar_id text, provider_event_id text)
        where i.calendar_id = e.calendar_id and i.provider_event_id = e.provider_event_id
      );
  end if;

  update public.calendar_connections set status = outcome,
    last_success_at = case when outcome = 'healthy' then now() else last_success_at end,
    next_sync_at = now() + make_interval(secs => delay_seconds),
    sync_failures = case when outcome = 'healthy' then 0 else sync_failures + 1 end,
    sync_lease_until = null, sync_lease_id = null
    where id = owner.id;
end;
$$;

revoke execute on function public.claim_calendar_sync(uuid, public.calendar_provider[]),
  public.rotate_calendar_token(uuid, uuid, text),
  public.finish_calendar_sync(uuid, uuid, text, integer, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_calendar_sync(uuid, public.calendar_provider[]),
  public.rotate_calendar_token(uuid, uuid, text),
  public.finish_calendar_sync(uuid, uuid, text, integer, timestamptz, timestamptz, jsonb)
  to service_role;
