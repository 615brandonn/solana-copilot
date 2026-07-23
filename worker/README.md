# Helix Worker

Long-running Node.js service that runs the actual copy-trading logic. Deploy
this on a **VPS** (Vultr HF, Latitude, or a bare-metal box) in a region close
to a fast RPC and to the Jito block engine (Amsterdam / NYC / Tokyo).

Cloudflare Workers **cannot** run this — you need a persistent connection to
Yellowstone gRPC and to Jito, which serverless edges don't support.

## Setup

```bash
cd worker
cp .env.example .env    # fill in every value
bun install             # or `npm install`
bun run dev             # or `npm run dev`
```

## Required env vars

| Name | What it is |
|------|-----------|
| `BOT_SUPABASE_URL` | Your Supabase project URL |
| `BOT_SUPABASE_SERVICE_ROLE_KEY` | Server-only key (never ship to browser) |
| `RPC_URL` | Helius / Triton / QuickNode mainnet HTTPS RPC endpoint |
| `YELLOWSTONE_GRPC_URL` | Helius Laserstream or Yellowstone gRPC endpoint (e.g. `https://laserstream-mainnet-ewr.helius-rpc.com`) |
| `YELLOWSTONE_TOKEN` | Helius API key (used as the gRPC auth token) |
| `JITO_BLOCK_ENGINE_URL` | e.g. `https://amsterdam.mainnet.block-engine.jito.wtf` |
| `JITO_TIP_ACCOUNTS` | CSV of the 8 Jito tip accounts (see Jito docs) |
| `KEY_ENCRYPTION_KEY` | 32-byte AES key, base64. Generate with `openssl rand -base64 32` |
| `WORKER_API_TOKEN` | Bearer token the dashboard uses to talk to this worker |
| `HELIX_USER_ID` | UUID matching the `bot_config.user_id` row for this deployment |

## Architecture

```
 Dashboard (Cloudflare Pages)          Worker (your VPS)
 ┌──────────────────────┐              ┌────────────────────────────┐
 │ Settings UI          │──POST────────▶ /keys  (encrypt funding sk) │
 │ writes bot_config    │              │                            │
 └──────────┬───────────┘              │  Geyser gRPC subscription  │
            │                          │        │                   │
            ▼                          │        ▼                   │
     ┌──────────────┐                  │  Dispatcher                │
     │  Supabase    │◀─── config poll ─┤        │                   │
     │  (your own)  │                  │        ▼                   │
     └──────────────┘                  │  Filters + Executor        │
                                       │        │                   │
                                       │        ▼                   │
                                       │  Jito bundles / RPC send   │
                                       └────────────────────────────┘
```

## Follower-wallet lifecycle

1. Copy buy lands → open a `positions` row.
2. Monitor target wallet's outgoing SPL transfers of that mint. Every
   recipient is added to `follower_wallets` and subscribed on Geyser.
3. Any follower sell → aggregate `soldFraction` across the whole cohort →
   mirror the same fraction of your remaining bag.
4. When `amount_remaining = 0`, unsubscribe every follower and mark the
   position closed.

## Security

- Funding private keys are AES-256-GCM encrypted with `KEY_ENCRYPTION_KEY`
  before being written to Supabase. Only this worker (which holds the key)
  can decrypt them.
- The `funding_keys` table has RLS enabled and is not exposed to the
  `authenticated` role — only `service_role` can read it.
- Never commit `.env`. Rotate `KEY_ENCRYPTION_KEY` by re-encrypting existing
  ciphertexts, then updating the env var.

## Deploying

- Systemd unit or `pm2 start dist/index.js --name helix`.
- Log to stdout, pipe to Vector/Grafana Loki if you want history.
- Restart policy: always. The Geyser stream reconnects automatically.
