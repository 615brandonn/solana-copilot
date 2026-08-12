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
          configured: key.length > 0,
          serviceRoleVerified: role === "service_role",
          looksLikeJwt: key.split(".").length === 3,
          hint:
            role === "service_role"
              ? "Service-role JWT verified."
              : key.startsWith("sb_secret_")
                ? "Supabase secret key is configured."
                : "Server key role could not be verified.",
        });
      },
    },
  },
});
