-- Run once in the Supabase SQL editor before enabling the token-age filter.
-- Safe to run again: every statement is idempotent.

alter table public.bot_config
  add column if not exists token_age_filter_enabled boolean not null default false;

alter table public.bot_config
  add column if not exists token_age_min_minutes numeric not null default 0;

alter table public.bot_config
  add column if not exists token_age_max_minutes numeric not null default 60;
