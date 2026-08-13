import type {
  ConvictionBreakout,
  ConvictionEvent,
  ConvictionLeaderboardRow,
  ConvictionTokenSnapshot,
  ConvictionTransition,
} from "./conviction-engine.js";

export type ConvictionEventDbRow = {
  user_id: string;
  event_key: string;
  tx_sig: string;
  slot: number | null;
  source: "geyser" | "rpc" | "unknown";
  event_at: string;
  wallet: string;
  from_wallet: string | null;
  to_wallet: string | null;
  token_mint: string;
  classification: ConvictionEvent["type"];
  classification_reliable: boolean;
  amount_tokens: number;
  amount_usd: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number | null;
  metadata: Record<string, unknown>;
};

type EventRowInput = {
  userId: string;
  event: ConvictionEvent;
  txSig: string;
  slot?: number;
  source?: "geyser" | "rpc" | "unknown";
};

export function convictionEventDbRow(input: EventRowInput): ConvictionEventDbRow {
  const event = input.event;
  return {
    user_id: input.userId,
    event_key: event.eventId,
    tx_sig: input.txSig,
    slot: Number.isSafeInteger(input.slot) && Number(input.slot) >= 0 ? Number(input.slot) : null,
    source: input.source ?? "unknown",
    event_at: new Date(event.timestampMs).toISOString(),
    wallet: event.wallet,
    from_wallet: event.fromWallet ?? null,
    to_wallet: event.toWallet ?? null,
    token_mint: event.tokenMint,
    classification: event.type,
    classification_reliable: event.classificationReliable === true,
    amount_tokens: Math.max(0, Number(event.amountTokens ?? 0)),
    amount_usd: Number.isFinite(event.amountUsd) ? Math.max(0, event.amountUsd) : null,
    market_cap_usd:
      event.marketCapUsd !== undefined && Number.isFinite(event.marketCapUsd)
        ? event.marketCapUsd
        : null,
    liquidity_usd:
      event.liquidityUsd !== undefined && Number.isFinite(event.liquidityUsd)
        ? event.liquidityUsd
        : null,
    metadata: {
      ...(event.metadata ?? {}),
      ...(event.symbol ? { symbol: event.symbol } : {}),
      ...(event.tokenCreatedAtMs ? { tokenCreatedAtMs: event.tokenCreatedAtMs } : {}),
    },
  };
}

export function convictionEventFromDbRow(row: {
  event_key: string;
  event_at: string;
  wallet: string;
  token_mint: string;
  classification: string;
  classification_reliable?: boolean | null;
  amount_tokens?: number | string | null;
  amount_usd?: number | string | null;
  from_wallet?: string | null;
  to_wallet?: string | null;
  market_cap_usd?: number | string | null;
  liquidity_usd?: number | string | null;
  metadata?: Record<string, unknown> | null;
}): ConvictionEvent | null {
  const timestampMs = new Date(row.event_at).getTime();
  const amountUsd = Number(row.amount_usd ?? 0);
  const amountTokens = Number(row.amount_tokens ?? 0);
  const validTypes = new Set<ConvictionEvent["type"]>([
    "DEX_BUY",
    "DEX_SELL",
    "INTERNAL_CLUSTER_TRANSFER",
    "EXTERNAL_TRANSFER_IN",
    "EXTERNAL_TRANSFER_OUT",
    "UNKNOWN",
  ]);
  if (
    !row.event_key ||
    !row.wallet ||
    !row.token_mint ||
    !validTypes.has(row.classification as ConvictionEvent["type"]) ||
    !Number.isFinite(timestampMs) ||
    !Number.isFinite(amountUsd) ||
    amountUsd < 0 ||
    !Number.isFinite(amountTokens) ||
    amountTokens < 0
  ) {
    return null;
  }
  const metadata = row.metadata ?? {};
  const marketCapUsd = row.market_cap_usd == null ? Number.NaN : Number(row.market_cap_usd);
  const liquidityUsd = row.liquidity_usd == null ? Number.NaN : Number(row.liquidity_usd);
  const tokenCreatedAtMs =
    metadata.tokenCreatedAtMs == null ? Number.NaN : Number(metadata.tokenCreatedAtMs);
  return {
    eventId: row.event_key,
    timestampMs,
    wallet: row.wallet,
    tokenMint: row.token_mint,
    type: row.classification as ConvictionEvent["type"],
    amountUsd,
    amountTokens,
    symbol: typeof metadata.symbol === "string" ? metadata.symbol : undefined,
    fromWallet: row.from_wallet ?? undefined,
    toWallet: row.to_wallet ?? undefined,
    marketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : undefined,
    liquidityUsd: Number.isFinite(liquidityUsd) ? liquidityUsd : undefined,
    tokenCreatedAtMs: Number.isFinite(tokenCreatedAtMs) ? tokenCreatedAtMs : undefined,
    classificationReliable: row.classification_reliable === true,
    metadata,
  };
}

