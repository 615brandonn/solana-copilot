import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "./supabase-types";
import type { BotConfig } from "./bot-config";
import { normalizeSupabaseUrl } from "./supabase-url";
import { decodeBase58, encodeBase58 } from "./base58";

export type SaveFundingKeyResult =
  { ok: true } | { ok: false; code: "missing_backend_key" | "save_failed"; error: string };

export function currentUserId() {
  const userId = process.env.HELIX_USER_ID?.trim();
  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("HELIX_USER_ID must be set to a valid UUID");
  }
  return userId;
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
  const serverKey = serviceRoleKey();
  const url = normalizeSupabaseUrl(process.env.SERVER_SUPABASE_URL ?? "");
  if (!url) throw new Error("SERVER_SUPABASE_URL is missing");
  if (!serverKey) throw new Error("SERVER_SUPABASE_SERVICE_ROLE_KEY is missing");
  return createClient<Database>(url, serverKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("apikey", serverKey);
        if (serverKey.startsWith("sb_") && headers.get("Authorization") === `Bearer ${serverKey}`) {
          headers.delete("Authorization");
        }
        return fetch(input, { ...init, headers });
      },
    },
  });
}

export function rowToConfig(row: Database["public"]["Tables"]["bot_config"]["Row"]): BotConfig {
  return {
    enabled: row.enabled,
    targetWallet: row.target_wallet ?? "",
    additionalTargetWallets: row.additional_target_wallets ?? [],
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
    require24hUptrend: row.require_24h_uptrend ?? false,
    largeBuyScannerEnabled: row.large_buy_scanner_enabled ?? false,
    largeBuyScannerMaxMcUsd: row.large_buy_scanner_max_mc_usd ?? 10_000,
    largeBuyScannerMinBuyUsd: row.large_buy_scanner_min_buy_usd ?? 500,
    largeBuyScannerMultiplier: row.large_buy_scanner_multiplier ?? 2,
    largeBuyScannerHistoryWindow: row.large_buy_scanner_history_window ?? 20,
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

export function configToRow(
  cfg: BotConfig,
): Omit<Database["public"]["Tables"]["bot_config"]["Row"], "id"> {
  return {
    user_id: currentUserId(),
    enabled: cfg.enabled,
    target_wallet: cfg.targetWallet.trim() || null,
    additional_target_wallets: Array.from(
      new Set(
        cfg.additionalTargetWallets
          .map((wallet) => wallet.trim())
          .filter((wallet) => wallet && wallet !== cfg.targetWallet.trim()),
      ),
    ),
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
    require_24h_uptrend: cfg.require24hUptrend,
    large_buy_scanner_enabled: cfg.largeBuyScannerEnabled,
    large_buy_scanner_max_mc_usd: cfg.largeBuyScannerMaxMcUsd,
    large_buy_scanner_min_buy_usd: cfg.largeBuyScannerMinBuyUsd,
    large_buy_scanner_multiplier: cfg.largeBuyScannerMultiplier,
    large_buy_scanner_history_window: cfg.largeBuyScannerHistoryWindow,
    only_first_buy_ever: cfg.onlyFirstBuyEver,
    only_once_per_token: cfg.onlyOncePerToken,
    take_profit_enabled: cfg.takeProfitEnabled,
    take_profit_pct: cfg.takeProfitPct,
    take_profit_sell_pct: cfg.takeProfitSellPct,
    stop_loss_enabled: cfg.stopLossEnabled,
    stop_loss_pct: cfg.stopLossPct,
    proportional_follower_sells: cfg.proportionalFollowerSells,
    updated_at: new Date().toISOString(),
  };
}

function configuredEncryptionKey(): Buffer | null {
  const raw = process.env.KEY_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("KEY_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

export async function saveFundingKeyRecord(privateKey: string): Promise<SaveFundingKeyResult> {
  const serverKey = serviceRoleKey();
  if (!serverKey) {
    return {
      ok: false,
      code: "missing_backend_key",
      error:
        "The backend service key is missing. Add SERVER_SUPABASE_SERVICE_ROLE_KEY first, then save your wallet key again.",
    };
  }
  const secretBytes = decodeBase58(privateKey);
  if (secretBytes.length !== 64) {
    return {
      ok: false,
      code: "save_failed",
      error: `Private key decoded to ${secretBytes.length} bytes; expected 64.`,
    };
  }
  const explicitKey = configuredEncryptionKey();
  const key = explicitKey ?? createHash("sha256").update(serverKey).digest();

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const prefix = explicitKey ? "key:" : "svc:";
  const ciphertext = `${prefix}${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64")}`;

  const db = adminClient();
  const row = {
    user_id: currentUserId(),
    wallet_pubkey: encodeBase58(secretBytes.slice(32)),
    ciphertext,
  };
  const { error } = await db.from("funding_keys").upsert(row as any, { onConflict: "user_id" });
  if (error) {
    return { ok: false, code: "save_failed", error: error.message };
  }
  return { ok: true };
}
