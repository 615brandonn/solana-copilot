import assert from "node:assert/strict";
import test from "node:test";
import {
  createSupabaseFreshTailStore,
  type FreshTailDbClient,
  type FreshTailLease,
} from "./fresh-tail-store.js";

type RpcCall = { name: string; parameters: Record<string, unknown> };

function client(calls: RpcCall[], response: Record<string, unknown>): FreshTailDbClient {
  return {
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      return { data: response, error: null };
    },
  };
}

const lease: FreshTailLease = {
  epochId: "00000000-0000-4000-8000-000000000001",
  leaseToken: "00000000-0000-4000-8000-000000000002",
  leaseGeneration: 7,
  leaseExpiresAt: "2026-08-26T06:00:30.000Z",
};

const roots = [
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
] as const;

test("active epoch lookup strictly restores restart identity before activation", async () => {
  const calls: RpcCall[] = [];
  const store = createSupabaseFreshTailStore(
    client(calls, {
      ok: true,
      reason: "active_epoch_found",
      epochId: lease.epochId,
      activationSlot: 123,
      activationBlockhash: "activation-hash",
      activationBlockTime: "2026-08-26T06:00:00.000Z",
      rootWallets: [...roots].sort(),
      rootFingerprint: "a".repeat(64),
      scopeRevision: 4,
      leaseOwner: "prior-process",
      leaseGeneration: 7,
      leaseExpiresAt: "2026-08-26T06:00:30.000Z",
      status: "active",
    }),
    "00000000-0000-4000-8000-000000000003",
  );
  const epoch = await store.loadActiveEpoch();
  assert.equal(epoch?.epochId, lease.epochId);
  assert.deepEqual(epoch?.rootWallets, [...roots].sort());
  assert.deepEqual(calls, [
    {
      name: "get_custody_fresh_tail_active_epoch",
      parameters: { p_user_id: "00000000-0000-4000-8000-000000000003" },
    },
  ]);
});

test("active epoch lookup accepts the database's authoritative collation order", async () => {
  const databaseOrderedRoots = [
    "7iVCXQn4u6tiTEfNVqbWSEsRdEi69E9oYsSMiepuECwi",
    "7JCe3GHwkEr3feHgtLXnmuJ1yB3A7coSeyynxTBgdG8k",
    "Em8J3gBWapfVBGVhVipwQnLrqCvnWBnLajw6XFsFECPF",
  ] as const;
  assert.notDeepEqual(databaseOrderedRoots, [...databaseOrderedRoots].sort());
  const permutations = [
    databaseOrderedRoots,
    [databaseOrderedRoots[0], databaseOrderedRoots[2], databaseOrderedRoots[1]],
    [databaseOrderedRoots[1], databaseOrderedRoots[0], databaseOrderedRoots[2]],
    [databaseOrderedRoots[1], databaseOrderedRoots[2], databaseOrderedRoots[0]],
    [databaseOrderedRoots[2], databaseOrderedRoots[0], databaseOrderedRoots[1]],
    [databaseOrderedRoots[2], databaseOrderedRoots[1], databaseOrderedRoots[0]],
  ];
  for (const rootWallets of permutations) {
    const store = createSupabaseFreshTailStore(
      client([], {
        ok: true,
        reason: "active_epoch_found",
        epochId: lease.epochId,
        activationSlot: 123,
        activationBlockhash: "activation-hash",
        activationBlockTime: "2026-08-26T06:00:00.000Z",
        rootWallets,
        rootFingerprint: "a".repeat(64),
        scopeRevision: 0,
        leaseOwner: null,
        leaseGeneration: 0,
        leaseExpiresAt: null,
        status: "active",
      }),
      "00000000-0000-4000-8000-000000000003",
    );

    const epoch = await store.loadActiveEpoch();
    assert.deepEqual(epoch?.rootWallets, [...databaseOrderedRoots].sort());
  }
});

test("active epoch lookup still rejects a duplicate root set", async () => {
  const store = createSupabaseFreshTailStore(
    client([], {
      ok: true,
      reason: "active_epoch_found",
      epochId: lease.epochId,
      activationSlot: 123,
      activationBlockhash: "activation-hash",
      activationBlockTime: "2026-08-26T06:00:00.000Z",
      rootWallets: [roots[0], roots[0], roots[2]],
      rootFingerprint: "a".repeat(64),
      scopeRevision: 0,
      leaseOwner: null,
      leaseGeneration: 0,
      leaseExpiresAt: null,
      status: "active",
    }),
    "00000000-0000-4000-8000-000000000003",
  );
  await assert.rejects(store.loadActiveEpoch(), /active fresh-tail epoch response is malformed/);
});

