import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  new URL("../../supabase/sell-claim-recovery-migration.sql", import.meta.url),
  "utf8",
);

function functionBody(name: string, nextMarker: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  const end = sql.indexOf(nextMarker, start + 1);
  assert.ok(start >= 0 && end > start, `${name} function body was not found`);
  return sql.slice(start, end);
}

test("migration records the immutable prepared signature, expiry, and exact raw sizing", () => {
  for (const column of [
    "recovery_version smallint",
    "token_decimals integer",
    "executed_sell_amount_raw text",
    "prepared_wallet_balance_raw text",
    "position_amount_before_raw text",
    "recent_blockhash text",
    "last_valid_block_height bigint",
    "receipt_pre_amount_raw text",
    "receipt_post_amount_raw text",
    "trade_id uuid",
    "persisted_at timestamptz",
  ]) {
    assert.match(sql, new RegExp(column.replaceAll(" ", "\\s+"), "i"));
  }
  assert.match(sql, /sell_signal_claims_recovery_v1_check[\s\S]*recovery_version = 1/i);
  assert.match(
    sql,
    /receipt_pre_amount_raw::numeric - receipt_post_amount_raw::numeric[\s\S]*executed_sell_amount_raw::numeric/i,
  );
  assert.match(
    sql,
    /create unique index if not exists sell_signal_claims_bot_signature_idx[\s\S]*where bot_tx_sig is not null/i,
  );
  assert.match(
    sql,
    /create unique index if not exists trades_sell_signature_idx[\s\S]*where side = 'sell'/i,
  );
});

test("prepare RPC takes the position-action lock and publishes one complete attempt", () => {
  const body = functionBody(
    "prepare_sell_claim_attempt_v1",
    "create or replace function public.apply_landed_sell_claim_v1",
  );
  assert.match(body, /auth\.role\(\)[\s\S]*service_role/i);
  assert.match(body, /pg_advisory_xact_lock[\s\S]*helix-position-action:/i);
  assert.match(body, /from public\.sell_signal_claims[\s\S]*for update/i);
  assert.match(body, /from public\.positions[\s\S]*for update/i);
  assert.match(body, /v_position_raw := v_position\.amount_remaining_raw::numeric/i);
  assert.match(
    body,
    /update public\.sell_signal_claims set[\s\S]*status = 'submitted'[\s\S]*recovery_version = 1[\s\S]*bot_tx_sig = v_signature[\s\S]*recent_blockhash = v_blockhash[\s\S]*executed_sell_amount_raw = p_executed_sell_amount_raw[\s\S]*position_amount_before_raw = p_position_amount_before_raw[\s\S]*submission_started_at = now\(\)/i,
  );
  assert.match(
    body,
    /status = 'claimed' and bot_tx_sig is null and recovery_version is null/i,
  );
});

test("apply RPC validates an exact debit and atomically writes trade, position, and claim", () => {
  const body = functionBody("apply_landed_sell_claim_v1", "revoke all on function");
  assert.match(body, /auth\.role\(\)[\s\S]*service_role/i);
  assert.match(body, /v_pre_raw - v_post_raw <> v_sold_raw/i);
  assert.match(body, /v_claim\.executed_sell_amount_raw is distinct from p_sold_amount_raw/i);
  assert.match(body, /v_current_raw::text is distinct from v_claim\.position_amount_before_raw/i);
  assert.match(body, /if v_claim\.status = 'landed'[\s\S]*already_applied/i);
  const replayAt = body.indexOf("if v_claim.status = 'landed'");
  const closedRejectionAt = body.indexOf("position_already_closed");
  assert.ok(
    replayAt >= 0 && closedRejectionAt > replayAt,
    "full exits must reach idempotent replay before the open-position gate",
  );
  assert.match(
    body.slice(replayAt, closedRejectionAt),
    /from public\.trades[\s\S]*t\.id = v_claim\.trade_id[\s\S]*t\.position_id = v_claim\.position_id[\s\S]*t\.side = 'sell'[\s\S]*t\.token_mint = v_position\.token_mint[\s\S]*t\.tx_sig = v_signature/i,
  );
  assert.match(
    body.slice(replayAt, closedRejectionAt),
    /v_existing_trade\.amount_tokens \* power\(10::numeric, p_token_decimals\) <> v_sold_raw[\s\S]*persisted_trade_mismatch/i,
  );
  const tradeAt = body.indexOf("insert into public.trades");
  const positionAt = body.indexOf("update public.positions set");
  const claimAt = body.indexOf("update public.sell_signal_claims set");
  assert.ok(tradeAt >= 0 && positionAt > tradeAt && claimAt > positionAt);
  assert.match(
    body,
    /status = 'landed'[\s\S]*receipt_pre_amount_raw = p_receipt_pre_amount_raw[\s\S]*receipt_post_amount_raw = p_receipt_post_amount_raw[\s\S]*trade_id = v_trade_id[\s\S]*persisted_at = now\(\)/i,
  );
  assert.doesNotMatch(body, /getParsedTokenAccountsByOwner|walletTokenHoldings/i);
});

test("both mutation RPCs are service-role only", () => {
  for (const name of ["prepare_sell_claim_attempt_v1", "apply_landed_sell_claim_v1"]) {
    assert.match(
      sql,
      new RegExp(
        `revoke all on function public\\.${name}\\([\\s\\S]*?from public, anon, authenticated;[\\s\\S]*?grant execute on function public\\.${name}\\([\\s\\S]*?to service_role;`,
        "i",
      ),
    );
  }
});
