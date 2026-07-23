import { createClient } from "@supabase/supabase-js";
import { fetch, WebSocket } from "undici";
import { env } from "./env.js";

function normalizeSupabaseUrl(url: string): string {
  let trimmed = url.trim();
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  if (trimmed.toLowerCase().endsWith("/rest/v1")) trimmed = trimmed.slice(0, -"/rest/v1".length);
  while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

export const db = createClient(normalizeSupabaseUrl(env.BOT_SUPABASE_URL), env.BOT_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket },
  global: {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("apikey", env.BOT_SUPABASE_SERVICE_ROLE_KEY);

      // New-format sb_secret_* keys are opaque, not JWTs. PostgREST accepts
      // them as apikey, but not as an Authorization bearer token.
      if (
        env.BOT_SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_") &&
        headers.get("Authorization") === `Bearer ${env.BOT_SUPABASE_SERVICE_ROLE_KEY}`
      ) {
        headers.delete("Authorization");
      }

      return fetch(input, { ...init, headers });
    },
  },
});

export type BotConfigRow = {
  id: string;
  user_id: string;
  enabled: boolean;
  target_wallet: string | null;
  execution_route: "jito" | "rpc";
  jito_tip_sol: number;
  fixed_buy_usd: number;
  min_target_buy_usd: number;
  mc_min_usd: number;
  mc_max_usd: number;
  liq_min_usd: number;
  liq_max_usd: number;
  pump_fun_only: boolean;
  require_socials: boolean;
  only_first_buy_ever: boolean;
  only_once_per_token: boolean;
  take_profit_enabled: boolean;
  take_profit_pct: number;
  take_profit_sell_pct: number;
  stop_loss_enabled: boolean;
  stop_loss_pct: number;
  proportional_follower_sells: boolean;
};
