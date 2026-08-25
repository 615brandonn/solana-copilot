export type ConvictionTradingMode = "shadow" | "live";

export type RevivalTrackerConfig = {
  /** Independent observation-only campaign collector. It has no Live mode. */
  revivalTrackerEnabled: boolean;
  /** Inclusive seed-admission floor; active campaigns remain tracked outside it. */
  revivalMarketCapMinUsd: number;
  /** Inclusive seed-admission ceiling; active campaigns remain tracked above it. */
  revivalMarketCapMaxUsd: number;
};

export type SupplyAccumulationConfig = {
  /** Exclusive automatic entry strategy based on verified rolling target supply accumulation. */
  supplyAccumulationModeEnabled: boolean;
  /** Minimum verified net share of total supply required for an entry signal. */
  supplyAccumulationThresholdPct: number;
  /** Dedicated USD size for a supply-accumulation entry. */
  supplyAccumulationBuyUsd: number;
  /** Strict live entry ceiling. Values above $15,000 are never accepted. */
  supplyAccumulationMaxMarketCapUsd: number;
  /** Rolling buy-minus-sell observation window. */
  supplyAccumulationWindowSeconds: number;
};

export type ConvictionConfig = {
  convictionModeEnabled: boolean;
  convictionTradingMode: ConvictionTradingMode;
  convictionRapidFollowEnabled: boolean;
  convictionPrimaryWindowMinutes: 5 | 30 | 60;
  convictionScoreThreshold: number;
  convictionTopN: number;
  convictionMinCommitmentUsd: number;
  convictionMinRecentNetInflowUsd: number;
  convictionMinVelocityUsdPerMinute: number;
  convictionMinAccelerationRatio: number;
  convictionMinConvergedWallets: number;
  convictionTwoWalletWindowSeconds: number;
  convictionThreeWalletWindowSeconds: number;
  convictionMinIndividualBuyUsd: number;
  convictionMarketCapFilterEnabled: boolean;
  convictionMarketCapMinUsd: number;
  convictionMarketCapMaxUsd: number;
  convictionLiquidityFilterEnabled: boolean;
  convictionLiquidityMinUsd: number;
  convictionLiquidityMaxUsd: number;
  convictionTokenAgeFilterEnabled: boolean;
  convictionTokenAgeMinMinutes: number;
  convictionTokenAgeMaxMinutes: number;
  convictionMaxPositionPerTokenUsd: number;
  convictionDistributionSellRatio: number;
  convictionDistributionMinSellsUsd: number;
  convictionDistributionWalletCount: number;
  convictionInactivityMinutes: number;
  convictionRankLossGraceSeconds: number;
  convictionWeightNetCommitment: number;
  convictionWeightVelocity: number;
  convictionWeightAcceleration: number;
  convictionWeightConvergence: number;
  convictionWeightPersistence: number;
  convictionTierCommitmentThresholdsUsd: number[];
  convictionTierBuyAmountsUsd: number[];
};

