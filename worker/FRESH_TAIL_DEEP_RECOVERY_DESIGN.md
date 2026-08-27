# Fresh-tail deep recovery contract

The current observer deliberately stops with `page_limit` when an exact lane
cursor is more than eight 1,000-signature pages behind. It must not advance a
partial cursor: root and descendant events are order-sensitive, and processing
the newest page before undiscovered older transfers could miss a child edge or
authorize an invalid custody state.

A restart-safe deep recovery needs durable discovery state. Raising the page
cap, keeping all pages in Node memory, or moving the cursor to the oldest page
seen are not acceptable fixes.

## Additive schema

Add `custody_fresh_tail_scan_sessions`, unique for one active
`(epoch_id, lane_kind, scope_mint, wallet, range_id)` identity. A session binds:

- the exact durable cursor signature/slot and coverage revision;
- the attested target head slot/blockhash and lease generation;
- `discovering | replaying` phase, next `before` signature, page count, and the
  next oldest page to replay;
- the provider first-available-block witness and terminal boundary proof.

Add `custody_fresh_tail_scan_pages`, keyed by `(session_id, page_index)`, with
the exact request `before` identity, first/last signature and slot, row count,
and SHA-256 digest of every canonical signature row. Page zero additionally
stores its at-most-1,000 canonical rows as JSON because a head request without
`before` shifts when newer finalized transactions arrive. Other pages are
refetched from their immutable `before` anchor and must match their digest.

Both tables are service-only, RLS-protected, epoch-fenced, and cascade when a
session completes. No session data is entry evidence.

## Required RPCs

1. `begin_custody_fresh_tail_scan_session` — CAS the current durable cursor and
   attested head into one fenced discovery session.
2. `append_custody_fresh_tail_scan_page` — append exactly the next descriptor;
   reject changed cursor/head/lease/continuation identities.
3. `seal_custody_fresh_tail_scan_discovery` — record the exact lower-boundary
   and history-floor proof, then switch once to oldest-page replay.
4. `get_custody_fresh_tail_scan_replay_page` — return the next descriptor (or
   stored page-zero rows) only to the current lease generation.
5. `checkpoint_custody_fresh_tail_scan_replay` — after every event and child
   edge on that page are durable, decrement the replay page by CAS.
6. `complete_custody_fresh_tail_scan` — only after every page replays, atomically
   advance the ordinary exact cursor to the session head and delete the
   session. Scope revision and cursor identity must still match.

Any page mismatch, history pruning, blockhash conflict, lease loss, or scope
revision conflict leaves the ordinary cursor untouched. The session is marked
conflicted for diagnosis; it cannot silently restart from a slot.

## Mandatory verification

- Replay 100,000 signatures in exact chronological/block order while restarting
  after every discovery append and every replay checkpoint.
- Prove peak retained Node data is one 1,000-row signature page plus one
  50-transaction batch, independent of backlog depth.
- Shift the live head after discovery; stored page zero must remain identical.
- Mutate any refetched page and prove zero cursor advancement.
- Crash after event persistence but before page checkpoint and prove idempotent
  replay without duplicate accounting.
- Change lease generation, cursor signature, scope revision, first-available
  block, or attested blockhash and prove the session fences closed.

Until this contract exists, `page_limit` is a retryable, fail-closed condition
and the observer must report backlog rather than skip history.
