import type { BotConfigRow } from "./db.js";
import type { TokenMeta } from "./filters.js";

export type TargetBuyObservation = {
  wallet: string;
  tokenMint: string;
  amountUsd: number | undefined;
  firstBuy: boolean;
  timestampMs: number;
  txSig: string;
  slot: number;
  decimals: number;
};

export type CoordinationDecision =
  | { ready: false; reason: string; qualifyingWallets: number }
  | { ready: true; observations: TargetBuyObservation[]; qualifyingWallets: number };

function eventKey(observation: TargetBuyObservation) {
  return `${observation.wallet}:${observation.tokenMint}:${observation.txSig || observation.slot}`;
}

export class CoordinatedBuyTracker {
  private byMint = new Map<string, Map<string, TargetBuyObservation>>();
  private seen = new Map<string, number>();
  private lastTriggerFingerprint = new Map<string, string>();

  record(cfg: BotConfigRow, observation: TargetBuyObservation): CoordinationDecision {
    const nowMs = observation.timestampMs;
    const windowMs = Math.max(1, Number(cfg.coordinated_window_seconds)) * 1000;
    this.prune(nowMs, windowMs);

    const key = eventKey(observation);
    if (this.seen.has(key)) {
      return {
        ready: false,
        reason: "duplicate target transaction",
        qualifyingWallets: this.byMint.get(observation.tokenMint)?.size ?? 0,
      };
    }
    this.seen.set(key, nowMs);

    if (observation.amountUsd === undefined) {
      return { ready: false, reason: "target buy size unavailable", qualifyingWallets: 0 };
    }
    if (
      observation.amountUsd < Number(cfg.coordinated_target_buy_min_usd) ||
      observation.amountUsd > Number(cfg.coordinated_target_buy_max_usd)
    ) {
      return {
        ready: false,
        reason: "target buy outside coordinated USD range",
        qualifyingWallets: 0,
      };
    }
    if (cfg.coordinated_first_buy_only && !observation.firstBuy) {
      return { ready: false, reason: "not target wallet's first buy", qualifyingWallets: 0 };
    }

    const observations = this.byMint.get(observation.tokenMint) ?? new Map();
    observations.set(observation.wallet, observation);
    this.byMint.set(observation.tokenMint, observations);

    const matched = Array.from(observations.values())
      .filter((candidate) => nowMs - candidate.timestampMs <= windowMs)
      .sort((a, b) => a.timestampMs - b.timestampMs);
    const required = Math.max(2, Math.floor(Number(cfg.coordinated_target_wallet_count)));
    if (matched.length < required) {
      return {
        ready: false,
        reason: `waiting for ${required - matched.length} more target wallet(s)`,
        qualifyingWallets: matched.length,
      };
    }

    const selected = matched.slice(-required);
    const fingerprint = selected
      .map((candidate) => eventKey(candidate))
      .sort()
      .join("|");
    if (this.lastTriggerFingerprint.get(observation.tokenMint) === fingerprint) {
      return {
        ready: false,
        reason: "coordinated cluster already triggered",
        qualifyingWallets: matched.length,
      };
    }
    this.lastTriggerFingerprint.set(observation.tokenMint, fingerprint);
    return { ready: true, observations: selected, qualifyingWallets: matched.length };
  }

  private prune(nowMs: number, windowMs: number) {
    for (const [key, timestampMs] of this.seen) {
      if (nowMs - timestampMs > Math.max(windowMs * 2, 60_000)) this.seen.delete(key);
    }
    for (const [mint, observations] of this.byMint) {
      for (const [wallet, observation] of observations) {
        if (nowMs - observation.timestampMs > windowMs) observations.delete(wallet);
      }
      if (observations.size === 0) this.byMint.delete(mint);
    }
  }
}

export type CoordinatedEntryDecision = { pass: true } | { pass: false; reason: string };

export function checkCoordinatedEntry(
  cfg: BotConfigRow,
  meta: TokenMeta,
  alreadyTraded: boolean,
  nowMs = Date.now(),
): CoordinatedEntryDecision {
  if (meta.marketCapUsd === undefined) return { pass: false, reason: "market cap unavailable" };
  if (
    meta.marketCapUsd < Number(cfg.coordinated_mc_min_usd) ||
    meta.marketCapUsd > Number(cfg.coordinated_mc_max_usd)
  ) {
    return { pass: false, reason: "coordinated market cap out of range" };
  }
  if (meta.pairCreatedAtMs === undefined) return { pass: false, reason: "coin age unavailable" };
  const ageMinutes = Math.max(0, (nowMs - meta.pairCreatedAtMs) / 60_000);
  if (
    ageMinutes < Number(cfg.coordinated_coin_age_min_minutes) ||
    ageMinutes > Number(cfg.coordinated_coin_age_max_minutes)
  ) {
    return {
      pass: false,
      reason: `coin age ${ageMinutes.toFixed(1)}m outside ${cfg.coordinated_coin_age_min_minutes}-${cfg.coordinated_coin_age_max_minutes}m`,
    };
  }
  if (cfg.coordinated_once_per_token && alreadyTraded) {
    return { pass: false, reason: "already copied this coin" };
  }
  return { pass: true };
}

export function inactivityDeadlineMs(lastTargetBuyAt: string | number | Date, hours: number) {
  const timestamp = new Date(lastTargetBuyAt).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  return timestamp + Math.max(0, Number(hours)) * 60 * 60_000;
}

export function shouldTriggerDistinctSellerExit(
  distinctSellerCount: number,
  requiredSellerCount: number,
  alreadyTriggered: boolean,
) {
  if (alreadyTriggered) return false;
  return (
    Math.max(0, Math.floor(distinctSellerCount)) >= Math.max(1, Math.floor(requiredSellerCount))
  );
}