export type BotConfig = ConvictionConfig &
  RevivalTrackerConfig &
  SupplyAccumulationConfig & {
    enabled: boolean;
    targetWallet: string;
    additionalTargetWallets: string[];
    fundingPrivateKey: string; // client-side only; encrypted before persistence
    executionRoute: "jito" | "rpc";
    jitoTipSol: number;
    fixedBuyUsd: number;
    /** Observation-only custody tracing. Never enables Entries or trading. */
    custodyJourneyEnabled: boolean;
    crewExitEnabled: boolean;
    crewExitPct: number;
    crewExitMinMints: number;
    coordinatedModeEnabled: boolean;
    coordinatedFixedBuyUsd: number;
    coordinatedThreeWalletBuyUsd: number;
    coordinatedTargetWalletCount: number;
    coordinatedWindowSeconds: number;
    coordinatedMcMinUsd: number;
    coordinatedMcMaxUsd: number;
    coordinatedCoinAgeMinMinutes: number;
    coordinatedCoinAgeMaxMinutes: number;
    coordinatedTargetBuyMinUsd: number;
    coordinatedTargetBuyMaxUsd: number;
    coordinatedFirstBuyOnly: boolean;
    coordinatedOncePerToken: boolean;
    coordinatedFollowerSellCount: number;
    coordinatedFollowerSellPct: number;
    coordinatedInactivityHours: number;
    networkScalingEnabled: boolean;
    starterPositionPct: number;
    maxPositionPct: number;
    newEntryReservePct: number;
    targetCopyRatioPct: number;
    minScaleBuyUsd: number;
    minTargetBuyUsd: number;
    mcMinUsd: number;
    mcMaxUsd: number;
    liqMinUsd: number;
    liqMaxUsd: number;
    tokenAgeFilterEnabled: boolean;
    tokenAgeMinMinutes: number;
    tokenAgeMaxMinutes: number;
    pumpFunOnly: boolean;
    requireSocials: boolean;
    require24hUptrend: boolean;
    largeBuyScannerEnabled: boolean;
    largeBuyScannerMaxMcUsd: number;
    largeBuyScannerMinBuyUsd: number;
    largeBuyScannerMultiplier: number;
    largeBuyScannerHistoryWindow: number;
    onlyFirstBuyEver: boolean;
    onlyOncePerToken: boolean;
    takeProfitEnabled: boolean;
    takeProfitPct: number; // gain% trigger e.g. 100
    takeProfitSellPct: number; // portion to sell e.g. 50
    stopLossEnabled: boolean;
    stopLossPct: number; // e.g. 30 = -30%
    trailingStopEnabled: boolean;
    trailingStopPct: number;
    trailingActivationPct: number;
    proportionalFollowerSells: boolean;
    followerSellerExitEnabled: boolean;
    followerSellerExitCount: number;
    followerSellerExitPct: number;
    targetInactivityExitEnabled: boolean;
    targetInactivityHours: number;
    directTargetSellExitMode: "off" | "proportional" | "fixed_pct" | "full";
    directTargetSellExitPct: number;
    terminalOutflowExitEnabled: boolean;
    terminalOutflowExitPct: number;
    targetTerminalOutflowExitEnabled: boolean;
    targetTerminalOutflowExitPct: number;
  };

/** Safe installation defaults: Conviction is disabled and cannot submit live buys. */
export const DEFAULT_CONVICTION_CONFIG: ConvictionConfig = {
  convictionModeEnabled: false,
  convictionTradingMode: "shadow",
  convictionRapidFollowEnabled: false,
  convictionPrimaryWindowMinutes: 30,
  convictionScoreThreshold: 70,
  convictionTopN: 3,
  convictionMinCommitmentUsd: 1_000,
  convictionMinRecentNetInflowUsd: 0.01,
  convictionMinVelocityUsdPerMinute: 250,
  convictionMinAccelerationRatio: 1.25,
  convictionMinConvergedWallets: 1,
  convictionTwoWalletWindowSeconds: 120,
  convictionThreeWalletWindowSeconds: 300,
  convictionMinIndividualBuyUsd: 0,
  convictionMarketCapFilterEnabled: false,
  convictionMarketCapMinUsd: 0,
  convictionMarketCapMaxUsd: 1_000_000_000,
  convictionLiquidityFilterEnabled: false,
  convictionLiquidityMinUsd: 0,
  convictionLiquidityMaxUsd: 1_000_000_000,
  convictionTokenAgeFilterEnabled: false,
  convictionTokenAgeMinMinutes: 0,
  convictionTokenAgeMaxMinutes: 525_600,
  convictionMaxPositionPerTokenUsd: 25,
  convictionDistributionSellRatio: 0.2,
  convictionDistributionMinSellsUsd: 100,
  convictionDistributionWalletCount: 2,
  convictionInactivityMinutes: 15,
  convictionRankLossGraceSeconds: 120,
  convictionWeightNetCommitment: 30,
  convictionWeightVelocity: 25,
  convictionWeightAcceleration: 20,
  convictionWeightConvergence: 15,
  convictionWeightPersistence: 10,
  convictionTierCommitmentThresholdsUsd: [1_000, 2_500, 5_000, 10_000],
  convictionTierBuyAmountsUsd: [5, 5, 5, 10],
};

