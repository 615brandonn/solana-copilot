export type RevivalCampaignState =
  | "DORMANT_CANDIDATE"
  | "SEEDED"
  | "ACCUMULATING"
  | "ENTRY_READY"
  | "EXPOSED"
  | "RETAIL_IGNITION"
  | "DISTRIBUTION_RISK"
  | "CLOSED"
  | "INVALIDATED"
  | "COVERAGE_GAP";

export type RevivalCoverageStatus = "COMPLETE" | "PARTIAL" | "MISSING";

export type RevivalCampaignSummary = {
  id: string;
  tokenMint: string;
  symbol: string | null;
  state: RevivalCampaignState;
  stateVersion: number;
  eligibilityStatus: "pending_market_data" | "eligible" | "ineligible";
  eligibilityReason: string;
  seededAt: string;
  lastActivityAt: string;
  closedAt: string | null;
  seedMarketCapUsd: number | null;
  latestMarketCapUsd: number | null;
  seedPriceUsd: number | null;
  latestPriceUsd: number | null;
  targetNetCommitmentUsd: number;
  targetBuyCount: number;
  targetSellCount: number;
  uniqueTargetWalletCount: number;
  accumulationScore: number;
  ignitionScore: number;
  distributionScore: number;
  marketDataReliable: boolean;
  targetAttributionReliable: boolean;
  custodyEvidenceReliable: boolean;
  coverageStatus: RevivalCoverageStatus;
  mfePct: number | null;
  maePct: number | null;
};

export type RevivalObserverHealth = {
  installed: boolean;
  enabled: boolean;
  online: boolean;
  degraded: boolean;
  updatedAt: string | null;
  targetWalletCount: number;
  eventCount: number;
  activeCampaignCount: number;
  pendingMarketDataCount: number;
  rpcBacklogWalletCount: number;
  lastEventAt: string | null;
  lastMarketSnapshotAt: string | null;
};

export type RevivalDashboardData = {
  generatedAt: string;
  health: RevivalObserverHealth;
  summary: RevivalDashboardSummary;
  campaignsReturned: number;
  campaignsTotal: number;
  campaignsTruncated: boolean;
  campaigns: RevivalCampaignSummary[];
};

export type RevivalDashboardSummary = {
  active: number;
  entryReady: number;
  ignition: number;
  distributionRisk: number;
  closed: number;
  invalidated: number;
  coverageGaps: number;
};

export type RevivalDetailValue =
  | string
  | number
  | boolean
  | null
  | RevivalDetailValue[]
  | { [key: string]: RevivalDetailValue };

export type RevivalDetailRow = { [key: string]: RevivalDetailValue };

export type RevivalCampaignDetail = {
  campaign: RevivalCampaignSummary;
  events: RevivalDetailRow[];
  transitions: RevivalDetailRow[];
  marketSnapshots: RevivalDetailRow[];
  shadowActions: RevivalDetailRow[];
  outcome: RevivalDetailRow | null;
};

function number(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function revivalCampaignSummary(row: Record<string, unknown>): RevivalCampaignSummary {
  return {
    id: String(row.id ?? ""),
    tokenMint: String(row.token_mint ?? ""),
    symbol: nullableText(row.symbol),
    state: String(row.state ?? "COVERAGE_GAP") as RevivalCampaignState,
    stateVersion: number(row.state_version, 1),
    eligibilityStatus: String(
      row.eligibility_status ?? "pending_market_data",
    ) as RevivalCampaignSummary["eligibilityStatus"],
    eligibilityReason: String(row.eligibility_reason ?? "unknown"),
    seededAt: String(row.seeded_at ?? ""),
    lastActivityAt: String(row.last_available_at ?? row.seeded_at ?? ""),
    closedAt: nullableText(row.closed_at),
    seedMarketCapUsd: nullableNumber(row.seed_market_cap_usd),
    latestMarketCapUsd: nullableNumber(row.latest_market_cap_usd),
    seedPriceUsd: nullableNumber(row.seed_price_usd),
    latestPriceUsd: nullableNumber(row.latest_price_usd),
    targetNetCommitmentUsd: number(row.target_net_commitment_usd),
    targetBuyCount: number(row.target_buy_count),
    targetSellCount: number(row.target_sell_count),
    uniqueTargetWalletCount: number(row.unique_target_wallet_count),
    accumulationScore: number(row.accumulation_score),
    ignitionScore: number(row.ignition_score),
    distributionScore: number(row.distribution_score),
    marketDataReliable: row.market_data_reliable === true,
    targetAttributionReliable: row.target_attribution_reliable === true,
    custodyEvidenceReliable: row.custody_evidence_reliable === true,
    coverageStatus: String(row.coverage_status ?? "MISSING") as RevivalCoverageStatus,
    mfePct: nullableNumber(row.mfe_pct),
    maePct: nullableNumber(row.mae_pct),
  };
}

export function buildRevivalDashboard(
  campaignRows: Array<Record<string, unknown>>,
  heartbeat: Record<string, unknown> | null,
  nowMs = Date.now(),
  authoritativeSummary?: RevivalDashboardSummary,
  authoritativeCampaignTotal?: number,
): RevivalDashboardData {
  const campaigns = campaignRows.map(revivalCampaignSummary);
  const updatedAt = heartbeat ? nullableText(heartbeat.updated_at) : null;
  const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const online = Number.isFinite(updatedAtMs) && nowMs - updatedAtMs < 60_000;
  const active = campaigns.filter((campaign) => campaign.closedAt === null);
  const projectedSummary: RevivalDashboardSummary = {
    active: active.length,
    entryReady: active.filter((campaign) => campaign.state === "ENTRY_READY").length,
    ignition: active.filter((campaign) => campaign.state === "RETAIL_IGNITION").length,
    distributionRisk: active.filter((campaign) => campaign.state === "DISTRIBUTION_RISK").length,
    closed: campaigns.filter((campaign) => campaign.state === "CLOSED").length,
    invalidated: campaigns.filter((campaign) => campaign.state === "INVALIDATED").length,
    coverageGaps: active.filter(
      (campaign) => campaign.coverageStatus !== "COMPLETE" || campaign.state === "COVERAGE_GAP",
    ).length,
  };
  const requestedCampaignTotal = Number(authoritativeCampaignTotal);
  const campaignsTotal = Math.max(
    campaigns.length,
    Number.isFinite(requestedCampaignTotal)
      ? Math.max(0, Math.floor(requestedCampaignTotal))
      : campaigns.length,
  );
  return {
    generatedAt: new Date(nowMs).toISOString(),
    health: {
      installed: heartbeat !== null,
      enabled: heartbeat?.enabled === true,
      online,
      degraded: heartbeat?.degraded === true,
      updatedAt,
      targetWalletCount: number(heartbeat?.target_wallet_count),
      eventCount: number(heartbeat?.event_count),
      activeCampaignCount: number(heartbeat?.active_campaign_count, active.length),
      pendingMarketDataCount: number(heartbeat?.pending_market_data_count),
      rpcBacklogWalletCount: number(heartbeat?.rpc_backlog_wallet_count),
      lastEventAt: nullableText(heartbeat?.last_event_at),
      lastMarketSnapshotAt: nullableText(heartbeat?.last_market_snapshot_at),
    },
    summary: authoritativeSummary ?? projectedSummary,
    campaignsReturned: campaigns.length,
    campaignsTotal,
    campaignsTruncated: campaigns.length < campaignsTotal,
    campaigns,
  };
}