export function convictionStateDbRow(userId: string, snapshot: ConvictionTokenSnapshot) {
  const rolling = snapshot.rolling;
  return {
    user_id: userId,
    token_mint: snapshot.mint,
    symbol: snapshot.symbol ?? null,
    first_seen_at: new Date(snapshot.firstSeenAtMs).toISOString(),
    last_activity_at: new Date(snapshot.lastActivityAtMs).toISOString(),
    gross_cluster_buys_usd: snapshot.grossClusterBuysUsd,
    gross_cluster_sells_usd: snapshot.grossClusterSellsUsd,
    net_cluster_investment_usd: snapshot.netClusterInvestmentUsd,
    wallet_net_usd: Object.fromEntries(
      Object.entries(snapshot.walletStats).map(([wallet, stats]) => [
        wallet,
        stats.netInvestmentUsd,
      ]),
    ),
    buy_count: snapshot.buyCount,
    sell_count: snapshot.sellCount,
    largest_buy_usd: snapshot.largestBuyUsd,
    last_buy_usd: snapshot.lastBuyUsd,
    average_buy_usd: snapshot.averageBuyUsd,
    median_buy_usd: snapshot.medianBuyUsd,
    wallets_that_bought: snapshot.walletsThatBought,
    wallets_currently_accumulating: snapshot.walletsCurrentlyAccumulating,
    wallet_convergence_count: Math.min(3, snapshot.convergedWalletCount),
    market_cap_usd: snapshot.marketCapUsd ?? null,
    market_cap_at_first_cluster_buy_usd: snapshot.marketCapAtFirstClusterBuyUsd ?? null,
    liquidity_usd: snapshot.liquidityUsd ?? null,
    our_current_position_usd: snapshot.ourCurrentPositionUsd,
    net_flow_1m_usd: rolling["60"]?.netFlowUsd ?? 0,
    net_flow_5m_usd: rolling["300"]?.netFlowUsd ?? 0,
    net_flow_30m_usd: rolling["1800"]?.netFlowUsd ?? 0,
    net_flow_60m_usd: rolling["3600"]?.netFlowUsd ?? 0,
    capital_velocity_usd_per_minute: rolling["1800"]?.capitalVelocityUsdPerMinute ?? 0,
    capital_acceleration_ratio: rolling["1800"]?.accelerationSignal ?? 0,
    buy_size_acceleration_ratio: rolling["1800"]?.buySizeAcceleration ?? 0,
    conviction_score: snapshot.convictionScore,
    conviction_state: snapshot.convictionState,
    score_reasons: snapshot.scoreReasons,
    current_rank: snapshot.ranks["30"]?.currentRank ?? null,
    previous_rank: snapshot.ranks["30"]?.previousRank ?? null,
    rank_direction:
      snapshot.ranks["30"]?.direction === "out"
        ? "unranked"
        : (snapshot.ranks["30"]?.direction ?? "unranked"),
    time_in_top_10_seconds: Math.floor((snapshot.ranks["30"]?.timeInTop10Ms ?? 0) / 1_000),
    time_in_top_3_seconds: Math.floor((snapshot.ranks["30"]?.timeInTop3Ms ?? 0) / 1_000),
    time_at_rank_one_seconds: Math.floor((snapshot.ranks["30"]?.timeAtOneMs ?? 0) / 1_000),
    rapid_follow_status: snapshot.rapidFollowStatus,
    data_reliable: snapshot.classificationReliable,
    rolling_metrics: {
      windows: snapshot.rolling,
      ranks: snapshot.ranks,
      windowScores: snapshot.windowScores,
      scoreComponents: snapshot.scoreComponents,
      convergenceWallets: snapshot.convergenceWallets,
      distributionDetected: snapshot.distributionDetected,
      classificationUpdatedAtMs: snapshot.classificationUpdatedAtMs,
      lastClusterBuyAtMs: snapshot.lastClusterBuyAtMs,
      tokenCreatedAtMs: snapshot.tokenCreatedAtMs,
    },
    last_ranked_at: snapshot.ranks["30"]?.lastRankedAtMs
      ? new Date(snapshot.ranks["30"].lastRankedAtMs).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  };
}

