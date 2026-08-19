import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRICE_SANITY,
  checkPriceSanity,
  priceSanityConfigFrom,
  type PriceSanityState,
} from "./price-sanity.js";

test("normal ticks pass and advance the baseline", () => {
  let state: PriceSanityState = {};
  for (const price of [0.00001, 0.000012, 0.000011, 0.000015]) {
    const result = checkPriceSanity(price, 0.00001, state, DEFAULT_PRICE_SANITY);
    assert.equal(result.accepted, true);
    assert.equal(result.state.lastGood, price);
    state = result.state;
  }
});

test("the real corrupted tick is rejected", () => {
  const result = checkPriceSanity(0.05229, 0.000010498269301215398, {
    lastGood: 0.0000111,
  });
  assert.equal(result.accepted, false);
  assert.match(String(result.reason), /exceeds/);
  assert.match(String(result.reason), /1\/3 confirmations/);
});

test("wildly disagreeing garbage never accumulates confirmations", () => {
  const entry = 0.00001;
  let state: PriceSanityState = { lastGood: 0.00001 };
  for (const price of [0.05229, 1.2, 0.0004, 900]) {
    const result = checkPriceSanity(price, entry, state);
    assert.equal(result.accepted, false, `expected reject for ${price}`);
    assert.equal(result.state.pending?.count, 1);
    state = result.state;
  }
});

test("a sustained level is confirmed after three agreeing ticks", () => {
  const entry = 0.00001;
  let state: PriceSanityState = { lastGood: 0.00001 };
  const first = checkPriceSanity(0.005, entry, state);
  assert.equal(first.accepted, false);
  state = first.state;
  const second = checkPriceSanity(0.0051, entry, state);
  assert.equal(second.accepted, false);
  state = second.state;
  const third = checkPriceSanity(0.0049, entry, state);
  assert.equal(third.accepted, true);
  assert.equal(third.confirmedOutlier, true);
  assert.equal(third.state.lastGood, 0.0049);
});

test("a genuine collapse is eventually accepted so stop-loss still fires", () => {
  const entry = 0.001;
  let state: PriceSanityState = { lastGood: 0.001 };
  let accepted = false;
  for (let i = 0; i < 3; i += 1) {
    const result = checkPriceSanity(0.00001, entry, state);
    state = result.state;
    accepted = result.accepted;
  }
  assert.equal(accepted, true);
  assert.equal(state.lastGood, 0.00001);
});

test("a single downward glitch is rejected", () => {
  const result = checkPriceSanity(0.0000001, 0.001, { lastGood: 0.001 });
  assert.equal(result.accepted, false);
  assert.ok((result.tickJump ?? 0) > 1);
});

test("rejection preserves the previous good price", () => {
  const result = checkPriceSanity(0.05229, 0.00001, { lastGood: 0.000012 });
  assert.equal(result.accepted, false);
  assert.equal(result.state.lastGood, 0.000012);
  assert.equal(result.state.pending?.price, 0.05229);
});

test("zero entry passes through", () => {
  const result = checkPriceSanity(0.5, 0);
  assert.equal(result.accepted, true);
  assert.equal(result.state.lastGood, 0.5);
});

test("non-positive prices are rejected", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(checkPriceSanity(bad, 0.001, { lastGood: 0.001 }).accepted, false);
  }
});

test("config falls back on nonsense values", () => {
  assert.deepEqual(priceSanityConfigFrom(null), DEFAULT_PRICE_SANITY);
  assert.deepEqual(
    priceSanityConfigFrom({
      price_sanity_max_entry_multiple: 0,
      price_sanity_max_tick_jump: 1,
      price_sanity_confirm_ticks: 0,
    }),
    DEFAULT_PRICE_SANITY,
  );
  assert.deepEqual(
    priceSanityConfigFrom({
      price_sanity_max_entry_multiple: 50,
      price_sanity_max_tick_jump: 10,
      price_sanity_confirm_ticks: 2,
    }),
    { maxEntryMultiple: 50, maxTickJump: 10, confirmTicks: 2, agreementTolerance: 0.25 },
  );
});
