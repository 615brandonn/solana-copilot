import { z } from "zod";
import { decodeBase58, isSolanaPublicKey } from "./base58";

export const BotConfigSchema = z
  .object({
    enabled: z.boolean(),
    targetWallet: z
      .string()
      .trim()
      .refine((value) => value === "" || isSolanaPublicKey(value), "Invalid Solana target wallet"),
    additionalTargetWallets: z
      .array(z.string().trim().refine(isSolanaPublicKey, "Invalid additional target wallet"))
      .max(20, "You can add up to 20 additional target wallets"),
    executionRoute: z.enum(["jito", "rpc"]),
    jitoTipSol: z.number().finite().min(0).max(1),
    fixedBuyUsd: z.number().finite().positive().max(1_000_000),
    convictionModeEnabled: z.boolean(),
    convictionTradingMode: z.enum(["shadow", "live"]),
    convictionRapidFollowEnabled: z.boolean(),
    convictionPrimaryWindowMinutes: z.union([z.literal(5), z.literal(30), z.literal(60)]),
    convictionScoreThreshold: z.number().finite().min(0).max(100),
    convictionTopN: z.number().int().min(1).max(10),
    convictionMinCommitmentUsd: z.number().finite().min(0).max(1_000_000_000),
    convictionMinRecentNetInflowUsd: z.number().finite().min(0).max(1_000_000_000),
    convictionMinVelocityUsdPerMinute: z.number().finite().min(0).max(1_000_000_000),
    convictionMinAccelerationRatio: z.number().finite().min(0).max(1_000),
    convictionMinConvergedWallets: z.number().int().min(1).max(3),
    convictionTwoWalletWindowSeconds: z.number().int().min(1).max(21_600),
    convictionThreeWalletWindowSeconds: z.number().int().min(1).max(21_600),
    convictionMinIndividualBuyUsd: z.number().finite().min(0).max(1_000_000_000),
    convictionMarketCapFilterEnabled: z.boolean(),
    convictionMarketCapMinUsd: z.number().finite().min(0).max(1_000_000_000),
    convictionMarketCapMaxUsd: z.number().finite().min(0).max(1_000_000_000),
    convictionLiquidityFilterEnabled: z.boolean(),
    convictionLiquidityMinUsd: z.number().finite().min(0).max(1_000_000_000),
    convictionLiquidityMaxUsd: z.number().finite().min(0).max(1_000_000_000),
    convictionTokenAgeFilterEnabled: z.boolean(),
    convictionTokenAgeMinMinutes: z.number().finite().min(0).max(525_600),
    convictionTokenAgeMaxMinutes: z.number().finite().min(0).max(525_600),
    convictionMaxPositionPerTokenUsd: z.number().finite().positive().max(1_000_000),
    convictionDistributionSellRatio: z.number().finite().min(0).max(1),
    convictionDistributionMinSellsUsd: z.number().finite().min(0).max(1_000_000_000),
    convictionDistributionWalletCount: z.number().int().min(1).max(3),
    convictionInactivityMinutes: z.number().finite().positive().max(43_200),
    convictionRankLossGraceSeconds: z.number().int().min(0).max(86_400),
    convictionWeightNetCommitment: z.number().finite().min(0).max(100),
    convictionWeightVelocity: z.number().finite().min(0).max(100),
    convictionWeightAcceleration: z.number().finite().min(0).max(100),
    convictionWeightConvergence: z.number().finite().min(0).max(100),
    convictionWeightPersistence: z.number().finite().min(0).max(100),
    convictionTierCommitmentThresholdsUsd: z
      .array(z.number().finite().positive().max(1_000_000_000))
      .length(4),
    convictionTierBuyAmountsUsd: z.array(z.number().finite().positive().max(1_000_000)).length(4),
    coordinatedModeEnabled: z.boolean(),
    coordinatedFixedBuyUsd: z.number().finite().positive().max(1_000_000),
    coordinatedTargetWalletCount: z.number().int().min(2).max(20),
    coordinatedWindowSeconds: z.number().int().min(1).max(21_600),
    coordinatedMcMinUsd: z.number().finite().min(0).max(1_000_000_000),
    coordinatedMcMaxUsd: z.number().finite().min(0).max(1_000_000_000),
    coordinatedCoinAgeMinMinutes: z.number().finite().min(0).max(525_600),
    coordinatedCoinAgeMaxMinutes: z.number().finite().min(0).max(525_600),
    coordinatedTargetBuyMinUsd: z.number().finite().min(0).max(1_000_000_000),
    coordinatedTargetBuyMaxUsd: z.number().finite().min(0).max(1_000_000_000),
    coordinatedFirstBuyOnly: z.boolean(),
    coordinatedOncePerToken: z.boolean(),
    coordinatedFollowerSellCount: z.number().int().min(1).max(1_000),
    coordinatedFollowerSellPct: z.number().finite().positive().max(100),
    coordinatedInactivityHours: z.number().finite().min(0.05).max(720),
    networkScalingEnabled: z.boolean(),
    starterPositionPct: z.number().finite().positive().max(100),
    maxPositionPct: z.number().finite().positive().max(100),
    newEntryReservePct: z.number().finite().min(0).max(95),
    targetCopyRatioPct: z.number().finite().positive().max(100),
    minScaleBuyUsd: z.number().finite().positive().max(1_000_000),
    minTargetBuyUsd: z.number().finite().min(0).max(1_000_000_000),
    mcMinUsd: z.number().finite().min(0),
    mcMaxUsd: z.number().finite().min(0),
    liqMinUsd: z.number().finite().min(0),
    liqMaxUsd: z.number().finite().min(0),
    tokenAgeFilterEnabled: z.boolean(),
    tokenAgeMinMinutes: z.number().finite().min(0).max(525_600),
    tokenAgeMaxMinutes: z.number().finite().min(0).max(525_600),
    pumpFunOnly: z.boolean(),
    requireSocials: z.boolean(),
    require24hUptrend: z.boolean(),
    largeBuyScannerEnabled: z.boolean(),
    largeBuyScannerMaxMcUsd: z.number().finite().positive().max(1_000_000_000),
    largeBuyScannerMinBuyUsd: z.number().finite().positive().max(1_000_000_000),
    largeBuyScannerMultiplier: z.number().finite().min(1).max(100),
    largeBuyScannerHistoryWindow: z.number().int().min(5).max(200),
    onlyFirstBuyEver: z.boolean(),
    onlyOncePerToken: z.boolean(),
    takeProfitEnabled: z.boolean(),
    takeProfitPct: z.number().finite().min(0).max(100_000),
    takeProfitSellPct: z.number().finite().min(0).max(100),
    stopLossEnabled: z.boolean(),
    stopLossPct: z.number().finite().min(0).max(100),
    proportionalFollowerSells: z.boolean(),
    followerSellerExitEnabled: z.boolean(),
    followerSellerExitCount: z.number().int().min(1).max(1_000),
    followerSellerExitPct: z.number().finite().positive().max(100),
    targetInactivityExitEnabled: z.boolean(),
    targetInactivityHours: z.number().finite().min(0.05).max(720),
    directTargetSellExitMode: z.enum(["off", "proportional", "fixed_pct", "full"]),
    directTargetSellExitPct: z.number().finite().positive().max(100),
    terminalOutflowExitEnabled: z.boolean(),
    terminalOutflowExitPct: z.number().finite().positive().max(100),
    targetTerminalOutflowExitEnabled: z.boolean(),
    targetTerminalOutflowExitPct: z.number().finite().positive().max(100),
  })
  .refine((config) => config.mcMinUsd <= config.mcMaxUsd, {
    message: "Market-cap minimum cannot exceed maximum",
    path: ["mcMaxUsd"],
  })
  .refine((config) => config.coordinatedMcMinUsd <= config.coordinatedMcMaxUsd, {
    message: "Coordinated market-cap minimum cannot exceed maximum",
    path: ["coordinatedMcMaxUsd"],
  })
  .refine((config) => config.coordinatedCoinAgeMinMinutes <= config.coordinatedCoinAgeMaxMinutes, {
    message: "Coordinated coin-age minimum cannot exceed maximum",
    path: ["coordinatedCoinAgeMaxMinutes"],
  })
  .refine((config) => config.coordinatedTargetBuyMinUsd <= config.coordinatedTargetBuyMaxUsd, {
    message: "Coordinated target-buy minimum cannot exceed maximum",
    path: ["coordinatedTargetBuyMaxUsd"],
  })
  .refine((config) => config.liqMinUsd <= config.liqMaxUsd, {
    message: "Liquidity minimum cannot exceed maximum",
    path: ["liqMaxUsd"],
  })
  .refine((config) => config.tokenAgeMinMinutes <= config.tokenAgeMaxMinutes, {
    message: "Token-age minimum cannot exceed maximum",
    path: ["tokenAgeMaxMinutes"],
  })
  .refine((config) => config.starterPositionPct <= config.maxPositionPct, {
    message: "Starter position cannot exceed the per-coin maximum",
    path: ["maxPositionPct"],
  })
  .refine((config) => config.convictionMarketCapMinUsd <= config.convictionMarketCapMaxUsd, {
    message: "Conviction market-cap minimum cannot exceed maximum",
    path: ["convictionMarketCapMaxUsd"],
  })
  .refine((config) => config.convictionLiquidityMinUsd <= config.convictionLiquidityMaxUsd, {
    message: "Conviction liquidity minimum cannot exceed maximum",
    path: ["convictionLiquidityMaxUsd"],
  })
  .refine((config) => config.convictionTokenAgeMinMinutes <= config.convictionTokenAgeMaxMinutes, {
    message: "Conviction token-age minimum cannot exceed maximum",
    path: ["convictionTokenAgeMaxMinutes"],
  })
  .superRefine((config, ctx) => {
    const normalized = config.additionalTargetWallets.map((wallet) => wallet.trim());
    if (new Set(normalized).size !== normalized.length) {
      ctx.addIssue({
        code: "custom",
        message: "Additional target wallets must be unique",
        path: ["additionalTargetWallets"],
      });
    }
    if (config.targetWallet && normalized.includes(config.targetWallet.trim())) {
      ctx.addIssue({
        code: "custom",
        message: "Do not repeat the primary target wallet",
        path: ["additionalTargetWallets"],
      });
    }
    const configuredTargetCount = (config.targetWallet ? 1 : 0) + normalized.length;
    if (config.convictionModeEnabled && configuredTargetCount !== 3) {
      ctx.addIssue({
        code: "custom",
        message: "Conviction Mode requires exactly 3 unique market-maker wallets",
        path: ["convictionModeEnabled"],
      });
    }
    const convictionWeightTotal =
      config.convictionWeightNetCommitment +
      config.convictionWeightVelocity +
      config.convictionWeightAcceleration +
      config.convictionWeightConvergence +
      config.convictionWeightPersistence;
    if (Math.abs(convictionWeightTotal - 100) > 0.000_001) {
      ctx.addIssue({
        code: "custom",
        message: "Conviction score weights must total 100%",
        path: ["convictionWeightPersistence"],
      });
    }
    if (
      config.convictionTierCommitmentThresholdsUsd.some(
        (threshold, index, rows) => index > 0 && threshold <= rows[index - 1],
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Conviction tier commitment thresholds must increase strictly",
        path: ["convictionTierCommitmentThresholdsUsd"],
      });
    }
    const configuredTierExposure = config.convictionTierBuyAmountsUsd.reduce(
      (total, amount) => total + amount,
      0,
    );
    if (configuredTierExposure > config.convictionMaxPositionPerTokenUsd) {
      ctx.addIssue({
        code: "custom",
        message: "Conviction tier buys cannot exceed the per-token exposure cap",
        path: ["convictionMaxPositionPerTokenUsd"],
      });
    }
    if (config.convictionThreeWalletWindowSeconds < config.convictionTwoWalletWindowSeconds) {
      ctx.addIssue({
        code: "custom",
        message: "The 3-wallet convergence window cannot be shorter than the 2-wallet window",
        path: ["convictionThreeWalletWindowSeconds"],
      });
    }
    if (
      config.coordinatedModeEnabled &&
      configuredTargetCount < config.coordinatedTargetWalletCount
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Add at least ${config.coordinatedTargetWalletCount} target wallets before enabling coordinated mode`,
        path: ["coordinatedTargetWalletCount"],
      });
    }
  });

export const FundingKeySchema = z.object({
  privateKey: z
    .string()
    .trim()
    .min(32, "Private key is too short")
    .max(256, "Private key is too long")
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "Paste the base58 private key from Phantom")
    .refine((value) => {
      try {
        return decodeBase58(value).length === 64;
      } catch {
        return false;
      }
    }, "Private key must decode to a 64-byte Solana secret key"),
});
