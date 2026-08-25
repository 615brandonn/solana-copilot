import { createHash } from "node:crypto";
import {
  DEFAULT_REVIVAL_TRACKER_CONFIG,
  REVIVAL_ENGINE_VERSION,
  type RevivalCampaignSnapshot,
  type RevivalCampaignState,
  type RevivalEvent,
  type RevivalReplayResult,
  type RevivalShadowAction,
  type RevivalTrackerConfig,
  type RevivalTransition,
} from "./revival-types.js";

const TERMINAL_STATES = new Set<RevivalCampaignState>(["CLOSED", "INVALIDATED"]);

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function normalizeRevivalConfig(
  config: Partial<RevivalTrackerConfig> = {},
): RevivalTrackerConfig {
  const min = finite(config.marketCapMinUsd) ?? DEFAULT_REVIVAL_TRACKER_CONFIG.marketCapMinUsd;
  const maxCandidate =
    finite(config.marketCapMaxUsd) ?? DEFAULT_REVIVAL_TRACKER_CONFIG.marketCapMaxUsd;
  return {
    enabled: config.enabled === true,
    marketCapMinUsd: min,
    marketCapMaxUsd: Math.max(min, maxCandidate),
    minTargetBuys: Math.max(
      2,
      Math.round(finite(config.minTargetBuys) ?? DEFAULT_REVIVAL_TRACKER_CONFIG.minTargetBuys),
    ),
    minNetCommitmentUsd: Math.max(
      0,
      finite(config.minNetCommitmentUsd) ?? DEFAULT_REVIVAL_TRACKER_CONFIG.minNetCommitmentUsd,
    ),
    confirmationWindowMs: Math.max(
      60_000,
      finite(config.confirmationWindowMs) ?? DEFAULT_REVIVAL_TRACKER_CONFIG.confirmationWindowMs,
    ),
    campaignTtlMs: Math.max(
      60_000,
      finite(config.campaignTtlMs) ?? DEFAULT_REVIVAL_TRACKER_CONFIG.campaignTtlMs,
    ),
    marketDataGraceMs: Math.max(
      1_000,
      finite(config.marketDataGraceMs) ?? DEFAULT_REVIVAL_TRACKER_CONFIG.marketDataGraceMs,
    ),
    ignitionRequiredSignals: Math.max(
      1,
      Math.min(
        5,
        Math.round(
          finite(config.ignitionRequiredSignals) ??
            DEFAULT_REVIVAL_TRACKER_CONFIG.ignitionRequiredSignals,
        ),
      ),
    ),
    ignitionConfirmationSnapshots: Math.max(
      1,
      Math.min(
        5,
        Math.round(
          finite(config.ignitionConfirmationSnapshots) ??
            DEFAULT_REVIVAL_TRACKER_CONFIG.ignitionConfirmationSnapshots,
        ),
      ),
    ),
  };
}

export function revivalConfigHash(config: RevivalTrackerConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        algorithmVersion: REVIVAL_ENGINE_VERSION,
        config: normalizeRevivalConfig(config),
      }),
    )
    .digest("hex");
}

/**
 * Durable identity namespace for every projection derived by this engine.
 *
 * A source transaction is immutable evidence and keeps its chain identity,
 * while campaigns and recommendations are strategy-versioned projections of
 * that evidence. This prevents a later engine/config version from colliding
 * with, or silently overwriting, the prior shadow experiment.
 */
export function revivalStrategyNamespace(config: RevivalTrackerConfig): string {
  return `${REVIVAL_ENGINE_VERSION}:${revivalConfigHash(config)}`;
}

