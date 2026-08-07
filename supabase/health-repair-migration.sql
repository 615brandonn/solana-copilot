-- Helix funding/worker readiness repair.
-- Safe to run repeatedly in the Supabase SQL editor.

create table if not exists public.worker_heartbeat (
  user_id uuid primary key,
  target_wallet text,
  started_at timestamptz not null,
  updated_at timestamptz not null,
  geyser_connected boolean not null default false,
  last_geyser_message_at timestamptz,
  decoded_event_count bigint not null default 0,
  rpc_last_poll_at timestamptz,
  funding_key_ready boolean not null default false,
  funding_key_checked_at timestamptz,
  funding_wallet_pubkey text,
  last_error text
);

alter table public.worker_heartbeat
  add column if not exists funding_key_ready boolean not null default false;
alter table public.worker_heartbeat
  add column if not exists funding_key_checked_at timestamptz;
alter table public.worker_heartbeat
  add column if not exists funding_wallet_pubkey text;
alter table public.worker_heartbeat
  add column if not exists last_error text;

-- Older manual repairs referenced auth.users, which rejects the intentional
-- all-zero single-user UUID. The heartbeat is service-written, so no FK is
-- needed here.
alter table public.worker_heartbeat
  drop constraint if exists worker_heartbeat_user_id_fkey;

grant select on public.worker_heartbeat to authenticated;
grant all on public.worker_heartbeat to service_role;

alter table public.worker_heartbeat enable row level security;

drop policy if exists "read own worker heartbeat" on public.worker_heartbeat;
create policy "read own worker heartbeat" on public.worker_heartbeat
  for select to authenticated using (user_id = auth.uid());
