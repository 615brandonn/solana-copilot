import { fetch } from "undici";
import { env } from "./env.js";
import { parseJupiterPrice } from "./price-parser.js";

const PRICE_CACHE_TTL_MS = 2_500;
const priceCache = new Map<string, { value: number; expiresAt: number }>();
const inFlight = new Map<string, Promise<number | undefined>>();

export async function priceUsd(mint: string): Promise<number | undefined> {
  const cached = priceCache.get(mint);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = inFlight.get(mint);
  if (pending) return pending;

  const request = fetchPriceUsd(mint).finally(() => inFlight.delete(mint));
  inFlight.set(mint, request);
  const value = await request;
  if (value !== undefined) {
    priceCache.set(mint, { value, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
  }
  return value;
}

async function fetchPriceUsd(mint: string): Promise<number | undefined> {
  try {
    const url = new URL(env.PRICE_API_URL);
    url.searchParams.set("ids", mint);
    const headers = env.JUPITER_API_KEY ? { "x-api-key": env.JUPITER_API_KEY } : undefined;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(1_500) });
    if (response.ok) {
      const parsed = parseJupiterPrice(await response.json(), mint);
      if (parsed !== undefined) return parsed;
    }
  } catch {
    // Fall through to an independent public price source.
  }

  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { pairs?: unknown[] };
    const candidates = (Array.isArray(payload.pairs) ? payload.pairs : [])
      .map((pair) => {
        if (!pair || typeof pair !== "object") return undefined;
        const row = pair as Record<string, unknown>;
        const price = Number(row.priceUsd);
        const liquidity = Number(
          row.liquidity && typeof row.liquidity === "object"
            ? (row.liquidity as Record<string, unknown>).usd
            : 0,
        );
        if (!Number.isFinite(price) || price <= 0) return undefined;
        return { price, liquidity: Number.isFinite(liquidity) ? liquidity : 0 };
      })
      .filter((row): row is { price: number; liquidity: number } => row !== undefined)
      .sort((a, b) => b.liquidity - a.liquidity);
    return candidates[0]?.price;
  } catch {
    return undefined;
  }
}