export function revivalEventFingerprint(event: RevivalEvent): string {
  const market =
    event.eventType === "MARKET_SNAPSHOT"
      ? {
          provider: event.market?.provider ?? null,
          observedAtMs: event.market?.observedAtMs ?? null,
          pairAddress: event.market?.pairAddress ?? null,
          priceUsd: event.market?.priceUsd ?? null,
          marketCapUsd: event.market?.marketCapUsd ?? null,
          fdvUsd: event.market?.fdvUsd ?? null,
          liquidityUsd: event.market?.liquidityUsd ?? null,
          volumeM5Usd: event.market?.volumeM5Usd ?? null,
          volumeH1Usd: event.market?.volumeH1Usd ?? null,
          volumeH6Usd: event.market?.volumeH6Usd ?? null,
          volumeH24Usd: event.market?.volumeH24Usd ?? null,
          buysM5: event.market?.buysM5 ?? null,
          sellsM5: event.market?.sellsM5 ?? null,
          buysH1: event.market?.buysH1 ?? null,
          sellsH1: event.market?.sellsH1 ?? null,
          activeBoosts: event.market?.activeBoosts ?? null,
          reliable: event.market?.reliable ?? false,
        }
      : null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        eventKey: event.eventKey,
        eventType: event.eventType,
        tokenMint: event.tokenMint,
        // A clock key already identifies its minute. Excluding the exact
        // timestamp makes a restart in that minute an idempotent duplicate.
        eventAtMs: event.eventType === "CLOCK_TICK" ? null : event.eventAtMs,
        txSig: event.txSig ?? null,
        slot: event.slot ?? null,
        txIndex: event.txIndex ?? null,
        targetWallet: event.targetWallet ?? null,
        verified: event.verified,
        // USD valuations are fetched after the chain fact and may improve on
        // retry. They must never turn an identical transaction into a conflict.
        amountTokens: event.amountTokens ?? null,
        market,
      }),
    )
    .digest("hex");
}

function isTerminal(campaign: RevivalCampaignSnapshot): boolean {
  return TERMINAL_STATES.has(campaign.state) || campaign.closedAtMs !== undefined;
}

function stateTransition(
  campaign: RevivalCampaignSnapshot,
  state: RevivalCampaignState,
  event: RevivalEvent,
  reasons: string[],
  transitions: RevivalTransition[],
): boolean {
  if (campaign.state === state) return false;
  const fromState = campaign.state;
  const fromVersion = campaign.stateVersion;
  campaign.state = state;
  campaign.stateVersion += 1;
  transitions.push({
    transitionKey: `${campaign.campaignKey}:v${campaign.stateVersion}`,
    campaignKey: campaign.campaignKey,
    tokenMint: campaign.tokenMint,
    fromState,
    toState: state,
    fromVersion,
    toVersion: campaign.stateVersion,
    triggerEventKey: event.eventKey,
    occurredAtMs: event.eventAtMs,
    availableAtMs: event.availableAtMs,
    reasons,
    metrics: {
      targetBuyCount: campaign.targetBuyCount,
      targetSellCount: campaign.targetSellCount,
      targetNetCommitmentUsd: campaign.targetNetCommitmentUsd,
      latestMarketCapUsd: campaign.latestMarketCapUsd ?? null,
      ignitionScore: campaign.ignitionScore,
    },
  });
  return true;
}

function closeCampaign(
  campaign: RevivalCampaignSnapshot,
  event: RevivalEvent,
  reason: string,
  transitions: RevivalTransition[],
): void {
  stateTransition(campaign, "CLOSED", event, [reason], transitions);
  campaign.closedAtMs = event.availableAtMs;
  campaign.closeReason = reason;
}

