import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCustodyObserverHealth,
  buildCustodyDashboardData,
  CUSTODY_HEARTBEAT_STALE_AFTER_MS,
  custodyEventCategory,
  custodyEventEvidence,
  custodyObserverEffectiveStatus,
  custodyReasonIndicatesPartialCoverage,
  identityName,
  identityType,
  walletIdentity,
  type CustodyJourneyEventRow,
  type CustodyJourneyRow,
  type CustodyWorkerHeartbeatRow,
  type CustodyWalletProfileRow,
} from "./custody.js";

const START = "2026-08-13T12:00:00.000Z";

test("unresolved custody outflows stay observations, never transfers or sells", () => {
  assert.equal(custodyEventCategory("UNRESOLVED_OUTFLOW"), "observation");
  assert.equal(custodyEventCategory("AMBIGUOUS_OUTFLOW"), "observation");
  assert.equal(custodyEventCategory("CUSTODY_TRANSFER"), "transfer");
  assert.equal(custodyEventCategory("VERIFIED_CUSTODY_SELL"), "sell");
});

function journey(id: string, mint: string, bought: number, current = bought): CustodyJourneyRow {
  return {
    id,
    user_id: "00000000-0000-0000-0000-000000000000",
    token_mint: mint,
    status: "active",
    started_at: START,
    last_activity_at: START,
    flat_at: null,
    flat_reason: null,
    total_verified_target_buy_tokens: bought,
    total_verified_custody_sell_tokens: 0,
    current_attributed_tokens: current,
    source_target_wallets: [`target-${id}`],
    first_event_key: `buy-${id}`,
    last_event_key: `buy-${id}`,
    created_at: START,
    updated_at: START,
  };
}

function event(
  id: string,
  journeyId: string,
  destination: string | null,
  amount: number,
  eventAt = START,
  eventType = "CUSTODY_TRANSFER",
  metadata: Record<string, unknown> = {},
): CustodyJourneyEventRow {
  return {
    id,
    journey_id: journeyId,
    user_id: "00000000-0000-0000-0000-000000000000",
    event_key: id,
    event_type: eventType,
    request_fingerprint: `fingerprint-${id}`,
    tx_sig: `tx-${id}`,
    slot: 1,
    event_at: eventAt,
    source_wallet: `source-${journeyId}`,
    destination_wallet: destination,
    requested_amount_tokens: amount,
    applied_amount_tokens: amount,
    recipients: [],
    result_reason: null,
    result_watched_wallets: [],
    result_released_wallets: [],
    journey_released: false,
    metadata,
    recorded_at: eventAt,
  };
}

function profile(patch: Partial<CustodyWalletProfileRow>): CustodyWalletProfileRow {
  return {
    user_id: "00000000-0000-0000-0000-000000000000",
    wallet: "wallet",
    inferred_type: "unknown",
    inferred_label: null,
    inference_confidence: 0,
    inference_source: "unknown",
    manual_type: null,
    manual_label: null,
    first_seen_at: START,
    last_seen_at: START,
    created_at: START,
    updated_at: START,
    ...patch,
  };
}

function heartbeat(patch: Partial<CustodyWorkerHeartbeatRow> = {}): CustodyWorkerHeartbeatRow {
  return {
    user_id: "00000000-0000-0000-0000-000000000000",
    started_at: "2026-08-13T11:00:00.000Z",
    updated_at: "2026-08-13T11:59:50.000Z",
    enabled: true,
    geyser_connected: true,
    last_geyser_message_at: "2026-08-13T11:59:49.000Z",
    decoded_event_count: 12,
    rpc_last_poll_at: "2026-08-13T11:59:48.000Z",
    rpc_last_success_at: "2026-08-13T11:59:48.000Z",
    rpc_backlog_wallet_count: 0,
    watched_wallet_count: 3,
    active_journey_count: 2,
    last_event_at: "2026-08-13T11:59:40.000Z",
    degraded: false,
    last_error: null,
    ...patch,
  };
}

