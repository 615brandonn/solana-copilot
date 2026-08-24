import { fetch } from "undici";
import type { RevivalCampaignSnapshot, RevivalMarketSnapshot } from "./revival-types.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function timestampMs(value: unknown): number | undefined {
  const parsed = finite(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
}

function pairContainsMint(pair: UnknownRecord, mint: string): boolean {
  const base = record(pair.baseToken);
  // DexScreener priceUsd/marketCap/fdv describe the base token. Accepting a
  // quote-token match would attribute the other token's valuation to `mint`.
  return text(base?.address) === mint;
}

function tokenForMint(pair: UnknownRecord, mint: string): UnknownRecord | undefined {
  const base = record(pair.baseToken);
  if (text(base?.address) === mint) return base;
  return undefined;
}

function txnCount(pair: UnknownRecord, window: string, side: "buys" | "sells") {
  return finite(record(record(pair.txns)?.[window])?.[side]);
}

export function revivalMarketSnapshotFromDexScreener(
  payload: unknown,
  mint: string,
  observedAtMs = Date.now(),
): RevivalMarketSnapshot {
  const root = record(payload);
  const pairs = Array.isArray(root?.pairs)
    ? root.pairs
        .map(record)
        .filter((pair): pair is UnknownRecord => Boolean(pair))
        .filter(
          (pair) =>
            String(pair.chainId ?? "").toLowerCase() === "solana" && pairContainsMint(pair, mint),
        )
    : [];
  const pair = pairs.sort(
    (left, right) =>
      (finite(record(right.liquidity)?.usd) ?? 0) - (finite(record(left.liquidity)?.usd) ?? 0),
  )[0];
  if (!pair) {
    return {
      provider: "dexscreener",
      observedAtMs,
      reliable: false,
      reason: "no_solana_pair",
    };
  }

  const token = tokenForMint(pair, mint);
  const marketCapUsd = finite(pair.marketCap);
  const fdvUsd = finite(pair.fdv);
  const volume = record(pair.volume);
  const boosts = record(pair.boosts);
  return {
    provider: "dexscreener",
    observedAtMs,
    pairAddress: text(pair.pairAddress),
    dexId: text(pair.dexId),
    symbol: text(token?.symbol)?.slice(0, 32),
    priceUsd: finite(pair.priceUsd),
    // Market cap and FDV remain separate. FDV is not silently substituted for
    // the requested $2k-$15k seed market-cap admission rule.
    marketCapUsd,
    fdvUsd,
    valuationKind:
      marketCapUsd !== undefined ? "market_cap" : fdvUsd !== undefined ? "fdv" : "unknown",
    liquidityUsd: finite(record(pair.liquidity)?.usd),
    volumeM5Usd: finite(volume?.m5),
    volumeH1Usd: finite(volume?.h1),
    volumeH6Usd: finite(volume?.h6),
    volumeH24Usd: finite(volume?.h24),
    buysM5: txnCount(pair, "m5", "buys"),
    sellsM5: txnCount(pair, "m5", "sells"),
    buysH1: txnCount(pair, "h1", "buys"),
    sellsH1: txnCount(pair, "h1", "sells"),
    buysH24: txnCount(pair, "h24", "buys"),
    sellsH24: txnCount(pair, "h24", "sells"),
    activeBoosts: finite(boosts?.active),
    pairCreatedAtMs: timestampMs(pair.pairCreatedAt),
    reliable: marketCapUsd !== undefined,
    reason: marketCapUsd === undefined ? "market_cap_unavailable_fdv_not_substituted" : undefined,
  };
}

export async function loadRevivalMarketSnapshot(
  mint: string,
  timeoutMs = 4_000,
): Promise<RevivalMarketSnapshot> {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return {
        provider: "dexscreener",
        observedAtMs: Date.now(),
        reliable: false,
        reason: `http_${response.status}`,
      };
    }
    const payload = await response.json();
    return revivalMarketSnapshotFromDexScreener(payload, mint, Date.now());
  } catch {
    return {
      provider: "dexscreener",
      observedAtMs: Date.now(),
      reliable: false,
      reason: "provider_unavailable",
    };
  }
}

export type RevivalSeedMarketRetryOptions = {
  /** Hard wall-clock bound measured from the first unreliable response. */
  maxRetryWindowMs?: number;
  /** Optional earlier campaign eligibility deadline. */
  deadlineAtMs?: number;
  requestTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  load?: (mint: string, timeoutMs: number) => Promise<RevivalMarketSnapshot>;
};

export type RevivalMarketSamplingMode = "skip" | "seed_retry" | "single";

export function revivalMarketSamplingMode(
  campaign: RevivalCampaignSnapshot | undefined,
): RevivalMarketSamplingMode {
  if (!campaign) return "skip";
  if (campaign.eligibilityStatus !== "pending_market_data") return "single";
  // A recovered seed can never receive a causal point-in-time admission
  // quote. Retrying it would only stall confirmed-RPC catch-up for an outcome
  // the engine must reject, so let the durable clock close its coverage gap.
  return campaign.seedHistorical ? "skip" : "seed_retry";
}

const wait = (delayMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });

/**
 * Retry a missing seed quote without allowing unbounded provider work.
 *
 * This is intentionally used only while seed admission is unresolved. Normal
 * campaign snapshots make one request and defer to the next sweep. The first
 * unreliable response starts the 15-second budget, and an earlier campaign
 * deadline always wins.
 */
export async function loadRevivalSeedMarketSnapshotWithRetry(
  mint: string,
  options: RevivalSeedMarketRetryOptions = {},
): Promise<RevivalMarketSnapshot> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const load = options.load ?? loadRevivalMarketSnapshot;
  const requestTimeoutMs = Math.max(1, Math.trunc(options.requestTimeoutMs ?? 4_000));
  const maxRetryWindowMs = Math.max(0, Math.trunc(options.maxRetryWindowMs ?? 15_000));
  const retryDelaysMs = options.retryDelaysMs ?? [250, 750, 1_500, 3_000, 5_000];

  let attempts = 1;
  let latest = await load(mint, requestTimeoutMs);
  if (latest.reliable) return { ...latest, attemptCount: attempts };

  const retryDeadline = Math.min(
    now() + maxRetryWindowMs,
    options.deadlineAtMs ?? Number.POSITIVE_INFINITY,
  );
  for (const configuredDelay of retryDelaysMs) {
    const remainingBeforeDelay = retryDeadline - now();
    if (remainingBeforeDelay <= 0) break;
    const delayMs = Math.min(Math.max(0, Math.trunc(configuredDelay)), remainingBeforeDelay);
    if (delayMs > 0) await sleep(delayMs);
    const remainingForRequest = retryDeadline - now();
    if (remainingForRequest <= 0) break;
    attempts += 1;
    latest = await load(mint, Math.max(1, Math.min(requestTimeoutMs, remainingForRequest)));
    if (latest.reliable) return { ...latest, attemptCount: attempts };
  }

  return {
    ...latest,
    attemptCount: attempts,
    retryWindowExhausted: now() >= retryDeadline,
    reason: latest.reason ?? "seed_market_retry_exhausted",
  };
}