function createCampaign(
  event: RevivalEvent,
  campaignNumber: number,
  transitions: RevivalTransition[],
): RevivalCampaignSnapshot {
  const config = normalizeRevivalConfig(event.seedConfig);
  const marketCap = event.market?.reliable === true ? finite(event.market.marketCapUsd) : undefined;
  let state: RevivalCampaignState = "SEEDED";
  let eligibilityStatus: RevivalCampaignSnapshot["eligibilityStatus"] = "eligible";
  let eligibilityReason = "seed_market_cap_in_range";
  let closedAtMs: number | undefined;
  let closeReason: string | undefined;
  let coverageStatus: RevivalCampaignSnapshot["coverageStatus"] = "COMPLETE";

  if (marketCap === undefined) {
    state = "COVERAGE_GAP";
    eligibilityStatus = "pending_market_data";
    eligibilityReason = "market_cap_unavailable";
    coverageStatus = "MISSING";
  } else if (marketCap < config.marketCapMinUsd) {
    state = "INVALIDATED";
    eligibilityStatus = "ineligible";
    eligibilityReason = "market_cap_below_min";
    closedAtMs = event.availableAtMs;
    closeReason = eligibilityReason;
  } else if (marketCap > config.marketCapMaxUsd) {
    state = "INVALIDATED";
    eligibilityStatus = "ineligible";
    eligibilityReason = "market_cap_above_max";
    closedAtMs = event.availableAtMs;
    closeReason = eligibilityReason;
  }

  const campaignKey = `${revivalStrategyNamespace(config)}:${event.tokenMint}:${event.eventKey}`;
  const wallet = event.targetWallet?.trim();
  const seedAmountUsd = finite(event.amountUsd);
  const buyUsd = event.verified ? (seedAmountUsd ?? 0) : 0;
  const seedTargetAttributionReliable =
    event.verified && seedAmountUsd !== undefined && seedAmountUsd > 0;
  if (eligibilityStatus === "eligible" && !seedTargetAttributionReliable) {
    coverageStatus = "PARTIAL";
  }
  const campaign: RevivalCampaignSnapshot = {
    campaignKey,
    campaignNumber,
    tokenMint: event.tokenMint,
    symbol: event.market?.symbol,
    state,
    stateVersion: 1,
    eligibilityStatus,
    eligibilityReason,
    seedEventKey: event.eventKey,
    seedTxSig: event.txSig,
    seedSlot: event.slot,
    seedTxIndex: event.txIndex,
    seededAtMs: event.eventAtMs,
    seedAvailableAtMs: event.availableAtMs,
    seedHistorical: event.historical,
    eligibilityDeadlineAtMs:
      eligibilityStatus === "pending_market_data"
        ? event.availableAtMs + config.marketDataGraceMs
        : undefined,
    lastEventKey: event.eventKey,
    lastEventAtMs: event.eventAtMs,
    lastAvailableAtMs: event.availableAtMs,
    closedAtMs,
    closeReason,
    seedMarketCapUsd: marketCap,
    latestMarketCapUsd: marketCap,
    seedPriceUsd: finite(event.market?.priceUsd),
    latestPriceUsd: finite(event.market?.priceUsd),
    peakPriceUsd: finite(event.market?.priceUsd),
    troughPriceUsd: finite(event.market?.priceUsd),
    seedVolumeH1Usd: finite(event.market?.volumeH1Usd),
    latestVolumeH1Usd: finite(event.market?.volumeH1Usd),
    seedBuysH1: finite(event.market?.buysH1),
    latestBuysH1: finite(event.market?.buysH1),
    seedActiveBoosts: finite(event.market?.activeBoosts),
    latestActiveBoosts: finite(event.market?.activeBoosts),
    lastMarketObservedAtMs: finite(event.market?.observedAtMs),
    targetGrossBuysUsd: buyUsd,
    targetGrossSellsUsd: 0,
    targetNetCommitmentUsd: buyUsd,
    targetBuyCount: event.verified ? 1 : 0,
    targetSellCount: 0,
    targetWallets: wallet ? [wallet] : [],
    uniqueTargetWalletCount: wallet ? 1 : 0,
    accumulationScore: 0,
    ignitionScore: 0,
    distributionScore: 0,
    ignitionStreak: 0,
    marketDataReliable: event.market?.reliable === true && marketCap !== undefined,
    targetAttributionReliable: seedTargetAttributionReliable,
    custodyEvidenceReliable: false,
    coverageStatus,
    config,
    engineVersion: REVIVAL_ENGINE_VERSION,
  };
  transitions.push({
    transitionKey: `${campaignKey}:v1`,
    campaignKey,
    tokenMint: event.tokenMint,
    fromState: null,
    toState: state,
    fromVersion: 0,
    toVersion: 1,
    triggerEventKey: event.eventKey,
    occurredAtMs: event.eventAtMs,
    availableAtMs: event.availableAtMs,
    reasons: [eligibilityReason],
    metrics: { seedMarketCapUsd: marketCap ?? null },
  });
  return campaign;
}

function degradeForSilentMarketGap(campaign: RevivalCampaignSnapshot, event: RevivalEvent): void {
  if (campaign.lastMarketObservedAtMs === undefined) return;
  const configuredIntervalMs = finite(event.metadata?.sampleIntervalMs) ?? 30_000;
  const gapToleranceMs = Math.max(90_000, configuredIntervalMs * 3);
  if (event.eventAtMs - campaign.lastMarketObservedAtMs <= gapToleranceMs) return;
  campaign.marketDataReliable = false;
  campaign.coverageStatus =
    campaign.eligibilityStatus === "pending_market_data" ? "MISSING" : "PARTIAL";
}

