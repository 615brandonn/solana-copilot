import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
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
    target_wallet: cfg.targetWallet || null,
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
  const { data: positions, error: posErr } = await db
    .from("positions")
    .select("id, token_mint")
    .eq("user_id", userId())
    .is("closed_at", null);
  if (posErr) throw new Error(posErr.message);
  if (!positions || positions.length === 0) return [];

  const posIds = positions.map((p) => p.id);
  const mintByPos = new Map(positions.map((p) => [p.id, p.token_mint]));

  const { data: fws, error: fwErr } = await db
    .from("follower_wallets")
    .select("wallet, position_id, initial_amount, current_amount, last_updated")
    .in("position_id", posIds)
    .order("last_updated", { ascending: false });
  if (fwErr) throw new Error(fwErr.message);

  return (fws ?? []).map((f) => {
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
