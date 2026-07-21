// Entry-filter pipeline: run before we submit a copy buy.

import { fetch } from "undici";
import type { BotConfigRow } from "./db.js";
import type { SwapEvent } from "./geyser.js";

export type TokenMeta = {
  marketCapUsd?: number;
  liquidityUsd?: number;
  isPumpFun: boolean;
  socials: { website?: string; twitter?: string; telegram?: string };
};

export async function loadTokenMeta(mint: string): Promise<TokenMeta> {
  // Use Birdeye / DexScreener / Pump.fun API — plug your preferred provider.
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const j = (await r.json()) as any;
    const pair = j?.pairs?.[0];
    return {
      marketCapUsd: pair?.fdv,
      liquidityUsd: pair?.liquidity?.usd,
      isPumpFun: (pair?.dexId ?? "").toLowerCase() === "pumpfun" || mint.endsWith("pump"),
      socials: {
        website: pair?.info?.websites?.[0]?.url,
        twitter: pair?.info?.socials?.find((s: any) => s.type === "twitter")?.url,
        telegram: pair?.info?.socials?.find((s: any) => s.type === "telegram")?.url,
      },
    };
  } catch {
    return { isPumpFun: false, socials: {} };
  }
}

export type FilterDecision = { pass: true } | { pass: false; reason: string };

export function checkEntry(cfg: BotConfigRow, event: SwapEvent, meta: TokenMeta, priorBuy: { first: boolean; already: boolean }): FilterDecision {
  if (!cfg.enabled) return { pass: false, reason: "bot disabled" };
  if (event.side !== "buy") return { pass: false, reason: "not a buy" };
  if (event.amountUsd !== undefined && event.amountUsd < cfg.min_target_buy_usd)
    return { pass: false, reason: `target buy $${event.amountUsd?.toFixed(0)} < min $${cfg.min_target_buy_usd}` };

  if (meta.marketCapUsd !== undefined) {
    if (meta.marketCapUsd < cfg.mc_min_usd || meta.marketCapUsd > cfg.mc_max_usd)
      return { pass: false, reason: `MC out of range` };
  }
  if (meta.liquidityUsd !== undefined) {
    if (meta.liquidityUsd < cfg.liq_min_usd || meta.liquidityUsd > cfg.liq_max_usd)
      return { pass: false, reason: `liquidity out of range` };
  }
  if (cfg.pump_fun_only && !meta.isPumpFun) return { pass: false, reason: "not pump.fun" };
  if (cfg.require_socials && !(meta.socials.website || meta.socials.twitter || meta.socials.telegram))
    return { pass: false, reason: "no socials" };
  if (cfg.only_first_buy_ever && !priorBuy.first) return { pass: false, reason: "not target's first buy" };
  if (cfg.only_once_per_token && priorBuy.already) return { pass: false, reason: "already traded this token" };
  return { pass: true };
}