test("observer status is derived from the worker heartbeat, not read-query success", () => {
  const now = new Date(START).getTime();
  const live = buildCustodyObserverHealth(heartbeat(), now);
  assert.equal(live.status, "live");
  assert.equal(live.freshness, "fresh");
  assert.equal(live.geyserConnected, true);

  assert.equal(buildCustodyObserverHealth(heartbeat({ enabled: false }), now).status, "off");
  assert.equal(
    buildCustodyObserverHealth(heartbeat({ rpc_backlog_wallet_count: 4 }), now).status,
    "degraded",
  );
  const recovering = buildCustodyObserverHealth(heartbeat(), now, { pending: 3 });
  assert.equal(recovering.status, "degraded");
  assert.equal(recovering.pendingEventCount, 3);
  assert.equal(recovering.hasObservationGap, false);

  const boundary = buildCustodyObserverHealth(heartbeat(), now, { expired: 2, terminal: 1 });
  assert.equal(boundary.status, "degraded");
  assert.equal(boundary.hasObservationGap, true);
  assert.equal(boundary.expiredEventCount + boundary.terminalEventCount, 3);
  assert.equal(buildCustodyObserverHealth(null, now).status, "not_started");

  const stale = buildCustodyObserverHealth(
    heartbeat({ updated_at: "2026-08-13T11:58:00.000Z" }),
    now,
  );
  assert.equal(stale.status, "stale");
});

test("cached live health becomes stale and raw worker errors never cross the DTO boundary", () => {
  const now = new Date(START).getTime();
  const sensitive = "https://user:secret@example.invalid private diagnostic";
  const health = buildCustodyObserverHealth(heartbeat({ last_error: sensitive }), now);
  assert.equal(health.status, "degraded");
  assert.equal(health.hasLastError, true);
  assert.doesNotMatch(JSON.stringify(health), /secret|private diagnostic/);

  const live = buildCustodyObserverHealth(heartbeat(), now);
  assert.equal(
    custodyObserverEffectiveStatus(live, now + CUSTODY_HEARTBEAT_STALE_AFTER_MS + 1),
    "stale",
  );
});

test("unknown and candidate wallet identities are never presented as confirmed entities", () => {
  const unknown = walletIdentity("unlabeled");
  assert.equal(unknown.confidence, "unknown");
  assert.equal(identityName(unknown), "Unlabeled wallet");
  assert.equal(identityType(unknown), "Entity unknown");

  const candidate = walletIdentity(
    "candidate",
    profile({
      wallet: "candidate",
      inferred_type: "exchange_candidate",
      inferred_label: "Example Exchange",
      inference_confidence: 0.55,
      inference_source: "behavioral_candidate",
    }),
  );
  assert.equal(candidate.confidence, "candidate");
  assert.equal(identityName(candidate), "Possible Example Exchange");
  assert.equal(identityType(candidate), "Possible CEX");

  const manual = walletIdentity(
    "manual",
    profile({ wallet: "manual", manual_label: "My vault", manual_type: "vault" }),
  );
  assert.equal(manual.confidence, "manual");
  assert.equal(identityName(manual), "My vault");
});

test("only explicit verified custody sells receive the verified-sale evidence label", () => {
  assert.equal(
    custodyEventEvidence(event("verified", "j1", null, 10, START, "VERIFIED_CUSTODY_SELL")),
    "confirmed",
  );
  assert.equal(
    custodyEventEvidence(event("ambiguous", "j1", null, 10, START, "CUSTODY_SELL")),
    "candidate",
  );
  assert.equal(
    custodyEventEvidence(event("transfer", "j1", "wallet", 10, START, "CUSTODY_TRANSFER")),
    "confirmed",
  );
});