function updateLatestMarket(campaign: RevivalCampaignSnapshot, event: RevivalEvent): void {
  const market = event.market;
  if (!market) return;
  const observedAtMs = finite(market.observedAtMs);
  degradeForSilentMarketGap(campaign, event);
  if (observedAtMs !== undefined) {
    campaign.lastMarketObservedAtMs = Math.max(
      campaign.lastMarketObservedAtMs ?? observedAtMs,
      observedAtMs,
    );
  }
  campaign.symbol = market.symbol ?? campaign.symbol;
  if (!market.reliable) {
    campaign.marketDataReliable = false;
    campaign.coverageStatus =
      campaign.eligibilityStatus === "pending_market_data" ? "MISSING" : "PARTIAL";
    return;
  }
  const price = finite(market.priceUsd);
  const marketCap = finite(market.marketCapUsd);
  campaign.latestPriceUsd = price ?? campaign.latestPriceUsd;
  campaign.latestMarketCapUsd = marketCap ?? campaign.latestMarketCapUsd;
  campaign.latestVolumeH1Usd = finite(market.volumeH1Usd) ?? campaign.latestVolumeH1Usd;
  campaign.latestBuysH1 = finite(market.buysH1) ?? campaign.latestBuysH1;
  campaign.latestActiveBoosts = finite(market.activeBoosts) ?? campaign.latestActiveBoosts;
  campaign.marketDataReliable = true;
  // A missed interval permanently weakens path-dependent MFE/MAE and ignition
  // evidence. Only an initial MISSING seed quote can become COMPLETE later,
  // and that happens explicitly in the causal eligibility-resolution branch.
  if (campaign.eligibilityStatus === "eligible" && campaign.coverageStatus !== "PARTIAL") {
    campaign.coverageStatus = campaign.targetAttributionReliable ? "COMPLETE" : "PARTIAL";
  }
  if (price !== undefined) {
    campaign.peakPriceUsd = Math.max(campaign.peakPriceUsd ?? price, price);
    campaign.troughPriceUsd = Math.min(campaign.troughPriceUsd ?? price, price);
  }
}

function freshForShadowDecision(event: RevivalEvent): boolean {
  const lagMs = event.availableAtMs - event.eventAtMs;
  return !event.historical && lagMs >= 0 && lagMs <= 15_000;
}

function recordVerifiedBuy(campaign: RevivalCampaignSnapshot, event: RevivalEvent): void {
  const valuedAmountUsd = finite(event.amountUsd);
  const amountUsd = valuedAmountUsd ?? 0;
  if (valuedAmountUsd === undefined || valuedAmountUsd <= 0) {
    campaign.targetAttributionReliable = false;
    campaign.coverageStatus = "PARTIAL";
  }
  campaign.targetBuyCount += 1;
  campaign.targetGrossBuysUsd += amountUsd;
  campaign.targetNetCommitmentUsd += amountUsd;
  if (event.targetWallet && !campaign.targetWallets.includes(event.targetWallet)) {
    campaign.targetWallets.push(event.targetWallet);
    campaign.targetWallets.sort();
    campaign.uniqueTargetWalletCount = campaign.targetWallets.length;
  }
  campaign.accumulationScore = Math.min(
    100,
    (campaign.targetBuyCount / campaign.config.minTargetBuys) * 50 +
      (campaign.targetNetCommitmentUsd / Math.max(1, campaign.config.minNetCommitmentUsd)) * 50,
  );
}

function recordVerifiedSell(campaign: RevivalCampaignSnapshot, event: RevivalEvent): void {
  const valuedAmountUsd = finite(event.amountUsd);
  const amountUsd = valuedAmountUsd ?? 0;
  if (valuedAmountUsd === undefined || valuedAmountUsd <= 0) {
    campaign.targetAttributionReliable = false;
    campaign.coverageStatus = "PARTIAL";
  }
  campaign.targetSellCount += 1;
  campaign.targetGrossSellsUsd += amountUsd;
  campaign.targetNetCommitmentUsd = Math.max(0, campaign.targetNetCommitmentUsd - amountUsd);
  campaign.distributionScore = Math.min(
    100,
    Math.max(50, (campaign.targetGrossSellsUsd / Math.max(1, campaign.targetGrossBuysUsd)) * 100),
  );
}

