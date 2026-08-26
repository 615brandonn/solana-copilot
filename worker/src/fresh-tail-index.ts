// Observation-only finalized fresh-tail process. This file intentionally does
// not import the executor, funding keys, positions, claims, or the main worker.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createClient } from "@supabase/supabase-js";
import { Connection, PublicKey } from "@solana/web3.js";
import pino from "pino";
import { fetch, WebSocket } from "undici";
import { z } from "zod";
import {
  FreshTailObserver,
  FreshTailObserverError,
  type FreshTailObserverConfig,
  type FreshTailSolPriceQuote,
} from "./fresh-tail-observer.js";
import {
  createSupabaseFreshTailStore,
  type FreshTailDbClient,
} from "./fresh-tail-store.js";
import { safeDiagnostic } from "./diagnostics.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const LOOP_DELAY_MS = 750;
const SUPABASE_TIMEOUT_MS = 8_000;

const ObserverEnv = z.object({
  BOT_SUPABASE_URL: z.string().url(),
  BOT_SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  RPC_URL: z.string().url(),
  HELIX_USER_ID: z.string().uuid(),
  PRICE_API_URL: z.string().url().default("https://api.jup.ag/price/v3"),
  JUPITER_API_KEY: z.string().min(1).optional(),
  LOG_LEVEL: z.string().default("info"),
  FRESH_TAIL_SHADOW: z
    .string()
    .optional()
    .transform((value) => value !== "false" && value !== "0"),
});

const env = ObserverEnv.parse(process.env);
const log = pino({ level: env.LOG_LEVEL });

function baseSupabaseUrl(value: string): string {
  let normalized = value.trim().replace(/\/+$/, "");
  if (normalized.toLowerCase().endsWith("/rest/v1")) {
    normalized = normalized.slice(0, -"/rest/v1".length).replace(/\/+$/, "");
  }
  return normalized;
}

const db = createClient(
  baseSupabaseUrl(env.BOT_SUPABASE_URL),
  env.BOT_SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("apikey", env.BOT_SUPABASE_SERVICE_ROLE_KEY);
        if (
          env.BOT_SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_") &&
          headers.get("Authorization") === `Bearer ${env.BOT_SUPABASE_SERVICE_ROLE_KEY}`
        ) {
          headers.delete("Authorization");
        }
        const timeout = AbortSignal.timeout(SUPABASE_TIMEOUT_MS);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        return fetch(input as Parameters<typeof fetch>[0], {
          ...init,
          headers,
          signal,
        } as Parameters<typeof fetch>[1]) as unknown as Promise<Response>;
      },
    },
  },
);

function wallet(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new PublicKey(value.trim()).toBase58();
  } catch {
    return null;
  }
}

async function loadConfig(): Promise<FreshTailObserverConfig> {
  const result = await db
    .from("bot_config")
    .select(
      "enabled,target_wallet,additional_target_wallets,supply_accumulation_mode_enabled,custody_journey_enabled,supply_accumulation_window_seconds",
    )
    .eq("user_id", env.HELIX_USER_ID)
    .maybeSingle();
  if (result.error) {
    throw new Error(`fresh-tail config load failed: ${safeDiagnostic(result.error)}`);
  }
  if (!result.data) throw new Error("fresh-tail bot_config row is missing");
  const roots = [
    result.data.target_wallet,
    ...(Array.isArray(result.data.additional_target_wallets)
      ? result.data.additional_target_wallets
      : []),
  ]
    .map(wallet)
    .filter((value): value is string => value !== null)
    .sort();
  if (roots.length !== 3 || new Set(roots).size !== 3) {
    throw new Error("fresh-tail requires exactly three unique configured target wallets");
  }
  const windowSeconds = Number(result.data.supply_accumulation_window_seconds ?? 30);
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 30 || windowSeconds > 3_600) {
    throw new Error("fresh-tail accumulation window must be an integer from 30 to 3600 seconds");
  }
  return {
    observerEnabled:
      result.data.supply_accumulation_mode_enabled === true &&
      result.data.custody_journey_enabled === true,
    entriesEnabled: result.data.enabled === true,
    shadow: env.FRESH_TAIL_SHADOW,
    rootWallets: roots as [string, string, string],
    windowSeconds,
  };
}

