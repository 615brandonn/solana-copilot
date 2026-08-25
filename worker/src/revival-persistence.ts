import {
  REVIVAL_ENGINE_VERSION,
  type RevivalCampaignSnapshot,
  type RevivalEvent,
  type RevivalMarketSnapshot,
  type RevivalShadowAction,
  type RevivalTrackerConfig,
  type RevivalTransition,
} from "./revival-types.js";
import { normalizeRevivalConfig, revivalEventFingerprint } from "./revival-engine.js";

function iso(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function number(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function revivalEventDbRow(userId: string, strategyVersionId: string, event: RevivalEvent) {
  return {
    user_id: userId,
    strategy_version_id: strategyVersionId,
    event_key: event.eventKey,
    request_fingerprint: revivalEventFingerprint(event),
    event_type: event.eventType,
    source: event.source,
    tx_sig: event.txSig ?? null,
    slot: event.slot ?? null,
    tx_index: event.txIndex ?? null,
    event_at: iso(event.eventAtMs),
    available_at: iso(event.availableAtMs),
    actor_wallet: event.targetWallet ?? null,
    token_mint: event.tokenMint,
    amount_tokens: event.amountTokens ?? null,
    amount_usd: event.amountUsd ?? null,
    price_usd: event.market?.priceUsd ?? null,
    market_cap_usd: event.market?.marketCapUsd ?? null,
    liquidity_usd: event.market?.liquidityUsd ?? null,
    classification_reliable: event.verified,
    market_data_reliable: event.market?.reliable ?? false,
    historical: event.historical,
    metadata: {
      ...(event.metadata ?? {}),
      market: event.market ?? null,
      seedConfig: normalizeRevivalConfig(event.seedConfig),
    },
  };
}

export function revivalEventFromDbRow(row: Record<string, unknown>): RevivalEvent | null {
  const eventAtMs = Date.parse(String(row.event_at ?? ""));
  const availableAtMs = Date.parse(String(row.available_at ?? ""));
  const eventType = String(row.event_type ?? "");
  if (
    !["TARGET_BUY", "TARGET_SELL", "MARKET_SNAPSHOT", "CLOCK_TICK"].includes(eventType) ||
    !Number.isFinite(eventAtMs) ||
    !Number.isFinite(availableAtMs)
  ) {
    return null;
  }
  const metadata = object(row.metadata);
  const { market: _market, seedConfig: _seedConfig, ...eventMetadata } = metadata;
  const market = object(metadata.market);
  const parsedMarket: RevivalMarketSnapshot | undefined =
    Object.keys(market).length > 0
      ? {
          provider: market.provider === "dexscreener" ? "dexscreener" : "unknown",
          observedAtMs: number(market.observedAtMs) ?? availableAtMs,
          pairAddress: typeof market.pairAddress === "string" ? market.pairAddress : undefined,
          dexId: typeof market.dexId === "string" ? market.dexId : undefined,
          symbol: typeof market.symbol === "string" ? market.symbol : undefined,
          priceUsd: number(market.priceUsd),
          marketCapUsd: number(market.marketCapUsd),
          fdvUsd: number(market.fdvUsd),
          valuationKind:
            market.valuationKind === "market_cap" || market.valuationKind === "fdv"
              ? market.valuationKind
              : "unknown",
          liquidityUsd: number(market.liquidityUsd),
          volumeM5Usd: number(market.volumeM5Usd),
          volumeH1Usd: number(market.volumeH1Usd),
          volumeH6Usd: number(market.volumeH6Usd),
          volumeH24Usd: number(market.volumeH24Usd),
          buysM5: number(market.buysM5),
          sellsM5: number(market.sellsM5),
          buysH1: number(market.buysH1),
          sellsH1: number(market.sellsH1),
          buysH24: number(market.buysH24),
          sellsH24: number(market.sellsH24),
          activeBoosts: number(market.activeBoosts),
          pairCreatedAtMs: number(market.pairCreatedAtMs),
          reliable: market.reliable === true,
          reason: typeof market.reason === "string" ? market.reason : undefined,
          attemptCount: number(market.attemptCount),
          retryWindowExhausted: market.retryWindowExhausted === true,
        }
      : undefined;
  return {
    eventKey: String(row.event_key ?? ""),
    eventType: eventType as RevivalEvent["eventType"],
    tokenMint: String(row.token_mint ?? ""),
    eventAtMs,
    availableAtMs,
    source:
      row.source === "rpc" || row.source === "market" || row.source === "clock"
        ? row.source
        : "rpc",
    txSig: typeof row.tx_sig === "string" ? row.tx_sig : undefined,
    slot: number(row.slot),
    txIndex: number(row.tx_index),
    targetWallet: typeof row.actor_wallet === "string" ? row.actor_wallet : undefined,
    verified: row.classification_reliable === true,
    historical: row.historical === true,
    amountTokens: number(row.amount_tokens),
    amountUsd: number(row.amount_usd),
    market: parsedMarket,
    seedConfig: normalizeRevivalConfig(object(metadata.seedConfig)),
    metadata: eventMetadata,
  };
}

export function revivalCampaignDbRow(
  userId: string,
  strategyVersionId: string,
  campaign: RevivalCampaignSnapshot,
) {
  const mfePct =
    campaign.seedPriceUsd && campaign.peakPriceUsd
      ? (campaign.peakPriceUsd / campaign.seedPriceUsd - 1) * 100
      : null;
  const maePct =
    campaign.seedPriceUsd && campaign.troughPriceUsd
      ? (campaign.troughPriceUsd / campaign.seedPriceUsd - 1) * 100
      : null;
  return {
    user_id: userId,
    strategy_version_id: strategyVersionId,
    campaign_key: campaign.campaignKey,
    campaign_number: campaign.campaignNumber,
    token_mint: campaign.tokenMint,
    symbol: campaign.symbol ?? null,
    state: campaign.state,
    state_version: campaign.stateVersion,
    eligibility_status: campaign.eligibilityStatus,
    eligibility_reason: campaign.eligibilityReason,
    seed_event_key: campaign.seedEventKey,
    seed_tx_sig: campaign.seedTxSig ?? null,
    seed_slot: campaign.seedSlot ?? null,
    seed_tx_index: campaign.seedTxIndex ?? null,
    seeded_at: iso(campaign.seededAtMs),
    seed_available_at: iso(campaign.seedAvailableAtMs),
    eligibility_deadline_at: iso(campaign.eligibilityDeadlineAtMs),
    last_event_key: campaign.lastEventKey,
    last_event_at: iso(campaign.lastEventAtMs),
    last_available_at: iso(campaign.lastAvailableAtMs),
    closed_at: iso(campaign.closedAtMs),
    close_reason: campaign.closeReason ?? null,
    seed_market_cap_usd: campaign.seedMarketCapUsd ?? null,
    latest_market_cap_usd: campaign.latestMarketCapUsd ?? null,
    seed_price_usd: campaign.seedPriceUsd ?? null,
    latest_price_usd: campaign.latestPriceUsd ?? null,
    peak_price_usd: campaign.peakPriceUsd ?? null,
    trough_price_usd: campaign.troughPriceUsd ?? null,
    baseline_volume_h1_usd: campaign.seedVolumeH1Usd ?? null,
    latest_volume_h1_usd: campaign.latestVolumeH1Usd ?? null,
    baseline_buy_count_h1: campaign.seedBuysH1 ?? null,
    latest_buy_count_h1: campaign.latestBuysH1 ?? null,
    seed_active_boosts: campaign.seedActiveBoosts ?? null,
    latest_active_boosts: campaign.latestActiveBoosts ?? null,
    last_market_observed_at: iso(campaign.lastMarketObservedAtMs),
    target_gross_buys_usd: campaign.targetGrossBuysUsd,
    target_gross_sells_usd: campaign.targetGrossSellsUsd,
    target_net_commitment_usd: campaign.targetNetCommitmentUsd,
    target_buy_count: campaign.targetBuyCount,
    target_sell_count: campaign.targetSellCount,
    target_wallets: campaign.targetWallets,
    unique_target_wallet_count: campaign.uniqueTargetWalletCount,
    accumulation_score: campaign.accumulationScore,
    ignition_score: campaign.ignitionScore,
    distribution_score: campaign.distributionScore,
    ignition_streak: campaign.ignitionStreak,
    market_data_reliable: campaign.marketDataReliable,
    target_attribution_reliable: campaign.targetAttributionReliable,
    custody_evidence_reliable: campaign.custodyEvidenceReliable,
    coverage_status: campaign.coverageStatus,
    entry_ready_at: iso(campaign.entryReadyAtMs),
    ignited_at: iso(campaign.ignitedAtMs),
    distribution_risk_at: iso(campaign.distributionRiskAtMs),
    mfe_pct: mfePct,
    mae_pct: maePct,
    config_snapshot: campaign.config,
    engine_version: campaign.engineVersion,
    updated_at: new Date().toISOString(),
  };
}

export function revivalTransitionDbRow(
  userId: string,
  strategyVersionId: string,
  campaignId: string,
  transition: RevivalTransition,
) {
  return {
    user_id: userId,
    strategy_version_id: strategyVersionId,
    campaign_id: campaignId,
    transition_key: transition.transitionKey,
    trigger_kind: "event",
    trigger_key: transition.triggerEventKey,
    from_state: transition.fromState,
    to_state: transition.toState,
    from_state_version: transition.fromVersion,
    to_state_version: transition.toVersion,
    reasons: transition.reasons,
    metrics: transition.metrics,
    occurred_at: iso(transition.occurredAtMs),
    available_at: iso(transition.availableAtMs),
  };
}

export function revivalShadowActionDbRow(
  userId: string,
  strategyVersionId: string,
  campaignId: string,
  action: RevivalShadowAction,
) {
  return {
    user_id: userId,
    strategy_version_id: strategyVersionId,
    campaign_id: campaignId,
    action_key: action.actionKey,
    variant_key: REVIVAL_ENGINE_VERSION,
    mode: "shadow",
    state: action.state,
    state_version: action.stateVersion,
    action_type: action.actionType,
    decision_at: iso(action.decisionAtMs),
    available_at: iso(action.availableAtMs),
    source_event_key: action.sourceEventKey,
    executable: false,
    reason: action.reason,
    metadata: action.metadata,
  };
}

export function revivalMarketSnapshotDbRow(
  userId: string,
  strategyVersionId: string,
  campaignId: string | null,
  event: RevivalEvent,
) {
  const market = event.market!;
  return {
    user_id: userId,
    strategy_version_id: strategyVersionId,
    campaign_id: campaignId,
    snapshot_key: event.eventKey,
    request_fingerprint: revivalEventFingerprint(event),
    provider: market.provider,
    pair_address: market.pairAddress ?? null,
    dex_id: market.dexId ?? null,
    market_at: iso(event.eventAtMs),
    available_at: iso(event.availableAtMs),
    price_usd: market.priceUsd ?? null,
    market_cap_usd: market.marketCapUsd ?? null,
    fdv_usd: market.fdvUsd ?? null,
    valuation_kind: market.valuationKind ?? "unknown",
    liquidity_usd: market.liquidityUsd ?? null,
    volume_m5_usd: market.volumeM5Usd ?? null,
    volume_h1_usd: market.volumeH1Usd ?? null,
    volume_h6_usd: market.volumeH6Usd ?? null,
    volume_h24_usd: market.volumeH24Usd ?? null,
    buys_m5: market.buysM5 ?? null,
    sells_m5: market.sellsM5 ?? null,
    buys_h1: market.buysH1 ?? null,
    sells_h1: market.sellsH1 ?? null,
    buys_h24: market.buysH24 ?? null,
    sells_h24: market.sellsH24 ?? null,
    active_boosts: market.activeBoosts ?? null,
    reliable: market.reliable,
    metadata: {
      reason: market.reason ?? null,
      pairCreatedAtMs: market.pairCreatedAtMs ?? null,
      attemptCount: market.attemptCount ?? 1,
      retryWindowExhausted: market.retryWindowExhausted ?? false,
    },
  };
}

export function revivalStrategyVersionRow(
  userId: string,
  configHash: string,
  config: RevivalTrackerConfig,
  versionNumber: number,
) {
  return {
    user_id: userId,
    version_number: versionNumber,
    strategy_key: "revival_campaign",
    role: "challenger",
    algorithm_version: REVIVAL_ENGINE_VERSION,
    config_hash: configHash,
    config,
    activated_at: new Date().toISOString(),
  };
}
