import assert from "node:assert/strict";
import test from "node:test";

import { authoritativeCoordinatedTargetLinks } from "./target-link-backfill.js";

const position = {
  positionId: "position",
  tokenMint: "mint",
  entryMode: "coordinated",
  rootBuyCount: 2,
  anchorAt: "2026-08-11T12:00:10.000Z",
  lastRootBuyWallet: "target-b",
};

test("backfills only a complete, configured, coordinated Strategy Lab cohort", () => {
  const links = authoritativeCoordinatedTargetLinks({
    position,
    configuredTargets: new Set(["target-a", "target-b", "unseen-target"]),
    windowSeconds: 30,
    observations: [
      {
        actor_wallet: "target-a",
        event_at: "2026-08-11T12:00:00.000Z",
        metadata: { entryMode: "coordinated" },
      },
      {
        actor_wallet: "target-b",
        event_at: "2026-08-11T12:00:10.000Z",
        metadata: { entryMode: "coordinated" },
      },
    ],
  });
  assert.deepEqual(links, ["target-a", "target-b"]);
});

test("partial, out-of-window, or unlabelled evidence never guesses missing targets", () => {
  const base = {
    position,
    configuredTargets: new Set(["target-a", "target-b"]),
    windowSeconds: 30,
  };
  assert.deepEqual(
    authoritativeCoordinatedTargetLinks({
      ...base,
      observations: [
        {
          actor_wallet: "target-b",
          event_at: "2026-08-11T12:00:10.000Z",
          metadata: { entryMode: "coordinated" },
        },
      ],
    }),
    [],
  );
  assert.deepEqual(
    authoritativeCoordinatedTargetLinks({
      ...base,
      observations: [
        {
          actor_wallet: "target-a",
          event_at: "2026-08-11T11:00:00.000Z",
          metadata: { entryMode: "coordinated" },
        },
        {
          actor_wallet: "target-b",
          event_at: "2026-08-11T12:00:10.000Z",
          metadata: {},
        },
      ],
    }),
    [],
  );
});
