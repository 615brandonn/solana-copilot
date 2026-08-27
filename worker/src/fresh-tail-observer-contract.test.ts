import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  freshTailTradeMarketCapUsd,
  freshTailTransactionLookupKeys,
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
