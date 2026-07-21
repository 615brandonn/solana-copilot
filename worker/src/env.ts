import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // Solana infra
  RPC_URL: z.string().url(),                // Helius/Triton mainnet
  YELLOWSTONE_GRPC_URL: z.string().url(),   // Geyser gRPC
  YELLOWSTONE_TOKEN: z.string().optional(),

  // Jito
  JITO_BLOCK_ENGINE_URL: z.string().url().default("https://mainnet.block-engine.jito.wtf"),
  JITO_TIP_ACCOUNTS: z.string().optional(), // csv of pubkeys; jito-ts also ships defaults

  // Encryption master key for funding-wallet private keys (32-byte base64)
  KEY_ENCRYPTION_KEY: z.string().min(43),

  // Price feed (Birdeye/Jupiter)
  PRICE_API_URL: z.string().url().default("https://price.jup.ag/v6/price"),

  // Auth for worker HTTP API called by the dashboard
  WORKER_API_TOKEN: z.string().min(16),

  LOG_LEVEL: z.string().default("info"),
});

export const env = Env.parse(process.env);
