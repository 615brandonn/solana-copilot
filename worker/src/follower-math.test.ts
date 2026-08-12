import assert from "node:assert/strict";
import test from "node:test";

import {
  chainedTransferAmount,
  followerSoldFraction,
  isFlatPosition,
  nextFollowerHop,
  proportionalMirrorSell,
} from "./follower-math.js";

test("follower propagation stops after three hops", () => {
  assert.equal(nextFollowerHop(1), 2);
  assert.equal(nextFollowerHop(2), 3);
  assert.equal(nextFollowerHop(3), null);
});

test("observation-only lineage can continue to a hard maximum of five hops", () => {
  assert.equal(nextFollowerHop(3, 5), 4);
  assert.equal(nextFollowerHop(4, 5), 5);
  assert.equal(nextFollowerHop(5, 5), null);
  assert.equal(nextFollowerHop(5, 500), null);
});

test("chained transfers move only the sender's available cohort balance", () => {
  assert.equal(chainedTransferAmount(75, 25), 25);
  assert.equal(chainedTransferAmount(10, 25), 10);
  assert.equal(chainedTransferAmount(10, -1), 0);
});

test("net follower selling is based on conserved cohort supply", () => {
  assert.equal(
    followerSoldFraction([
      { initial_amount: 60, current_amount: 40 },
      { initial_amount: 40, current_amount: 20 },
    ]),
    0.4,
  );
  assert.equal(followerSoldFraction([{ initial_amount: 0, current_amount: 0 }]), 0);
  assert.equal(followerSoldFraction([{ initial_amount: 100, current_amount: -5 }]), 1);
});

test("unresolved custody outflows are not counted again as verified sales", () => {
  const fraction = followerSoldFraction([
    {
      initial_amount: 100,
      current_amount: 40,
      unexplained_outflow_amount: 40,
    },
  ]);
  assert.ok(Math.abs(fraction - 0.2) < 1e-12);
});

test("proportional mirroring is cumulative and never oversells", () => {
  assert.equal(proportionalMirrorSell(100, 100, 0.3), 30);
  assert.equal(proportionalMirrorSell(100, 70, 0.3), 0);
  assert.equal(proportionalMirrorSell(100, 70, 0.5), 20);
  assert.equal(proportionalMirrorSell(100, 12, 1), 12);
});

test("sell-all results are treated as flat despite floating point dust", () => {
  assert.equal(isFlatPosition(0), true);
  assert.equal(isFlatPosition(5e-10), true);
  assert.equal(isFlatPosition(1e-4), false);
});
