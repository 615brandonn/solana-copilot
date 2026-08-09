-- Additive, idempotent snapshot used by the read-only dashboard holdings panel.
alter table public.worker_heartbeat
  add column if not exists wallet_holdings jsonb not null default '[]'::jsonb,
  add column if not exists observed_follower_holdings jsonb not null default '[]'::jsonb;

comment on column public.worker_heartbeat.wallet_holdings is
  'Latest non-zero SPL and Token-2022 balances observed by the trusted VPS worker RPC.';

comment on column public.worker_heartbeat.observed_follower_holdings is
  'Latest on-chain balances for wallets that received held tokens from configured target wallets.';
