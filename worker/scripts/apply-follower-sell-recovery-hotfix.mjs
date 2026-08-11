import fs from "node:fs";
import path from "node:path";

const workerRoot = path.resolve(process.argv[2] ?? process.cwd());
const monitorPath = path.join(workerRoot, "src", "monitor.ts");
const indexPath = path.join(workerRoot, "src", "index.ts");

for (const file of [monitorPath, indexPath]) {
  if (!fs.existsSync(file)) {
    throw new Error(`Required source file not found: ${file}`);
  }
}

const originals = new Map([
  [monitorPath, fs.readFileSync(monitorPath, "utf8")],
  [indexPath, fs.readFileSync(indexPath, "utf8")],
]);
const edits = new Map(originals);

function replaceExactly(file, description, needle, replacement) {
  const source = edits.get(file);
  const occurrences = source.split(needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${description}: expected exactly one source anchor, found ${occurrences}. No files were changed.`,
    );
  }
  edits.set(file, source.replace(needle, replacement));
}

const monitorMethods = String.raw`
  /**
   * Recover a follower that is persisted in Supabase but missing from the
   * process-local watch set. This is authoritative only for a positive,
   * descendant holding on the requested open position.
   */
  async ensureFollower(
    positionId: string,
    wallet: string,
    observedSlot?: number,
    observedSignature?: string,
  ): Promise<boolean> {
    if (this.targetWallets.has(wallet)) return false;
    if (this.isFollower(positionId, wallet)) return true;

    const { data: follower, error } = await db
      .from("follower_wallets")
      .select("wallet,hop_depth,current_amount,last_seen_slot,last_seen_signature")
      .eq("position_id", positionId)
      .eq("wallet", wallet)
      .maybeSingle();
    if (error) {
      log.error(
        { err: error, positionId, wallet },
        "follower ownership recovery lookup failed",
      );
      return false;
    }

    const hopDepth = Number(follower?.hop_depth ?? 0);
    const currentAmount = Number(follower?.current_amount ?? 0);
    if (!follower || hopDepth <= 0 || !Number.isFinite(currentAmount) || currentAmount <= 0) {
      log.info(
        { positionId, wallet, hopDepth, currentAmount },
        "unknown sell or transfer wallet rejected after database ownership check",
      );
      return false;
    }

    await this.retainFollower(
      positionId,
      wallet,
      observedSlot ??
        (follower.last_seen_slot === null ? undefined : Number(follower.last_seen_slot)),
      observedSignature ?? follower.last_seen_signature ?? undefined,
    );
    log.warn(
      { positionId, wallet, hopDepth, currentAmount },
      "follower ownership recovered before event routing",
    );
    return true;
  }

  /** Restore every persisted positive follower holding for active positions. */
  async reconcileFollowersFromDatabase(): Promise<number> {
    const positionIds = Array.from(this.active.keys());
    if (positionIds.length === 0) return 0;

    const { data: followers, error } = await db
      .from("follower_wallets")
      .select("position_id,wallet,current_amount,last_seen_slot,last_seen_signature")
      .in("position_id", positionIds)
      .gt("hop_depth", 0)
      .gt("current_amount", 0);
    if (error) {
      throw new Error("follower ownership reconciliation failed: " + error.message);
    }

    let restored = 0;
    for (const follower of followers ?? []) {
      if (!this.active.has(follower.position_id)) continue;
      if (this.isFollower(follower.position_id, follower.wallet)) continue;
      await this.retainFollower(
        follower.position_id,
        follower.wallet,
        follower.last_seen_slot === null ? undefined : Number(follower.last_seen_slot),
        follower.last_seen_signature ?? undefined,
      );
      restored += 1;
    }
    if (restored > 0) {
      log.warn(
        { activePositionCount: positionIds.length, restored },
        "persisted follower ownership restored into live watch set",
      );
    }
    return restored;
  }

`;

let monitorSource = edits.get(monitorPath);
const monitorHasRecovery =
  monitorSource.includes("async ensureFollower(") &&
  monitorSource.includes("async reconcileFollowersFromDatabase(");
if (!monitorHasRecovery) {
  replaceExactly(
    monitorPath,
    "monitor recovery methods",
    "  /** Register (or top up) a follower wallet after target transfers tokens to it. */",
    monitorMethods + "  /** Register (or top up) a follower wallet after target transfers tokens to it. */",
  );
}

let indexSource = edits.get(indexPath);
const indexHasPreflight = indexSource.includes("await monitorRef.current?.ensureFollower(");
if (!indexHasPreflight) {
  replaceExactly(
    indexPath,
    "async event dispatcher",
    "  const dispatchEvent = (event: FeedEvent) => {",
    "  const dispatchEvent = async (event: FeedEvent) => {",
  );

  const relevanceAnchor = "    const relevant = isRelevantStrategyEvent(\n";
  const ownershipPreflight = String.raw`    // A restart, transient database failure, or missed transfer can leave the
    // in-memory follower set behind Supabase. Before the relevance filter can
    // silently discard an exit, verify an unknown sell/transfer source against
    // the persisted ownership row for this exact open position and mint.
    const ownershipWallet =
      event.kind === "swap" ? (event.side === "sell" ? event.wallet : undefined) : event.from;
    const ownershipCtx = monitorRef.current?.activeForMint(event.tokenMint);
    if (
      ownershipWallet &&
      ownershipCtx &&
      !targetWallets.has(ownershipWallet) &&
      !monitorRef.current?.isFollower(ownershipCtx.positionId, ownershipWallet)
    ) {
      await monitorRef.current?.ensureFollower(
        ownershipCtx.positionId,
        ownershipWallet,
        event.slot,
        event.txSig,
      );
    }

`;
  replaceExactly(
    indexPath,
    "pre-routing ownership verification",
    relevanceAnchor,
    ownershipPreflight + relevanceAnchor,
  );

}

indexSource = edits.get(indexPath);
const indexHasStartupRecovery = indexSource.includes(
  "await monitor.reconcileFollowersFromDatabase();",
);
if (!indexHasStartupRecovery) {
  const startupAnchor = "  // A follower sell is persisted before its mirror transaction is built. If\n";
  const startupRecovery = String.raw`  // Repair any persisted follower ownership that was absent from memory before
  // accepting live events. This also re-subscribes those wallets immediately.
  await monitor.reconcileFollowersFromDatabase();

`;
  replaceExactly(
    indexPath,
    "startup follower recovery",
    startupAnchor,
    startupRecovery + startupAnchor,
  );
}

indexSource = edits.get(indexPath);
const indexHasPeriodicRecovery =
  indexSource.includes("let followerOwnershipReconciliationRunning = false;") ||
  indexSource.includes("let followerSubscriptionReconciliationRunning = false;");
if (!indexHasPeriodicRecovery) {
  const loopAnchor = "  let followerSellReconciliationRunning = false;\n";
  const recoveryLoop = String.raw`  let followerOwnershipReconciliationRunning = false;
  setInterval(() => {
    if (followerOwnershipReconciliationRunning) return;
    followerOwnershipReconciliationRunning = true;
    monitor
      .reconcileFollowersFromDatabase()
      .catch((err) => log.error({ err }, "follower ownership reconciliation loop failed"))
      .finally(() => {
        followerOwnershipReconciliationRunning = false;
      });
  }, 15_000);

`;
  replaceExactly(
    indexPath,
    "periodic follower recovery",
    loopAnchor,
    recoveryLoop + loopAnchor,
  );
}

for (const [file, source] of edits) {
  if (source === originals.get(file)) {
    console.log(`Already patched: ${path.relative(workerRoot, file)}`);
  }
}

const changedFiles = [...edits].filter(([file, source]) => source !== originals.get(file));
if (changedFiles.length === 0) {
  console.log("Follower-sell recovery hotfix is already present. No changes needed.");
  process.exit(0);
}

// Validate all intended safeguards before making a single write.
const combined = [...edits.values()].join("\n");
for (const marker of [
  "async ensureFollower(",
  "async reconcileFollowersFromDatabase(",
  "const dispatchEvent = async (event: FeedEvent)",
  "await monitor.reconcileFollowersFromDatabase();",
]) {
  if (!combined.includes(marker)) {
    throw new Error(`Internal validation failed; missing marker: ${marker}. No files were changed.`);
  }
}
if (
  !combined.includes("follower ownership reconciliation loop failed") &&
  !combined.includes("follower subscription reconciliation loop failed")
) {
  throw new Error(
    "Internal validation failed; missing periodic follower reconciliation loop. No files were changed.",
  );
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = path.join(workerRoot, `.follower-sell-hotfix-backup-${stamp}`);
fs.mkdirSync(path.join(backupRoot, "src"), { recursive: true });
for (const [file, source] of originals) {
  fs.writeFileSync(path.join(backupRoot, "src", path.basename(file)), source, "utf8");
}
for (const [file, source] of changedFiles) {
  fs.writeFileSync(file, source, "utf8");
}

console.log(`Backup created: ${backupRoot}`);
for (const [file] of changedFiles) {
  console.log(`Patched: ${path.relative(workerRoot, file)}`);
}
console.log("Follower-sell recovery hotfix applied successfully.");
