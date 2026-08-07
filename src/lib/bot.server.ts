import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "./supabase-types";
import type { BotConfig } from "./bot-config";
import { normalizeSupabaseUrl } from "./supabase-url";
import { decodeBase58, encodeBase58 } from "./base58";

export type SaveFundingKeyResult =
  { ok: true } | { ok: false; code: "missing_backend_key" | "save_failed"; error: string };

const SINGLE_USER_ID = "00000000-0000-0000-0000-000000000000";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function currentUserId() {
  const userId = process.env.HELIX_USER_ID?.trim();
  // Lovable preview does not always expose optional project variables. This
  // project is intentionally single-user, and its existing Supabase row and
  // VPS worker both use the zero UUID, so a missing value safely resolves to
  // that same row. A nonempty malformed value is still rejected.
  if (!userId) return SINGLE_USER_ID;
  if (!UUID_PATTERN.test(userId)) {
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
  if (key.split(".").length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")) as {
        role?: string;
      };
      if (payload.role && payload.role !== "service_role") {
        throw new Error(
          `SERVER_SUPABASE_SERVICE_ROLE_KEY has JWT role ${payload.role}; expected service_role`,
        );
      }
    } catch (error) {
      if (error instanceof Error && /expected service_role/.test(error.message)) throw error;
    }
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
    coordinatedModeEnabled: row.coordinated_mode_enabled ?? false,
    coordinatedFixedBuyUsd: row.coordinated_fixed_buy_usd ?? 25,
    coordinatedTargetWalletCount: row.coordinated_target_wallet_count ?? 2,
    coordinatedWindowSeconds: row.coordinated_window_seconds ?? 30,
    coordinatedMcMinUsd: row.coordinated_mc_min_usd ?? 0,
    coordinatedMcMaxUsd: row.coordinated_mc_max_usd ?? 15_000,
    coordinatedCoinAgeMinMinutes: row.coordinated_coin_age_min_minutes ?? 0,
    coordinatedCoinAgeMaxMinutes: row.coordinated_coin_age_max_minutes ?? 60,
    coordinatedTargetBuyMinUsd: row.coordinated_target_buy_min_usd ?? 0,
    coordinatedTargetBuyMaxUsd: row.coordinated_target_buy_max_usd ?? 1_000_000,
    coordinatedFirstBuyOnly: row.coordinated_first_buy_only ?? false,
    coordinatedOncePerToken: row.coordinated_once_per_token ?? true,
    coordinatedFollowerSellCount: row.coordinated_follower_sell_count ?? 1,
    coordinatedFollowerSellPct: row.coordinated_follower_sell_pct ?? 100,
    coordinatedInactivityHours: row.coordinated_inactivity_hours ?? 6,
    networkScalingEnabled: row.network_scaling_enabled ?? true,
    starterPositionPct: row.starter_position_pct ?? 5,
    maxPositionPct: row.max_position_pct ?? 15,
    newEntryReservePct: row.new_entry_reserve_pct ?? 50,
    targetCopyRatioPct: row.target_copy_ratio_pct ?? 1,
    minScaleBuyUsd: row.min_scale_buy_usd ?? 1,
    minTargetBuyUsd: row.min_target_buy_usd,
    mcMinUsd: row.mc_min_usd,
    mcMaxUsd: row.mc_max_usd,
    liqMinUsd: row.liq_min_usd,
    liqMaxUsd: row.liq_max_usd,
    tokenAgeFilterEnabled: row.token_age_filter_enabled ?? false,
    tokenAgeMinMinutes: row.token_age_min_minutes ?? 0,
    tokenAgeMaxMinutes: row.token_age_max_minutes ?? 60,
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
    coordinated_mode_enabled: cfg.coordinatedModeEnabled,
    coordinated_fixed_buy_usd: cfg.coordinatedFixedBuyUsd,
    coordinated_target_wallet_count: cfg.coordinatedTargetWalletCount,
    coordinated_window_seconds: cfg.coordinatedWindowSeconds,
    coordinated_mc_min_usd: cfg.coordinatedMcMinUsd,
    coordinated_mc_max_usd: cfg.coordinatedMcMaxUsd,
    coordinated_coin_age_min_minutes: cfg.coordinatedCoinAgeMinMinutes,
    coordinated_coin_age_max_minutes: cfg.coordinatedCoinAgeMaxMinutes,
    coordinated_target_buy_min_usd: cfg.coordinatedTargetBuyMinUsd,
    coordinated_target_buy_max_usd: cfg.coordinatedTargetBuyMaxUsd,
    coordinated_first_buy_only: cfg.coordinatedFirstBuyOnly,
    coordinated_once_per_token: cfg.coordinatedOncePerToken,
    coordinated_follower_sell_count: cfg.coordinatedFollowerSellCount,
    coordinated_follower_sell_pct: cfg.coordinatedFollowerSellPct,
    coordinated_inactivity_hours: cfg.coordinatedInactivityHours,
    network_scaling_enabled: cfg.networkScalingEnabled,
    starter_position_pct: cfg.starterPositionPct,
    max_position_pct: cfg.maxPositionPct,
    new_entry_reserve_pct: cfg.newEntryReservePct,
    target_copy_ratio_pct: cfg.targetCopyRatioPct,
    min_scale_buy_usd: cfg.minScaleBuyUsd,
    min_target_buy_usd: cfg.minTargetBuyUsd,
    mc_min_usd: cfg.mcMinUsd,
    mc_max_usd: cfg.mcMaxUsd,
    liq_min_usd: cfg.liqMinUsd,
    liq_max_usd: cfg.liqMaxUsd,
    token_age_filter_enabled: cfg.tokenAgeFilterEnabled,
    token_age_min_minutes: cfg.tokenAgeMinMinutes,
    token_age_max_minutes: cfg.tokenAgeMaxMinutes,
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
  const fundingKeys = db.from("funding_keys") as unknown as {
    upsert: (
      value: Database["public"]["Tables"]["funding_keys"]["Insert"],
      options: { onConflict: string },
    ) => PromiseLike<{ error: { message: string } | null }>;
  };
  const { error } = await fundingKeys.upsert(row, { onConflict: "user_id" });
  if (error) {
    return { ok: false, code: "save_failed", error: error.message };
  }
  return { ok: true };
}
