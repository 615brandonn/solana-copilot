import assert from "node:assert/strict";
import test from "node:test";
import { SubmissionUncertainError } from "./execution-safety.js";
import { submitKnownSignatureWithTimeout } from "./rpc-submission.js";

test("raw submission returns only the locally known signature", async () => {
  const signature = await submitKnownSignatureWithTimeout({
    route: "pump.fun",
    knownSig: "known-signature",
    timeoutMs: 50,
    send: async () => "known-signature",
  });
  assert.equal(signature, "known-signature");
});

test("a hung raw submission is bounded but remains uncertain under the known signature", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    submitKnownSignatureWithTimeout({
      route: "pump.fun",
      knownSig: "known-signature",
      timeoutMs: 10,
      send: () => new Promise<string>(() => undefined),
    }),
    (error: unknown) => {
      assert(error instanceof SubmissionUncertainError);
      assert.equal(error.txSig, "known-signature");
      assert.equal(error.route, "pump.fun");
      assert.match(error.message, /submission timed out/);
      return true;
    },
  );
  assert(Date.now() - startedAt < 500, "hung submission exceeded its local bound");
});

test("RPC errors and mismatched signatures can never authorize an alternate route", async () => {
  for (const send of [
    async () => {
      throw new Error("connection reset");
    },
    async () => "different-signature",
  ]) {
    await assert.rejects(
      submitKnownSignatureWithTimeout({
        route: "rpc",
        knownSig: "known-signature",
        timeoutMs: 50,
        send,
      }),
      (error: unknown) => {
        assert(error instanceof SubmissionUncertainError);
        assert.equal(error.txSig, "known-signature");
        return true;
      },
    );
  }
});
