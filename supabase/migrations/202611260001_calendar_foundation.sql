create type public.calendar_provider as enum ('google', 'microsoft', 'apple', 'zoho');

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider public.calendar_provider not null,
  account_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'healthy', 'degraded', 'reauthorize', 'paused')),
  last_success_at timestamptz,
  unique (user_id, provider, account_id),
  unique (id, user_id, provider)
);

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  connection_id uuid not null,
  provider public.calendar_provider not null,
  calendar_id text not null,
  provider_event_id text not null,
  ical_uid text,
  title text,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  busy boolean not null default true,
  all_day boolean not null default false,
  private boolean not null default false,
  check (not private or title is null),
  foreign key (connection_id, user_id, provider)
    references public.calendar_connections (id, user_id, provider) on delete cascade,
  unique (connection_id, calendar_id, provider_event_id)
);

create index calendar_events_user_start_idx on public.calendar_events (user_id, starts_at, id);

alter table public.calendar_connections enable row level security;
alter table public.calendar_events enable row level security;

revoke all on public.calendar_connections, public.calendar_events from anon, authenticated;
grant select (id, provider, status, last_success_at) on public.calendar_connections to authenticated;
grant select (id, provider, ical_uid, title, starts_at, ends_at, busy, all_day, private)
  on public.calendar_events to authenticated;
grant select, insert, update, delete on public.calendar_connections, public.calendar_events to service_role;

create policy "Read own connections" on public.calendar_connections
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Read own events" on public.calendar_events
  for select to authenticated using ((select auth.uid()) = user_id);
