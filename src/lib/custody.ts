export type CustodyWindow = "24h" | "7d" | "30d" | "all";

export type CustodyJourneyRow = {
  id: string;
  user_id: string;
  token_mint: string;
  status: string;
  started_at: string;
  last_activity_at: string;
  flat_at: string | null;
  flat_reason: string | null;
  total_verified_target_buy_tokens: number | string;
  total_verified_custody_sell_tokens: number | string;
  total_unresolved_outflow_tokens?: number | string;
  current_attributed_tokens: number | string;
  source_target_wallets: unknown;
  first_event_key: string;
  last_event_key: string;
  created_at: string;
  updated_at: string;
};

export type CustodyJourneyWalletRow = {
  id: string;
  journey_id: string;
  user_id: string;
  token_mint: string;
  wallet: string;
  hop_depth: number | string;
  parent_wallet: string | null;
  source_target_wallets: unknown;
  watch_status: string;
  current_attributed_tokens: number | string;
  last_observed_balance_tokens?: number | string | null;
  attributed_share?: number | string | null;
  balance_evidence_reliable?: boolean;
  total_received_tokens: number | string;
  total_transferred_tokens: number | string;
  total_verified_sold_tokens: number | string;
  total_unresolved_outflow_tokens?: number | string;
  first_seen_at: string;
  last_activity_at: string;
  last_balance_observed_at?: string | null;
  released_at: string | null;
  release_reason: string | null;
  last_event_key: string;
  last_tx_sig: string | null;
  last_slot: number | string | null;
  created_at?: string;
  updated_at?: string;
};

export type CustodyJourneyEventRow = {
  id: string;
  journey_id: string;
  user_id: string;
  event_key: string;
  event_type: string;
  request_fingerprint: string;
  tx_sig: string;
  slot: number | string | null;
  event_at: string;
  source_wallet: string | null;
  destination_wallet: string | null;
  requested_amount_tokens: number | string;
  applied_amount_tokens: number | string;
  reconciled_amount_tokens?: number | string;
  source_pre_amount_tokens?: number | string | null;
  source_post_amount_tokens?: number | string | null;
  evidence_reliable?: boolean;
  recipients: unknown;
  result_reason: string | null;
  result_journey_status?: string;
  result_watched_wallets: unknown;
  result_released_wallets: unknown;
  journey_released: boolean;
  metadata: unknown;
  recorded_at: string;
};

