export const REVIVAL_ENGINE_VERSION = "revival-shadow-v1";

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

export type RevivalEventType = "TARGET_BUY" | "TARGET_SELL" | "MARKET_SNAPSHOT" | "CLOCK_TICK";

export type RevivalShadowActionType =
  | "STARTER_ELIGIBLE"
  | "SCALE_ELIGIBLE"
  | "STOP_ADDING"
  | "TAKE_PROFIT"
  | "EXIT"
  | "SKIP";

export type RevivalCoverageStatus = "COMPLETE" | "PARTIAL" | "MISSING";

export type RevivalTrackerConfig = {
  enabled: boolean;
  marketCapMinUsd: number;
  marketCapMaxUsd: number;
  minTargetBuys: number;
  minNetCommitmentUsd: number;
  confirmationWindowMs: number;
  campaignTtlMs: number;
  marketDataGraceMs: number;
  ignitionRequiredSignals: number;
  ignitionConfirmationSnapshots: number;
};

export const DEFAULT_REVIVAL_TRACKER_CONFIG: RevivalTrackerConfig = {
  enabled: false,
  marketCapMinUsd: 2_000,
  marketCapMaxUsd: 15_000,
  minTargetBuys: 2,
  minNetCommitmentUsd: 1_000,
  confirmationWindowMs: 45 * 60_000,
  campaignTtlMs: 24 * 60 * 60_000,
  // Seed admission is deliberately short-lived. The observer performs
  // bounded retries inside this window; a later quote must never be
  // retroactively presented as the market cap that was knowable at seed.
  marketDataGraceMs: 15_000,
  ignitionRequiredSignals: 2,
  ignitionConfirmationSnapshots: 2,
};

export type RevivalMarketSnapshot = {
  provider: "dexscreener" | "unknown";
  observedAtMs: number;
  pairAddress?: string;
  dexId?: string;
  symbol?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  valuationKind?: "market_cap" | "fdv" | "unknown";
  liquidityUsd?: number;
  volumeM5Usd?: number;
  volumeH1Usd?: number;
  volumeH6Usd?: number;
  volumeH24Usd?: number;
  buysM5?: number;
  sellsM5?: number;
  buysH1?: number;
  sellsH1?: number;
  buysH24?: number;
  sellsH24?: number;
  activeBoosts?: number;
  pairCreatedAtMs?: number;
  reliable: boolean;
  reason?: string;
  attemptCount?: number;
  retryWindowExhausted?: boolean;
};

export type RevivalEvent = {
  eventKey: string;
  eventType: RevivalEventType;
  tokenMint: string;
  eventAtMs: number;
  availableAtMs: number;
  source: "rpc" | "market" | "clock";
  txSig?: string;
  slot?: number;
  txIndex?: number;
  targetWallet?: string;
  verified: boolean;
  historical: boolean;
  amountTokens?: number;
  amountUsd?: number;
  market?: RevivalMarketSnapshot;
  seedConfig?: RevivalTrackerConfig;
  metadata?: Record<string, unknown>;
};

export type RevivalTransition = {
  transitionKey: string;
  campaignKey: string;
  tokenMint: string;
  fromState: RevivalCampaignState | null;
  toState: RevivalCampaignState;
  fromVersion: number;
  toVersion: number;
  triggerEventKey: string;
  occurredAtMs: number;
  availableAtMs: number;
  reasons: string[];
  metrics: Record<string, unknown>;
};

export type RevivalShadowAction = {
  actionKey: string;
  campaignKey: string;
  tokenMint: string;
  actionType: RevivalShadowActionType;
  state: RevivalCampaignState;
  stateVersion: number;
  decisionAtMs: number;
  availableAtMs: number;
  sourceEventKey: string;
  reason: string;
  executable: false;
  metadata: Record<string, unknown>;
};

export type RevivalCampaignSnapshot = {
  campaignKey: string;
  campaignNumber: number;
  tokenMint: string;
  symbol?: string;
  state: RevivalCampaignState;
  stateVersion: number;
  eligibilityStatus: "pending_market_data" | "eligible" | "ineligible";
  eligibilityReason: string;
  seedEventKey: string;
  seedTxSig?: string;
  seedSlot?: number;
  seedTxIndex?: number;
  seededAtMs: number;
  seedAvailableAtMs: number;
  seedHistorical: boolean;
  eligibilityDeadlineAtMs?: number;
  lastEventKey: string;
  lastEventAtMs: number;
  lastAvailableAtMs: number;
  closedAtMs?: number;
  closeReason?: string;
  seedMarketCapUsd?: number;
  latestMarketCapUsd?: number;
  seedPriceUsd?: number;
  latestPriceUsd?: number;
  peakPriceUsd?: number;
  troughPriceUsd?: number;
  seedVolumeH1Usd?: number;
  latestVolumeH1Usd?: number;
  seedBuysH1?: number;
  latestBuysH1?: number;
  seedActiveBoosts?: number;
  latestActiveBoosts?: number;
  /** Latest attempted market observation, reliable or not, used to detect silent gaps. */
  lastMarketObservedAtMs?: number;
  targetGrossBuysUsd: number;
  targetGrossSellsUsd: number;
  targetNetCommitmentUsd: number;
  targetBuyCount: number;
  targetSellCount: number;
  targetWallets: string[];
  uniqueTargetWalletCount: number;
  accumulationScore: number;
  ignitionScore: number;
  distributionScore: number;
  ignitionStreak: number;
  marketDataReliable: boolean;
  targetAttributionReliable: boolean;
  custodyEvidenceReliable: boolean;
  coverageStatus: RevivalCoverageStatus;
  entryReadyAtMs?: number;
  ignitedAtMs?: number;
  distributionRiskAtMs?: number;
  config: RevivalTrackerConfig;
  engineVersion: string;
};

export type RevivalReplayResult = {
  campaigns: RevivalCampaignSnapshot[];
  transitions: RevivalTransition[];
  actions: RevivalShadowAction[];
};

export type RevivalRuntimeHealth = {
  initialized: boolean;
  eventCount: number;
  activeCampaignCount: number;
  pendingMarketDataCount: number;
  lastObservationAt: number | null;
  lastMarketSnapshotAt: number | null;
  lastReliableMarketSnapshotAt: number | null;
  marketProviderReliable: boolean | null;
  consecutiveMarketProviderFailures: number;
  lastError: string | null;
};
