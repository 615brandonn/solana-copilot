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

| Name                            | What it is                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `BOT_SUPABASE_URL`              | Your Supabase project URL                                                                               |
| `BOT_SUPABASE_SERVICE_ROLE_KEY` | Server-only key (never ship to browser)                                                                 |
| `RPC_URL`                       | Helius / Triton / QuickNode mainnet HTTPS RPC endpoint                                                  |
| `YELLOWSTONE_GRPC_URL`          | Helius Laserstream or Yellowstone gRPC endpoint (e.g. `https://laserstream-mainnet-ewr.helius-rpc.com`) |
| `YELLOWSTONE_TOKEN`             | Helius API key (used as the gRPC auth token)                                                            |
| `JUPITER_API_KEY`               | Paid Jupiter developer key for Price API v3 and the official Swap endpoint                              |
| `PRICE_API_URL`                 | `https://api.jup.ag/price/v3`                                                                           |
| `JITO_BLOCK_ENGINE_URL`         | e.g. `https://amsterdam.mainnet.block-engine.jito.wtf`                                                  |
| `JITO_TIP_ACCOUNTS`             | CSV of the 8 Jito tip accounts (see Jito docs)                                                          |
| `KEY_ENCRYPTION_KEY`            | Optional 32-byte AES key, base64. When set, it must match the dashboard server value                    |
| `HELIX_USER_ID`                 | UUID matching the `bot_config.user_id` row for this deployment                                          |

## Architecture

```
 Dashboard (Cloudflare)                Worker (your VPS)
 ┌──────────────────────┐              ┌────────────────────────────┐
 │ Server functions     │              │                            │
 │ encrypt funding key  │              │  Geyser gRPC subscription  │
 └──────────┬───────────┘              │  Heartbeat every 20 sec    │
            │                          │        │                   │
            ▼                          │        ▼                   │
     ┌──────────────┐                  │  Dispatcher                │
     │  Supabase    │◀── config/health ┤        │                   │
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

## Token-age filter

The optional token-age range uses the earliest `pairCreatedAt` timestamp
returned by DexScreener for the mint. When enabled, missing age metadata is
rejected. Run `supabase/token-age-migration.sql` before enabling it on an
existing deployment.

## Coordinated-wallet mode

Run `supabase/coordinated-mode-migration.sql` before deploying this worker.
The worker then:

1. Subscribes to the primary and all additional target wallets.
2. Counts only distinct, in-range target buys of the same mint inside the
   configured rolling window.
3. Opens one coordinated position after the wallet threshold and independent
   market-cap/age filters pass.
4. Tracks direct recipients and transfer chains up to three hops only while
   that position is open.
5. Counts each recipient wallet once toward the coordinated seller threshold,
   with transaction-signature deduplication across Geyser and RPC delivery.
6. Exits 100% after the target-inactivity window, which defaults to six hours.

Turning Entries off blocks new buys but deliberately leaves open-position
follower exits, take-profit/stop-loss, and inactivity exits active.

## Conviction Mode

Run `supabase/conviction-mode-migration.sql` before deploying a worker that
contains Conviction Mode, then run `npm test`, `npm run build`, and
`npm run doctor`. The migration is additive and leaves the feature OFF in
SHADOW mode. Conviction requires exactly three unique configured target
wallets.

The existing Geyser/RPC decoders feed one persistent Conviction engine. With
the master switch on, the central strategy router blocks regular and
coordinated automatic entries; it does not block exits. SHADOW records
hypothetical tiers only. LIVE still requires global Entries to be on and all
monitoring, classification, freshness, funding, exposure, and durable-claim
safety gates to pass immediately before the shared executor is called.

## Security

- Funding private keys are AES-256-GCM encrypted by the dashboard server
  before being written to Supabase. The worker decrypts them with the shared
  explicit key or the shared service-role-key derivation.
- The `funding_keys` table has RLS enabled and is not exposed to the
  `authenticated` role — only `service_role` can read it.
- Never commit `.env`. Rotate `KEY_ENCRYPTION_KEY` by re-encrypting existing
  ciphertexts, then updating the env var.

## Deploying

- Systemd unit or `pm2 start dist/index.js --name helix-worker-v3`.
- Log to stdout, pipe to Vector/Grafana Loki if you want history.
- Restart policy: always. The Geyser stream reconnects automatically.