export type CustodyWalletProfileRow = {
  user_id: string;
  wallet: string;
  inferred_type: string | null;
  inferred_label: string | null;
  inference_confidence: string | number | null;
  inference_source: string | null;
  manual_type: string | null;
  manual_label: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

export type CustodyWorkerHeartbeatRow = {
  user_id: string;
  started_at: string;
  updated_at: string;
  enabled: boolean;
  geyser_connected: boolean;
  last_geyser_message_at: string | null;
  decoded_event_count: number | string;
  rpc_last_poll_at: string | null;
  rpc_last_success_at: string | null;
  rpc_backlog_wallet_count: number | string;
  watched_wallet_count: number | string;
  active_journey_count: number | string;
  last_event_at: string | null;
  degraded: boolean;
  last_error: string | null;
};

export type CustodyPendingEventRow = {
  id: string;
  user_id: string;
  event_key: string;
  event_type: string;
  request_fingerprint: string;
  token_mint: string;
  tx_sig: string;
  slot: number | string | null;
  event_at: string;
  source_wallet: string;
  requested_amount_tokens: number | string;
  payload: unknown;
  status: string;
  queue_state?: "ready" | "dormant_scope" | "waiting_dependency" | "transient_retry" | "resolved";
  retry_count: number | string;
  next_retry_at: string;
  last_retry_at: string | null;
  last_error_code: string | null;
  last_error_sqlstate?: string | null;
  journey_id: string | null;
  event_id: string | null;
  result: unknown;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type CustodyPendingEventCounts = {
  pending: number;
  waiting: number;
  dormant: number;
  expired: number;
  terminal: number;
};

/**
 * Lightweight, all-time durability evidence used only to decide whether a
 * journey's accounting coverage can honestly be called complete.
 */
export type CustodyCoverageReasonRow = {
  journeyId: string;
  reason: string | null;
};

export type CustodyIdentityConfidence = "manual" | "confirmed" | "candidate" | "unknown";
export type CustodyEventCategory = "buy" | "transfer" | "sell" | "boundary" | "observation";
export type CustodyEvidence = "confirmed" | "candidate" | "unknown";
export type CustodyAccountingCoverage = "complete" | "partial" | "unknown";
export type CustodyObserverStatus = "off" | "live" | "degraded" | "stale" | "not_started";
export type CustodyObserverFreshness = "fresh" | "stale" | "missing";
export type CustodyJson =
  | null
  | string
  | number
  | boolean
  | CustodyJson[]
  | { [key: string]: CustodyJson };

export type CustodyWalletIdentity = {
  wallet: string;
  label: string | null;
  type: string | null;
  confidence: CustodyIdentityConfidence;
  source: string | null;
};

export type CustodyJourneyEventView = {
  id: string;
  journeyId: string;
  eventKey: string;
  eventType: string;
  category: CustodyEventCategory;
  evidence: CustodyEvidence;
  txSig: string | null;
  slot: number | null;
  eventAt: string;
  source: CustodyWalletIdentity | null;
  destination: CustodyWalletIdentity | null;
  requestedAmountTokens: number;
  appliedAmountTokens: number;
  resultReason: string | null;
  journeyReleased: boolean;
  metadata: { [key: string]: CustodyJson };
};

export type CustodyJourneyWalletView = {
  id: string;
  journeyId: string;
  identity: CustodyWalletIdentity;
  parentWallet: string | null;
  hopDepth: number;
  watchStatus: string;
  currentAttributedTokens: number;
  totalReceivedTokens: number;
  totalTransferredTokens: number;
  totalVerifiedSoldTokens: number;
  firstSeenAt: string;
  lastActivityAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
};

export type CustodyJourneySummary = {
  id: string;
  tokenMint: string;
  status: string;
  startedAt: string;
  lastActivityAt: string;
  flatAt: string | null;
  flatReason: string | null;
  sourceTargetWallets: string[];
  totalVerifiedTargetBuyTokens: number;
  totalVerifiedCustodySellTokens: number;
  currentAttributedTokens: number;
  walletCount: number;
  eventCount: number;
  transferCount: number;
  verifiedSellCount: number;
  accountingCoverage: CustodyAccountingCoverage;
  destinationPreview: CustodyWalletIdentity[];
};

export type CustodyDestinationLeaderboardRow = {
  rank: number;
  identity: CustodyWalletIdentity;
  journeyCount: number;
  transferCount: number;
  confirmedTransferCount: number;
  uniqueTokenCount: number;
  sourceTargetCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type CustodyTransferLeaderboardRow = {
  rank: number;
  journeyId: string;
  tokenMint: string;
  eventKey: string;
  eventAt: string;
  txSig: string | null;
  source: CustodyWalletIdentity | null;
  destination: CustodyWalletIdentity;
  amountTokens: number;
  shareOfJourneyBuyPct: number | null;
  evidence: CustodyEvidence;
};

export type CustodyReadCoverage = {
  complete: boolean;
  journeyRowsLoaded: number;
  journeyRowsAvailable: number;
  walletRowsLoaded: number;
  walletRowsAvailable: number;
  eventRowsLoaded: number;
  eventRowsAvailable: number;
  lastEventAt: string | null;
};

/**
 * Sanitized health projection. `last_error` is intentionally reduced to a
 * boolean at the server boundary so provider URLs, credentials, and request
 * details can never be rendered by the dashboard.
 */
export type CustodyObserverHealth = {
  status: CustodyObserverStatus;
  freshness: CustodyObserverFreshness;
  heartbeatPresent: boolean;
  enabled: boolean | null;
  startedAt: string | null;
  updatedAt: string | null;
  heartbeatAgeMs: number | null;
  geyserConnected: boolean;
  lastGeyserMessageAt: string | null;
  decodedEventCount: number;
  rpcLastPollAt: string | null;
  rpcLastSuccessAt: string | null;
  rpcBacklogWalletCount: number;
  watchedWalletCount: number;
  activeJourneyCount: number;
  lastEventAt: string | null;
  pendingEventCount: number;
  waitingDependencyCount: number;
  dormantEvidenceCount: number;
  expiredEventCount: number;
  terminalEventCount: number;
  hasObservationGap: boolean;
  degraded: boolean;
  hasLastError: boolean;
};

export type CustodyDashboardData = {
  window: CustodyWindow;
  generatedAt: string;
  observer: CustodyObserverHealth;
  summary: {
    journeyCount: number;
    activeJourneyCount: number;
    observedWalletCount: number;
    transferEventCount: number;
    verifiedSellEventCount: number;
  };
  journeys: CustodyJourneySummary[];
  destinationLeaderboard: CustodyDestinationLeaderboardRow[];
  transferLeaderboard: CustodyTransferLeaderboardRow[];
  coverage: CustodyReadCoverage;
};

export type CustodyJourneyDetailData = {
  generatedAt: string;
  journey: CustodyJourneySummary;
  wallets: CustodyJourneyWalletView[];
  events: CustodyJourneyEventView[];
  coverage: CustodyReadCoverage;
};

type DashboardBuildInput = {
  window: CustodyWindow;
  journeys: CustodyJourneyRow[];
  wallets: CustodyJourneyWalletRow[];
  events: CustodyJourneyEventRow[];
  profiles: CustodyWalletProfileRow[];
  heartbeat?: CustodyWorkerHeartbeatRow | null;
  pendingEvents?: Partial<CustodyPendingEventCounts>;
  coverageReasons?: CustodyCoverageReasonRow[];
  coverageReasonsComplete?: boolean;
  limit: number;
  available?: Partial<
    Pick<CustodyReadCoverage, "journeyRowsAvailable" | "walletRowsAvailable" | "eventRowsAvailable">
  >;
  generatedAt?: string;
};

// The observer writes every 20 seconds. Three missed writes is enough to stop
// presenting it as live without making normal scheduling jitter look broken.
export const CUSTODY_HEARTBEAT_STALE_AFTER_MS = 60_000;

function finiteNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function ageFromIso(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}

export function buildCustodyObserverHealth(
  row: CustodyWorkerHeartbeatRow | null | undefined,
  nowMs = Date.now(),
  pendingEvents: Partial<CustodyPendingEventCounts> = {},
): CustodyObserverHealth {
  const pendingEventCount = Math.max(0, Math.trunc(finiteNumber(pendingEvents.pending)));
  const waitingDependencyCount = Math.max(0, Math.trunc(finiteNumber(pendingEvents.waiting)));
  const dormantEvidenceCount = Math.max(0, Math.trunc(finiteNumber(pendingEvents.dormant)));
  const expiredEventCount = Math.max(0, Math.trunc(finiteNumber(pendingEvents.expired)));
  const terminalEventCount = Math.max(0, Math.trunc(finiteNumber(pendingEvents.terminal)));
  const hasObservationGap = expiredEventCount > 0 || terminalEventCount > 0;
  if (!row) {
    return {
      status: "not_started",
      freshness: "missing",
      heartbeatPresent: false,
      enabled: null,
      startedAt: null,
      updatedAt: null,
      heartbeatAgeMs: null,
      geyserConnected: false,
      lastGeyserMessageAt: null,
      decodedEventCount: 0,
      rpcLastPollAt: null,
      rpcLastSuccessAt: null,
      rpcBacklogWalletCount: 0,
      watchedWalletCount: 0,
      activeJourneyCount: 0,
      lastEventAt: null,
      pendingEventCount,
      waitingDependencyCount,
      dormantEvidenceCount,
      expiredEventCount,
      terminalEventCount,
      hasObservationGap,
      degraded: false,
      hasLastError: false,
    };
  }

  const startedAt = cleanText(row.started_at);
  const updatedAt = cleanText(row.updated_at);
  const heartbeatAgeMs = ageFromIso(updatedAt, nowMs);
  const stale = heartbeatAgeMs === null || heartbeatAgeMs > CUSTODY_HEARTBEAT_STALE_AFTER_MS;
  const rpcBacklogWalletCount = Math.max(0, Math.trunc(finiteNumber(row.rpc_backlog_wallet_count)));
  const hasLastError = Boolean(cleanText(row.last_error));
  const degraded =
    row.degraded === true ||
    rpcBacklogWalletCount > 0 ||
    pendingEventCount > 0 ||
    hasObservationGap ||
    hasLastError;
  const status: CustodyObserverStatus = stale
    ? "stale"
    : row.enabled !== true
      ? "off"
      : degraded
        ? "degraded"
        : "live";
  return {
    status,
    freshness: stale ? "stale" : "fresh",
    heartbeatPresent: true,
    enabled: row.enabled === true,
    startedAt,
    updatedAt,
    heartbeatAgeMs,
    geyserConnected: row.geyser_connected === true,
    lastGeyserMessageAt: cleanText(row.last_geyser_message_at),
    decodedEventCount: Math.max(0, Math.trunc(finiteNumber(row.decoded_event_count))),
    rpcLastPollAt: cleanText(row.rpc_last_poll_at),
    rpcLastSuccessAt: cleanText(row.rpc_last_success_at),
    rpcBacklogWalletCount,
    watchedWalletCount: Math.max(0, Math.trunc(finiteNumber(row.watched_wallet_count))),
    activeJourneyCount: Math.max(0, Math.trunc(finiteNumber(row.active_journey_count))),
    lastEventAt: cleanText(row.last_event_at),
    pendingEventCount,
    waitingDependencyCount,
    dormantEvidenceCount,
    expiredEventCount,
    terminalEventCount,
    hasObservationGap,
    degraded,
    hasLastError,
  };
}

/** Re-evaluates cached snapshots so an old successful response cannot stay "Live". */
export function custodyObserverEffectiveStatus(
  health: CustodyObserverHealth,
  nowMs = Date.now(),
): CustodyObserverStatus {
  if (!health.heartbeatPresent) return "not_started";
  const age = ageFromIso(health.updatedAt, nowMs);
  return age === null || age > CUSTODY_HEARTBEAT_STALE_AFTER_MS ? "stale" : health.status;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function serializableJson(value: unknown): CustodyJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(serializableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        serializableJson(item),
      ]),
    );
  }
  return null;
}

