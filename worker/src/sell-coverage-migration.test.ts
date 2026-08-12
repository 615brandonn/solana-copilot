import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationPath = fileURLToPath(
  new URL("../../supabase/sell-coverage-migration.sql", import.meta.url),
);
const sql = readFileSync(migrationPath, "utf8");
const schema = readFileSync(
  fileURLToPath(new URL("../../supabase/schema.sql", import.meta.url)),
  "utf8",
);

test("sell-coverage migration is additive, idempotent, and contains no data deletion", () => {
  let installStatements = sql;
  for (const functionName of [
    "record_follower_transfer_batch",
    "record_root_follower_transfer",
    "record_follower_sell_event",
  ]) {
    installStatements = installStatements.replace(
      new RegExp(`create or replace function public\\.${functionName}[\\s\\S]*?\\n\\$\\$;`, "i"),
      "",
    );
  }
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.doesNotMatch(sql, /\bdrop\b/i);
  // Runtime DML is intentionally encapsulated in the atomic RPC. Installing
  // the migration itself must not rewrite existing rows.
  assert.doesNotMatch(installStatements, /\b(update|insert\s+into)\s+public\./i);
  assert.doesNotMatch(sql, /\b(postgres(?:ql)?|https?):\/\//i);
  assert.doesNotMatch(sql, /\b(password|secret|private[_ ]?key)\b\s*=/i);

  for (const table of [
    "rpc_wallet_cursors",
    "position_target_wallets",
    "sell_signal_claims",
    "entry_signal_claims",
    "follower_accounting_events",
    "follower_outflow_observations",
    "target_outflow_observations",
    "follower_transfer_batches",
    "follower_balance_alerts",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`, "i"));
  }

  assert.match(sql, /add column if not exists direct_target_sell_exit_mode/i);
  assert.match(sql, /add column if not exists trigger_eligible/i);
  assert.match(sql, /add column if not exists first_fresh_sell_at timestamptz/i);
  assert.match(sql, /create index if not exists follower_wallets_active_wallet_idx/i);
  assert.match(sql, /create index if not exists follower_wallets_fresh_sellers_idx/i);
  assert.match(sql, /if not exists \(\s*select 1 from pg_policies/ims);
});

test("split follower transfers use one durable, locked, conservation-safe RPC", () => {
  assert.match(sql, /create or replace function public\.record_follower_transfer_batch/i);
  assert.match(sql, /unique \(position_id, tx_sig, source_wallet, token_mint\)/i);
  assert.match(sql, /from public\.follower_wallets[\s\S]*for update;/i);
  assert.match(sql, /from public\.positions[\s\S]*closed_at is null[\s\S]*for update;/i);
  assert.match(
    sql,
    /v_scale := least\(1, greatest\(0, v_parent\.current_amount\) \/ v_total_requested\)/i,
  );
  assert.match(
    sql,
    /initial_amount = greatest\(0, v_parent\.initial_amount - v_actionable_tracked_amount\)/i,
  );
  assert.match(sql, /unexplained_outflow_amount =[\s\S]*v_unresolved_amount/i);
  assert.match(
    sql,
    /trigger_eligible = follower_wallets\.trigger_eligible and excluded\.trigger_eligible/i,
  );
  assert.doesNotMatch(
    sql,
    /trigger_eligible = follower_wallets\.trigger_eligible or excluded\.trigger_eligible/i,
  );
  assert.match(sql, /tracked_wallets jsonb not null default '\[\]'::jsonb/i);
  assert.match(
    sql,
    /revoke all on function public\.record_follower_transfer_batch[\s\S]*from public, anon, authenticated/i,
  );
});

test("root transfers and follower sells use an atomic replay-safe accounting ledger", () => {
  assert.match(sql, /create table if not exists public\.follower_accounting_events/i);
  assert.match(
    sql,
    /unique \(position_id, event_kind, tx_sig, source_wallet, follower_wallet, token_mint\)/i,
  );
  assert.match(sql, /create or replace function public\.record_root_follower_transfer/i);
  assert.match(sql, /create or replace function public\.record_follower_sell_event/i);
  assert.match(
    sql,
    /trigger_eligible = existing_follower\.trigger_eligible and excluded\.trigger_eligible/i,
  );
  assert.doesNotMatch(
    sql,
    /trigger_eligible = existing_follower\.trigger_eligible or excluded\.trigger_eligible/i,
  );
  assert.match(sql, /'duplicate', true[\s\S]*'soldFraction'/i);
  assert.match(sql, /'freshForAction', v_existing\.fresh_for_action/i);
  assert.match(sql, /'payloadMismatch', v_mismatch/i);
  assert.match(
    sql,
    /revoke all on function public\.record_root_follower_transfer[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    sql,
    /revoke all on function public\.record_follower_sell_event[\s\S]*from public, anon, authenticated/i,
  );
});

test("sell-coverage defaults keep automatic exits off and match the worker contract", () => {
  assert.match(sql, /direct_target_sell_exit_mode text not null default 'off'/i);
  assert.match(sql, /terminal_outflow_exit_enabled boolean not null default false/i);
  assert.match(sql, /target_terminal_outflow_exit_enabled boolean not null default false/i);
  assert.match(sql, /direct_target_sell_exit_pct numeric not null default 100/i);
  assert.match(sql, /terminal_outflow_exit_pct numeric not null default 100/i);
  assert.match(sql, /target_terminal_outflow_exit_pct numeric not null default 100/i);
  assert.match(
    sql,
    /direct_target_sell_exit_mode in \('off', 'proportional', 'fixed_pct', 'full'\)/i,
  );
  assert.match(sql, /trigger_eligible boolean not null default true/i);
  assert.match(sql, /unexplained_outflow_amount numeric not null default 0/i);
  assert.match(sql, /released_at timestamptz/i);
  assert.match(sql, /start_slot bigint not null default 0/i);
  assert.match(sql, /last_processed_signature text/i);
  assert.match(sql, /last_processed_slot bigint/i);
  assert.match(sql, /last_block_time bigint/i);
  assert.match(sql, /unique \(position_id, source_tx_sig, source_wallet, trigger_kind\)/i);
  assert.match(
    sql,
    /create unique index if not exists sell_signal_claims_active_position_idx[\s\S]*where status in \('claimed', 'submitted', 'uncertain'\)/i,
  );
  for (const kind of [
    "direct_target_sell",
    "terminal_outflow",
    "target_terminal_outflow",
    "take_profit",
    "stop_loss",
    "target_inactivity",
    "distinct_follower",
    "proportional_follower",
  ]) {
    assert.match(sql, new RegExp(`'${kind}'`, "i"));
  }
  assert.match(sql, /requested_sell_amount numeric/i);
  assert.match(sql, /submission_started_at timestamptz/i);
  assert.match(sql, /landed_at timestamptz/i);
  assert.match(
    sql,
    /status in \('claimed', 'submitted', 'landed', 'failed_pre_submit', 'uncertain'\)/i,
  );
  assert.match(sql, /planned_position_id uuid not null unique/i);
  assert.match(sql, /unique \(user_id, source_tx_sig, source_wallet, token_mint\)/i);
  assert.match(
    sql,
    /status in \([\s\S]*'persisted'[\s\S]*'failed_pre_submit'[\s\S]*'uncertain'[\s\S]*\)/i,
  );
  assert.match(
    sql,
    /create unique index if not exists entry_signal_claims_active_mint_idx[\s\S]*where status in \('claimed', 'submitted', 'landed', 'uncertain'\)/i,
  );
  assert.match(sql, /rpc_backlog_wallet_count integer not null default 0/i);
  assert.match(sql, /monitoring_degraded boolean not null default false/i);
  assert.match(sql, /follower_balance_last_checked_at timestamptz/i);
  assert.match(sql, /follower_balance_candidate_count integer not null default 0/i);
  assert.match(sql, /follower_balance_mismatch_count integer not null default 0/i);
  assert.match(sql, /follower_balance_reconciliation_degraded boolean not null default true/i);
  assert.match(sql, /follower_balance_last_error text/i);
  assert.match(sql, /confirmed_at timestamptz/i);
  assert.match(
    sql,
    /create unique index if not exists follower_balance_alerts_open_key_idx[\s\S]*where resolved_at is null/i,
  );
});

test("canonical schema contains the exact sell-coverage migration", () => {
  const marker = "-- Sell coverage schema (kept in sync with sell-coverage-migration.sql).";
  const resumeMarker = "revoke all on function public.record_strategy_observations(jsonb)";
  const canonicalStart = schema.indexOf(marker);
  const canonicalEnd = schema.indexOf(resumeMarker, canonicalStart);

  assert.notEqual(canonicalStart, -1, "sell-coverage schema marker is missing");
  assert.notEqual(canonicalEnd, -1, "sell-coverage schema end marker is missing");

  const canonicalBlock = schema.slice(canonicalStart + marker.length, canonicalEnd).trim();
  const migrationBlock = sql.slice(sql.indexOf("alter table public.bot_config")).trim();
  assert.equal(canonicalBlock, migrationBlock);
});
