import assert from "node:assert/strict";
import test from "node:test";

import { buildRevivalDashboard, type RevivalDashboardSummary } from "./revival.js";

const NOW = Date.parse("2026-08-23T12:00:00.000Z");

function campaign(id: string, state: string, closed = false): Record<string, unknown> {
  return {
    id,
    token_mint: `mint-${id}`,
    state,
    state_version: 1,
    eligibility_status: "eligible",
    eligibility_reason: "seed_market_cap_in_range",
    seeded_at: "2026-08-23T11:00:00.000Z",
    last_available_at: "2026-08-23T11:59:00.000Z",
    closed_at: closed ? "2026-08-23T11:59:00.000Z" : null,
    coverage_status: "COMPLETE",
  };
}

test("dashboard preserves authoritative totals when the campaign table is truncated", () => {
  const summary: RevivalDashboardSummary = {
    active: 18,
    entryReady: 4,
    ignition: 3,
    distributionRisk: 2,
    closed: 500,
    invalidated: 120,
    coverageGaps: 7,
  };
  const dashboard = buildRevivalDashboard(
    [campaign("recent", "ENTRY_READY")],
    {
      enabled: true,
      degraded: false,
      updated_at: "2026-08-23T11:59:50.000Z",
    },
    NOW,
    summary,
    638,
  );

  assert.deepEqual(dashboard.summary, summary);
  assert.equal(dashboard.campaignsReturned, 1);
  assert.equal(dashboard.campaignsTotal, 638);
  assert.equal(dashboard.campaignsTruncated, true);
  assert.equal(dashboard.health.enabled, true);
  assert.equal(dashboard.health.online, true);
});

test("dashboard heartbeat exposes a fresh but disabled observer as disabled", () => {
  const dashboard = buildRevivalDashboard(
    [],
    {
      enabled: false,
      degraded: false,
      updated_at: "2026-08-23T11:59:50.000Z",
    },
    NOW,
  );
  assert.equal(dashboard.health.installed, true);
  assert.equal(dashboard.health.enabled, false);
  assert.equal(dashboard.health.online, true);
  assert.equal(dashboard.campaignsTruncated, false);
});