function serializableObject(value: unknown): { [key: string]: CustodyJson } {
  const normalized = serializableJson(value);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized
    : {};
}

function normalized(value: unknown): string {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_")
    : "";
}

function normalizedWalletType(value: unknown): string | null {
  const raw = normalized(value);
  if (!raw || ["unknown", "unclassified", "wallet", "other"].includes(raw)) return null;
  const labels: Record<string, string> = {
    cex: "CEX",
    centralized_exchange: "CEX",
    exchange: "CEX",
    exchange_candidate: "Possible CEX",
    cold_wallet: "Cold storage",
    cold_storage: "Cold storage",
    cold_storage_candidate: "Possible cold storage",
    hot_wallet_candidate: "Possible hot wallet",
    dex: "DEX",
    dex_pool: "DEX pool",
    liquidity_pool: "Liquidity pool",
    target: "Target wallet",
    custody: "Custody wallet",
    routing_wallet: "Routing wallet",
    router: "Router",
    bridge: "Bridge",
    vault: "Vault",
    program: "Program / off-curve",
    program_or_off_curve: "Program / off-curve",
    personal_wallet: "Personal wallet",
    treasury: "Treasury",
    market_maker: "Market maker",
  };
  return (
    labels[raw] ?? raw.replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase())
  );
}

function inferredConfidence(value: unknown): CustodyIdentityConfidence {
  const raw = normalized(value);
  const numeric = nullableFiniteNumber(value);
  if (
    ["confirmed", "verified", "exact", "high"].includes(raw) ||
    (numeric !== null && numeric >= 0.9)
  ) {
    return "confirmed";
  }
  if (
    ["candidate", "probable", "possible", "inferred", "medium", "low"].includes(raw) ||
    (numeric !== null && numeric > 0)
  ) {
    return "candidate";
  }
  return "unknown";
}

