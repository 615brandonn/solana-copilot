import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health/url-check")({
  server: {
    handlers: {
      GET: async () => {
        const url = process.env.SERVER_SUPABASE_URL ?? "";
        const key = process.env.SERVER_SUPABASE_SERVICE_ROLE_KEY ?? "";
        return Response.json({
          urlConfigured: url.length > 0,
          keyConfigured: key.length > 0,
        });
      },
    },
  },
});
