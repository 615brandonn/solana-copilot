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

  // Single user this bot instance manages (matches the dashboard user)
  HELIX_USER_ID: z.string().uuid().default("00000000-0000-0000-0000-000000000000"),

  LOG_LEVEL: z.string().default("info"),
});

export const env = Env.parse(process.env);