export function walletIdentity(
  wallet: string,
  profile?: CustodyWalletProfileRow,
): CustodyWalletIdentity {
  const manualLabel = cleanText(profile?.manual_label);
  const manualType = normalizedWalletType(profile?.manual_type);
  if (manualLabel || manualType) {
    return {
      wallet,
      label: manualLabel,
      type: manualType,
      confidence: "manual",
      source: "manual",
    };
  }

  const inferredLabel = cleanText(profile?.inferred_label);
  const inferredType = normalizedWalletType(profile?.inferred_type);
  const confidence = inferredConfidence(profile?.inference_confidence);
  // An unclassified address never becomes a named entity merely because a
  // classifier emitted a source string or a low/empty confidence value.
  if ((!inferredLabel && !inferredType) || confidence === "unknown") {
    return { wallet, label: null, type: null, confidence: "unknown", source: null };
  }
  return {
    wallet,
    label: inferredLabel,
    type: inferredType,
    confidence,
    source: cleanText(profile?.inference_source),
  };
}

export function identityName(identity: CustodyWalletIdentity): string {
  if (!identity.label) return "Unlabeled wallet";
  return identity.confidence === "candidate" ? `Possible ${identity.label}` : identity.label;
}

export function identityType(identity: CustodyWalletIdentity): string {
  if (!identity.type) return "Entity unknown";
  return identity.confidence === "candidate" && !/^possible\b/i.test(identity.type)
    ? `Possible ${identity.type}`
    : identity.type;
}

export function custodyWindowSince(window: CustodyWindow, nowMs = Date.now()): string | null {
  const duration =
    window === "24h"
      ? 24 * 60 * 60_000
      : window === "7d"
        ? 7 * 24 * 60 * 60_000
        : window === "30d"
          ? 30 * 24 * 60 * 60_000
          : null;
  return duration === null ? null : new Date(nowMs - duration).toISOString();
}

export function custodyEventCategory(eventType: string): CustodyEventCategory {
  const type = normalized(eventType);
  if (type.includes("buy")) return "buy";
  if (type.includes("sell")) return "sell";
  // An unresolved outflow is explicitly the case where no conserving transfer
  // or verified sell could be attributed. Keep it visible as an observation
  // gap rather than inflating transfer leaderboards or implying a destination.
  if (type.includes("unresolved") || type.includes("ambiguous_outflow")) {
    return "observation";
  }
  if (type.includes("transfer")) return "transfer";
  if (type.includes("release") || type.includes("boundary") || type.includes("flat")) {
    return "boundary";
  }
  return "observation";
}

function positiveEvidence(metadata: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => metadata[key] === true);
}

export function custodyEventEvidence(row: CustodyJourneyEventRow): CustodyEvidence {
  const category = custodyEventCategory(row.event_type);
  const type = normalized(row.event_type);
  const metadata = record(row.metadata);
  const hasTransaction = Boolean(cleanText(row.tx_sig));
  const applied = finiteNumber(row.applied_amount_tokens);
  if (category === "sell") {
    if (row.evidence_reliable === false) return hasTransaction ? "candidate" : "unknown";
    return (row.evidence_reliable === true && type.includes("sell")) ||
      (type.includes("verified") && type.includes("sell")) ||
      (positiveEvidence(metadata, "verifiedSwap", "verified_swap") &&
        positiveEvidence(metadata, "sellAttributionVerified", "sell_attribution_verified"))
      ? "confirmed"
      : hasTransaction
        ? "candidate"
        : "unknown";
  }
  if (category === "buy") {
    if (row.evidence_reliable === false) return hasTransaction ? "candidate" : "unknown";
    return row.evidence_reliable === true ||
      type.includes("verified") ||
      positiveEvidence(metadata, "verifiedSwap", "verified_swap", "classificationReliable")
      ? "confirmed"
      : hasTransaction
        ? "candidate"
        : "unknown";
  }
  if (category === "transfer") {
    // A confirmed token movement is still only a transfer; this label never
    // implies that the recipient is an exchange or that a sale occurred.
    if (row.evidence_reliable === false) return hasTransaction ? "candidate" : "unknown";
    if (hasTransaction && applied > 0) return "confirmed";
    return hasTransaction ? "candidate" : "unknown";
  }
  return cleanText(row.result_reason) || row.journey_released ? "confirmed" : "unknown";
}

function profileMap(profiles: CustodyWalletProfileRow[]): Map<string, CustodyWalletProfileRow> {
  return new Map(profiles.map((profile) => [profile.wallet, profile]));
}

function eventView(
  row: CustodyJourneyEventRow,
  profiles: Map<string, CustodyWalletProfileRow>,
): CustodyJourneyEventView {
  const sourceWallet = cleanText(row.source_wallet);
  const destinationWallet = cleanText(row.destination_wallet);
  return {
    id: row.id,
    journeyId: row.journey_id,
    eventKey: row.event_key,
    eventType: row.event_type,
    category: custodyEventCategory(row.event_type),
    evidence: custodyEventEvidence(row),
    txSig: cleanText(row.tx_sig),
    slot: nullableFiniteNumber(row.slot),
    eventAt: row.event_at,
    source: sourceWallet ? walletIdentity(sourceWallet, profiles.get(sourceWallet)) : null,
    destination: destinationWallet
      ? walletIdentity(destinationWallet, profiles.get(destinationWallet))
      : null,
    requestedAmountTokens: Math.max(0, finiteNumber(row.requested_amount_tokens)),
    appliedAmountTokens: Math.max(0, finiteNumber(row.applied_amount_tokens)),
    resultReason: cleanText(row.result_reason),
    journeyReleased: row.journey_released === true,
    metadata: serializableObject(row.metadata),
  };
}

