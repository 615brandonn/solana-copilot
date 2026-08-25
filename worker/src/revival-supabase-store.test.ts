import assert from "node:assert/strict";
import test from "node:test";

import {
  revivalEventFallsWithinCampaign,
  revivalMarketSamplingIsStale,
} from "./revival-supabase-store.js";

test("projection repair excludes market completions that arrived after campaign closure", () => {
  assert.equal(revivalEventFallsWithinCampaign(200, 100, 200), true);
  assert.equal(revivalEventFallsWithinCampaign(201, 100, 200), false);
  assert.equal(revivalEventFallsWithinCampaign(99, 100, 200), false);
  assert.equal(revivalEventFallsWithinCampaign(10_000, 100), true);
});

test("heartbeat degrades when active market sampling silently stops", () => {
  assert.equal(
    revivalMarketSamplingIsStale({ activeCampaignCount: 1, lastMarketSnapshotAt: 1_000 }, 91_001),
    true,
  );
  assert.equal(
    revivalMarketSamplingIsStale({ activeCampaignCount: 1, lastMarketSnapshotAt: 1_000 }, 91_000),
    false,
  );
  assert.equal(
    revivalMarketSamplingIsStale({ activeCampaignCount: 0, lastMarketSnapshotAt: null }, 1_000_000),
    false,
  );
});
