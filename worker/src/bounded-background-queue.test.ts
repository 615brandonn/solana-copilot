import assert from "node:assert/strict";
import test from "node:test";
import { BoundedBackgroundQueue } from "./bounded-background-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition did not become true");
}

test("queue caps concurrency and retained work while preserving FIFO start order", async () => {
  const queue = new BoundedBackgroundQueue(2, 2);
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const started: number[] = [];
  for (let index = 0; index < gates.length; index += 1) {
    assert.equal(
      queue.schedule(`task-${index}`, async () => {
        started.push(index);
        await gates[index].promise;
      }),
      "scheduled",
    );
  }
  assert.equal(
    queue.schedule("overflow", async () => undefined),
    "full",
  );
  assert.deepEqual(queue.health(), { active: 2, queued: 2, retained: 4 });
  await eventually(() => started.length === 2);
  assert.deepEqual(started, [0, 1]);
  gates[0].resolve();
  await eventually(() => started.length === 3);
  assert.deepEqual(started, [0, 1, 2]);
  for (const gate of gates) gate.resolve();
  await eventually(() => queue.health().retained === 0);
});

test("duplicates are coalesced and rejection releases capacity", async () => {
  const queue = new BoundedBackgroundQueue(1, 1);
  const gate = deferred();
  assert.equal(
    queue.schedule("same", () => gate.promise),
    "scheduled",
  );
  assert.equal(
    queue.schedule("same", async () => undefined),
    "duplicate",
  );
  assert.equal(
    queue.schedule("reject", async () => {
      throw new Error("expected test rejection");
    }),
    "scheduled",
  );
  gate.resolve();
  await eventually(() => queue.health().retained === 0);
  assert.equal(
    queue.schedule("same", async () => undefined),
    "scheduled",
  );
  await eventually(() => queue.health().retained === 0);
});