function ignitionSignals(campaign: RevivalCampaignSnapshot): string[] {
  const signals: string[] = [];
  if (
    campaign.seedPriceUsd !== undefined &&
    campaign.latestPriceUsd !== undefined &&
    campaign.latestPriceUsd >= campaign.seedPriceUsd * 1.4
  ) {
    signals.push("price_up_40pct");
  }
  if (
    campaign.seedMarketCapUsd !== undefined &&
    campaign.latestMarketCapUsd !== undefined &&
    campaign.latestMarketCapUsd >= campaign.seedMarketCapUsd * 1.4
  ) {
    signals.push("market_cap_up_40pct");
  }
  if (
    campaign.latestVolumeH1Usd !== undefined &&
    campaign.latestVolumeH1Usd >= Math.max(500, (campaign.seedVolumeH1Usd ?? 0) * 3)
  ) {
    signals.push("volume_h1_accelerating");
  }
  if (
    campaign.latestBuysH1 !== undefined &&
    campaign.latestBuysH1 >= Math.max(10, (campaign.seedBuysH1 ?? 0) * 3)
  ) {
    signals.push("external_buy_rate_accelerating");
  }
  if ((campaign.latestActiveBoosts ?? 0) > (campaign.seedActiveBoosts ?? 0)) {
    signals.push("new_active_boost");
  }
  return signals;
}

function action(
  campaign: RevivalCampaignSnapshot,
  event: RevivalEvent,
  actionType: RevivalShadowAction["actionType"],
  reason: string,
  metadata: Record<string, unknown> = {},
): RevivalShadowAction {
  return {
    actionKey: `${campaign.campaignKey}:${actionType}:${campaign.stateVersion}`,
    campaignKey: campaign.campaignKey,
    tokenMint: campaign.tokenMint,
    actionType,
    state: campaign.state,
    stateVersion: campaign.stateVersion,
    decisionAtMs: event.availableAtMs,
    availableAtMs: event.availableAtMs,
    sourceEventKey: event.eventKey,
    reason,
    executable: false,
    metadata: {
      latestPriceUsd: campaign.latestPriceUsd ?? null,
      latestMarketCapUsd: campaign.latestMarketCapUsd ?? null,
      ...metadata,
    },
  };
}

function hasStarterPaperExposure(
  campaign: RevivalCampaignSnapshot,
  actions: readonly RevivalShadowAction[],
): boolean {
  return actions.some(
    (candidate) =>
      candidate.campaignKey === campaign.campaignKey && candidate.actionType === "STARTER_ELIGIBLE",
  );
}

