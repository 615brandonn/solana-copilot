# Finalized fresh-tail live rollout

This is the production checklist for the finalized Supply Accumulation lane.
Follow it in order. A failed check means keep **Entries OFF** and stop at that
step.

The fresh-tail observer is observation-only; the main worker remains the only
process that can buy or sell. Fresh-tail authorizes only **initial** Supply
Accumulation entries for Pump launches created after its activation boundary.
Tier 2–4 scale buys still use the strict legacy Supply/Custody gate, so legacy
RPC catch-up can block scales without blocking a certified fresh initial entry.

## 1. Freeze entries and verify the sell mode

In the dashboard:

1. Turn **Entries OFF**.
2. Set **Direct target sell exit mode** to `off`, `fixed_pct`, or `full`.
   `proportional` is unsupported by the exact fresh-tail exit contract and will
   block live candidates.
3. Leave the main worker and legacy Custody observer running. Entries OFF does
   not disable exits.

Do not reset, delete, truncate, or advance any legacy or fresh cursor. In
particular, do not modify `rpc_wallet_cursors`, `custody_rpc_wallet_cursors`,
`custody_fresh_tail_cursors`, or the active fresh-tail epoch. The new lane has
its own finalized activation boundary; legacy catch-up must continue normally.

## 2. Apply the two SQL migrations in order

In the Supabase SQL editor, run each checked-in file separately and wait for it
to succeed before continuing:

1. `supabase/sell-claim-recovery-migration.sql`
2. `supabase/supply-accumulation-fresh-tail-migration.sql`

Do not paste a service-role key into the SQL editor, shell history, or logs.
The migrations are additive and do not enable Entries.

## 3. Build and stage the matching worker release

On the VPS, from the exact same Git commit that supplied the migrations:

```bash
cd /path/to/solana-copilot/worker
bun install --frozen-lockfile
npm test
npm run build
```

Do not restart the main worker yet. Confirm that both files exist in this build:

```bash
test -f dist/index.js
test -f dist/fresh-tail-index.js
```

## 4. Arm observation while Entries stays OFF

In the dashboard, turn **Supply Accumulation ON** and **Custody Journey ON**.
Keep **Entries OFF**. Confirm that exactly three unique target wallets are
configured and the direct target sell mode is still not `proportional`.

Start the fresh observer in shadow mode:

```bash
cd /path/to/solana-copilot/worker
FRESH_TAIL_SHADOW=true pm2 start dist/fresh-tail-index.js --name helix-fresh-tail-v1 --time
pm2 status helix-fresh-tail-v1
pm2 logs helix-fresh-tail-v1 --lines 200 --nostream
```

There must be one `fresh-tail observation-only process started` message with
`shadow: true`, continuing successful cycles, and no repeating startup/cycle
error.

## 5. Prove the shadow lane

Run Doctor against the staged release:

```bash
cd /path/to/solana-copilot/worker
npm run doctor
```

The fresh-tail schema/RPC checks, sell-recovery schema, configuration, funding
key, and RPC connection must pass. A separately labelled **legacy** RPC/Custody
backlog can still be reported while old history drains; it is not fresh-tail
proof and it continues to block tier 2–4 scale buys. Do not proceed for any
schema, missing-RPC, sell-recovery, funding, target-count, or configuration
failure.

Then run this read-only query in the Supabase SQL editor. Replace
`<HELIX_USER_ID>` with the deployment's non-secret user UUID; never paste a
service key.

```sql
select
  e.status as epoch_status,
  h.enabled,
  h.shadow,
  h.root_required_count,
  h.root_covered_count,
  h.root_backlog_count,
  h.descendant_required_count,
  h.descendant_covered_count,
  h.incomplete_backscan_count,
  h.exit_pending_count,
  h.exit_retry_count,
  h.exit_uncertain_count,
  h.last_error,
  extract(epoch from (clock_timestamp() - h.updated_at))::numeric(10,2)
    as heartbeat_age_seconds,
  extract(epoch from (clock_timestamp() - h.last_success_at))::numeric(10,2)
    as success_age_seconds
from public.custody_fresh_tail_worker_heartbeat h
join public.custody_fresh_tail_epochs e on e.id = h.epoch_id
where h.user_id = '<HELIX_USER_ID>'::uuid
order by h.updated_at desc
limit 1;
```

