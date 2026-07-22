import { createFileRoute } from "@tanstack/react-router";

function decodeJwtRole(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload?.role ?? null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/health/key-role")({
  server: {
    handlers: {
      GET: async () => {
        const key = process.env.SERVER_SUPABASE_SERVICE_ROLE_KEY ?? "";
        const role = decodeJwtRole(key);
        return Response.json({
          role,
          looksLikeJwt: key.split(".").length === 3,
          keyLength: key.length,
          hint: role === "service_role" ? "Correct service role key" : "This key is NOT the service role key. Go to Supabase → Settings → API → copy the Secret key (service role).",
        });
      },
    },
  },
});