function applyEvent(
  campaign: RevivalCampaignSnapshot,
  event: RevivalEvent,
  transitions: RevivalTransition[],
  actions: RevivalShadowAction[],
): void {
  // Confirmed RPC callbacks from different target wallets can arrive out of
  // causal order. A chain fact that predates this campaign remains durable
  // evidence, but it must never inflate the current campaign's commitment or
  // manufacture a distribution/entry decision.
  const targetEventOrderUncertain =
    (event.slot !== undefined &&
      campaign.seedSlot !== undefined &&
      event.slot === campaign.seedSlot &&
      (event.txIndex === undefined || campaign.seedTxIndex === undefined)) ||
    ((event.slot === undefined || campaign.seedSlot === undefined) &&
      event.eventAtMs === campaign.seededAtMs);
  const eventPredatesSeed =
    event.slot !== undefined && campaign.seedSlot !== undefined
      ? event.slot < campaign.seedSlot ||
        (event.slot === campaign.seedSlot &&
          event.txIndex !== undefined &&
          campaign.seedTxIndex !== undefined &&
          event.txIndex < campaign.seedTxIndex)
      : event.eventAtMs < campaign.seededAtMs;
  if (
    (event.eventType === "TARGET_BUY" || event.eventType === "TARGET_SELL") &&
    targetEventOrderUncertain
  ) {
    campaign.targetAttributionReliable = false;
    campaign.coverageStatus =
      campaign.eligibilityStatus === "pending_market_data" ? "MISSING" : "PARTIAL";
    return;
  }
  if (
    (event.eventType === "TARGET_BUY" || event.eventType === "TARGET_SELL") &&
    eventPredatesSeed
  ) {
    return;
  }
  campaign.lastEventKey = event.eventKey;
  campaign.lastEventAtMs = event.eventAtMs;
  campaign.lastAvailableAtMs = event.availableAtMs;

  // Degrade path-dependent evidence before any terminal return. Otherwise a
  // restart after a long outage could close and score a sparse path as COMPLETE.
  degradeForSilentMarketGap(campaign, event);

  if (
    campaign.eligibilityStatus === "pending_market_data" &&
    campaign.eligibilityDeadlineAtMs !== undefined &&
    event.availableAtMs > campaign.eligibilityDeadlineAtMs
  ) {
    campaign.eligibilityStatus = "ineligible";
    campaign.eligibilityReason = "market_data_timeout";
    campaign.coverageStatus = "MISSING";
    stateTransition(campaign, "INVALIDATED", event, ["market_data_timeout"], transitions);
    campaign.closedAtMs = event.availableAtMs;
    campaign.closeReason = "market_data_timeout";
    return;
  }

  // Expiry is evaluated before any new evidence can create a paper action.
  // CLOCK_TICK uses wall time, while recovered chain events retain their real
  // block time, so catch-up delivery cannot compress hours into seconds.
  if (
    campaign.eligibilityStatus === "eligible" &&
    event.eventAtMs - campaign.seededAtMs > campaign.config.campaignTtlMs
  ) {
    closeCampaign(campaign, event, "campaign_ttl_expired", transitions);
    return;
  }

  updateLatestMarket(campaign, event);

  if ((event.eventType === "TARGET_BUY" || event.eventType === "TARGET_SELL") && !event.verified) {
    campaign.targetAttributionReliable = false;
    campaign.coverageStatus =
      campaign.eligibilityStatus === "pending_market_data" ? "MISSING" : "PARTIAL";
    return;
  }

  let eligibilityResolvedNow = false;
  if (campaign.eligibilityStatus === "pending_market_data" && event.market?.reliable === true) {
    const marketCap = finite(event.market.marketCapUsd);
    // Admission uses only a quote observed within the campaign's bounded
    // availability window. Comparing to seedAvailableAtMs avoids pretending
    // that a recovered historical transaction had a contemporaneous quote.
    const seedMarketLagMs = event.market.observedAtMs - campaign.seedAvailableAtMs;
    const seedMarketIsCausal =
      !campaign.seedHistorical &&
      seedMarketLagMs >= 0 &&
      seedMarketLagMs <= campaign.config.marketDataGraceMs;
    if (marketCap !== undefined && seedMarketIsCausal) {
      campaign.seedMarketCapUsd = marketCap;
      campaign.latestMarketCapUsd = marketCap;
      campaign.seedPriceUsd = finite(event.market.priceUsd);
      campaign.seedVolumeH1Usd = finite(event.market.volumeH1Usd);
      campaign.seedBuysH1 = finite(event.market.buysH1);
      campaign.seedActiveBoosts = finite(event.market.activeBoosts);
      campaign.marketDataReliable = true;
      if (marketCap < campaign.config.marketCapMinUsd) {
        campaign.eligibilityStatus = "ineligible";
        campaign.eligibilityReason = "market_cap_below_min";
        stateTransition(campaign, "INVALIDATED", event, [campaign.eligibilityReason], transitions);
        campaign.closedAtMs = event.availableAtMs;
        campaign.closeReason = campaign.eligibilityReason;
      } else if (marketCap > campaign.config.marketCapMaxUsd) {
        campaign.eligibilityStatus = "ineligible";
        campaign.eligibilityReason = "market_cap_above_max";
        stateTransition(campaign, "INVALIDATED", event, [campaign.eligibilityReason], transitions);
        campaign.closedAtMs = event.availableAtMs;
        campaign.closeReason = campaign.eligibilityReason;
      } else {
        campaign.eligibilityStatus = "eligible";
        campaign.eligibilityReason = "seed_market_cap_resolved_in_range";
        campaign.coverageStatus = campaign.targetAttributionReliable ? "COMPLETE" : "PARTIAL";
        stateTransition(campaign, "SEEDED", event, [campaign.eligibilityReason], transitions);
        eligibilityResolvedNow = true;
      }
    } else if (marketCap !== undefined) {
      campaign.eligibilityReason = "seed_market_cap_not_causal";
      campaign.coverageStatus = "MISSING";
    }
  }

  if (isTerminal(campaign)) return;
  if (campaign.eligibilityStatus !== "eligible") {
    // Preserve verified target facts observed during a transient market-data
    // gap. They remain non-actionable until a causal seed snapshot resolves.
    if (event.eventType === "TARGET_BUY" && event.verified) recordVerifiedBuy(campaign, event);
    if (event.eventType === "TARGET_SELL" && event.verified) recordVerifiedSell(campaign, event);
    return;
  }

  if (eligibilityResolvedNow) {
    // Distribution always wins over entry. Buys and sells observed while the
    // provider was unavailable are durable facts; a later successful quote
    // must never manufacture a starter after a verified target sale.
    if (campaign.targetSellCount > 0) {
      campaign.distributionRiskAtMs = event.availableAtMs;
      stateTransition(
        campaign,
        "DISTRIBUTION_RISK",
        event,
        ["verified_target_sell_preceded_market_resolution"],
        transitions,
      );
      if (hasStarterPaperExposure(campaign, actions) && freshForShadowDecision(event)) {
        actions.push(
          action(campaign, event, "EXIT", "verified target sale preceded market resolution"),
        );
      }
      return;
    }
    const withinConfirmationWindow =
      event.eventAtMs >= campaign.seededAtMs &&
      event.eventAtMs - campaign.seededAtMs <= campaign.config.confirmationWindowMs;
    if (
      campaign.targetAttributionReliable &&
      campaign.targetBuyCount >= campaign.config.minTargetBuys &&
      withinConfirmationWindow
    ) {
      stateTransition(
        campaign,
        "ACCUMULATING",
        event,
        ["verified_buys_recovered_after_market_resolution"],
        transitions,
      );
    }
    if (
      campaign.state === "ACCUMULATING" &&
      campaign.targetAttributionReliable &&
      campaign.targetNetCommitmentUsd >= campaign.config.minNetCommitmentUsd
    ) {
      campaign.entryReadyAtMs = event.availableAtMs;
      const becameEntryReady = stateTransition(
        campaign,
        "ENTRY_READY",
        event,
        ["target_net_commitment_threshold_met"],
        transitions,
      );
      if (becameEntryReady && freshForShadowDecision(event)) {
        actions.push(
          action(campaign, event, "STARTER_ELIGIBLE", "shadow starter became eligible", {
            targetBuyCount: campaign.targetBuyCount,
            targetNetCommitmentUsd: campaign.targetNetCommitmentUsd,
          }),
        );
      }
    }
  }

  if (event.eventType === "TARGET_BUY" && event.verified) {
    recordVerifiedBuy(campaign, event);
    const withinConfirmationWindow =
      event.eventAtMs >= campaign.seededAtMs &&
      event.eventAtMs - campaign.seededAtMs <= campaign.config.confirmationWindowMs;
    if (
      campaign.state === "SEEDED" &&
      campaign.targetAttributionReliable &&
      campaign.targetBuyCount >= campaign.config.minTargetBuys &&
      withinConfirmationWindow
    ) {
      stateTransition(
        campaign,
        "ACCUMULATING",
        event,
        ["multiple_verified_target_buys"],
        transitions,
      );
    }
    if (
      campaign.state === "ACCUMULATING" &&
      campaign.targetAttributionReliable &&
      campaign.targetNetCommitmentUsd >= campaign.config.minNetCommitmentUsd &&
      withinConfirmationWindow
    ) {
      campaign.entryReadyAtMs = event.availableAtMs;
      const becameEntryReady = stateTransition(
        campaign,
        "ENTRY_READY",
        event,
        ["target_net_commitment_threshold_met"],
        transitions,
      );
      if (becameEntryReady && freshForShadowDecision(event)) {
        actions.push(
          action(campaign, event, "STARTER_ELIGIBLE", "shadow starter became eligible", {
            targetBuyCount: campaign.targetBuyCount,
            targetNetCommitmentUsd: campaign.targetNetCommitmentUsd,
          }),
        );
      }
    }
  }

  if (event.eventType === "TARGET_SELL" && event.verified) {
    recordVerifiedSell(campaign, event);
    campaign.distributionRiskAtMs = event.availableAtMs;
    stateTransition(campaign, "DISTRIBUTION_RISK", event, ["verified_target_sell"], transitions);
    if (hasStarterPaperExposure(campaign, actions) && freshForShadowDecision(event)) {
      actions.push(action(campaign, event, "EXIT", "verified target sale observed"));
    }
  }

  if (
    event.eventType === "MARKET_SNAPSHOT" &&
    event.verified &&
    event.market?.reliable === true &&
    (campaign.state === "ENTRY_READY" || campaign.state === "EXPOSED")
  ) {
    const signals = ignitionSignals(campaign);
    campaign.ignitionScore = (signals.length / 5) * 100;
    campaign.ignitionStreak =
      signals.length >= campaign.config.ignitionRequiredSignals ? campaign.ignitionStreak + 1 : 0;
    if (campaign.ignitionStreak >= campaign.config.ignitionConfirmationSnapshots) {
      campaign.ignitedAtMs = event.availableAtMs;
      stateTransition(campaign, "RETAIL_IGNITION", event, signals, transitions);
      if (hasStarterPaperExposure(campaign, actions) && freshForShadowDecision(event)) {
        actions.push(
          action(campaign, event, "STOP_ADDING", "market ignition confirmed", { signals }),
        );
        actions.push(
          action(campaign, event, "TAKE_PROFIT", "shadow ignition harvest became eligible", {
            signals,
          }),
        );
      }
    }
  } else if (event.eventType === "MARKET_SNAPSHOT" && event.market?.reliable !== true) {
    campaign.ignitionStreak = 0;
  }

  if (
    event.eventType === "CLOCK_TICK" &&
    (campaign.state === "SEEDED" || campaign.state === "ACCUMULATING") &&
    event.eventAtMs - campaign.seededAtMs > campaign.config.confirmationWindowMs
  ) {
    closeCampaign(campaign, event, "confirmation_window_expired", transitions);
  }
}

