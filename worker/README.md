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
bun install --frozen-lockfile
bun run dev             # or `npm run dev`
```

Production installs must use the committed Bun lockfile. The direct Pump.fun
executor pins its reviewed SDK exactly; an unlocked `npm install` could resolve
different transitive instruction builders.

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

## Supply Accumulation entry

With global Entries OFF, apply the current
`supabase/custody-journey-migration.sql` and then
`supabase/supply-accumulation-entry-migration.sql`, followed by
`supabase/supply-accumulation-scale-buys-migration.sql`, and finally
`supabase/supply-accumulation-20k-cap-migration.sql`. Run `npm test`, `npm run
build`, and `npm run doctor` before restarting the worker. The migrations are
additive and leave the strategy and every scale tier OFF. Enable Custody Journey
before enabling this exclusive automatic entry route; it turns off the
Conviction and Coordinated toggles.

The strategy aggregates raw verified buys minus raw verified sells across all
configured market-maker roots inside a 30–3,600 second rolling window. Its
threshold is constrained to 10–20% of authoritative raw total supply, defaults
to 10%, and cannot be lowered to the 3% test-buy range. The dedicated initial
entry size defaults to $20. Market cap must be at least the configurable $2,000
default floor, while current and estimated post-fill market cap must both remain
strictly below the configurable ceiling, which defaults to and is capped at
$20,000. A coin at exactly $20,000 is rejected when the ceiling is set to
$20,000; missing or conflicting supply, attribution, Pump.fun, or valuation
evidence blocks entry.

Optional second, third, and fourth buys default OFF, with 12%, 15%, and 18%
thresholds and $10 sizes. Enabled tiers must be contiguous, strictly increasing,
and backed by later fresh verified target buys. Each uses a separate replay-safe
claim plus the same final custody, raw-supply, and current/projected cap checks.
The database rejects ambiguous multiple-open-position state instead of adding a
global positions index that could alter unrelated strategies. Any lifetime sell
claim or sell trade permanently seals scaling. Atomic receipt persistence
changes only the same position's amount and cost basis; its ID, original entry
signature/slot, and every exit rule remain unchanged.

`supply_accumulation_events` and `supply_accumulation_state` preserve raw integer
evidence across restart and duplicate Geyser/RPC delivery. The service-only
recorder quarantines an event-key payload conflict. A landed entry deliberately
uses the standard position contract, so take-profit, stop-loss, trailing-stop,
custody, target-sell, follower-sell, and inactivity exits remain unchanged.

Custody Journey must be ON for every Supply Accumulation entry. The worker calls
one service-only atomic database gate that requires a fresh, non-degraded
heartbeat and RPC success, zero backlog, the exact reliable target buy on an
active same-mint journey, positive live attribution, and no verified custody sell
or unresolved outflow across any journey in the window. State keeps forwarded
direct/private-program evidence sticky as `directSettlementSeen` for audit.

The migration adds nullable recovery metadata to durable entry claims without
rewriting existing rows. Supply execution records its strategy, source slot,
token decimals, contributing wallets, original planned USD amount, prepared
signature, and last valid block height before submission. Startup may
automatically recover only the exact `supply_accumulation` claim; legacy or
incomplete claims remain fail-closed for manual reconciliation.

### Finalized fresh-tail rollout

The additive `supabase/supply-accumulation-fresh-tail-migration.sql` creates a
separate FINALIZED, epoch-fenced observer. It does not import the executor,
funding key, positions, or claims. Apply it only with global Entries OFF, then
run the observer in mandatory shadow mode first:

```bash
cd worker
npm run build
FRESH_TAIL_SHADOW=true pm2 start dist/fresh-tail-index.js --name helix-fresh-tail-v1
```

Do not set `FRESH_TAIL_SHADOW=false` or enable Entries until the fresh-tail
heartbeat is current, every root/descendant cursor is covered, Doctor passes,
and the matching main worker plus `sell-claim-recovery-migration.sql` are
deployed. Prepared exits persist their exact signed attempt before send and
apply their finalized raw token debit atomically. Legacy positions without an
exact raw receipt remain deliberately fail-closed rather than guessing from a
floating-point amount or aggregate wallet balance.

## Custody Journey observer

Custody Journey is an optional, observation-only service. It starts a durable
journey after every verified configured-target buy, follows attributed token
balances through split and merged wallet transfers, and closes attributed
amounts only after a strictly verified on-chain sell. It does not read the
funding key, submit transactions, change Entries, or mutate positions. Its fresh
health and custody evidence form a read-only gate only for Supply Accumulation;
other entry strategies and every exit remain independent.

For deterministic custody accounting, this service uses one ordered confirmed
RPC timeline rather than the trading worker's processed Geyser hot path. It
keeps one active per-mint campaign and records every buy/transfer/sell edge
inside that campaign. Jupiter v6, Pump, and PumpSwap are the currently verified
swap sources; unsupported DEX activity is never guessed into a sale.
Confirmed RPC watches follow wallet-address transaction history. An approved
SPL-token delegate can move an owner's token account without including that
owner address; such activity may remain unobserved until balance continuity or
another attributed event exposes the gap. The dashboard discloses this limit
and never represents the journey as proof of exhaustive off-chain custody.

Run `supabase/custody-journey-migration.sql` before starting it on an existing
deployment. The migration is additive and leaves `custody_journey_enabled`
OFF. After the worker tests and dashboard build pass, the observer can run as a
separate process using the same server-only environment:

```bash
cd worker
npm run build
pm2 start dist/custody-index.js --name helix-custody-v1
```

The separate `custody_worker_heartbeat` and `custody_rpc_wallet_cursors`
tables keep observer outages and catch-up state isolated from copy trading.
Ordinary wallet transfers are never called sales. Known program boundaries,
bridges, vaults, and centralized-exchange deposits may end observable on-chain
custody; the dashboard reports that boundary instead of inventing an off-chain
sale. Wallet/entity names are confirmed only from explicit evidence or a user
label. Behavioral guesses are shown as candidates.

## Revival Campaign observer

Revival Campaign is a second independent, observation-only service for the
“old coin revival” thesis. A first verified target buy seeds evidence but can
never authorize a transaction. New campaigns are admitted only when the
point-in-time market cap is inclusively between $2,000 and $15,000. Once
admitted, they remain sampled above $15,000 so ignition, MFE/MAE, distribution,
and the eventual price-proxy outcome are not truncated.

Run `supabase/revival-campaign-migration.sql` followed by the additive
`supabase/revival-hydration-index-migration.sql`, build the worker, and start
the collector separately:

```bash
cd worker
npm run build
pm2 start dist/revival-index.js --name helix-revival-v1
pm2 save
```

The migration installs the toggle OFF. Enable **Revival Campaign Tracker** in
Settings when you are ready to collect. It is independent of Entries,
Conviction, Coordinated mode, Custody Journey, positions, and exits. Its own
`revival_rpc_wallet_cursors` and `revival_worker_heartbeat` tables isolate
catch-up and health from trading. Confirmed target swaps and 30-second market
snapshots are persisted with both event time and availability time; recovered
history cannot manufacture a fresh paper decision.

DexScreener pair age, liquidity, volume, and transaction activity are stored
as dormancy evidence. Pair age is not treated as token creation date, and no
historical ATH is invented when a causal history source is unavailable. All
recommendations are CHECK-constrained to non-executable `shadow` rows.

This observer is separate from the older `REVIVAL_ONLY_MODE` environment
flag in the trading worker. That legacy flag can authorize real entries and is
not controlled by the dashboard tracker toggle. Keep it OFF during the
collection-only week.

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
- Optional observation-only custody service:
  `pm2 start dist/custody-index.js --name helix-custody-v1` after its migration.
- Optional observation-only Revival service:
  `pm2 start dist/revival-index.js --name helix-revival-v1` after its migration.
- Log to stdout, pipe to Vector/Grafana Loki if you want history.
- Restart policy: always. Durable confirmed-RPC cursors resume after restart.
