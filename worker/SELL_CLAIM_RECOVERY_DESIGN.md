# Sell claim crash recovery handoff

Base audited: `1965c57535bbd485fc3d422fc6b3e2c8eb7c55f4`.

This branch contains the fail-closed recovery policy, exact transaction token-debit parser,
and the proposed atomic database boundaries. It intentionally does **not** wire the migration
into the live worker yet. Do not apply `sell-claim-recovery-migration.sql` or deploy these files
alone; the worker must switch its existing sell path to both RPCs in the same release.

## Required runtime sequence

1. Insert the durable sell claim, including reason and position-marker intent.
2. Change `claimed -> submitted` before transaction construction.
3. In `onInputAmountCapped`, retain the exact sold raw amount, exact wallet raw balance, and
   decimals returned by the executor.
4. In `onPrepared`, call `prepare_sell_claim_attempt_v1` with the signed transaction signature,
   recent blockhash, optional last-valid block height, and exact raw values. A failed response
   cancels submission. The existing final `beforeSubmit` gate must then confirm the same claim,
   signature, and recovery version.
5. After confirmation, load that exact signature with `getTransaction`; derive the owner/mint
   raw pre/post debit with `confirmedTokenDebitFromTx`; require it to equal the prepared sold raw
   amount; then call `apply_landed_sell_claim_v1`.
6. Remove the current separate position update, trade insert, and claim-landed update. The RPC is
   the sole atomic accounting boundary. Treat a lost RPC response as uncertain and replay it.
7. Run the same reconciliation once before feed startup and every 60 seconds. Never derive a
   sell from a later wallet snapshot.

## Recovery matrix

| Durable point at crash | Evidence after restart | Automatic action |
| --- | --- | --- |
| `claimed`, no signature | Stale at least 120 seconds | Release as proven pre-send |
| `submitted`, no signature | Stale at least 120 seconds | Release as proven pre-send |
| Signature stored, before send | Blockhash expired; history-enabled signature lookup is null twice | Release |
| Signature stored, send uncertain | Signature missing but blockhash still valid | Quarantine |
| Signature stored | Processed/confirmed success or failure | Quarantine until finalized |
| Signature stored | Finalized failure | Release |
| Signature stored | Finalized success, missing/mismatched exact debit | Quarantine |
| Signature stored | Finalized success, exact debit matches | Replay atomic apply RPC |
| Atomic apply committed, response lost | Claim is `landed` with matching receipt/trade | Idempotent no-op replay |
| Legacy signed claim | Any chain result | Manual quarantine; it lacks the immutable prepared snapshot |

## Why the current worker cannot safely auto-repair a landed sell

The current order is transaction landing, position update, trade insert, then claim update. A
legacy `submitted` row plus a finalized signature and no trade is compatible with two different
crashes: before the position update or after it but before the trade insert. Subtracting again can
double-debit the position; assuming it already applied can leave the ledger overstated. No later
wallet balance resolves that ambiguity when manual holdings coexist. Only the new atomic RPC
removes it.

## Deployment gates

- The migration must be syntax-tested against a disposable PostgreSQL/Supabase instance.
- Its two unique indexes deliberately fail if historical duplicate signatures exist; inspect and
  resolve those rows instead of weakening the invariant.
- Mirror the migration into `supabase/schema.sql` and regenerate Supabase types.
- Add runtime/store tests for every row of the matrix plus a simulated lost apply-RPC response.
- Run Doctor and require zero pre-existing `claimed`, `submitted`, or `uncertain` sell claims.
- Keep Entries off until the migration and matching runtime are deployed together and forward
  shadow validation is clean.
