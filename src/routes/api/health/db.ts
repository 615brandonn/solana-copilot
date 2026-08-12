import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase-types";
import { normalizeSupabaseUrl } from "@/lib/supabase-url";

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
          const db = createClient<Database>(normalizeSupabaseUrl(url), key, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { count, error } = await db
            .from("bot_config")
            .select("*", { count: "exact", head: true });
          if (error) {
            const safeCode =
              typeof error.code === "string" && /^[a-z0-9_-]{1,32}$/i.test(error.code)
                ? error.code
                : null;
            return Response.json({
              ok: false,
              error: "Supabase database health check failed.",
              code: safeCode,
              hint: "Check that schema.sql was run and the service role key is correct.",
            });
          }
          return Response.json({ ok: true, message: "Connected to Supabase", rowCount: count });
        } catch {
          return Response.json({
            ok: false,
            error: "Supabase database health check could not complete.",
          });
        }
      },
    },
  },
});
