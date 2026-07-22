import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase-types";

export const Route = createFileRoute("/api/health/db")({
  server: {
    handlers: {
      GET: async () => {
        const url = process.env.SERVER_SUPABASE_URL;
        const key = process.env.SERVER_SUPABASE_SERVICE_ROLE_KEY;

        if (!url || !key) {
          return Response.json({
            ok: false,
            error: "Missing SERVER_SUPABASE_URL or SERVER_SUPABASE_SERVICE_ROLE_KEY",
            hasUrl: !!url,
            hasKey: !!key,
          });
        }

        try {
          const db = createClient<Database>(url, key, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { count, error } = await db.from("bot_config").select("*", { count: "exact", head: true });
          if (error) {
            return Response.json({
              ok: false,
              error: error.message,
              code: error.code,
              hint: "Check that schema.sql was run and the service role key is correct.",
            });
          }
          return Response.json({ ok: true, message: "Connected to Supabase", rowCount: count });
        } catch (e: any) {
          return Response.json({ ok: false, error: e.message });
        }
      },
    },
  },
});
