import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const migration = readFileSync(
  root("supabase/supply-accumulation-scale-buys-migration.sql"),
  "utf8",
);
const schema = readFileSync(root("supabase/schema.sql"), "utf8");
const botConfig = readFileSync(root("src/lib/bot-config.ts"), "utf8");
const botSchemas = readFileSync(root("src/lib/bot.schemas.ts"), "utf8");
const botServer = readFileSync(root("src/lib/bot.server.ts"), "utf8");
const appTypes = readFileSync(root("src/lib/supabase-types.ts"), "utf8");
const workerDb = readFileSync(root("worker/src/db.ts"), "utf8");
const doctor = readFileSync(root("worker/src/doctor.ts"), "utf8");
const settings = readFileSync(
  root("src/components/dashboard/SupplyAccumulationSettingsCard.tsx"),
  "utf8",
);

test("Supply scale migration is additive and installs every new control OFF", () => {
  assert.doesNotMatch(migration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(migration, /\btruncate\b/i);
  assert.doesNotMatch(migration, /\bdrop\s+(table|column|schema)\b/i);
  assert.match(migration, /supply_accumulation_min_market_cap_usd numeric not null default 2000/i);
  for (const [tier, threshold] of [
    [2, 12],
    [3, 15],
    [4, 18],
  ] as const) {
    assert.match(
      migration,
      new RegExp(`supply_accumulation_scale_${tier}_enabled boolean not null default false`, "i"),
    );
    assert.match(
      migration,
      new RegExp(
        `supply_accumulation_scale_${tier}_threshold_pct numeric not null default ${threshold}`,
        "i",
      ),
    );
    assert.match(
      migration,
      new RegExp(`supply_accumulation_scale_${tier}_buy_usd numeric not null default 10`, "i"),
    );
  }
  assert.doesNotMatch(migration, /supply_accumulation_scale_[234]_enabled\s*=\s*true/i);
  assert.match(
    migration,
    /supply_accumulation_min_market_cap_usd < supply_accumulation_max_market_cap_usd/i,
  );
  assert.match(migration, /supply_accumulation_max_market_cap_usd <= 15000/i);
  assert.match(
    migration,
    /not supply_accumulation_scale_3_enabled or supply_accumulation_scale_2_enabled/i,
  );
  assert.match(
    migration,
    /not supply_accumulation_scale_4_enabled[\s\S]*supply_accumulation_scale_3_enabled/i,
  );
});

test("initial Supply state enforces the inclusive floor and strict ceiling", () => {
  assert.match(
    migration,
    /alter table public\.supply_accumulation_state[\s\S]*min_market_cap_usd numeric not null default 2000[\s\S]*above_market_cap_floor boolean not null default false[\s\S]*within_market_cap_range boolean not null default false/i,
  );
  assert.match(
    migration,
    /v_latest_market_cap_usd >= v_min_market_cap_usd/i,
    "$2,000 is inclusive",
  );
  assert.match(migration, /v_latest_market_cap_usd < v_max_market_cap_usd/i, "$15,000 is strict");
  assert.match(migration, /v_entry_ready :=[\s\S]*and v_within_market_cap_range/i);
  assert.match(
    migration,
    /create or replace function public\.materialize_supply_accumulation_market_cap_range\(\)[\s\S]*new\.entry_ready := new\.entry_ready and new\.within_market_cap_range/i,
    "the original state writer must also materialize the floor atomically",
  );
  assert.match(
    migration,
    /create trigger materialize_supply_accumulation_market_cap_range_trigger[\s\S]*before insert or update/i,
  );
  for (const key of [
    "minMarketCapUsd",
    "maxMarketCapUsd",
    "aboveMarketCapFloor",
    "withinMarketCapRange",
  ]) {
    assert.match(migration, new RegExp(`'${key}'`));
  }
  assert.match(
    doctor,
    /min_market_cap_usd[\s\S]*above_market_cap_floor[\s\S]*within_market_cap_range/i,
  );
});

test("scale claims have a complete exact-attempt lifecycle and one active mint owner", () => {
  assert.match(migration, /create table if not exists public\.supply_accumulation_scale_claims/i);
  assert.match(
    migration,
    /status in \(\s*'claimed', 'submitted', 'landed', 'persisted', 'failed_pre_submit', 'uncertain'/i,
  );
  for (const field of [
    "position_id uuid not null references public.positions(id)",
    "source_event_key text not null",
    "source_tx_sig text not null",
    "source_slot bigint not null",
    "amount_lamports bigint not null",
    "config_fingerprint text not null",
    "last_valid_block_height bigint",
    "received_amount_raw text",
    "submission_started_at timestamptz",
    "landed_at timestamptz",
    "persisted_at timestamptz",
    "applied_at timestamptz",
    "post_apply_repaired_at timestamptz",
  ]) {
    assert.match(migration, new RegExp(field.replace(/[().]/g, "\\$&"), "i"));
  }
  assert.match(
    migration,
    /supply_accumulation_scale_claims_lifecycle_check[\s\S]*status = 'submitted'[\s\S]*bot_tx_sig is not null[\s\S]*last_valid_block_height is not null[\s\S]*submission_started_at is not null/i,
  );
  assert.match(
    migration,
    /received_amount_raw ~ '\^\[1-9\]\[0-9\]\*\$'[\s\S]*char_length\(received_amount_raw\) <= 78/i,
  );
  assert.match(
    migration,
    /p_received_amount_raw text[\s\S]*v_received_raw := p_received_amount_raw::numeric/i,
  );
  assert.match(
    migration,
    /supply_accumulation_scale_claims_post_apply_repair_check[\s\S]*post_apply_repaired_at is null[\s\S]*status = 'persisted'[\s\S]*persisted_at is not null[\s\S]*applied_at is not null/i,
  );
  assert.match(
    migration,
    /supply_accumulation_scale_claims_post_apply_repair_idx[\s\S]*where status = 'persisted' and post_apply_repaired_at is null/i,
  );
  assert.match(
    migration,
    /create unique index if not exists supply_accumulation_scale_claims_active_mint_idx[\s\S]*\(user_id, token_mint\)[\s\S]*where status in \('claimed', 'submitted', 'landed', 'uncertain'\)/i,
  );
  assert.match(migration, /group by user_id, token_mint[\s\S]*having count\(\*\) > 1/i);
});

test("sell and scale owners share a database lock and sells permanently seal scaling", () => {
  assert.ok(
    (migration.match(/helix-position-action:/g) ?? []).length >= 4,
    "claim, apply, and both triggers must share the same lock namespace",
  );
  assert.match(
    migration,
    /guard_supply_scale_against_position_exit[\s\S]*from public\.sell_signal_claims s[\s\S]*s\.position_id = new\.position_id/i,
  );
  assert.match(
    migration,
    /guard_position_exit_against_supply_scale[\s\S]*c\.status in \('claimed', 'submitted', 'landed', 'uncertain'\)/i,
  );
  assert.match(
    migration,
    /before insert or update of status, position_id[\s\S]*on public\.sell_signal_claims/i,
  );
  assert.match(
    migration,
    /select 1 from public\.sell_signal_claims s[\s\S]*s\.position_id = p_position_id/i,
  );
  assert.match(
    migration,
    /select 1 from public\.trades t[\s\S]*t\.position_id = p_position_id and t\.side = 'sell'/i,
  );
  assert.match(
    migration,
    /from public\.supply_accumulation_events e[\s\S]*e\.side = 'sell'[\s\S]*e\.slot >= v_initial_source_slot[\s\S]*e\.target_wallet = any\(v_targets\)[\s\S]*from public\.position_target_wallets linked[\s\S]*linked\.position_id = p_position_id[\s\S]*'lifetime_target_sell_recorded'/i,
    "wallet removal and rolling-window expiry must never erase target distribution evidence",
  );
  const lifetimeTargetVeto =
    migration.match(
      /if exists \([\s\S]*?from public\.supply_accumulation_events e[\s\S]*?'lifetime_target_sell_recorded'\);/i,
    )?.[0] ?? "";
  assert.doesNotMatch(
    lifetimeTargetVeto,
    /not e\.quarantined|e\.classification_reliable|e\.is_pump_fun/i,
    "ambiguous or quarantined sell evidence must fail closed",
  );
  assert.match(
    migration,
    /initial_custody_journey_not_found[\s\S]*total_verified_custody_sell_tokens > 0[\s\S]*total_unresolved_outflow_tokens > 0[\s\S]*VERIFIED_CUSTODY_SELL[\s\S]*custody_pending_events pending[\s\S]*pending\.status <> 'applied'[\s\S]*lifetime_custody_distribution_recorded/i,
    "custody sells and unresolved downstream evidence must remain lifetime vetoes",
  );
});

test("service-only plan is fresh, exact, contiguous, and fail-closed", () => {
  assert.match(
    migration,
    /create or replace function public\.get_supply_accumulation_scale_plan\(/i,
  );
  assert.match(migration, /extensions\.digest\([\s\S]*'sha256'/i);
  assert.match(migration, /service_role is required for Supply Accumulation scale planning/i);
  assert.match(migration, /v_event\.event_at < now\(\) - interval '55 seconds'/i);
  assert.match(migration, /v_state\.as_of < now\(\) - interval '55 seconds'/i);
  assert.match(
    migration,
    /pg_advisory_xact_lock\(hashtext\(p_user_id::text\), hashtext\(v_mint\)\)[\s\S]*select \* into v_config[\s\S]*lifetime_target_sell_recorded/i,
    "the event-writer lock must precede every durable sell/state read",
  );
  assert.match(migration, /select count\(\*\)[\s\S]*p\.closed_at is null[\s\S]*<> 1/i);
  assert.match(migration, /amount_remaining is distinct from v_position\.amount_tokens/i);
  assert.match(migration, /v_claim\.status <> 'submitted'/i);
  assert.match(
    migration,
    /repaired\.status = 'persisted'[\s\S]*repaired\.post_apply_repaired_at is null[\s\S]*post_apply_repair_pending/i,
  );
  assert.match(
    migration,
    /c\.tier_number = 2 and c\.status = 'persisted'[\s\S]*c\.post_apply_repaired_at is not null/i,
    "later tiers require the prior scale's durable sell-repair checkpoint",
  );
  assert.match(migration, /v_event\.slot <= v_prior_source_slot/i);
  assert.match(migration, /v_net_supply_pct < v_threshold/i);
  assert.match(
    migration,
    /latest_market_cap_usd < v_config\.supply_accumulation_min_market_cap_usd[\s\S]*latest_market_cap_usd >= v_config\.supply_accumulation_max_market_cap_usd/i,
  );
  assert.doesNotMatch(
    migration,
    /v_existing_claim\.status = 'failed_pre_submit'[\s\S]{0,180}'claimId'/i,
  );
});

test("claim reclaim is identity-safe and atomic application preserves original entry identity", () => {
  assert.match(
    migration,
    /create or replace function public\.claim_supply_accumulation_scale_buy\(/i,
  );
  assert.match(
    migration,
    /status = 'claimed'[\s\S]*bot_tx_sig = null[\s\S]*last_valid_block_height = null[\s\S]*submission_started_at = null/i,
  );
  assert.match(
    migration,
    /where id = v_claim\.id[\s\S]*status = 'failed_pre_submit'[\s\S]*returning \* into v_claim/i,
  );
  assert.match(
    migration,
    /'scale_tier_already_claimed'[\s\S]*c\.position_id = p_position_id[\s\S]*c\.source_event_key = btrim\(p_source_event_key\)[\s\S]*c\.amount_lamports = p_amount_lamports[\s\S]*v_replay := true/i,
    "a lost claim response may replay only the exact durable request",
  );
  assert.match(
    migration,
    /create or replace function public\.apply_supply_accumulation_scale_buy\(/i,
  );
  assert.match(
    migration,
    /v_claim\.received_amount_raw is not null[\s\S]*v_claim\.received_amount_raw is distinct from p_received_amount_raw[\s\S]*'landed_receipt_mismatch'/i,
  );
  assert.match(
    migration,
    /insert into public\.trades[\s\S]*update public\.positions set[\s\S]*update public\.supply_accumulation_scale_claims set[\s\S]*status = 'persisted'/i,
  );
  assert.match(
    migration,
    /insert into public\.position_target_wallets \([\s\S]*'additional_buy'[\s\S]*on conflict \(position_id, wallet\) do update set[\s\S]*last_buy_at = greatest\([\s\S]*update public\.supply_accumulation_scale_claims set[\s\S]*status = 'persisted'/i,
    "contributor attribution must commit atomically before the scale claim becomes persisted",
  );
  assert.match(
    migration,
    /update public\.supply_accumulation_scale_claims set[\s\S]*status = 'persisted'[\s\S]*post_apply_repaired_at = null/i,
    "atomic apply must leave the durable sell-repair marker pending",
  );
  assert.match(migration, /'postApplyRepairedAt', v_claim\.post_apply_repaired_at/i);
  assert.match(doctor, /post_apply_repaired_at/i);
  assert.match(appTypes, /post_apply_repaired_at: string \| null/i);
  const positionUpdate =
    migration.match(/update public\.positions set([\s\S]*?)where id = v_position\.id/i)?.[1] ?? "";
  assert.match(positionUpdate, /amount_tokens = v_new_amount_tokens/i);
  assert.match(positionUpdate, /amount_remaining = v_new_amount_remaining/i);
  assert.match(positionUpdate, /entry_price_usd = v_new_entry_price/i);
  assert.match(
    positionUpdate,
    /bot_cost_basis_usd = v_new_cost_basis/i,
    "legacy zero/default basis must be rebuilt from the untouched position before scaling",
  );
  assert.doesNotMatch(
    positionUpdate,
    /entry_tx_sig|entry_slot|entry_mode|tp_taken|exit_triggered/i,
  );
});

test("scale table and RPCs are private-write and service-only", () => {
  assert.match(
    migration,
    /alter table public\.supply_accumulation_scale_claims enable row level security/i,
  );
  assert.match(
    migration,
    /grant select on table public\.supply_accumulation_scale_claims to authenticated/i,
  );
  assert.doesNotMatch(
    migration,
    /grant (?:insert|update|delete)[^;]*supply_accumulation_scale_claims to authenticated/i,
  );
  for (const fn of [
    "get_supply_accumulation_scale_plan",
    "claim_supply_accumulation_scale_buy",
    "apply_supply_accumulation_scale_buy",
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${fn}[\\s\\S]*?authenticated`, "i"),
    );
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${fn}[\\s\\S]*?to service_role`, "i"),
    );
  }
});

test("canonical schema embeds the scale migration byte-for-byte", () => {
  const begin = "-- SUPPLY_ACCUMULATION_SCALE_BUYS_CANONICAL_MIRROR_BEGIN";
  const end = "-- SUPPLY_ACCUMULATION_SCALE_BUYS_CANONICAL_MIRROR_END";
  const beginIndex = schema.indexOf(begin);
  const endIndex = schema.indexOf(end);
  assert.ok(beginIndex >= 0, "canonical mirror begin marker is missing");
  assert.ok(endIndex > beginIndex, "canonical mirror end marker is missing");
  assert.equal(schema.slice(beginIndex + begin.length, endIndex).trim(), migration.trim());
});

test("config, settings, database types, and Doctor expose the full scale contract", () => {
  const camelFields = [
    "supplyAccumulationMinMarketCapUsd",
    "supplyAccumulationScale2Enabled",
    "supplyAccumulationScale2ThresholdPct",
    "supplyAccumulationScale2BuyUsd",
    "supplyAccumulationScale3Enabled",
    "supplyAccumulationScale3ThresholdPct",
    "supplyAccumulationScale3BuyUsd",
    "supplyAccumulationScale4Enabled",
    "supplyAccumulationScale4ThresholdPct",
    "supplyAccumulationScale4BuyUsd",
  ];
  const snakeFields = [
    "supply_accumulation_min_market_cap_usd",
    "supply_accumulation_scale_2_enabled",
    "supply_accumulation_scale_2_threshold_pct",
    "supply_accumulation_scale_2_buy_usd",
    "supply_accumulation_scale_3_enabled",
    "supply_accumulation_scale_3_threshold_pct",
    "supply_accumulation_scale_3_buy_usd",
    "supply_accumulation_scale_4_enabled",
    "supply_accumulation_scale_4_threshold_pct",
    "supply_accumulation_scale_4_buy_usd",
  ];
  for (const field of camelFields) {
    assert.match(botConfig, new RegExp(`${field}:`));
    assert.match(botSchemas, new RegExp(`${field}:`));
  }
  for (const field of snakeFields) {
    assert.match(botServer, new RegExp(field));
    assert.match(appTypes, new RegExp(field));
    assert.match(workerDb, new RegExp(field));
    assert.match(doctor, new RegExp(field));
  }
  assert.match(settings, /supplyAccumulationModeEnabled \? "ON" : "OFF"/);
  assert.match(settings, /label="Market-cap range"/);
  assert.match(settings, /label="Second buy"/);
  assert.match(settings, /label="Third buy"/);
  assert.match(settings, /label="Fourth buy"/);
  assert.match(settings, /preserves its original entry[\s\S]*signature, slot, and exit behavior/i);
  assert.match(doctor, /get_supply_accumulation_scale_plan/);
  assert.match(doctor, /claim_supply_accumulation_scale_buy/);
  assert.match(doctor, /apply_supply_accumulation_scale_buy/);
});
