import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { classifyCustodyWallet } from "./custody-classifier.js";

test("target labels are factual", async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const row = await classifyCustodyWallet(
    { getAccountInfo: async () => null } as never,
    wallet,
    new Set([wallet]),
  );
  assert.equal(row.inferredType, "target");
  assert.equal(row.confidence, 1);
  assert.equal(row.watchable, true);
});

test("ordinary on-curve wallets remain unknown rather than invented CEX or cold labels", async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const row = await classifyCustodyWallet(
    { getAccountInfo: async () => ({ owner: SystemProgram.programId }) } as never,
    wallet,
    new Set(),
  );
  assert.equal(row.inferredType, "unknown");
  assert.equal(row.inferredLabel, null);
  assert.equal(row.watchable, true);
});

test("program-controlled accounts are boundaries, never called exchanges", async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const row = await classifyCustodyWallet(
    {
      getAccountInfo: async () => ({
        owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
      }),
    } as never,
    wallet,
    new Set(),
  );
  assert.equal(row.inferredType, "program");
  assert.equal(row.watchable, false);
  assert.ok(!row.evidence.toLowerCase().includes("exchange"));
});

test("a transient lookup failure does not truncate a valid on-curve custody path", async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const row = await classifyCustodyWallet(
    {
      getAccountInfo: async () => {
        throw new Error("temporary RPC outage");
      },
    } as never,
    wallet,
    new Set(),
  );
  assert.equal(row.inferredType, "unknown");
  assert.equal(row.confidence, 0);
  assert.equal(row.watchable, true);
  assert.equal(row.transientFailure, true);
});

test("a hung account lookup is bounded and remains a retryable transient failure", async () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const startedAt = Date.now();
  const row = await classifyCustodyWallet(
    {
      getAccountInfo: async () => new Promise<never>(() => undefined),
    } as never,
    wallet,
    new Set(),
    { lookupTimeoutMs: 20 },
  );
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(row.watchable, true);
  assert.equal(row.transientFailure, true);
  assert.match(row.evidence, /temporarily unavailable/i);
});

test("an ownerless token-account destination resolves to its controlling wallet", async () => {
  const tokenAccount = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const data = Buffer.alloc(165);
  owner.toBuffer().copy(data, 32);
  const row = await classifyCustodyWallet(
    {
      getAccountInfo: async (address: PublicKey) =>
        address.equals(tokenAccount)
          ? { owner: TOKEN_PROGRAM_ID, data }
          : { owner: SystemProgram.programId, data: Buffer.alloc(0) },
    } as never,
    tokenAccount.toBase58(),
    new Set(),
  );
  assert.equal(row.wallet, owner.toBase58());
  assert.equal(row.watchable, true);
  assert.equal(row.inferredType, "unknown");
  assert.match(row.evidence, /token account was resolved/i);
});
