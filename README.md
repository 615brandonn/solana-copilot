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
- On a buy that passes your filters (market cap, liquidity, token trading age,
  pump.fun-only, socials, first-ever-buy, min buy size, once-per-token), immediately sends
  a copy buy through a **Jito bundle** with configurable tip, or through
  your RPC.
- After a successful copy buy, monitors the target's outgoing SPL transfers
  of the same mint. Every recipient becomes a "follower" you watch too.
- When followers dump N% of the combined cohort, your bot mirrors it —
  proportional exit. Take profit and stop loss run alongside.
- When your bag hits zero, all follower subscriptions are released.

### Exclusive coordinated-wallet mode

This mode waits for a configurable number of distinct target wallets to buy
the same mint inside a rolling time window. It has independent buy size,
market-cap, coin-age, target-buy-size, first-observed-buy, and once-per-coin
rules. Normal entry and exit settings are ignored while the mode is enabled.

Tracked recipient wallets count once each toward the distinct-seller exit,
even if the same transaction arrives from both Geyser and the RPC fallback.
The mode also exits the full remaining position when no configured target buys
that mint again inside the configured inactivity window (six hours by default).

Existing deployments must run
`supabase/coordinated-mode-migration.sql` before deploying the updated
dashboard or worker.

### Optional Conviction Mode

Conviction Mode reuses the same three target-wallet feeds and shared trade
executor, but ranks every token by verified cluster commitment, velocity,
acceleration, convergence, persistence, and distribution. When its master
switch is on, it is the only automatic entry strategy; the regular and
coordinated buy paths remain saved but cannot submit. Existing position exits,
follower monitoring, emergency protections, and manual controls remain active.

Conviction Mode installs **OFF**, with its trading mode set to **SHADOW** and
Rapid Follow set to **OFF**. Shadow mode records hypothetical tiers without
submitting transactions. Live buys require all three conditions: the master
switch on, trading mode explicitly set to Live, and the global Entries switch
on. A hard per-token exposure cap and durable per-mode tier claims prevent
duplicate scale-ins after replay or restart.

Existing deployments must run the additive, repeatable
`supabase/conviction-mode-migration.sql` and pass `cd worker && npm run doctor`
before restarting the worker. Fresh installations can run `supabase/schema.sql`,
which already contains the same schema. Applying the migration does not enable
Conviction Mode or Entries.

### Optional Custody Journey observer

Custody Journey runs as a separate observation-only VPS process. It starts on
verified configured-target buys even when Entries is off, follows conservatively
attributed balances across split and merged wallet transfers, records strict
verified sells, and builds destination/journey leaderboards. It never imports
the trade executor, reads the funding key, changes a position, or participates
in the trading worker's health gate.

The observer applies one ordered, confirmed-RPC timeline and keeps one active
campaign per user and token mint. Later verified target buys extend that
campaign while its immutable event graph preserves each transaction and split.
Verified swap seeding currently covers Jupiter v6, Pump, and PumpSwap; other
protocols remain visible only after a dedicated, fail-closed decoder is added.
RPC monitoring follows wallet-address transaction history. A delegated token
account action that omits the owner address can remain outside that history;
the dashboard discloses this limitation instead of claiming exhaustive chain
coverage.

Existing deployments must run the additive
`supabase/custody-journey-migration.sql`, build the worker, and start
`dist/custody-index.js` separately. The feature installs OFF. Transfers into
exchanges, bridges, vaults, or other opaque custody are shown as tracking
boundaries—not automatically labeled as sales—and inferred wallet identities
are clearly shown as candidates unless confirmed or manually labeled.

Revival Campaign is a separate SHADOW-only collector for low-cap target
revivals. Apply `supabase/revival-campaign-migration.sql`, build the worker,
and start `dist/revival-index.js` as its own PM2 process. The feature installs
OFF and uses an inclusive $2,000–$15,000 market-cap gate only when a campaign
is seeded. Admitted campaigns continue above $15,000, and no Revival module
imports the executor, funding-key path, positions, trades, or claim ledgers.
This collector does not control the older worker environment flag
`REVIVAL_ONLY_MODE`, which is a separate money-moving entry route. Keep that
legacy flag OFF during a collection-only rollout.

## Security notes

- Your funding private key is sent over HTTPS to the dashboard's server
  function, **AES-256-GCM encrypted there**, and stored in Supabase only as
  ciphertext. It is never stored in browser localStorage.
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
