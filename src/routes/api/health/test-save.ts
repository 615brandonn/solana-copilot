import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health/test-save")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json(
          {
            ok: false,
            error: "This unsafe write diagnostic is permanently disabled.",
          },
          { status: 410 },
        );
      },
    },
  },
});