export const DEFAULT_CONFIG: BotConfig = {
  ...DEFAULT_CONVICTION_CONFIG,
  enabled: false,
  targetWallet: "",
  additionalTargetWallets: [],
  fundingPrivateKey: "",
  executionRoute: "jito",
  jitoTipSol: 0.001,
  fixedBuyUsd: 25,
  supplyAccumulationModeEnabled: false,
  supplyAccumulationThresholdPct: 10,
  supplyAccumulationBuyUsd: 20,
  supplyAccumulationMaxMarketCapUsd: 15_000,
  supplyAccumulationWindowSeconds: 600,
  custodyJourneyEnabled: false,
  revivalTrackerEnabled: false,
  revivalMarketCapMinUsd: 2_000,
  revivalMarketCapMaxUsd: 15_000,
  crewExitEnabled: false,
  crewExitPct: 100,
  crewExitMinMints: 4,
  coordinatedModeEnabled: false,
  coordinatedFixedBuyUsd: 25,
  coordinatedThreeWalletBuyUsd: 0,
  coordinatedTargetWalletCount: 2,
  coordinatedWindowSeconds: 30,
  coordinatedMcMinUsd: 0,
  coordinatedMcMaxUsd: 15_000,
  coordinatedCoinAgeMinMinutes: 0,
  coordinatedCoinAgeMaxMinutes: 60,
  coordinatedTargetBuyMinUsd: 0,
  coordinatedTargetBuyMaxUsd: 1_000_000,
  coordinatedFirstBuyOnly: false,
  coordinatedOncePerToken: true,
  coordinatedFollowerSellCount: 1,
  coordinatedFollowerSellPct: 100,
  coordinatedInactivityHours: 6,
  networkScalingEnabled: true,
  starterPositionPct: 5,
  maxPositionPct: 15,
  newEntryReservePct: 50,
  targetCopyRatioPct: 1,
  minScaleBuyUsd: 1,
  minTargetBuyUsd: 100,
  mcMinUsd: 20_000,
  mcMaxUsd: 5_000_000,
  liqMinUsd: 10_000,
  liqMaxUsd: 2_000_000,
  tokenAgeFilterEnabled: false,
  tokenAgeMinMinutes: 0,
  tokenAgeMaxMinutes: 60,
  pumpFunOnly: false,
  requireSocials: true,
  require24hUptrend: false,
  largeBuyScannerEnabled: false,
  largeBuyScannerMaxMcUsd: 10_000,
  largeBuyScannerMinBuyUsd: 500,
  largeBuyScannerMultiplier: 2,
  largeBuyScannerHistoryWindow: 20,
  onlyFirstBuyEver: false,
  onlyOncePerToken: true,
  takeProfitEnabled: true,
  takeProfitPct: 100,
  takeProfitSellPct: 50,
  stopLossEnabled: true,
  stopLossPct: 30,
  trailingStopEnabled: false,
  trailingStopPct: 35,
  trailingActivationPct: 50,
  proportionalFollowerSells: true,
  followerSellerExitEnabled: false,
  followerSellerExitCount: 1,
  followerSellerExitPct: 100,
  targetInactivityExitEnabled: false,
  targetInactivityHours: 6,
  directTargetSellExitMode: "off",
  directTargetSellExitPct: 100,
  terminalOutflowExitEnabled: false,
  terminalOutflowExitPct: 100,
  targetTerminalOutflowExitEnabled: false,
  targetTerminalOutflowExitPct: 100,
};

const KEY = "helix.bot.config.v1";

export function loadConfig(): Partial<BotConfig> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<BotConfig>;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: BotConfig) {
  if (typeof window === "undefined") return;
  // Never persist the private key in plain localStorage — strip before save.
  // The key is entered per-session and sent to the worker over an authenticated channel.
  const { fundingPrivateKey: _pk, ...safe } = cfg;
  localStorage.setItem(KEY, JSON.stringify(safe));
}
