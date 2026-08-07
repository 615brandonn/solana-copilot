-- Exclusive coordinated-wallet strategy mode.
-- Safe to run more than once in the Supabase SQL editor.

alter table public.bot_config
  add column if not exists coordinated_mode_enabled boolean not null default false,
  add column if not exists coordinated_fixed_buy_usd numeric not null default 25,
  add column if not exists coordinated_target_wallet_count integer not null default 2,
  add column if not exists coordinated_window_seconds integer not null default 30,
  add column if not exists coordinated_mc_min_usd numeric not null default 0,
  add column if not exists coordinated_mc_max_usd numeric not null default 15000,
  add column if not exists coordinated_coin_age_min_minutes numeric not null default 0,
  add column if not exists coordinated_coin_age_max_minutes numeric not null default 60,
  add column if not exists coordinated_target_buy_min_usd numeric not null default 0,
  add column if not exists coordinated_target_buy_max_usd numeric not null default 1000000,
  add column if not exists coordinated_first_buy_only boolean not null default false,
  add column if not exists coordinated_once_per_token boolean not null default true,
  add column if not exists coordinated_follower_sell_count integer not null default 1,
  add column if not exists coordinated_follower_sell_pct numeric not null default 100,
  add column if not exists coordinated_inactivity_hours numeric not null default 6;

alter table public.positions
  add column if not exists entry_mode text not null default 'regular',
  add column if not exists coordinated_exit_triggered boolean not null default false,
  add column if not exists root_buy_count integer not null default 0,
  add column if not exists last_root_buy_at timestamptz,
  add column if not exists last_root_buy_wallet text;

alter table public.follower_wallets
  add column if not exists first_sell_at timestamptz,
  add column if not exists hop_depth integer not null default 1,
  add column if not exists parent_wallet text,
  add column if not exists last_seen_slot bigint,
  add column if not exists last_seen_signature text;

alter table public.bot_config drop constraint if exists bot_config_coordinated_target_count_check;
alter table public.bot_config add constraint bot_config_coordinated_target_count_check
  check (coordinated_target_wallet_count between 2 and 20);

alter table public.bot_config drop constraint if exists bot_config_coordinated_window_check;
alter table public.bot_config add constraint bot_config_coordinated_window_check
  check (coordinated_window_seconds between 1 and 21600);

alter table public.bot_config drop constraint if exists bot_config_coordinated_ranges_check;
alter table public.bot_config add constraint bot_config_coordinated_ranges_check check (
  coordinated_fixed_buy_usd > 0
  and coordinated_mc_min_usd >= 0
  and coordinated_mc_max_usd >= coordinated_mc_min_usd
  and coordinated_coin_age_min_minutes >= 0
  and coordinated_coin_age_max_minutes >= coordinated_coin_age_min_minutes
  and coordinated_target_buy_min_usd >= 0
  and coordinated_target_buy_max_usd >= coordinated_target_buy_min_usd
  and coordinated_follower_sell_count >= 1
  and coordinated_follower_sell_pct > 0
  and coordinated_follower_sell_pct <= 100
  and coordinated_inactivity_hours > 0
);

alter table public.positions drop constraint if exists positions_entry_mode_check;
alter table public.positions add constraint positions_entry_mode_check
  check (entry_mode in ('regular', 'coordinated'));
