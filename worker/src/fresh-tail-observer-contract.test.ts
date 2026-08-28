import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ConfirmedSignatureInfo, ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  FreshTailObserver,
  freshTailDiscoveryExpired,
  freshTailRejectionFingerprint,
  freshTailTradeMarketCapUsd,
  freshTailTransactionLookupKeys,
  mapWithConcurrency,
} from "./fresh-tail-observer.js";

const indexSource = readFileSync(new URL("../src/fresh-tail-index.ts", import.meta.url), "utf8");
const observerSource = readFileSync(
  new URL("../src/fresh-tail-observer.ts", import.meta.url),
  "utf8",
);

test("fresh-tail process is observation-only and defaults to shadow mode", () => {
  for (const forbidden of ["./executor", "./funding", "./index.js", "positions", "funding_keys"]) {
    assert.doesNotMatch(indexSource, new RegExp(`from [\"']${forbidden.replace(".", "\\.")}`));
  }
  assert.match(indexSource, /FRESH_TAIL_SHADOW:[\s\S]*value !== "false" && value !== "0"/);
  assert.match(indexSource, /randomUUID\(\)/);
  assert.match(indexSource, /no trading path was invoked/);
  assert.match(indexSource, /log\.debug\([\s\S]*"fresh-tail cycle complete"/);
});

test("epoch activation is impossible while global Entries is enabled", () => {
  const ensureEpoch = observerSource.slice(
    observerSource.indexOf("private async ensureEpoch"),
    observerSource.indexOf("private async acquireLease"),
  );
  assert.match(ensureEpoch, /if \(config\.entriesEnabled\)/);
  assert.match(ensureEpoch, /activation_requires_entries_off/);
  assert.match(ensureEpoch, /this\.store\.activate\(roots, sampled\.head\)/);
  assert.ok(
    ensureEpoch.indexOf("activation_requires_entries_off") <
      ensureEpoch.indexOf("this.store.activate"),
  );
});

test("older durable request heads drain before discovery advances to the latest head", () => {
  const cycle = observerSource.slice(observerSource.indexOf("async cycle(config"));
  const headAttestation = cycle.indexOf("this.attestHead(sampled.head");
  const overflowRetirement = cycle.indexOf("this.retireResourceOverflow");
  const firstDrain = cycle.indexOf("this.drainRequests");
  const latestCoverage = cycle.indexOf("this.coverHead(sampled.head");
  const secondDrain = cycle.indexOf("this.drainRequests", firstDrain + 1);
  assert.ok(
    headAttestation >= 0 &&
      overflowRetirement > headAttestation &&
      firstDrain > overflowRetirement &&
      latestCoverage > firstDrain &&
      secondDrain > latestCoverage,
  );
  assert.match(observerSource, /\.sort\(requestSort\)/);
  assert.match(observerSource, /requestCannotRewind/);
});

test("dormant launch retirement runs only after current-head coverage and request drain", () => {
  const cycle = observerSource.slice(observerSource.indexOf("async cycle(config"));
  const latestCoverage = cycle.indexOf("this.coverHead(sampled.head");
  const secondDrain = cycle.indexOf("this.drainRequests", latestCoverage);
  const retirement = cycle.indexOf("this.retireInactiveMints", secondDrain);
  const heartbeat = cycle.indexOf("this.heartbeat", retirement);
  assert.ok(
    latestCoverage >= 0 &&
      secondDrain > latestCoverage &&
      retirement > secondDrain &&
      heartbeat > retirement,
  );
  assert.match(observerSource, /MAX_RETIREMENTS_PER_CYCLE = 25/);
  assert.match(observerSource, /fresh_position_still_armed/);
  assert.match(observerSource, /fresh_exit_still_unresolved/);
  assert.match(observerSource, /fresh_request_still_live/);
  assert.match(observerSource, /mint_not_dormant/);
});

test("market-cap evidence rejects stale prices and uses the exact reserve ratio", () => {
  const now = 1_000_000;
  const evidence = {
    quoteMint: "11111111111111111111111111111111",
    virtualSolReservesLamports: "2000000000",
    virtualTokenReservesRaw: "1000000",
  };
  assert.equal(
    freshTailTradeMarketCapUsd(evidence as never, "1000000", { usd: 100, observedAtMs: now }, now),
    200,
  );
  assert.equal(
    freshTailTradeMarketCapUsd(
      evidence as never,
      "1000000",
      { usd: 100, observedAtMs: now - 5_001 },
      now,
    ),
    null,
  );
});

test("expired first discoveries become stable tombstones before creation proof RPC", () => {
  const trigger = 1_000_000;
  assert.equal(freshTailDiscoveryExpired(trigger, trigger + 50_999), false);
  assert.equal(freshTailDiscoveryExpired(trigger, trigger + 51_000), true);
  assert.equal(freshTailDiscoveryExpired(trigger, trigger - 10_000), false);

  const identity = {
    mint: "So11111111111111111111111111111111111111112",
    signature: "root-buy-signature",
    slot: 123,
    code: "trigger_expired_before_enrollment",
  };
  assert.equal(freshTailRejectionFingerprint(identity), freshTailRejectionFingerprint(identity));
  assert.notEqual(
    freshTailRejectionFingerprint(identity),
    freshTailRejectionFingerprint({ ...identity, code: "created_before_epoch" }),
  );

  const enrollment = observerSource.slice(
    observerSource.indexOf("private async enrollDiscovery"),
    observerSource.indexOf("private async valuationFor"),
  );
  assert.ok(
    enrollment.indexOf("freshTailDiscoveryExpired") <
      enrollment.indexOf("attestFreshPumpFunCreate"),
  );
  assert.match(enrollment, /trigger_expired_before_enrollment/);
  const rejection = observerSource.slice(
    observerSource.indexOf("private async rejectDiscovery"),
    observerSource.indexOf("private async enrollDiscovery"),
  );
  assert.doesNotMatch(rejection, /headSlot|headBlockhash|detail/);
});

test("expired enrollment rejects durably without invoking creation-proof RPC", async () => {
  const nowMs = 1_000_000;
  const root = "11111111111111111111111111111111";
  const mint = "So11111111111111111111111111111111111111112";
  const rejections: Record<string, unknown>[] = [];
  const observer = new FreshTailObserver({
    rpc: new Proxy(
      {},
      {
        get() {
          throw new Error("creation-proof RPC must not run for an expired trigger");
        },
      },
    ) as never,
    store: {
      rejectMint: async (_epochId: string, _lease: unknown, input: Record<string, unknown>) => {
        rejections.push(input);
        return { ok: true, reason: "rejected" };
      },
    } as never,
    workerId: "expiry-test",
    nowMs: () => nowMs,
    getSolPriceUsd: async () => ({ usd: 100, observedAtMs: nowMs }),
  });
  Object.assign(observer as unknown as Record<string, unknown>, {
    epoch: {
      epochId: "00000000-0000-4000-8000-000000000001",
      activationSlot: 1,
      activationBlockhash: "activation",
    },
    lease: {
      epochId: "00000000-0000-4000-8000-000000000001",
      leaseToken: "00000000-0000-4000-8000-000000000002",
      leaseGeneration: 1,
      leaseExpiresAt: new Date(nowMs + 60_000).toISOString(),
    },
  });
  const enroll = (
    observer as unknown as {
      enrollDiscovery(...args: unknown[]): Promise<unknown>;
    }
  ).enrollDiscovery.bind(observer);
  const row = {
    signature: "expired-root-buy",
    slot: 10,
    blockTime: (nowMs - 51_000) / 1_000,
    confirmationStatus: "finalized",
    err: null,
    memo: null,
  } as ConfirmedSignatureInfo;
  const result = await enroll(
    { blockTime: row.blockTime } as ParsedTransactionWithMeta,
    row,
    root,
    { mint },
    {
      supplyEvents: [
        {
          side: "BUY",
          targetWallet: root,
          tokenMint: mint,
          blockTimeMs: nowMs - 51_000,
        },
      ],
      rootBuyEvidence: {},
    },
    { slot: 20, blockhash: "head", blockTimeMs: nowMs, sampledAtMs: nowMs },
    nowMs + 45_000,
  );
  assert.equal(result, null);
  assert.equal(rejections[0]?.rejectionCode, "trigger_expired_before_enrollment");
});

test("bounded root reads settle in-flight work before propagating the first failure", async () => {
  const failure = new Error("read failed");
  const started: number[] = [];
  let releaseFirst!: () => void;
  const firstFinished = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let returned = false;
  const mapped = mapWithConcurrency([1, 2, 3], 2, async (value) => {
    started.push(value);
    if (value === 1) await firstFinished;
    if (value === 2) throw failure;
    return value;
  }).finally(() => {
    returned = true;
  });

  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  assert.deepEqual(started, [1, 2], "failure must stop dispatching queued RPC work");
  assert.equal(returned, false, "helper returned while another RPC worker was still in flight");

  releaseFirst();
  await assert.rejects(mapped, (error: unknown) => error === failure);
  assert.equal(returned, true);
});

test("root decoding indexes contracts by transaction mint/account evidence", () => {
  const mint = "So11111111111111111111111111111111111111112";
  const curve = "ComputeBudget111111111111111111111111111111";
  const keys = freshTailTransactionLookupKeys({
    transaction: {
      message: { accountKeys: [{ pubkey: curve }] },
      signatures: ["signature"],
    },
    meta: {
      preTokenBalances: [{ mint }],
      postTokenBalances: [],
      loadedAddresses: { writable: [], readonly: [] },
    },
  } as never);
  assert.deepEqual(new Set(keys), new Set([mint, curve]));
  assert.equal(
    freshTailTransactionLookupKeys({
      transaction: { message: { accountKeys: ["not-a-key"] } },
      meta: { preTokenBalances: [], postTokenBalances: [] },
    } as never),
    null,
  );
  assert.match(observerSource, /contractsByCurve/);
  assert.match(observerSource, /lookupKeys === null[\s\S]*\.\.\.contracts\.values\(\)/);
});

test("historical tombstones and retired mints cannot pin a root cursor", () => {
  const enrollment = observerSource.slice(
    observerSource.indexOf("private async enrollDiscovery"),
    observerSource.indexOf("private async valuationFor"),
  );
  const attestation = enrollment.slice(enrollment.indexOf("const attestation"));
  assert.match(attestation, /attestation\.reason === "mint_tombstoned"/);
  assert.match(attestation, /attestation\.reason === "mint_retired"/);
  assert.ok(attestation.indexOf("return null") < attestation.indexOf("requireMutation"));
});