export function convictionRankDbRow(
  userId: string,
  row: ConvictionLeaderboardRow,
  rankingAtMs: number,
) {
  return {
    user_id: userId,
    token_mint: row.mint,
    window_minutes: row.windowMinutes,
    rank: row.rank,
    previous_rank: row.previousRank ?? null,
    rank_direction: row.rankDirection === "out" ? "down" : row.rankDirection,
    conviction_score: row.score,
    net_cluster_investment_usd: row.netClusterInvestmentUsd,
    net_flow_usd: row.netFlowUsd,
    capital_velocity_usd_per_minute: row.capitalVelocityUsdPerMinute,
    capital_acceleration_ratio: row.capitalAcceleration,
    buy_size_acceleration_ratio: row.buySizeAcceleration,
    wallet_convergence_count: Math.min(3, row.convergedWalletCount),
    continuing_accumulation: row.netFlowUsd > 0,
    distribution_penalty: row.state === "DISTRIBUTING" ? 1 : 0,
    ranking_at: new Date(rankingAtMs).toISOString(),
    metadata: { scoreReasons: row.scoreReasons },
  };
}

export function convictionTransitionDbRow(
  userId: string,
  transition: ConvictionTransition,
  eventKey: string,
) {
  return {
    user_id: userId,
    transition_key: `state:${eventKey}:${transition.mint}:${transition.newState}`,
    token_mint: transition.mint,
    event_type: "CONVICTION_STATE_CHANGE",
    previous_state: transition.previousState,
    new_state: transition.newState,
    previous_score: transition.previousScore,
    new_score: transition.newScore,
    reasons: transition.reasons,
    occurred_at: new Date(transition.timestampMs).toISOString(),
    metadata: {},
  };
}

export function convictionBreakoutDbRow(
  userId: string,
  breakout: ConvictionBreakout,
  eventKey: string,
) {
  return {
    user_id: userId,
    transition_key: `breakout:${eventKey}:${breakout.mint}`,
    token_mint: breakout.mint,
    event_type: breakout.kind,
    previous_state: null,
    new_state: null,
    previous_score: breakout.previousScore,
    new_score: breakout.newScore,
    net_cluster_investment_usd: breakout.netClusterInvestmentUsd,
    capital_velocity_usd_per_minute: breakout.capitalVelocityUsdPerMinute,
    wallet_convergence_count: breakout.walletConvergence,
    market_cap_usd: breakout.marketCapUsd ?? null,
    liquidity_usd: breakout.liquidityUsd ?? null,
    reasons: breakout.reasons,
    occurred_at: new Date(breakout.timestampMs).toISOString(),
    metadata: {},
  };
}
