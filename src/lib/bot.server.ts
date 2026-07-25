import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "./supabase-types";
import type { BotConfig } from "./bot-config";
import { normalizeSupabaseUrl } from "./supabase-url";

export type SaveFundingKeyResult =
  | { ok: true }
  | { ok: false; code: "missing_backend_key" | "save_failed"; error: string };

export function currentUserId() {
  return process.env.HELIX_USER_ID ?? "00000000-0000-0000-0000-000000000000";
}

function serviceRoleKey(): string {
  const key = process.env.SERVER_SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (key.startsWith("sb_publishable_")) {
    throw new Error(
      "SERVER_SUPABASE_SERVICE_ROLE_KEY is the publishable (anon) key. In Supabase, copy the Secret key (service role) instead.",
    );
  }
  return key;
}

export function adminClient() {
  return createClient<Database>(
    normalizeSupabaseUrl(process.env.SERVER_SUPABASE_URL ?? ""),
    serviceRoleKey(),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export function rowToConfig(row: Database["public"]["Tables"]["bot_config"]["Row"]): BotConfig {
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

export function configToRow(cfg: BotConfig): Omit<Database["public"]["Tables"]["bot_config"]["Row"], "id" | "updated_at"> {
  return {
    user_id: currentUserId(),
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

export async function saveFundingKeyRecord(privateKey: string): Promise<SaveFundingKeyResult> {
  const serverKey = serviceRoleKey();
  if (!serverKey) {
    return {
      ok: false,
      code: "missing_backend_key",
      error: "The backend service key is missing. Add SERVER_SUPABASE_SERVICE_ROLE_KEY first, then save your wallet key again.",
    };
  }
  const key = createHash("sha256").update(serverKey).digest();

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const ciphertext = `svc:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;

  const db = adminClient();
  const row = {
    user_id: currentUserId(),
    wallet_pubkey: "pending",
    ciphertext,
  };
  const { error } = await db.from("funding_keys").upsert(row as any, { onConflict: "user_id" });
  if (error) {
    return { ok: false, code: "save_failed", error: error.message };
  }
  return { ok: true };
}