type CustodyTransferEdge = {
  wallet: string;
  amountTokens: number;
  identity: CustodyWalletIdentity;
};

function recipientWallet(value: Record<string, unknown>): string | null {
  return cleanText(
    value.wallet ?? value.destinationWallet ?? value.destination_wallet ?? value.address,
  );
}

function recipientExplicitApplied(value: Record<string, unknown>): number | null {
  for (const key of [
    "appliedAmountTokens",
    "applied_amount_tokens",
    "movedAmount",
    "moved_amount",
    "movedAmountTokens",
    "moved_amount_tokens",
    "appliedAmount",
    "applied_amount",
  ]) {
    const parsed = nullableFiniteNumber(value[key]);
    if (parsed !== null && parsed >= 0) return parsed;
  }
  return null;
}

function recipientRequested(value: Record<string, unknown>): number {
  for (const key of [
    "amountTokens",
    "amount_tokens",
    "requestedAmountTokens",
    "requested_amount_tokens",
  ]) {
    const parsed = nullableFiniteNumber(value[key]);
    if (parsed !== null && parsed >= 0) return parsed;
  }
  return 0;
}

function recipientSnapshotIdentity(
  wallet: string,
  value: Record<string, unknown>,
  profile: CustodyWalletProfileRow | undefined,
): CustodyWalletIdentity {
  if (profile) return walletIdentity(wallet, profile);
  const inferredProfile: CustodyWalletProfileRow = {
    user_id: "",
    wallet,
    inferred_type:
      cleanText(value.inferredType ?? value.inferred_type ?? value.destinationClass) ?? "unknown",
    inferred_label: cleanText(value.inferredLabel ?? value.inferred_label),
    inference_confidence:
      nullableFiniteNumber(value.inferenceConfidence ?? value.inference_confidence) ?? 0,
    inference_source: cleanText(value.inferenceSource ?? value.inference_source),
    manual_type: null,
    manual_label: null,
    first_seen_at: "",
    last_seen_at: "",
    created_at: "",
    updated_at: "",
  };
  return walletIdentity(wallet, inferredProfile);
}

/**
 * A transfer event is one atomic batch. The database may persist a null scalar
 * destination for split transfers, so every recipient snapshot is expanded
 * into one display/ranking edge. When only requested amounts were persisted,
 * the database-applied batch amount is allocated proportionally. The scalar
 * destination is used only when no usable recipient exists, preventing a
 * single-recipient event from being counted twice.
 */
export function custodyTransferEdges(
  row: CustodyJourneyEventRow,
  profiles: ReadonlyMap<string, CustodyWalletProfileRow>,
): CustodyTransferEdge[] {
  const recipients = Array.isArray(row.recipients)
    ? row.recipients.map(record).filter((recipient) => recipientWallet(recipient))
    : [];
  if (recipients.length > 0) {
    const byWallet = new Map<
      string,
      { value: Record<string, unknown>; explicit: number | null; requested: number }
    >();
    for (const recipient of recipients) {
      const wallet = recipientWallet(recipient)!;
      const explicit = recipientExplicitApplied(recipient);
      const requested = recipientRequested(recipient);
      const prior = byWallet.get(wallet);
      if (prior) {
        prior.explicit =
          prior.explicit !== null || explicit !== null
            ? Math.max(0, prior.explicit ?? 0) + Math.max(0, explicit ?? 0)
            : null;
        prior.requested += requested;
      } else {
        byWallet.set(wallet, { value: recipient, explicit, requested });
      }
    }
    const rows = Array.from(byWallet.entries());
    const batchApplied = Math.max(0, finiteNumber(row.applied_amount_tokens));
    const explicitTotal = rows.reduce((sum, [, item]) => sum + (item.explicit ?? 0), 0);
    const unresolvedApplied = Math.max(0, batchApplied - explicitTotal);
    const explicitScale =
      explicitTotal > batchApplied && explicitTotal > 0 ? batchApplied / explicitTotal : 1;
    const implicitRequestedTotal = rows.reduce(
      (sum, [, item]) => sum + (item.explicit === null ? item.requested : 0),
      0,
    );
    return rows.map(([wallet, item]) => ({
      wallet,
      amountTokens:
        (item.explicit !== null ? item.explicit * explicitScale : null) ??
        (implicitRequestedTotal > 0
          ? (item.requested / implicitRequestedTotal) * unresolvedApplied
          : 0),
      identity: recipientSnapshotIdentity(wallet, item.value, profiles.get(wallet)),
    }));
  }

  const destination = cleanText(row.destination_wallet);
  if (!destination) return [];
  return [
    {
      wallet: destination,
      amountTokens: Math.max(0, finiteNumber(row.applied_amount_tokens)),
      identity: walletIdentity(destination, profiles.get(destination)),
    },
  ];
}

