export type BotConfig = {
  enabled: boolean;
  targetWallet: string;
  additionalTargetWallets: string[];
  fundingPrivateKey: string; // client-side only; encrypted before persistence
  executionRoute: "jito" | "rpc";
  jitoTipSol: number;
  fixedBuyUsd: number;
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
  proportionalFollowerSells: boolean;
};

export const DEFAULT_CONFIG: BotConfig = {
  enabled: false,
  targetWallet: "",
  additionalTargetWallets: [],
  fundingPrivateKey: "",
  executionRoute: "jito",
  jitoTipSol: 0.001,
  fixedBuyUsd: 25,
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
  proportionalFollowerSells: true,
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
