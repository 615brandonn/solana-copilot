import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Database } from "./supabase-types";
import type { BotConfig } from "./bot-config";
import { normalizeSupabaseUrl } from "./supabase-url";

const userId = () => process.env.HELIX_USER_ID ?? "00000000-0000-0000-0000-000000000000";

function serviceRoleKey(): string {
  const key = process.env.SERVER_SUPABASE_SERVICE_ROLE_KEY ?? "";
  // Catch the common mistake of pasting the publishable/anon key into the service role field.
  if (key.startsWith("sb_publishable_")) {
    throw new Error(
      "SERVER_SUPABASE_SERVICE_ROLE_KEY is the publishable (anon) key. In Supabase, copy the Secret key (service role) instead.",
    );
  }
  return key;
}

function adminClient() {
  return createClient<Database>(
    normalizeSupabaseUrl(process.env.SERVER_SUPABASE_URL!),
    serviceRoleKey(),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

const BotConfigSchema = z.object({
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

const FundingKeySchema = z.object({
  privateKey: z.string().min(32),
});

function rowToConfig(row: Database["public"]["Tables"]["bot_config"]["Row"]): BotConfig {
  return {
    enabled: row.enabled,
    targetWallet: row.target_wallet ?? "",
    fundingPrivateKey: "",
    executionRoute: row.execution_route as "jito" | "rpc",
    jitoTipSol: row.jito_tip_sol,
    fixedBuyUsd: row.fixed_buy_usd,
    minTargetBuyUsd: row.min_target_buy_usd,
    mcMinUsd: row.mc_min_usd,
    mcMaxUsd: row.mc_max_usd,
    liqMinUsd: row.liq_min_usd,
    liqMaxUsd: row.liq_max_usd,
    pumpFunOnly: row.pump_fun_only,
    requireSocials: row.require_socials,
    onlyFirstBuyEver: row.only_first_buy_ever,
    onlyOncePerToken: row.only_once_per_token,
    takeProfitEnabled: row.take_profit_enabled,
    takeProfitPct: row.take_profit_pct,
    takeProfitSellPct: row.take_profit_sell_pct,
    stopLossEnabled: row.stop_loss_enabled,
    stopLossPct: row.stop_loss_pct,
    proportionalFollowerSells: row.proportional_follower_sells,
  };
}

function configToRow(cfg: BotConfig): Omit<Database["public"]["Tables"]["bot_config"]["Row"], "id" | "updated_at"> {
  return {
    user_id: userId(),
    enabled: cfg.enabled,
    target_wallet: cfg.targetWallet.trim() || null,
    execution_route: cfg.executionRoute,
    jito_tip_sol: cfg.jitoTipSol,
    fixed_buy_usd: cfg.fixedBuyUsd,
    min_target_buy_usd: cfg.minTargetBuyUsd,
    mc_min_usd: cfg.mcMinUsd,
    mc_max_usd: cfg.mcMaxUsd,
    liq_min_usd: cfg.liqMinUsd,
    liq_max_usd: cfg.liqMaxUsd,
    pump_fun_only: cfg.pumpFunOnly,
    require_socials: cfg.requireSocials,
    only_first_buy_ever: cfg.onlyFirstBuyEver,
    only_once_per_token: cfg.onlyOncePerToken,
    take_profit_enabled: cfg.takeProfitEnabled,
    take_profit_pct: cfg.takeProfitPct,
    take_profit_sell_pct: cfg.takeProfitSellPct,
    stop_loss_enabled: cfg.stopLossEnabled,
    stop_loss_pct: cfg.stopLossPct,
    proportional_follower_sells: cfg.proportionalFollowerSells,
  };
}

function encryptionKey(): Buffer {
  const raw = process.env.SERVER_KEY_ENCRYPTION_KEY ?? process.env.KEY_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("Missing SERVER_KEY_ENCRYPTION_KEY. Use the same 32-byte base64 key as your worker KEY_ENCRYPTION_KEY.");
  return key;
}

function encryptPrivateKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export const getBotConfig = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await db
    .from("bot_config")
    .select("*")
    .eq("user_id", userId())
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
    const db = adminClient();
    const row = {
      user_id: userId(),
      wallet_pubkey: "pending",
      ciphertext: encryptPrivateKey(data.privateKey),
    };
    const { error } = await db.from("funding_keys").upsert(row as any, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getTrades = createServerFn({ method: "GET" }).handler(async () => {
  const db = adminClient();
  const { data, error } = await db
    .from("trades")
    .select("*")
    .eq("user_id", userId())
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
    .eq("user_id", userId())
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
    .eq("user_id", userId())
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