function eventViews(
  row: CustodyJourneyEventRow,
  profiles: Map<string, CustodyWalletProfileRow>,
): CustodyJourneyEventView[] {
  if (custodyEventCategory(row.event_type) !== "transfer") return [eventView(row, profiles)];
  const edges = custodyTransferEdges(row, profiles);
  if (edges.length === 0) return [eventView(row, profiles)];
  const sourceWallet = cleanText(row.source_wallet);
  return edges.map((edge, index) => ({
    ...eventView(row, profiles),
    id: edges.length === 1 ? row.id : `${row.id}:recipient:${edge.wallet}:${index}`,
    eventKey: edges.length === 1 ? row.event_key : `${row.event_key}:recipient:${edge.wallet}`,
    source: sourceWallet ? walletIdentity(sourceWallet, profiles.get(sourceWallet)) : null,
    destination: edge.identity,
    requestedAmountTokens: edge.amountTokens,
    appliedAmountTokens: edge.amountTokens,
  }));
}

function walletView(
  row: CustodyJourneyWalletRow,
  profiles: Map<string, CustodyWalletProfileRow>,
): CustodyJourneyWalletView {
  return {
    id: row.id,
    journeyId: row.journey_id,
    identity: walletIdentity(row.wallet, profiles.get(row.wallet)),
    parentWallet: cleanText(row.parent_wallet),
    hopDepth: Math.max(0, Math.trunc(finiteNumber(row.hop_depth))),
    watchStatus: row.watch_status || "unknown",
    currentAttributedTokens: Math.max(0, finiteNumber(row.current_attributed_tokens)),
    totalReceivedTokens: Math.max(0, finiteNumber(row.total_received_tokens)),
    totalTransferredTokens: Math.max(0, finiteNumber(row.total_transferred_tokens)),
    totalVerifiedSoldTokens: Math.max(0, finiteNumber(row.total_verified_sold_tokens)),
    firstSeenAt: row.first_seen_at,
    lastActivityAt: row.last_activity_at,
    releasedAt: cleanText(row.released_at),
    releaseReason: cleanText(row.release_reason),
  };
}

/**
 * Durable persistence conflicts and observation boundaries make the custody
 * chain partial even when the numeric buy/sell/holding totals still balance.
 * Normalize separators so database reason families remain fail-closed as new
 * prefixed variants are added (for example, `partial_*` or `*_conflict`).
 */
export function custodyReasonIndicatesPartialCoverage(reason: unknown): boolean {
  const value = normalized(reason);
  if (!value) return false;
  return (
    /(?:^|_)(?:unknown|unclassified|mixed|ambiguous|partial|unwatchable|pending|terminal|dropped|overflow|conflict|mismatch|stale|predates|chronology|gap|expired|unsupported)(?:_|$)/.test(
      value,
    ) ||
    /(?:^|_)(?:wallet|hop)_limit(?:_|$)/.test(value) ||
    /(?:^|_)same_slot_order_unknown(?:_|$)/.test(value)
  );
}

function accountingCoverage(
  journey: CustodyJourneyRow,
  wallets: CustodyJourneyWalletRow[],
  events: CustodyJourneyEventRow[],
  durableReasons: readonly (string | null)[] = [],
  durableReasonsComplete = true,
): CustodyAccountingCoverage {
  const bought = Math.max(0, finiteNumber(journey.total_verified_target_buy_tokens));
  if (bought <= 0) return "unknown";
  if (
    !durableReasonsComplete ||
    durableReasons.some(custodyReasonIndicatesPartialCoverage) ||
    events.some((event) => custodyReasonIndicatesPartialCoverage(event.result_reason)) ||
    wallets.some((wallet) => custodyReasonIndicatesPartialCoverage(wallet.release_reason)) ||
    wallets.some((wallet) => finiteNumber(wallet.total_unresolved_outflow_tokens) > 0)
  ) {
    return "partial";
  }
  const accounted =
    Math.max(0, finiteNumber(journey.current_attributed_tokens)) +
    Math.max(0, finiteNumber(journey.total_verified_custody_sell_tokens));
  const tolerance = Math.max(1e-9, bought * 0.001);
  return Math.abs(bought - accounted) <= tolerance ? "complete" : "partial";
}

function journeySummary(
  journey: CustodyJourneyRow,
  wallets: CustodyJourneyWalletRow[],
  events: CustodyJourneyEventRow[],
  profiles: Map<string, CustodyWalletProfileRow>,
  durableReasons: readonly (string | null)[] = [],
  durableReasonsComplete = true,
): CustodyJourneySummary {
  const destinationPreview = Array.from(
    new Map(
      events
        .filter((event) => custodyEventCategory(event.event_type) === "transfer")
        .flatMap((event) => custodyTransferEdges(event, profiles))
        .map((edge) => [edge.wallet, edge.identity]),
    ).values(),
  ).slice(0, 4);
  return {
    id: journey.id,
    tokenMint: journey.token_mint,
    status: journey.status || "unknown",
    startedAt: journey.started_at,
    lastActivityAt: journey.last_activity_at,
    flatAt: cleanText(journey.flat_at),
    flatReason: cleanText(journey.flat_reason),
    sourceTargetWallets: stringArray(journey.source_target_wallets),
    totalVerifiedTargetBuyTokens: Math.max(
      0,
      finiteNumber(journey.total_verified_target_buy_tokens),
    ),
    totalVerifiedCustodySellTokens: Math.max(
      0,
      finiteNumber(journey.total_verified_custody_sell_tokens),
    ),
    currentAttributedTokens: Math.max(0, finiteNumber(journey.current_attributed_tokens)),
    walletCount: wallets.length,
    eventCount: events.length,
    transferCount: events.filter((event) => custodyEventCategory(event.event_type) === "transfer")
      .length,
    verifiedSellCount: events.filter(
      (event) =>
        custodyEventCategory(event.event_type) === "sell" &&
        custodyEventEvidence(event) === "confirmed",
    ).length,
    accountingCoverage: accountingCoverage(
      journey,
      wallets,
      events,
      durableReasons,
      durableReasonsComplete,
    ),
    destinationPreview,
  };
}