Shadow proof requires all of the following on one current row:

- `epoch_status = 'active'`, `enabled = true`, and `shadow = true`.
- `root_required_count = 3`, `root_covered_count = 3`, and
  `root_backlog_count = 0`.
- `descendant_required_count = descendant_covered_count` and
  `incomplete_backscan_count = 0`.
- `last_error is null`; heartbeat and success ages remain below four seconds
  across repeated checks.
- `exit_uncertain_count = 0`. Let any pending/retry work drain before live
  entry activation.

This proves the isolated finalized lane only. Do not use old legacy cursor
timestamps as a substitute.

## 6. Switch the observer to non-shadow, then restart the main worker

Keep Entries OFF. Change only the observer environment and preserve its PM2
name:

```bash
cd /path/to/solana-copilot/worker
FRESH_TAIL_SHADOW=false pm2 restart helix-fresh-tail-v1 --update-env
pm2 logs helix-fresh-tail-v1 --lines 100 --nostream
```

Repeat the heartbeat query from step 5. It must now show `shadow = false` while
all three roots remain covered, fresh backlog remains zero, the heartbeat stays
under four seconds old, and `last_error` remains null.

Only after that proof, restart the matching main worker:

```bash
cd /path/to/solana-copilot/worker
pm2 restart helix-worker-v3 --update-env
pm2 logs helix-worker-v3 --lines 250 --nostream
```

Wait for a `stream heartbeat`. It must show:

- `exactSellClaimReconciliation.ready = true` and `lastError = null`.
- `freshTailExitDrainer.ready = true`, `unresolvedUncertainCount = 0`, and
  `lastError = null`.
- `freshTailEntryMonitoringGate.blocked = false`.

Verify the durable exit outbox directly:

```sql
select
  count(*) filter (where status = 'pending') as pending,
  count(*) filter (where status = 'retry') as retry,
  count(*) filter (where status = 'uncertain') as uncertain
from public.custody_fresh_tail_exit_intents
where user_id = '<HELIX_USER_ID>'::uuid;
```

`uncertain` must be zero. Before first activation, also wait for `pending = 0`
and `retry = 0`. Any startup sell-reconciliation or fresh-tail exit-drain error
is a stop condition even if PM2 says the process is online.

## 7. Enable entries

Recheck that Supply Accumulation and Custody Journey are ON, the observer is
non-shadow and healthy, and the direct target sell mode is not `proportional`.
Only then turn **Entries ON** in the dashboard.

Save the known-good PM2 process list:

```bash
pm2 save
```

Fresh initial entries can now act on newly created, finalized, fully covered
launches without waiting for the multi-day legacy cursor backlog. Scale tiers
remain disabled until their normal strict legacy gate is healthy; this rollout
does not weaken or bypass that rule.

## Rollback

If any live proof regresses:

1. Turn **Entries OFF** immediately in the dashboard.
2. Keep Supply Accumulation and Custody Journey ON so exit policy and legacy
   custody evidence remain available.
3. Stop only the fresh observer:

```bash
pm2 stop helix-fresh-tail-v1
pm2 save
pm2 status
```

Do **not** stop `helix-worker-v3` or `helix-custody-v1`, and do not reset any
cursor or epoch. The main worker continues standard exits and drains already
persisted fresh-tail exit intents; the legacy Custody observer continues its
own catch-up. Stopping the fresh observer also stops creation of new fresh-tail
evidence, so investigate promptly rather than leaving open positions in this
state indefinitely.
