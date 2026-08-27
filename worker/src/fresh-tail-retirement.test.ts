import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectFreshTailRetirementCandidates } from "./fresh-tail-observer.js";
import type {
  FreshTailArmedBinding,
  FreshTailWorkMint,
  FreshTailWorkRequest,
} from "./fresh-tail-store.js";

const headMs = Date.parse("2026-08-27T20:00:00.000Z");

function mint(
  tokenMint: string,
  lastSupplyEventBlockTime: string,
  patch: Partial<FreshTailWorkMint> = {},
): FreshTailWorkMint {
  return {
    tokenMint,
    enrollmentEventKey: `event:${tokenMint}`,
    enrollmentTxSig: `sig:${tokenMint}`,
    enrollmentSlot: 100,
    enrollmentBlockhash: "blockhash",
    enrollmentBlockTime: "2026-08-27T19:00:00.000Z",
    lastSupplyEventBlockTime,
    enrollmentTargetWallet: "root",
    creationSlot: 90,
    bondingCurve: "curve",
    creator: "creator",
    createVariant: "classic_v1",
    tokenProgram: "token-program",
    mintLayoutFingerprint: "a".repeat(64),
    parserAbiFingerprint: "b".repeat(64),
    totalSupplyRaw: "1000000000000000",
    decimals: 6,
    status: "active",
    scopeRevision: 1,
    poisoned: false,
    poisonReason: null,
    ...patch,
  };
}

function request(
  tokenMint: string,
  expiresAt: string,
  status: FreshTailWorkRequest["status"] = "pending",
): FreshTailWorkRequest {
  return {
    requestId: `request:${tokenMint}`,
    tokenMint,
    status,
    triggerEventKey: `event:${tokenMint}`,
    triggerSlot: 100,
    triggerBlockTime: "2026-08-27T19:59:30.000Z",
    expiresAt,
    requestedHeadSlot: 101,
    requestedHeadBlockhash: "head",
    scopeRevision: 1,
    settledRevision: null,
    settledLeaseGeneration: null,
  };
}

function binding(tokenMint: string): FreshTailArmedBinding {
  return {
    entryClaimId: `claim:${tokenMint}`,
    positionId: `position:${tokenMint}`,
    tokenMint,
    sourceSlot: 100,
    epochId: "epoch",
    requestId: `request:${tokenMint}`,
    armedAt: "2026-08-27T19:59:31.000Z",
  };
}

test("retires only old unclaimed launches in deterministic bounded order", () => {
  const candidates = selectFreshTailRetirementCandidates(
    {
      mints: [
        mint("new", "2026-08-27T19:55:00.000Z"),
        mint("old-b", "2026-08-27T19:20:00.000Z", { scopeRevision: 4 }),
        mint("old-a", "2026-08-27T19:10:00.000Z", { scopeRevision: 3 }),
        mint("retired", "2026-08-27T18:00:00.000Z", { status: "retired" }),
      ],
      requests: [],
      armedBindings: [],
    },
    headMs,
    600,
    1,
  );
  assert.deepEqual(candidates, [
    { tokenMint: "old-a", scopeRevision: 3, reason: "dormant_below_threshold" },
  ]);
});

test("live requests and every armed binding keep the mint monitored", () => {
  const candidates = selectFreshTailRetirementCandidates(
    {
      mints: [
        mint("requested", "2026-08-27T19:00:00.000Z"),
        mint("armed", "2026-08-27T19:00:00.000Z"),
        mint("expired", "2026-08-27T19:00:00.000Z"),
      ],
      requests: [
        request("requested", "2026-08-27T20:00:30.000Z"),
        request("expired", "2026-08-27T19:59:59.000Z", "settled"),
      ],
      armedBindings: [binding("armed")],
    },
    headMs,
    600,
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.tokenMint),
    ["expired"],
  );
});

test("poisoned unclaimed launches retire, while malformed binding data fails closed", () => {
  const poisoned = mint("poisoned", "2026-08-27T19:59:59.000Z", {
    poisoned: true,
    poisonReason: "payload_conflict",
  });
  assert.deepEqual(
    selectFreshTailRetirementCandidates(
      { mints: [poisoned], requests: [], armedBindings: [] },
      headMs,
      600,
    ),
    [
      {
        tokenMint: "poisoned",
        scopeRevision: 1,
        reason: "unsupported_after_enrollment",
      },
    ],
  );
  assert.deepEqual(
    selectFreshTailRetirementCandidates(
      {
        mints: [poisoned],
        requests: [],
        armedBindings: [{ ...binding("poisoned"), tokenMint: "" }],
      },
      headMs,
      600,
    ),
    [],
  );
});

test("SQL repeats every retirement safety check under the mint lock", () => {
  const sql = readFileSync(
    new URL("../../supabase/supply-accumulation-fresh-tail-migration.sql", import.meta.url),
    "utf8",
  );
  const start = sql.indexOf("create or replace function public.retire_custody_fresh_tail_mint(");
  const end = sql.indexOf("create or replace function public.", start + 1);
  const retirement = sql.slice(start, end);
  assert.match(retirement, /pg_advisory_xact_lock/);
  assert.match(retirement, /fresh_request_still_live/);
  assert.match(retirement, /fresh_position_still_armed/);
  assert.match(retirement, /fresh_exit_still_unresolved/);
  assert.match(retirement, /supply_accumulation_window_seconds/);
  assert.match(retirement, /max\(e\.block_time\)/);
  assert.match(retirement, /mint_not_dormant/);
  assert.match(sql, /'lastSupplyEventBlockTime',[\s\S]*max\(e\.block_time\)/);
});
