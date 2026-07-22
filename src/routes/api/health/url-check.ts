import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health/url-check")({
  server: {
    handlers: {
      GET: async () => {
        const url = process.env.SERVER_SUPABASE_URL ?? "";
        const key = process.env.SERVER_SUPABASE_SERVICE_ROLE_KEY ?? "";
        return Response.json({
          urlEndsWith: url.slice(-20),
          keyLength: key.length,
          keyPrefix: key.slice(0, 10),
        });
      },
    },
  },
});
