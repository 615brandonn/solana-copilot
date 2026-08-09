import { createServerFn } from "@tanstack/react-start";
import type { BotConfig } from "./bot-config";
import { BotConfigSchema, FundingKeySchema } from "./bot.schemas";
import {
  adminClient,
  configToRow,
  currentUserId,
  rowToConfig,
  saveFundingKeyRecord,
} from "./bot.server";

export const getBotConfig = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await (db as any)
    .from("bot_config")
    .select("*")
    .eq("user_id", currentUserId())
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return rowToConfig(data);
});

export const saveBotConfig = createServerFn({ method: "POST" })
  .validator((data) => BotConfigSchema.parse(data))
  .handler(async ({ data }) => {
    const db = adminClient();
    const row = configToRow(data as BotConfig);
    try {
      const { error } = await db.from("bot_config").upsert(row as any, { onConflict: "user_id" });
      if (error) {
        console.error("[saveBotConfig] Supabase error", error);
        throw new Error(`Supabase: ${error.message} (${error.code ?? "no code"})`);
      }
      return { ok: true };
    } catch (e: any) {
      console.error("[saveBotConfig] exception", e);
      throw new Error(e.message ?? "Unknown save error");
    }
  });

export const saveFundingKey = createServerFn({ method: "POST" })
  .validator((data) => FundingKeySchema.parse(data))
  .handler(async ({ data }) => {
    return saveFundingKeyRecord(data.privateKey);
  });

export const getFundingKeyStatus = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const userId = currentUserId();
  const { data, error } = await (db as any)
    .from("funding_keys")
    .select("wallet_pubkey")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) {
    return {
      saved: true,
      walletPubkey: data.wallet_pubkey ?? null,
      identityMismatch: false,
    };
  }

  const { data: otherRows, error: otherError } = await (db as any)
    .from("funding_keys")
    .select("user_id")
    .neq("user_id", userId)
    .limit(1);
  if (otherError) throw new Error(otherError.message);
  return {
    saved: false,
    walletPubkey: null,
    identityMismatch: (otherRows?.length ?? 0) > 0,
  };
});

export const getWorkerStatus = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const userId = currentUserId();
  const { data, error } = await (db as any)
    .from("worker_heartbeat")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const { data: otherRows, error: otherError } = await (db as any)
      .from("worker_heartbeat")
      .select("user_id,updated_at")
      .neq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (otherError) throw new Error(otherError.message);
    return {
      online: false,
      updatedAt: null,
      geyserConnected: false,
      decodedEventCount: 0,
      fundingKeyReady: null,
      fundingKeyCheckedAt: null,
      fundingWalletPubkey: null,
      lastError: null,
      identityMismatch: (otherRows?.length ?? 0) > 0,
    };
  }
  const updatedAtMs = new Date(data.updated_at).getTime();
  const online = Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < 45_000;
  return {
    online,
    updatedAt: data.updated_at,
    geyserConnected: data.geyser_connected,
    decodedEventCount: Number(data.decoded_event_count),
    fundingKeyReady:
      typeof data.funding_key_ready === "boolean" ? data.funding_key_ready : null,
    fundingKeyCheckedAt: data.funding_key_checked_at ?? null,
    fundingWalletPubkey: data.funding_wallet_pubkey ?? null,
    lastError: data.last_error ?? null,
    identityMismatch: false,
  };
});

export const getTrades = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await db
    .from("trades")
    .select("*")
    .eq("user_id", currentUserId())
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getPositions = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await db
    .from("positions")
    .select("*")
    .eq("user_id", currentUserId())
    .is("closed_at", null)
    .order("opened_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getWalletHoldings = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await (db as any)
    .from("worker_heartbeat")
    .select("wallet_holdings")
    .eq("user_id", currentUserId())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Array.isArray(data?.wallet_holdings) ? data.wallet_holdings : [];
});

export const getFollowers = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data: positionsRaw, error: posErr } = await db
    .from("positions")
    .select("id, token_mint")
    .eq("user_id", currentUserId())
    .is("closed_at", null);
  if (posErr) throw new Error(posErr.message);
  const positions = (positionsRaw ?? []) as Array<{ id: string; token_mint: string }>;
  const posIds = positions.map((p) => p.id);
  const mintByPos = new Map(positions.map((p) => [p.id, p.token_mint]));
  type ManagedFollower = {
    wallet: string;
    position_id: string;
    initial_amount: number | string;
    current_amount: number | string;
    hop_depth: number | null;
    last_updated: string;
  };
  let fws: ManagedFollower[] = [];
  if (posIds.length > 0) {
    const { data: fwsRaw, error: fwErr } = await (db as any)
      .from("follower_wallets")
      .select("wallet, position_id, initial_amount, current_amount, hop_depth, last_updated")
      .in("position_id", posIds)
      .order("last_updated", { ascending: false });
    if (fwErr) throw new Error(fwErr.message);
    fws = (fwsRaw ?? []) as ManagedFollower[];
  }

  const managed = fws.map((f) => {
    const initial = Number(f.initial_amount) || 0;
    const current = Number(f.current_amount) || 0;
    const heldPct = initial > 0 ? Math.max(0, Math.min(100, (current / initial) * 100)) : 0;
    return {
      wallet: f.wallet,
      position_id: f.position_id,
      token_mint: mintByPos.get(f.position_id) ?? "",
      current_amount: current,
      held_pct: heldPct,
      hop_depth: Math.max(1, Math.min(3, Number(f.hop_depth ?? 1))),
      last_updated: f.last_updated,
      observed_only: false,
      source_target_count: null,
    };
  });

  const { data: heartbeat, error: observedError } = await (db as any)
    .from("worker_heartbeat")
    .select("observed_follower_holdings")
    .eq("user_id", currentUserId())
    .maybeSingle();
  if (observedError) throw new Error(observedError.message);
  const managedKeys = new Set(managed.map((f) => `${f.token_mint}:${f.wallet}`));
  const observedRows = Array.isArray(heartbeat?.observed_follower_holdings)
    ? heartbeat.observed_follower_holdings
    : [];
  const observed = observedRows
    .filter((row) => !managedKeys.has(`${row.token_mint}:${row.wallet}`))
    .map((row) => ({
      wallet: row.wallet,
      position_id: null,
      token_mint: row.token_mint,
      current_amount: Math.max(0, Number(row.amount ?? 0)),
      held_pct: null,
      hop_depth: 1,
      last_updated: row.last_updated,
      observed_only: true,
      source_target_count: Math.max(1, Number(row.source_target_count ?? 1)),
    }));

  return [...managed, ...observed];
});

export const getStrategyInsights = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data, error } = await (db as any).rpc("strategy_insights", {
    p_user_id: currentUserId(),
    p_since: since,
  });
  if (error) throw new Error(error.message);
  return (
    data ?? {
      since,
      generated_at: new Date().toISOString(),
      total_observations: 0,
      target_buys: 0,
      target_sells: 0,
      target_transfers: 0,
      follower_sells: 0,
      unique_mints: 0,
      copied_buys: 0,
      filtered_buys: 0,
      failed_actions: 0,
      median_buy_reaction_ms: null,
      median_buy_execution_ms: null,
      median_sell_reaction_ms: null,
      median_sell_execution_ms: null,
      learning_confidence_pct: 0,
      top_filter_reasons: [],
      median_target_buy_usd: null,
      median_entry_market_cap_usd: null,
      median_entry_liquidity_usd: null,
      average_transfer_recipients: null,
      most_active_hour_utc: null,
      recent: [],
    }
  );
});
