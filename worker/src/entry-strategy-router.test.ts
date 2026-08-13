import assert from "node:assert/strict";
import test from "node:test";
import { automaticEntryStrategy } from "./entry-strategy-router.js";

test("Conviction Mode off preserves the existing regular strategy", () => {
  assert.equal(
    automaticEntryStrategy({
      conviction_mode_enabled: false,
      coordinated_mode_enabled: false,
    }),
    "regular",
  );
});

test("Conviction Mode off preserves the existing coordinated strategy", () => {
  assert.equal(
    automaticEntryStrategy({
      conviction_mode_enabled: false,
      coordinated_mode_enabled: true,
    }),
    "coordinated",
  );
});

test("Conviction Mode is the exclusive automatic entry strategy while enabled", () => {
  assert.equal(
    automaticEntryStrategy({
      conviction_mode_enabled: true,
      coordinated_mode_enabled: false,
    }),
    "conviction",
  );
  assert.equal(
    automaticEntryStrategy({
      conviction_mode_enabled: true,
      coordinated_mode_enabled: true,
    }),
    "conviction",
  );
});

test("turning Conviction Mode back off restores saved legacy routing", () => {
  const saved = { conviction_mode_enabled: true, coordinated_mode_enabled: true };
  assert.equal(automaticEntryStrategy(saved), "conviction");
  saved.conviction_mode_enabled = false;
  assert.equal(automaticEntryStrategy(saved), "coordinated");
  assert.equal(saved.coordinated_mode_enabled, true);
});