test("durable custody conflicts and chronology gaps always make accounting coverage partial", () => {
  const partialReasons = [
    "payload_mismatch",
    "predates_attribution_state",
    "same_slot_order_unknown",
    "partial_stale_target_buy",
    "partial_same_slot_target_buy_order_unknown",
    "partial_predates_destination_state",
    "partial_same_slot_destination_order_unknown",
    "partial_observation_boundary",
    "terminal_chronology_conflict",
  ];

  for (const reason of partialReasons) {
    assert.equal(
      custodyReasonIndicatesPartialCoverage(reason),
      true,
      `${reason} must be treated as partial coverage`,
    );
    const dashboard = buildCustodyDashboardData({
      window: "all",
      journeys: [journey("j1", "mint-a", 100)],
      wallets: [],
      events: [],
      profiles: [],
      // Production chronology guards may live only in the durable recovery
      // inbox, so coverage consumes the all-time reason projection directly.
      coverageReasons: [{ journeyId: "j1", reason }],
      limit: 10,
      generatedAt: START,
    });
    assert.equal(dashboard.journeys[0]?.accountingCoverage, "partial", reason);
  }

  for (const completeReason of [null, "verified_custody_sell", "attributed_balance_transferred"]) {
    assert.equal(custodyReasonIndicatesPartialCoverage(completeReason), false);
  }

  const unresolved = buildCustodyDashboardData({
    window: "24h",
    journeys: [journey("j1", "mint-a", 100)],
    wallets: [],
    events: [],
    profiles: [],
    coverageReasons: [{ journeyId: "j1", reason: "pending_upstream" }],
    coverageReasonsComplete: true,
    limit: 10,
    generatedAt: START,
  });
  assert.equal(unresolved.journeys[0]?.accountingCoverage, "partial");

  const truncated = buildCustodyDashboardData({
    window: "all",
    journeys: [journey("j1", "mint-a", 100)],
    wallets: [],
    events: [],
    profiles: [],
    coverageReasons: [],
    coverageReasonsComplete: false,
    limit: 10,
    generatedAt: START,
  });
  assert.equal(truncated.journeys[0]?.accountingCoverage, "partial");
});

test("leaderboards rank destinations by journeys and transfers by cohort share, not cross-mint units", () => {
  const journeys = [journey("j1", "mint-a", 100), journey("j2", "mint-b", 1_000)];
  const events = [
    event("a-large-share", "j1", "shared", 50, "2026-08-13T12:00:01.000Z"),
    event("b-small-share", "j2", "shared", 200, "2026-08-13T12:00:02.000Z"),
    event("b-other-1", "j2", "other", 100, "2026-08-13T12:00:03.000Z"),
    event("b-other-2", "j2", "other", 100, "2026-08-13T12:00:04.000Z"),
    event("b-other-3", "j2", "other", 100, "2026-08-13T12:00:05.000Z"),
  ];
  const dashboard = buildCustodyDashboardData({
    window: "7d",
    journeys,
    wallets: [],
    events,
    profiles: [],
    limit: 10,
    generatedAt: START,
  });

  // Shared wins despite fewer events because it appears in more journeys.
  assert.equal(dashboard.destinationLeaderboard[0]?.identity.wallet, "shared");
  assert.equal(dashboard.destinationLeaderboard[0]?.journeyCount, 2);
  // 50 mint-a units outrank 200 mint-b units because they represent 50% vs 20%
  // of their own verified cohorts. Raw units are never compared cross-mint.
  assert.equal(dashboard.transferLeaderboard[0]?.eventKey, "a-large-share");
  assert.equal(dashboard.transferLeaderboard[0]?.shareOfJourneyBuyPct, 50);
  assert.equal(dashboard.transferLeaderboard[1]?.eventKey, "b-small-share");
  assert.equal(dashboard.transferLeaderboard[1]?.shareOfJourneyBuyPct, 20);
});

test("split-transfer recipient snapshots become separate edges without double-counting the scalar destination", () => {
  const split = event("split", "j1", "wallet-a", 60);
  split.applied_amount_tokens = 60;
  split.recipients = [
    {
      wallet: "wallet-a",
      amountTokens: 40,
      inferredType: "unknown",
      inferenceConfidence: 0,
    },
    {
      wallet: "wallet-b",
      amountTokens: 20,
      appliedAmountTokens: 20,
      inferredType: "program",
      inferredLabel: "Program-controlled account",
      inferenceConfidence: 0.9,
      inferenceSource: "onchain_account",
    },
  ];
  const dashboard = buildCustodyDashboardData({
    window: "24h",
    journeys: [journey("j1", "mint-a", 100)],
    wallets: [],
    events: [split],
    profiles: [],
    limit: 10,
    generatedAt: START,
  });

  assert.equal(dashboard.destinationLeaderboard.length, 2);
  assert.deepEqual(dashboard.destinationLeaderboard.map((row) => row.identity.wallet).sort(), [
    "wallet-a",
    "wallet-b",
  ]);
  assert.equal(dashboard.transferLeaderboard.length, 2);
  assert.equal(
    dashboard.transferLeaderboard.reduce((sum, row) => sum + row.amountTokens, 0),
    60,
  );
  assert.equal(
    dashboard.destinationLeaderboard.find((row) => row.identity.wallet === "wallet-b")?.identity
      .label,
    "Program-controlled account",
  );
});