test("active epoch lookup returns null only for the exact absence result", async () => {
  const store = createSupabaseFreshTailStore(
    client([], { ok: false, reason: "no_active_epoch" }),
    "00000000-0000-4000-8000-000000000003",
  );
  assert.equal(await store.loadActiveEpoch(), null);

  const corrupt = createSupabaseFreshTailStore(
    client([], { ok: false, reason: "active_epoch_root_identity_corrupt" }),
    "00000000-0000-4000-8000-000000000003",
  );
  await assert.rejects(
    corrupt.loadActiveEpoch(),
    /active fresh-tail epoch unavailable: active_epoch_root_identity_corrupt/,
  );
});

test("lease renewal sends the prior token and generation as a fencing CAS", async () => {
  const calls: RpcCall[] = [];
  const store = createSupabaseFreshTailStore(
    client(calls, {
      ok: true,
      reason: "leased",
      epochId: lease.epochId,
      leaseToken: lease.leaseToken,
      leaseGeneration: lease.leaseGeneration,
      leaseExpiresAt: lease.leaseExpiresAt,
    }),
    "00000000-0000-4000-8000-000000000003",
  );
  assert.deepEqual(await store.acquireLease(lease.epochId, "random-process-id", 30, lease), lease);
  assert.deepEqual(calls, [
    {
      name: "acquire_custody_fresh_tail_lease",
      parameters: {
        p_user_id: "00000000-0000-4000-8000-000000000003",
        p_epoch_id: lease.epochId,
        p_worker_id: "random-process-id",
        p_lease_seconds: 30,
        p_expected_lease_token: lease.leaseToken,
        p_expected_lease_generation: 7,
      },
    },
  ]);
});

test("first lease acquisition explicitly sends a null prior identity", async () => {
  const calls: RpcCall[] = [];
  const store = createSupabaseFreshTailStore(
    client(calls, { ok: false, reason: "lease_busy" }),
    "00000000-0000-4000-8000-000000000003",
  );
  assert.equal(await store.acquireLease(lease.epochId, "random-process-id"), null);
  assert.equal(calls[0]?.parameters.p_expected_lease_token, null);
  assert.equal(calls[0]?.parameters.p_expected_lease_generation, null);
});

test("resource retirement candidates use a bounded fenced RPC independent of getWork", async () => {
  const calls: RpcCall[] = [];
  const store = createSupabaseFreshTailStore(
    client(calls, {
      ok: true,
      reason: "resource_retirement_candidates",
      activeMintCount: 258,
      overflowCount: 2,
      candidates: [
        {
          tokenMint: "mint-a",
          scopeRevision: 4,
          reason: "resource_cap",
          lastSupplyEventBlockTime: "2026-08-26T05:00:00.000Z",
        },
      ],
    }),
    "00000000-0000-4000-8000-000000000003",
  );
  assert.deepEqual(await store.getRetirementCandidates(lease.epochId, lease, 25), [
    { tokenMint: "mint-a", scopeRevision: 4, reason: "resource_cap" },
  ]);
  assert.deepEqual(calls, [
    {
      name: "get_custody_fresh_tail_retirement_candidates",
      parameters: {
        p_user_id: "00000000-0000-4000-8000-000000000003",
        p_epoch_id: lease.epochId,
        p_lease_token: lease.leaseToken,
        p_lease_generation: lease.leaseGeneration,
        p_limit: 25,
      },
    },
  ]);
});

test("heartbeat uses the fenced SQL RPC and exact canonical head identity", async () => {
  const calls: RpcCall[] = [];
  const store = createSupabaseFreshTailStore(
    client(calls, { ok: true, reason: "heartbeat_recorded" }),
    "00000000-0000-4000-8000-000000000003",
  );
  const result = await store.saveHeartbeat({
    epochId: lease.epochId,
    workerId: "random-process-id",
    lease,
    enabled: true,
    shadow: true,
    latestHead: {
      slot: 123,
      blockhash: "canonical-hash",
      blockTimeMs: 1_777_777_777_000,
      sampledAtMs: 1_777_777_778_000,
    },
    lastSuccessAt: "2026-08-26T06:00:00.000Z",
    lastError: null,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      name: "record_custody_fresh_tail_heartbeat",
      parameters: {
        p_user_id: "00000000-0000-4000-8000-000000000003",
        p_epoch_id: lease.epochId,
        p_lease_token: lease.leaseToken,
        p_lease_generation: 7,
        p_worker_id: "random-process-id",
        p_enabled: true,
        p_shadow: true,
        p_latest_head_slot: 123,
        p_latest_head_blockhash: "canonical-hash",
        p_latest_head_block_time: "2026-05-03T03:09:37.000Z",
        p_last_success_at: "2026-08-26T06:00:00.000Z",
        p_last_error: null,
      },
    },
  ]);
});
