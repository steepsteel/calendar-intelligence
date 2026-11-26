create table public.calendar_oauth_requests (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider public.calendar_provider not null,
  verifier text not null,
  expires_at timestamptz not null default now() + interval '10 minutes'
);

create table public.calendar_credentials (
  connection_id uuid primary key references public.calendar_connections(id) on delete cascade,
  sealed_refresh_token text not null
);

alter table public.calendar_oauth_requests enable row level security;
alter table public.calendar_credentials enable row level security;
revoke all on public.calendar_oauth_requests, public.calendar_credentials from public, anon, authenticated;
grant select, insert, delete on public.calendar_oauth_requests to service_role;
grant select, insert, update on public.calendar_credentials to service_role;

create function public.consume_calendar_oauth(request_hash text, requested_provider public.calendar_provider)
returns table(user_id uuid, verifier text)
language sql set search_path = ''
as $$
  delete from public.calendar_oauth_requests r
    where r.state_hash = request_hash and r.provider = requested_provider and r.expires_at > now()
    returning r.user_id, r.verifier;
$$;

alter table public.calendar_connections
  add column next_sync_at timestamptz not null default now(),
  add column sync_lease_until timestamptz,
  add column sync_lease_id uuid,
  add column sync_failures integer not null default 0;

create function public.save_calendar_connection(
  owner_id uuid, source public.calendar_provider, remote_account text, sealed_token text
)
returns void
language sql set search_path = ''
as $$
  with connection as (
    insert into public.calendar_connections (user_id, provider, account_id)
    values (owner_id, source, remote_account)
    on conflict (user_id, provider, account_id) do update
      set status = 'pending', next_sync_at = now(), sync_lease_until = null,
          sync_lease_id = null, sync_failures = 0
    returning id
  )
  insert into public.calendar_credentials (connection_id, sealed_refresh_token)
    select id, sealed_token from connection
    on conflict (connection_id) do update set sealed_refresh_token = excluded.sealed_refresh_token;
$$;

revoke execute on function public.consume_calendar_oauth(text, public.calendar_provider),
  public.save_calendar_connection(uuid, public.calendar_provider, text, text)
  from public, anon, authenticated;
grant execute on function public.consume_calendar_oauth(text, public.calendar_provider),
  public.save_calendar_connection(uuid, public.calendar_provider, text, text)
  to service_role;
