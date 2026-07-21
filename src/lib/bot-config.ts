export type BotConfig = {
  enabled: boolean;
  targetWallet: string;
  fundingPrivateKey: string; // client-side only; encrypted before persistence
  executionRoute: "jito" | "rpc";
  jitoTipSol: number;
  fixedBuyUsd: number;
  minTargetBuyUsd: number;
  mcMinUsd: number;
  mcMaxUsd: number;
  liqMinUsd: number;
  liqMaxUsd: number;
  pumpFunOnly: boolean;
  requireSocials: boolean;
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
  fundingPrivateKey: "",
  executionRoute: "jito",
  jitoTipSol: 0.001,
  fixedBuyUsd: 25,
  minTargetBuyUsd: 100,
  mcMinUsd: 20_000,
  mcMaxUsd: 5_000_000,
  liqMinUsd: 10_000,
  liqMaxUsd: 2_000_000,
  pumpFunOnly: false,
  requireSocials: true,
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

export function loadConfig(): BotConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(cfg: BotConfig) {
  if (typeof window === "undefined") return;
  // Never persist the private key in plain localStorage — strip before save.
  // The key is entered per-session and sent to the worker over an authenticated channel.
  const { fundingPrivateKey: _pk, ...safe } = cfg;
  localStorage.setItem(KEY, JSON.stringify(safe));
}