function jupiterSolPrice(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const direct = row[WSOL_MINT];
  const nested = row.data && typeof row.data === "object"
    ? (row.data as Record<string, unknown>)[WSOL_MINT]
    : undefined;
  for (const candidate of [direct, nested]) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const price = Number(record.usdPrice ?? record.price);
    if (Number.isFinite(price) && price > 0 && price <= 100_000) return price;
  }
  return null;
}

function dexSolPrice(payload: unknown): number | null {
  const pairs =
    payload && typeof payload === "object" && Array.isArray((payload as any).pairs)
      ? ((payload as any).pairs as unknown[])
      : [];
  const candidates = pairs.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    const base = row.baseToken as Record<string, unknown> | undefined;
    if (String(base?.address ?? "") !== WSOL_MINT) return [];
    const price = Number(row.priceUsd);
    const liquidity = Number((row.liquidity as Record<string, unknown> | undefined)?.usd ?? 0);
    return Number.isFinite(price) && price > 0 && price <= 100_000
      ? [{ price, liquidity: Number.isFinite(liquidity) ? liquidity : 0 }]
      : [];
  });
  candidates.sort((left, right) => right.liquidity - left.liquidity);
  return candidates[0]?.price ?? null;
}

let cachedPrice: FreshTailSolPriceQuote | null = null;

async function solPrice(deadlineMs: number): Promise<FreshTailSolPriceQuote> {
  const now = Date.now();
  if (cachedPrice && now - cachedPrice.observedAtMs <= 2_500) return cachedPrice;
  const timeoutMs = Math.max(1, Math.min(1_500, deadlineMs - now));
  if (timeoutMs <= 0) throw new Error("SOL/USD price deadline elapsed");
  try {
    const url = new URL(env.PRICE_API_URL);
    url.searchParams.set("ids", WSOL_MINT);
    const response = await fetch(url, {
      headers: env.JUPITER_API_KEY ? { "x-api-key": env.JUPITER_API_KEY } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      const usd = jupiterSolPrice(await response.json());
      if (usd !== null) {
        cachedPrice = { usd, observedAtMs: Date.now() };
        return cachedPrice;
      }
    }
  } catch {
    // Fall through to the independent public source within the same deadline.
  }
  const fallbackNow = Date.now();
  const fallbackTimeout = Math.max(1, Math.min(1_500, deadlineMs - fallbackNow));
  if (fallbackTimeout <= 0) throw new Error("SOL/USD fallback deadline elapsed");
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WSOL_MINT}`, {
    signal: AbortSignal.timeout(fallbackTimeout),
  });
  if (!response.ok) throw new Error(`SOL/USD fallback returned HTTP ${response.status}`);
  const usd = dexSolPrice(await response.json());
  if (usd === null) throw new Error("SOL/USD fallback response is malformed");
  cachedPrice = { usd, observedAtMs: Date.now() };
  return cachedPrice;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const rpc = new Connection(env.RPC_URL, { commitment: "finalized" });
  const store = createSupabaseFreshTailStore(
    db as unknown as FreshTailDbClient,
    env.HELIX_USER_ID,
  );
  // This identity is intentionally different after every process restart.
  // Lease continuation is possible only through this process's prior CAS token.
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  const observer = new FreshTailObserver({ rpc, store, workerId, getSolPriceUsd: solPrice });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log.info(
    { workerId, shadow: env.FRESH_TAIL_SHADOW },
    "fresh-tail observation-only process started",
  );
  while (!stopping) {
    try {
      const config = await loadConfig();
      const result = await observer.cycle(config);
      log.info(
        {
          status: result.status,
          epochId: result.epochId,
          leaseGeneration: result.leaseGeneration,
          headSlot: result.finalizedHeadSlot,
          requestsSettled: result.requestsSettled,
          enabled: config.observerEnabled,
          shadow: config.shadow,
        },
        "fresh-tail cycle complete",
      );
    } catch (error) {
      const retryable = error instanceof FreshTailObserverError ? error.retryable : true;
      log.error(
        { error: safeDiagnostic(error), retryable },
        "fresh-tail cycle failed closed; no trading path was invoked",
      );
      await delay(retryable ? LOOP_DELAY_MS : 5_000);
    }
    if (!stopping) await delay(LOOP_DELAY_MS);
  }
  log.info("fresh-tail observation-only process stopped");
}

main().catch((error) => {
  log.fatal({ error: safeDiagnostic(error) }, "fresh-tail process failed to start");
  process.exitCode = 1;
});
