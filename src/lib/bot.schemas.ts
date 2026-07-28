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
    minTargetBuyUsd: z.number().finite().min(0).max(1_000_000_000),
    mcMinUsd: z.number().finite().min(0),
    mcMaxUsd: z.number().finite().min(0),
    liqMinUsd: z.number().finite().min(0),
    liqMaxUsd: z.number().finite().min(0),
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
  })
  .refine((config) => config.mcMinUsd <= config.mcMaxUsd, {
    message: "Market-cap minimum cannot exceed maximum",
    path: ["mcMaxUsd"],
  })
  .refine((config) => config.liqMinUsd <= config.liqMaxUsd, {
    message: "Liquidity minimum cannot exceed maximum",
    path: ["liqMaxUsd"],
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
