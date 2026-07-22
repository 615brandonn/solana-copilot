import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { normalizeSupabaseUrl } from "@/lib/supabase-url";

export const Route = createFileRoute("/api/health/test-save")({
  server: {
    handlers: {
      GET: async () => {
        const url = process.env.SERVER_SUPABASE_URL;
        const key = process.env.SERVER_SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) {
          return Response.json({ ok: false, error: "Missing env vars" });
        }

        try {
          const db = createClient(normalizeSupabaseUrl(url), key, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const userId = process.env.HELIX_USER_ID ?? "00000000-0000-0000-0000-000000000000";
          const row = {
            user_id: userId,
            enabled: false,
            target_wallet: null,
            execution_route: "jito",
            jito_tip_sol: 0.001,
            fixed_buy_usd: 25,
            min_target_buy_usd: 100,
            mc_min_usd: 20000,
            mc_max_usd: 5000000,
            liq_min_usd: 10000,
            liq_max_usd: 2000000,
            pump_fun_only: false,
            require_socials: true,
            only_first_buy_ever: false,
            only_once_per_token: true,
            take_profit_enabled: true,
            take_profit_pct: 100,
            take_profit_sell_pct: 50,
            stop_loss_enabled: true,
            stop_loss_pct: 30,
            proportional_follower_sells: true,
          };
          const { data, error } = await db.from("bot_config").upsert(row as any, { onConflict: "user_id" } as any).select("id");

          if (error) {
            return Response.json({ ok: false, error: error.message, code: error.code, details: error });
          }
          return Response.json({ ok: true, message: "Upsert worked", data });
        } catch (e: any) {
          return Response.json({ ok: false, error: e.message, stack: e.stack });
        }
      },
    },
  },
});
