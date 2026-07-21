# Helix — Solana Copy Trading Bot

A self-hosted, sub-second Solana copy trading bot. You control the entire
stack: your own Supabase, your own Cloudflare (for the dashboard), your own
VPS (for the worker), your own RPC + Jito credentials.

## Repo layout

```
.
├── src/                      # Dashboard (TanStack Start, deployable to Cloudflare)
│   ├── routes/index.tsx      # Main settings dashboard
│   └── components/dashboard/ # UI panels: wallets, settings, activity, followers
├── worker/                   # Long-running Node.js trading service (deploy to a VPS)
│   ├── src/
│   │   ├── geyser.ts         # Yellowstone gRPC subscription (the hot path)
│   │   ├── executor.ts       # Jupiter route + Jito bundle / RPC sender
│   │   ├── filters.ts        # MC / liquidity / socials / first-buy / etc.
│   │   ├── monitor.ts        # Follower wallet propagation logic
│   │   ├── crypto.ts         # AES-256-GCM for funding keys
│   │   └── index.ts          # Entrypoint / dispatcher
│   └── README.md             # Worker deploy guide
└── supabase/schema.sql       # Run this in your Supabase SQL editor
```

## Bring-your-own-backend setup

1. **Supabase**: create a project, open the SQL editor, paste
   `supabase/schema.sql`, run.
2. **Cloudflare Pages**: connect this repo, add the `VITE_*` env vars from
   `.env.example`, deploy. The dashboard is a plain TanStack Start SSR app.
3. **VPS**: `cd worker && cp .env.example .env`, fill values, then
   `bun install && bun run dev` (or build & run under systemd/pm2). See
   `worker/README.md` for the architecture diagram.
4. **GitHub**: use Lovable's GitHub sync from the top-right menu.

## What the bot does

- Subscribes to a **target wallet** via Yellowstone Geyser gRPC — sub-second
  event delivery.
- On a buy that passes your filters (market cap, liquidity, pump.fun-only,
  socials, first-ever-buy, min buy size, once-per-token), immediately sends
  a copy buy through a **Jito bundle** with configurable tip, or through
  your RPC.
- After a successful copy buy, monitors the target's outgoing SPL transfers
  of the same mint. Every recipient becomes a "follower" you watch too.
- When followers dump N% of the combined cohort, your bot mirrors it —
  proportional exit. Take profit and stop loss run alongside.
- When your bag hits zero, all follower subscriptions are released.

## Security notes

- Your funding private key is **AES-256-GCM encrypted** in the browser (with
  a key that only your worker holds — see `KEY_ENCRYPTION_KEY`) before it
  ever leaves the device. It's stored as ciphertext in Supabase.
- The `funding_keys` table has RLS on and only `service_role` can read it.
- Nothing in this repo talks to Lovable's cloud. Delete this line to prove
  it: `grep -ri lovable src worker supabase` (only frontend error reporting
  helpers remain, which you can rip out).

## Roadmap after v1

- Wallet-connect signing so users never paste raw keys (Phantom/Backpack).
- Multi-target: mirror several wallets, one config each.
- Realtime dashboard subscriptions to Supabase (currently the worker polls).
- Full Pump.fun instruction decoder for gas-optimal direct bonding-curve
  entries.
