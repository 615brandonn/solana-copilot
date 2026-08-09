-- Add independent exit controls for regular (non-coordinated) positions.
-- Defaults preserve the existing behavior until each control is explicitly enabled.
alter table public.bot_config
  add column if not exists follower_seller_exit_enabled boolean not null default false,
  add column if not exists follower_seller_exit_count integer not null default 1,
  add column if not exists follower_seller_exit_pct numeric not null default 100,
  add column if not exists target_inactivity_exit_enabled boolean not null default false,
  add column if not exists target_inactivity_hours numeric not null default 6;

alter table public.positions
  add column if not exists follower_seller_exit_triggered boolean not null default false;