function validTime(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildCustodyDashboardData(input: DashboardBuildInput): CustodyDashboardData {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const generatedAtMs = new Date(generatedAt).getTime();
  const observer = buildCustodyObserverHealth(
    input.heartbeat,
    Number.isFinite(generatedAtMs) ? generatedAtMs : Date.now(),
    input.pendingEvents,
  );
  const profiles = profileMap(input.profiles);
  const walletsByJourney = new Map<string, CustodyJourneyWalletRow[]>();
  for (const wallet of input.wallets) {
    const rows = walletsByJourney.get(wallet.journey_id) ?? [];
    rows.push(wallet);
    walletsByJourney.set(wallet.journey_id, rows);
  }
  const eventsByJourney = new Map<string, CustodyJourneyEventRow[]>();
  for (const event of input.events) {
    const rows = eventsByJourney.get(event.journey_id) ?? [];
    rows.push(event);
    eventsByJourney.set(event.journey_id, rows);
  }
  const coverageReasonsByJourney = new Map<string, Array<string | null>>();
  for (const row of input.coverageReasons ?? []) {
    const rows = coverageReasonsByJourney.get(row.journeyId) ?? [];
    rows.push(row.reason);
    coverageReasonsByJourney.set(row.journeyId, rows);
  }

  const sortedJourneys = [...input.journeys].sort(
    (left, right) =>
      validTime(right.last_activity_at) - validTime(left.last_activity_at) ||
      left.id.localeCompare(right.id),
  );
  const journeyById = new Map(sortedJourneys.map((journey) => [journey.id, journey]));
  const allSummaries = sortedJourneys.map((journey) =>
    journeySummary(
      journey,
      walletsByJourney.get(journey.id) ?? [],
      eventsByJourney.get(journey.id) ?? [],
      profiles,
      coverageReasonsByJourney.get(journey.id) ?? [],
      input.coverageReasonsComplete ?? true,
    ),
  );

  type DestinationAccumulator = {
    wallet: string;
    identity: CustodyWalletIdentity;
    journeys: Set<string>;
    tokens: Set<string>;
    sourceTargets: Set<string>;
    transfers: number;
    confirmed: number;
    firstSeenAt: string;
    lastSeenAt: string;
  };
  const destinations = new Map<string, DestinationAccumulator>();
  const transferRows: Omit<CustodyTransferLeaderboardRow, "rank">[] = [];
  for (const event of input.events) {
    if (custodyEventCategory(event.event_type) !== "transfer") continue;
    const journey = journeyById.get(event.journey_id);
    if (!journey) continue;
    const edges = custodyTransferEdges(event, profiles);
    for (const edge of edges) {
      const destination = edge.wallet;
      const accumulator = destinations.get(destination) ?? {
        wallet: destination,
        identity: edge.identity,
        journeys: new Set<string>(),
        tokens: new Set<string>(),
        sourceTargets: new Set<string>(),
        transfers: 0,
        confirmed: 0,
        firstSeenAt: event.event_at,
        lastSeenAt: event.event_at,
      };
      accumulator.journeys.add(event.journey_id);
      const confidenceRank: Record<CustodyIdentityConfidence, number> = {
        unknown: 0,
        candidate: 1,
        confirmed: 2,
        manual: 3,
      };
      if (
        confidenceRank[edge.identity.confidence] > confidenceRank[accumulator.identity.confidence]
      ) {
        accumulator.identity = edge.identity;
      }
      accumulator.tokens.add(journey.token_mint);
      stringArray(journey.source_target_wallets).forEach((wallet) =>
        accumulator.sourceTargets.add(wallet),
      );
      accumulator.transfers += 1;
      if (custodyEventEvidence(event) === "confirmed") accumulator.confirmed += 1;
      if (validTime(event.event_at) < validTime(accumulator.firstSeenAt)) {
        accumulator.firstSeenAt = event.event_at;
      }
      if (validTime(event.event_at) > validTime(accumulator.lastSeenAt)) {
        accumulator.lastSeenAt = event.event_at;
      }
      destinations.set(destination, accumulator);

      const amount = edge.amountTokens;
      const bought = Math.max(0, finiteNumber(journey.total_verified_target_buy_tokens));
      transferRows.push({
        journeyId: event.journey_id,
        tokenMint: journey.token_mint,
        eventKey:
          edges.length === 1 ? event.event_key : `${event.event_key}:recipient:${destination}`,
        eventAt: event.event_at,
        txSig: cleanText(event.tx_sig),
        source: cleanText(event.source_wallet)
          ? walletIdentity(event.source_wallet!, profiles.get(event.source_wallet!))
          : null,
        destination: edge.identity,
        amountTokens: amount,
        // Percent of the verified journey cohort is dimensionless and therefore
        // safe to rank across different mints. Raw token amounts are never summed
        // or compared across tokens.
        shareOfJourneyBuyPct: bought > 0 ? (amount / bought) * 100 : null,
        evidence: custodyEventEvidence(event),
      });
    }
  }

  const destinationLeaderboard = Array.from(destinations.values())
    .sort(
      (left, right) =>
        right.journeys.size - left.journeys.size ||
        right.transfers - left.transfers ||
        validTime(right.lastSeenAt) - validTime(left.lastSeenAt) ||
        left.wallet.localeCompare(right.wallet),
    )
    .slice(0, input.limit)
    .map(
      (row, index): CustodyDestinationLeaderboardRow => ({
        rank: index + 1,
        identity: row.identity,
        journeyCount: row.journeys.size,
        transferCount: row.transfers,
        confirmedTransferCount: row.confirmed,
        uniqueTokenCount: row.tokens.size,
        sourceTargetCount: row.sourceTargets.size,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
      }),
    );

  const transferLeaderboard = transferRows
    .sort((left, right) => {
      const leftShare = left.shareOfJourneyBuyPct;
      const rightShare = right.shareOfJourneyBuyPct;
      if (leftShare !== null && rightShare === null) return -1;
      if (leftShare === null && rightShare !== null) return 1;
      if (leftShare !== null && rightShare !== null && leftShare !== rightShare) {
        return rightShare - leftShare;
      }
      return (
        validTime(right.eventAt) - validTime(left.eventAt) ||
        left.eventKey.localeCompare(right.eventKey)
      );
    })
    .slice(0, input.limit)
    .map((row, index) => ({ ...row, rank: index + 1 }));

  const journeyRowsAvailable = input.available?.journeyRowsAvailable ?? input.journeys.length;
  const walletRowsAvailable = input.available?.walletRowsAvailable ?? input.wallets.length;
  const eventRowsAvailable = input.available?.eventRowsAvailable ?? input.events.length;
  const lastEventAt = input.events.reduce<string | null>(
    (latest, event) =>
      !latest || validTime(event.event_at) > validTime(latest) ? event.event_at : latest,
    null,
  );
  const coverage: CustodyReadCoverage = {
    complete:
      input.journeys.length >= journeyRowsAvailable &&
      input.wallets.length >= walletRowsAvailable &&
      input.events.length >= eventRowsAvailable,
    journeyRowsLoaded: input.journeys.length,
    journeyRowsAvailable,
    walletRowsLoaded: input.wallets.length,
    walletRowsAvailable,
    eventRowsLoaded: input.events.length,
    eventRowsAvailable,
    lastEventAt,
  };

  const activeJourneyCount = allSummaries.filter(
    (journey) => !["flat", "closed", "complete", "released"].includes(normalized(journey.status)),
  ).length;
  const observedWallets = new Set(input.wallets.map((wallet) => wallet.wallet));
  return {
    window: input.window,
    generatedAt,
    observer,
    summary: {
      journeyCount: journeyRowsAvailable,
      activeJourneyCount,
      observedWalletCount: observedWallets.size,
      transferEventCount: input.events.filter(
        (event) => custodyEventCategory(event.event_type) === "transfer",
      ).length,
      verifiedSellEventCount: input.events.filter(
        (event) =>
          custodyEventCategory(event.event_type) === "sell" &&
          custodyEventEvidence(event) === "confirmed",
      ).length,
    },
    journeys: allSummaries.slice(0, input.limit),
    destinationLeaderboard,
    transferLeaderboard,
    coverage,
  };
}

export function buildCustodyJourneyDetail(input: {
  journey: CustodyJourneyRow;
  wallets: CustodyJourneyWalletRow[];
  events: CustodyJourneyEventRow[];
  profiles: CustodyWalletProfileRow[];
  availableWalletCount?: number;
  coverageReasons?: CustodyCoverageReasonRow[];
  coverageReasonsComplete?: boolean;
  availableEventCount?: number;
  generatedAt?: string;
}): CustodyJourneyDetailData {
  const profiles = profileMap(input.profiles);
  const wallets = input.wallets
    .map((wallet) => walletView(wallet, profiles))
    .sort(
      (left, right) =>
        left.hopDepth - right.hopDepth ||
        validTime(left.firstSeenAt) - validTime(right.firstSeenAt) ||
        left.identity.wallet.localeCompare(right.identity.wallet),
    );
  const events = input.events
    .flatMap((event) => eventViews(event, profiles))
    .sort(
      (left, right) =>
        validTime(left.eventAt) - validTime(right.eventAt) ||
        left.eventKey.localeCompare(right.eventKey),
    );
  const eventRowsAvailable = input.availableEventCount ?? input.events.length;
  const walletRowsAvailable = input.availableWalletCount ?? input.wallets.length;
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    journey: journeySummary(
      input.journey,
      input.wallets,
      input.events,
      profiles,
      (input.coverageReasons ?? [])
        .filter((row) => row.journeyId === input.journey.id)
        .map((row) => row.reason),
      input.coverageReasonsComplete ?? true,
    ),
    wallets,
    events,
    coverage: {
      complete:
        input.events.length >= eventRowsAvailable && input.wallets.length >= walletRowsAvailable,
      journeyRowsLoaded: 1,
      journeyRowsAvailable: 1,
      walletRowsLoaded: input.wallets.length,
      walletRowsAvailable,
      eventRowsLoaded: input.events.length,
      eventRowsAvailable,
      lastEventAt: input.events.reduce<string | null>(
        (latest, event) =>
          !latest || validTime(event.event_at) > validTime(latest) ? event.event_at : latest,
        null,
      ),
    },
  };
}
