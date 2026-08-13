// Entry-filter pipeline: run before we submit a copy buy.

import { fetch } from "undici";
import type { BotConfigRow } from "./db.js";
import type { SwapEvent } from "./geyser.js";

export type TokenMeta = {
  symbol?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  pairCreatedAtMs?: number;
  isPumpFun: boolean;
  socials: { website?: string; twitter?: string; telegram?: string };
};

function normalizedTimestampMs(value: unknown): number | undefined {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export async function loadTokenMeta(mint: string): Promise<TokenMeta> {
  // Use Birdeye / DexScreener / Pump.fun API — plug your preferred provider.
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(1_200),
    });
    const j = (await r.json()) as any;
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    const pair = pairs[0];
    if (!pair) return { isPumpFun: mint.endsWith("pump"), socials: {} };
    const pairCreatedAtValues = pairs
      .map((candidate: any) => normalizedTimestampMs(candidate?.pairCreatedAt))
      .filter((timestamp: number | undefined): timestamp is number => timestamp !== undefined);
    const requestedToken =
      pair?.baseToken?.address === mint
        ? pair.baseToken
        : pair?.quoteToken?.address === mint
          ? pair.quoteToken
          : pair?.baseToken;
    return {
      symbol:
        typeof requestedToken?.symbol === "string" && requestedToken.symbol.trim()
          ? requestedToken.symbol.trim().slice(0, 32)
          : undefined,
      marketCapUsd: finiteNumber(pair?.marketCap ?? pair?.fdv),
      liquidityUsd: finiteNumber(pair?.liquidity?.usd),
      pairCreatedAtMs:
        pairCreatedAtValues.length > 0 ? Math.min(...pairCreatedAtValues) : undefined,
      isPumpFun: (pair?.dexId ?? "").toLowerCase() === "pumpfun" || mint.endsWith("pump"),
      socials: {
        website: pair?.info?.websites?.[0]?.url,
        twitter: pair?.info?.socials?.find((s: any) => s.type === "twitter")?.url,
        telegram: pair?.info?.socials?.find((s: any) => s.type === "telegram")?.url,
      },
    };
  } catch {
    return { isPumpFun: mint.endsWith("pump"), socials: {} };
  }
}

export type FilterDecision = { pass: true } | { pass: false; reason: string };

export function checkEntry(
  cfg: BotConfigRow,
  event: SwapEvent,
  meta: TokenMeta,
  priorBuy: { first: boolean; already: boolean },
  nowMs = Date.now(),
): FilterDecision {
  if (!cfg.enabled) return { pass: false, reason: "bot disabled" };
  if (event.side !== "buy") return { pass: false, reason: "not a buy" };
  if (cfg.min_target_buy_usd > 0 && event.amountUsd === undefined)
    return { pass: false, reason: "target buy size unavailable" };
  if (event.amountUsd !== undefined && event.amountUsd < cfg.min_target_buy_usd)
    return {
      pass: false,
      reason: `target buy $${event.amountUsd.toFixed(0)} < min $${cfg.min_target_buy_usd}`,
    };

  if (meta.marketCapUsd === undefined) return { pass: false, reason: "market cap unavailable" };
  if (meta.marketCapUsd < cfg.mc_min_usd || meta.marketCapUsd > cfg.mc_max_usd)
    return { pass: false, reason: "MC out of range" };
  if (meta.liquidityUsd === undefined) return { pass: false, reason: "liquidity unavailable" };
  if (meta.liquidityUsd < cfg.liq_min_usd || meta.liquidityUsd > cfg.liq_max_usd)
    return { pass: false, reason: "liquidity out of range" };

  if (cfg.token_age_filter_enabled) {
    if (meta.pairCreatedAtMs === undefined) return { pass: false, reason: "token age unavailable" };
    const ageMinutes = Math.max(0, (nowMs - meta.pairCreatedAtMs) / 60_000);
    if (ageMinutes < cfg.token_age_min_minutes || ageMinutes > cfg.token_age_max_minutes) {
      return {
        pass: false,
        reason: `token age ${ageMinutes.toFixed(1)}m outside ${cfg.token_age_min_minutes}-${cfg.token_age_max_minutes}m`,
      };
    }
  }
  if (cfg.pump_fun_only && !meta.isPumpFun) return { pass: false, reason: "not pump.fun" };
  if (
    cfg.require_socials &&
    !(meta.socials.website || meta.socials.twitter || meta.socials.telegram)
  )
    return { pass: false, reason: "no socials" };
  if (cfg.only_first_buy_ever && !priorBuy.first)
    return { pass: false, reason: "not target's first buy" };
  if (cfg.only_once_per_token && priorBuy.already)
    return { pass: false, reason: "already traded this token" };
  return { pass: true };
}
