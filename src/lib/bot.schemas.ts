import { z } from "zod";

export const BotConfigSchema = z.object({
  enabled: z.boolean(),
  targetWallet: z.string(),
  executionRoute: z.enum(["jito", "rpc"]),
  jitoTipSol: z.number(),
  fixedBuyUsd: z.number(),
  minTargetBuyUsd: z.number(),
  mcMinUsd: z.number(),
  mcMaxUsd: z.number(),
  liqMinUsd: z.number(),
  liqMaxUsd: z.number(),
  pumpFunOnly: z.boolean(),
  requireSocials: z.boolean(),
  onlyFirstBuyEver: z.boolean(),
  onlyOncePerToken: z.boolean(),
  takeProfitEnabled: z.boolean(),
  takeProfitPct: z.number(),
  takeProfitSellPct: z.number(),
  stopLossEnabled: z.boolean(),
  stopLossPct: z.number(),
  proportionalFollowerSells: z.boolean(),
});

export const FundingKeySchema = z.object({
  privateKey: z.string().min(32),
});