import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  // Your own Supabase backend (renamed to avoid reserved Lovable prefixes)
  BOT_SUPABASE_URL: z.string().url(),
  BOT_SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // Solana infra
  RPC_URL: z.string().url(), // Helius/Triton mainnet HTTPS RPC
  YELLOWSTONE_GRPC_URL: z.string().url(), // Helius Laserstream / Yellowstone gRPC endpoint
  YELLOWSTONE_TOKEN: z.string().optional(), // Helius API key (x-token) for gRPC auth

  // Jito
  JITO_BLOCK_ENGINE_URL: z.string().url().default("https://mainnet.block-engine.jito.wtf"),
  JITO_TIP_ACCOUNTS: z.string().optional(), // csv of pubkeys; jito-ts also ships defaults

  // Optional legacy encryption master key. New dashboard-saved keys are
  // encrypted from the Supabase service key so no extra setup is required.
  KEY_ENCRYPTION_KEY: z.string().min(43).optional(),

  // Price feed (Birdeye/Jupiter)
  PRICE_API_URL: z.string().url().default("https://api.jup.ag/price/v3"),
  JUPITER_API_KEY: z.string().min(1).optional(),

  // DFlow aggregator (the venue Alien fills through). When DFLOW_ENABLED is
  // true the executor tries DFlow FIRST and falls back to the full Jupiter →
  // Pump.fun chain on any failure, so leaving it off changes nothing. The
  // public quote-api requires a key (email hello@dflow.net); dev is rate-limited.
  DFLOW_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  DFLOW_BASE_URL: z.string().url().default("https://quote-api.dflow.net"),
  DFLOW_API_KEY: z.string().min(1).optional(),

  // USDC-conviction gate/sizing for coordinated entries (env-flagged, default off).
  // Gates out low-conviction spray and sizes up when the target has committed more
  // real USDC to a mint. Off unless USDC_CONVICTION_ENABLED is set.
  USDC_CONVICTION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  USDC_CONVICTION_MIN_USD: z.coerce.number().default(150),
  USDC_CONVICTION_MAX_BUY_USD: z.coerce.number().default(40),
  USDC_CONVICTION_REF_USD: z.coerce.number().default(500),

  // Single user this bot instance manages (matches the dashboard user)
  HELIX_USER_ID: z.string().uuid().default("00000000-0000-0000-0000-000000000000"),

  LOG_LEVEL: z.string().default("info"),
});

export const env = Env.parse(process.env);
