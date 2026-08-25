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

### Supply Accumulation Entry

Supply Accumulation is an exclusive live entry strategy for verified Pump.fun
activity across the primary and every additional configured market-maker root.
Inside a configurable 30–3,600 second window, it adds raw verified buy amounts,
subtracts raw verified sells, and compares the result with authoritative raw
total supply. The threshold is restricted to 10–20% and defaults to 10%; a 3%
cluster share can never authorize a buy. The dedicated initial buy size defaults
to $20. The configurable market-cap floor defaults to $2,000. The strict ceiling
defaults to $20,000 and can be lowered.

Optional second, third, and fourth buys install OFF. Their default verified net
supply thresholds are 12%, 15%, and 18%, and each default buy is $10. Enabled
tiers must be contiguous and strictly increase from the initial threshold. Each
tier requires a later fresh verified target buy, a separate durable claim, and
the same final custody, supply, and current/projected market-cap checks. A tier
can execute only against the one exact, untouched initial position. Any exit
claim (including one that failed before submission) or recorded sell seals the
position against every later scale buy. Scaling updates amount and cost basis
atomically while preserving the original position ID, entry signature, entry
slot, and every existing exit rule.

Every entry requires reliable same-token supply and attribution evidence plus a
strict current and estimated post-fill market cap below the configured ceiling,
which can never exceed $20,000. A coin at exactly the configured ceiling is
rejected, including when that ceiling is $20,000. Missing, conflicting, stale,
or rounded evidence fails closed. Landed entries are standard positions, so all
existing take-profit, stop-loss, trailing-stop, custody, target-sell,
follower-sell, and inactivity exits remain authoritative.

Custody Journey must be ON for every Supply Accumulation entry. One service-only
atomic database gate requires a fresh, non-degraded observer and RPC success,
zero backlog, the exact reliable target buy on an active same-mint journey,
positive live attribution, and no verified custody sell or unresolved outflow
across any journey in the accumulation window. Direct/private-program forwarding
is surfaced as sticky `directSettlementSeen` audit evidence.

Durable entry claims also carry nullable strategy, source-slot, token-decimal,
contributing-wallet, planned-USD, and block-height recovery metadata. Existing
claims are not backfilled. Only an exact `supply_accumulation` claim with its
prepared signature, original USD basis, and expiry recorded before send is
eligible for automatic crash recovery.

Existing deployments must leave global Entries OFF, apply the current
`supabase/custody-journey-migration.sql` first, then run the additive
`supabase/supply-accumulation-entry-migration.sql` and then
`supabase/supply-accumulation-scale-buys-migration.sql`, followed by
`supabase/supply-accumulation-20k-cap-migration.sql`. Deploy the matching worker
and pass `cd worker && npm run doctor`. The scale migration does not add
a repository-wide unique index to `positions`, because that would change
unrelated entry strategies; its service-only plan instead rejects any user/mint
that does not have exactly one open position. All three Supply Accumulation
migrations install the strategy and every scale tier OFF; enable Custody Journey
and then enable this strategy explicitly in Settings only after validation.
Enabling it turns off the Conviction and Coordinated toggles.

### Optional Custody Journey observer

Custody Journey runs as a separate observation-only VPS process. It starts on
verified configured-target buys even when Entries is off, follows conservatively
attributed balances across split and merged wallet transfers, records strict
verified sells, and builds destination/journey leaderboards. It never imports
the trade executor, reads the funding key, or changes a position. Its fresh
health and custody evidence form a read-only gate only for Supply Accumulation;
other entry strategies and every exit remain independent.

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
revivals. Apply `supabase/revival-campaign-migration.sql` and the additive
`supabase/revival-hydration-index-migration.sql`, build the worker, and start
`dist/revival-index.js` as its own PM2 process. The feature installs OFF and
uses an inclusive $2,000–$15,000 market-cap gate only when a campaign is
seeded. Admitted campaigns continue above $15,000, and no Revival module
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