function cloneProjection(input: RevivalReplayResult): RevivalReplayResult {
  return {
    campaigns: input.campaigns.map((campaign) => ({
      ...campaign,
      targetWallets: [...campaign.targetWallets],
      config: { ...campaign.config },
    })),
    transitions: [...input.transitions],
    actions: [...input.actions],
  };
}

function processRevivalEvent(result: RevivalReplayResult, event: RevivalEvent): void {
  let current = [...result.campaigns].reverse().find(activeRevivalCampaign);
  if (!current) {
    if (event.eventType !== "TARGET_BUY" || !event.verified) return;
    current = createCampaign(event, result.campaigns.length + 1, result.transitions);
    result.campaigns.push(current);
    return;
  }

  if (
    event.eventType === "TARGET_BUY" &&
    event.verified &&
    event.eventAtMs - current.seededAtMs > current.config.campaignTtlMs
  ) {
    degradeForSilentMarketGap(current, event);
    closeCampaign(current, event, "campaign_ttl_expired", result.transitions);
    result.campaigns.push(createCampaign(event, result.campaigns.length + 1, result.transitions));
    return;
  }
  applyEvent(current, event, result.transitions, result.actions);
}

export function advanceRevivalProjection(
  prior: RevivalReplayResult,
  event: RevivalEvent,
): RevivalReplayResult {
  const result = cloneProjection(prior);
  processRevivalEvent(result, event);
  return result;
}

export function compareRevivalEventOrder(left: RevivalEvent, right: RevivalEvent): number {
  return (
    left.availableAtMs - right.availableAtMs ||
    left.eventAtMs - right.eventAtMs ||
    left.eventKey.localeCompare(right.eventKey)
  );
}

export function replayRevivalEvents(input: readonly RevivalEvent[]): RevivalReplayResult {
  const seen = new Set<string>();
  const events = [...input]
    .filter(
      (event) =>
        event.tokenMint.trim().length > 0 &&
        event.eventKey.trim().length > 0 &&
        Number.isFinite(event.eventAtMs) &&
        Number.isFinite(event.availableAtMs) &&
        !seen.has(event.eventKey) &&
        Boolean(seen.add(event.eventKey)),
    )
    .sort(compareRevivalEventOrder);
  const result: RevivalReplayResult = { campaigns: [], transitions: [], actions: [] };
  for (const event of events) processRevivalEvent(result, event);
  return result;
}

export function activeRevivalCampaign(campaign: RevivalCampaignSnapshot): boolean {
  return !isTerminal(campaign);
}
