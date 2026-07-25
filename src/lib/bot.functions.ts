import { createServerFn } from "@tanstack/react-start";
import type { BotConfig } from "./bot-config";
import { BotConfigSchema, FundingKeySchema } from "./bot.schemas";
import { adminClient, configToRow, currentUserId, rowToConfig, saveFundingKeyRecord } from "./bot.server";

export const getBotConfig = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await db
    .from("bot_config")
    .select("*")
    .eq("user_id", currentUserId())
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return rowToConfig(data);
});

export const saveBotConfig = createServerFn({ method: "POST" })
  .inputValidator((data) => BotConfigSchema.parse(data))
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
  .inputValidator((data) => FundingKeySchema.parse(data))
  .handler(async ({ data }) => {
    return saveFundingKeyRecord(data.privateKey);
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

export const getFollowers = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data: positionsRaw, error: posErr } = await db
    .from("positions")
    .select("id, token_mint")
    .eq("user_id", currentUserId())
    .is("closed_at", null);
  if (posErr) throw new Error(posErr.message);
  const positions = (positionsRaw ?? []) as Array<{ id: string; token_mint: string }>;
  if (positions.length === 0) return [];

  const posIds = positions.map((p) => p.id);
  const mintByPos = new Map(positions.map((p) => [p.id, p.token_mint]));

  const { data: fwsRaw, error: fwErr } = await (db as any)
    .from("follower_wallets")
    .select("wallet, position_id, initial_amount, current_amount, last_updated")
    .in("position_id", posIds)
    .order("last_updated", { ascending: false });
  if (fwErr) throw new Error(fwErr.message);
  const fws = (fwsRaw ?? []) as Array<{
    wallet: string;
    position_id: string;
    initial_amount: number | string;
    current_amount: number | string;
    last_updated: string;
  }>;

  return fws.map((f) => {
    const initial = Number(f.initial_amount) || 0;
    const current = Number(f.current_amount) || 0;
    const heldPct = initial > 0 ? Math.max(0, Math.min(100, (current / initial) * 100)) : 0;
    return {
      wallet: f.wallet,
      token_mint: mintByPos.get(f.position_id) ?? "",
      held_pct: heldPct,
      last_updated: f.last_updated,
    };
  });
});
