import {
  ConvictionEngine,
  evaluateConvictionEntry,
  nextConvictionTier,
  type ConvictionBreakout,
  type ConvictionConfig,
  type ConvictionEngineUpdate,
  type ConvictionEvent,
  type ConvictionLeaderboardRow,
  type ConvictionTokenSnapshot,
  type ConvictionTradingMode,
  type ConvictionTransition,
} from "./conviction-engine.js";

export type StoredConvictionTier = {
  id: string;
  tokenMint: string;
  tierId: string;
  status:
    | "eligible"
    | "shadowed"
    | "claimed"
    | "submitted"
    | "landed"
    | "persisted"
    | "failed_pre_submit"
    | "uncertain"
    | "skipped";
  tradingMode: ConvictionTradingMode;
  amountUsd: number;
  commitmentUsd: number;
  sourceEventKey?: string;
  botTxSig?: string;
  reference?: string;
  plannedPositionId?: string;
  positionId?: string;
  tierNumber?: number;
  executedAtMs?: number;
};

export type ConvictionTierLifecycleUpdate = {
  status: StoredConvictionTier["status"];
  botTxSig?: string | null;
  positionId?: string | null;
  receivedTokens?: number | null;
  errorCode?: string | null;
};

export type ConvictionTierClaimInput = {
  tokenMint: string;
  tierId: string;
  tierNumber: number;
  tradingMode: ConvictionTradingMode;
  status: "shadowed" | "claimed";
  amountUsd: number;
  commitmentUsd: number;
  score: number;
  sourceEventKey: string;
  reason: string;
};

export type ConvictionTierClaimResult = {
  claimed: boolean;
  row: StoredConvictionTier;
};

export type ConvictionEventWriteResult = "inserted" | "upgraded" | "duplicate";

export type ConvictionRuntimeTransition = {
  eventType:
    | "CONVICTION_STATE_CHANGE"
    | "CONVICTION_BREAKOUT"
    | "WALLET_CONVERGENCE"
    | "TOP_10_ENTRY"
    | "TOP_3_ENTRY"
    | "RAPID_FOLLOW_STARTED"
    | "RAPID_FOLLOW_SCALE_IN"
    | "RAPID_FOLLOW_STOPPED"
    | "DISTRIBUTION_DETECTED"
    | "CONVICTION_TRADE_EXECUTED"
    | "CONVICTION_TRADE_SKIPPED";
  eventKey: string;
  mint: string;
  timestampMs: number;
  transition?: ConvictionTransition;
  breakout?: ConvictionBreakout;
  score?: number;
  reasons: string[];
  metadata?: Record<string, unknown>;
};

export interface ConvictionRuntimeStore {
  loadEvents(): Promise<ConvictionEvent[]>;
  loadTiers(): Promise<StoredConvictionTier[]>;
  /** Distinguishes a new row from stronger evidence replacing UNKNOWN. */
  insertEvent(event: ConvictionEvent): Promise<ConvictionEventWriteResult>;
  saveState(snapshot: ConvictionTokenSnapshot): Promise<void>;
  saveRanks(rows: ConvictionLeaderboardRow[], rankingAtMs: number): Promise<void>;
  saveTransitions(rows: ConvictionRuntimeTransition[]): Promise<void>;
  claimTier(input: ConvictionTierClaimInput): Promise<ConvictionTierClaimResult>;
  updateTier(id: string, update: ConvictionTierLifecycleUpdate): Promise<StoredConvictionTier>;
}

export type ConvictionRuntimeAction = {
  claim: StoredConvictionTier;
  event: ConvictionEvent;
  snapshot: ConvictionTokenSnapshot;
};

export type ConvictionRuntimeResult = {
  duplicate: boolean;
  update: ConvictionEngineUpdate;
  action?: ConvictionRuntimeAction;
};

export type ConvictionRuntimeTickResult = {
  refreshedTokenCount: number;
  persistedRankCount: number;
};

export type ConvictionLiveClaimRevalidationOptions = {
  /** Wall-clock time used to decay rolling windows and refresh ranks. */
  nowMs?: number;
  /** The authoritative global Entries switch at the final submission boundary. */
  globalEntriesEnabled: boolean;
  /**
   * Authoritative live exposure immediately before this claim is submitted.
   * This must exclude the claimed tier: a durable claim is a reservation, not
   * an on-chain position. The runtime adds `claim.amountUsd` exactly once when
   * checking the configured per-token exposure cap.
   */
  currentPositionUsd: number;
  /** Strict source-event age at the automatic submission boundary. Defaults to 15 seconds. */
  maxSourceEventAgeMs?: number;
};

export type ConvictionLiveClaimRevalidationResult = {
  allowed: boolean;
  checkedAtMs: number;
  claimId: string;
  tokenMint: string;
  tierId: string;
  reasons: string[];
  /** Pre-submit view: the current claim is removed and exposure is authoritative. */
  snapshot?: ConvictionTokenSnapshot;
};

export type ConvictionLiveClaimAuthorizationResult = ConvictionLiveClaimRevalidationResult & {
  /** Present only after the durable claimed -> submitted transition succeeds. */
  submittedClaim?: StoredConvictionTier;
};

const consumesTier = (status: StoredConvictionTier["status"]) =>
  ["shadowed", "claimed", "submitted", "landed", "persisted", "uncertain"].includes(status);

const unresolvedLiveTier = (tier: StoredConvictionTier) =>
  tier.tradingMode === "live" &&
  ["claimed", "submitted", "landed", "uncertain"].includes(tier.status);

export class ConvictionRuntime {
  private engine: ConvictionEngine;
  private initialized = false;
  private readonly lastRanks = new Map<string, number>();
  private readonly unresolvedLiveMints = new Set<string>();
  private readonly droppedRankMints = new Set<string>();
  private durableEvents: ConvictionEvent[] = [];
  private durableTiers: StoredConvictionTier[] = [];
  /** Only events whose durable tier claim threw may retry on an exact replay. */
  private readonly pendingTierClaimEvents = new Set<string>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private config: Partial<ConvictionConfig>,
    private readonly store: ConvictionRuntimeStore,
  ) {
    this.engine = new ConvictionEngine(config);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  initialize(): Promise<void> {
    return this.runExclusive(() => this.initializeUnlocked());
  }

  private async initializeUnlocked(): Promise<void> {
    if (this.initialized) return;
    const [events, tiers] = await Promise.all([this.store.loadEvents(), this.store.loadTiers()]);
    this.durableEvents = events;
    this.durableTiers = tiers;
    this.rebuildEngine();
    this.initialized = true;
  }

  private rebuildEngine(
    exposureByMint = new Map<string, number>(),
    previousRanks?: Map<string, number>,
  ): void {
    this.engine = new ConvictionEngine(this.config, [], this.durableEvents);
    this.unresolvedLiveMints.clear();
    for (const tier of this.durableTiers) {
      // Shadow executions are paper history, not real exposure. Mode-specific
      // tier progression prevents a later LIVE switch from inheriting paper
      // buys or skipping its first controlled entry.
      if (tier.tradingMode !== this.engine.config.tradingMode) continue;
      if (unresolvedLiveTier(tier)) this.unresolvedLiveMints.add(tier.tokenMint);
      if (!consumesTier(tier.status) || !this.engine.snapshot(tier.tokenMint)) continue;
      this.engine.recordTierExecution(tier.tokenMint, tier.tierId, {
        amountUsd: tier.amountUsd,
        mode: tier.tradingMode,
        reference: tier.reference ?? tier.id,
        executedAtMs: tier.executedAtMs,
        netCommitmentUsd: tier.commitmentUsd,
        historical: true,
      });
    }
    for (const [mint, amountUsd] of exposureByMint) {
      if (this.engine.snapshot(mint)) this.engine.setPositionUsd(mint, amountUsd);
    }
    this.lastRanks.clear();
    if (previousRanks) {
      for (const [key, rank] of previousRanks) this.lastRanks.set(key, rank);
    } else {
      this.captureRanks();
    }
  }

  reconfigure(config: Partial<ConvictionConfig>): Promise<void> {
    return this.runExclusive(() => this.reconfigureUnlocked(config));
  }

  private async reconfigureUnlocked(config: Partial<ConvictionConfig>): Promise<void> {
    const previousMode = this.engine.config.tradingMode;
    this.config = config;
    this.droppedRankMints.clear();
    this.pendingTierClaimEvents.clear();
    if (!this.initialized) {
      await this.initializeUnlocked();
      return;
    }
    // Startup performs the one authoritative full load. Later setting edits
    // replay the already hydrated durable-equivalent cache, avoiding an O(n)
    // PostgREST rescan while still recomputing cluster membership and scores.
    const exposures = new Map<string, number>();
    if (previousMode === (config.tradingMode ?? previousMode)) {
      for (const snapshot of this.engine.snapshots()) {
        exposures.set(snapshot.mint, snapshot.ourCurrentPositionUsd);
      }
    }
    this.rebuildEngine(exposures);
  }

  snapshot(mint: string): ConvictionTokenSnapshot | undefined {
    return this.engine.snapshot(mint);
  }

  setPositionUsd(mint: string, amountUsd: number): Promise<void> {
    return this.runExclusive(() => this.setPositionUsdUnlocked(mint, amountUsd));
  }

  private async setPositionUsdUnlocked(mint: string, amountUsd: number): Promise<void> {
    await this.initializeUnlocked();
    this.engine.setPositionUsd(mint, amountUsd);
    const snapshot = this.engine.snapshot(mint);
    if (snapshot) await Promise.allSettled([this.store.saveState(snapshot)]);
  }

  /**
   * Advance rolling windows and current ranks during market silence. This never
   * evaluates or claims a tier; it only persists the decayed authoritative
   * state and bounded current leaderboard rows.
   */
  tick(nowMs = Date.now()): Promise<ConvictionRuntimeTickResult> {
    return this.runExclusive(() => this.tickUnlocked(nowMs));
  }

  private async tickUnlocked(nowMs: number): Promise<ConvictionRuntimeTickResult> {
    await this.initializeUnlocked();
    if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error("tick timestamp must be positive");
    const before = new Map(this.engine.snapshots().map((snapshot) => [snapshot.mint, snapshot]));
    for (const window of [5, 30, 60] as const) this.engine.leaderboard(window, nowMs);
    const ranks = this.changedRanks(nowMs, "");
    const changedMints = new Set<string>([
      ...ranks.map((row) => row.mint),
      ...this.droppedRankMints,
    ]);
    const after = this.engine.snapshots();
    const clockTransitions = this.clockTransitions(before, after, nowMs);
    for (const snapshot of after) {
      const prior = before.get(snapshot.mint);
      const rankChanged = ["5", "30", "60"].some((window) => {
        const oldRank = prior?.ranks[window];
        const newRank = snapshot.ranks[window];
        const relevant =
          (oldRank?.currentRank !== undefined && oldRank.currentRank <= 10) ||
          (newRank?.currentRank !== undefined && newRank.currentRank <= 10);
        if (!relevant) return false;
        return (
          oldRank?.currentRank !== newRank?.currentRank ||
          oldRank?.direction !== newRank?.direction ||
          oldRank?.timeInTop10Ms !== newRank?.timeInTop10Ms ||
          oldRank?.timeInTop3Ms !== newRank?.timeInTop3Ms ||
          oldRank?.timeAtOneMs !== newRank?.timeAtOneMs
        );
      });
      if (!prior || prior.rapidFollowStatus !== snapshot.rapidFollowStatus || rankChanged) {
        changedMints.add(snapshot.mint);
      }
    }
    for (const window of [5, 30, 60] as const) {
      for (const row of this.engine.leaderboard(window, nowMs).slice(0, 10)) {
        changedMints.add(row.mint);
      }
    }
    await Promise.all([
      ...after
        .filter((snapshot) => changedMints.has(snapshot.mint))
        .map((snapshot) => this.store.saveState(snapshot)),
      ...(ranks.length > 0 ? [this.store.saveRanks(ranks, nowMs)] : []),
      ...(clockTransitions.length > 0 ? [this.store.saveTransitions(clockTransitions)] : []),
    ]);
    return { refreshedTokenCount: changedMints.size, persistedRankCount: ranks.length };
  }

  /**
   * Revalidate one already-durable live claim immediately before submission.
   *
   * This deliberately does not call `nextConvictionTier`, claim a row, record
   * an execution, or persist diagnostics. The claim is already represented in
   * the engine, so eligibility is evaluated from a cloned pre-claim snapshot
   * with only this exact execution removed. All runtime operations, including
   * reconfigure and lifecycle transitions, share the same exclusive queue.
   */
  revalidateLiveClaim(
    claim: StoredConvictionTier,
    options: ConvictionLiveClaimRevalidationOptions,
  ): Promise<ConvictionLiveClaimRevalidationResult> {
    return this.runExclusive(() => this.revalidateLiveClaimUnlocked(claim, options));
  }

  /**
   * Atomically revalidate and reserve the final submission boundary. Rejected
   * claims remain `claimed`; allowed claims become durably `submitted` before
   * this method returns. Calling this twice can never authorize twice.
   */
  authorizeLiveClaimForSubmission(
    claim: StoredConvictionTier,
    options: ConvictionLiveClaimRevalidationOptions,
  ): Promise<ConvictionLiveClaimAuthorizationResult> {
    return this.runExclusive(async () => {
      // A single executor attempt may invoke its final callback again when an
      // endpoint fails definitively before sending and it tries another route.
      // Revalidate the same durable `submitted` reservation idempotently, but
      // never perform the lifecycle transition more than once.
      const decision = await this.revalidateLiveClaimUnlocked(claim, options, true);
      if (!decision.allowed) return decision;
      const existing = this.durableTiers.find((candidate) => candidate.id === claim.id);
      if (existing?.status === "submitted") {
        return { ...decision, submittedClaim: existing };
      }
      const submittedClaim = await this.store.updateTier(claim.id, { status: "submitted" });
      if (
        submittedClaim.id !== claim.id ||
        submittedClaim.tokenMint !== claim.tokenMint ||
        submittedClaim.tierId !== claim.tierId ||
        submittedClaim.tradingMode !== "live" ||
        submittedClaim.status !== "submitted"
      ) {
        throw new Error("Conviction claim submission transition returned an unexpected row");
      }
      this.cacheTier(submittedClaim);
      if (unresolvedLiveTier(submittedClaim)) {
        this.unresolvedLiveMints.add(submittedClaim.tokenMint);
      }
      return { ...decision, submittedClaim };
    });
  }

  private async revalidateLiveClaimUnlocked(
    claim: StoredConvictionTier,
    options: ConvictionLiveClaimRevalidationOptions,
    allowSameSubmittedClaim = false,
  ): Promise<ConvictionLiveClaimRevalidationResult> {
    await this.initializeUnlocked();
    const nowMs = options.nowMs ?? Date.now();
    const reasons: string[] = [];
    const addReason = (reason: string) => {
      if (!reasons.includes(reason)) reasons.push(reason);
    };
    const result = (snapshot?: ConvictionTokenSnapshot): ConvictionLiveClaimRevalidationResult => ({
      allowed: reasons.length === 0,
      checkedAtMs: nowMs,
      claimId: claim.id,
      tokenMint: claim.tokenMint,
      tierId: claim.tierId,
      reasons,
      snapshot,
    });

    if (!Number.isFinite(nowMs) || nowMs <= 0) addReason("revalidation time is invalid");
    if (!Number.isFinite(options.currentPositionUsd) || options.currentPositionUsd < 0) {
      addReason("authoritative current position exposure is invalid");
    }
    const maxSourceEventAgeMs = options.maxSourceEventAgeMs ?? 15_000;
    if (!Number.isFinite(maxSourceEventAgeMs) || maxSourceEventAgeMs < 0) {
      addReason("maximum source event age is invalid");
    }

    const config = this.engine.config;
    if (!config.enabled) addReason("Conviction Mode is disabled");
    if (config.tradingMode !== "live") addReason("Conviction Mode is not in live mode");
    if (!options.globalEntriesEnabled) addReason("global Entries switch is off");
    if (claim.tradingMode !== "live") addReason("claim is not a live Conviction tier");
    if (claim.status !== "claimed" && !(allowSameSubmittedClaim && claim.status === "submitted")) {
      addReason("claim is no longer awaiting submission");
    }

    const stored = this.durableTiers.find((candidate) => candidate.id === claim.id);
    if (!stored) {
      addReason("claim is not present in durable Conviction state");
    } else {
      if (
        stored.tokenMint !== claim.tokenMint ||
        stored.tierId !== claim.tierId ||
        stored.tradingMode !== claim.tradingMode ||
        stored.sourceEventKey !== claim.sourceEventKey ||
        Math.abs(stored.amountUsd - claim.amountUsd) > 1e-9
      ) {
        addReason("claim no longer matches its durable Conviction record");
      }
      if (
        stored.status !== "claimed" &&
        !(allowSameSubmittedClaim && stored.status === "submitted")
      ) {
        addReason("durable claim is no longer awaiting submission");
      }
    }

    const unresolvedForMint = this.durableTiers.filter(
      (candidate) => candidate.tokenMint === claim.tokenMint && unresolvedLiveTier(candidate),
    );
    if (
      !this.unresolvedLiveMints.has(claim.tokenMint) ||
      unresolvedForMint.length !== 1 ||
      unresolvedForMint[0]?.id !== claim.id
    ) {
      addReason("claim is not the sole current unresolved live tier for this token");
    }

    const source = claim.sourceEventKey
      ? this.durableEvents.find((event) => event.eventId === claim.sourceEventKey)
      : undefined;
    if (!source) {
      addReason("claim source event is missing");
    } else {
      if (
        source.tokenMint !== claim.tokenMint ||
        source.type !== "DEX_BUY" ||
        source.classificationReliable !== true
      ) {
        addReason("claim source is no longer a verified buy for this token");
      }
      if (!config.clusterWallets.includes(source.wallet)) {
        addReason("claim source wallet is no longer in the configured cluster");
      }
      if (Number.isFinite(nowMs) && source.timestampMs > nowMs) {
        addReason("claim source event is newer than the revalidation time");
      }
      if (
        Number.isFinite(nowMs) &&
        Number.isFinite(maxSourceEventAgeMs) &&
        maxSourceEventAgeMs >= 0 &&
        nowMs - source.timestampMs > maxSourceEventAgeMs
      ) {
        addReason("claim source event is stale");
      }
    }

    const tierIndex = config.tiers.findIndex((tier) => tier.id === claim.tierId);
    const configuredTier = tierIndex >= 0 ? config.tiers[tierIndex] : undefined;
    if (!configuredTier) {
      addReason("claimed tier is no longer configured");
    } else {
      if (claim.tierNumber !== tierIndex + 1) {
        addReason("claimed tier order no longer matches current configuration");
      }
      if (!Number.isFinite(claim.amountUsd) || claim.amountUsd <= 0) {
        addReason("claimed tier amount is invalid");
      } else if (claim.amountUsd > configuredTier.buyUsd + 1e-9) {
        addReason("claimed amount exceeds the current configured tier size");
      }
    }

    // Invalid time cannot safely advance rolling windows. All other structural
    // failures still get a snapshot when possible so callers have diagnostics.
    if (!Number.isFinite(nowMs) || nowMs <= 0) return result();
    this.engine.leaderboard(config.primaryLeaderboardWindowMinutes, nowMs);
    const current = this.engine.snapshot(claim.tokenMint);
    if (!current) {
      addReason("claim token is missing from current Conviction state");
      return result();
    }
    if (nowMs < current.lastActivityAtMs) {
      addReason("revalidation time predates current Conviction state");
    }

    const expectedReference = claim.reference ?? claim.id;
    const claimExecutionIndex = current.executedTiers.findIndex(
      (execution) =>
        execution.tierId === claim.tierId &&
        execution.mode === "live" &&
        execution.reference === expectedReference,
    );
    if (claimExecutionIndex < 0) {
      addReason("claim is missing from current Conviction tier state");
    }
    const priorExecutions = current.executedTiers.filter(
      (_execution, index) => index !== claimExecutionIndex,
    );
    const preClaimSnapshot: ConvictionTokenSnapshot = {
      ...current,
      ourCurrentPositionUsd:
        Number.isFinite(options.currentPositionUsd) && options.currentPositionUsd >= 0
          ? options.currentPositionUsd
          : current.ourCurrentPositionUsd,
      executedTiers: priorExecutions,
    };

    if (configuredTier) {
      for (const priorTier of config.tiers.slice(0, tierIndex)) {
        if (!priorExecutions.some((execution) => execution.tierId === priorTier.id)) {
          addReason(`prior tier ${priorTier.id} is no longer executed`);
        }
      }
      if (tierIndex > 0 && !config.rapidFollowEnabled) {
        addReason("Rapid Follow is disabled for this scale-in tier");
      }
      const priorTier = tierIndex > 0 ? config.tiers[tierIndex - 1] : undefined;
      const priorExecution = priorTier
        ? priorExecutions.find((execution) => execution.tierId === priorTier.id)
        : undefined;
      const requiredCommitment = Math.max(
        configuredTier.minNetCommitmentUsd,
        (priorExecution?.netCommitmentUsd ?? 0) *
          (1 + Math.max(0, configuredTier.minCommitmentIncreaseRatio)),
      );
      const primary = preClaimSnapshot.rolling[String(config.primaryLeaderboardWindowMinutes * 60)];
      if (preClaimSnapshot.convictionScore < configuredTier.minScore) {
        addReason("claimed tier score threshold is no longer met");
      }
      if (preClaimSnapshot.netClusterInvestmentUsd < requiredCommitment) {
        addReason("claimed tier commitment threshold is no longer met");
      }
      if (
        !primary ||
        primary.capitalVelocityUsdPerMinute < configuredTier.minVelocityUsdPerMinute
      ) {
        addReason("claimed tier velocity threshold is no longer met");
      }
    }

    const primaryRank =
      preClaimSnapshot.ranks[String(config.primaryLeaderboardWindowMinutes)]?.currentRank;
    const entry = evaluateConvictionEntry(preClaimSnapshot, config, {
      nowMs,
      rank: primaryRank,
      globalEntriesEnabled: options.globalEntriesEnabled,
      requestedBuyUsd: claim.amountUsd,
    });
    for (const failedGate of entry.failedGates) addReason(failedGate);
    if (!entry.authorizedToSubmit && entry.eligible) {
      addReason("current Conviction settings do not authorize live submission");
    }
    return result(preClaimSnapshot);
  }

  /**
   * Advance a durable live tier through its execution lifecycle. Only a
   * definite pre-submission failure releases the tier for a safe retry.
   */
  transitionAction(
    claim: StoredConvictionTier,
    update: ConvictionTierLifecycleUpdate,
  ): Promise<StoredConvictionTier> {
    return this.runExclusive(() => this.transitionActionUnlocked(claim, update));
  }

  private async transitionActionUnlocked(
    claim: StoredConvictionTier,
    update: ConvictionTierLifecycleUpdate,
  ): Promise<StoredConvictionTier> {
    await this.initializeUnlocked();
    const stored = await this.store.updateTier(claim.id, update);
    this.cacheTier(stored);
    if (unresolvedLiveTier(stored)) this.unresolvedLiveMints.add(stored.tokenMint);
    else this.unresolvedLiveMints.delete(stored.tokenMint);
    if (stored.status === "failed_pre_submit" && this.engine.snapshot(claim.tokenMint)) {
      this.engine.releaseTierExecution(claim.tokenMint, claim.tierId);
    }
    const snapshot = this.engine.snapshot(claim.tokenMint);
    const secondaryWrites: Promise<void>[] = [];
    if (snapshot) secondaryWrites.push(this.store.saveState(snapshot));
    if (["persisted", "failed_pre_submit", "uncertain"].includes(stored.status)) {
      const timestampMs = Date.now();
      secondaryWrites.push(
        this.store.saveTransitions([
          {
            eventType:
              stored.status === "persisted"
                ? "CONVICTION_TRADE_EXECUTED"
                : "CONVICTION_TRADE_SKIPPED",
            eventKey: `tier-status:${stored.id}:${stored.status}`,
            mint: stored.tokenMint,
            timestampMs,
            score: snapshot?.convictionScore,
            reasons: [
              stored.status === "persisted"
                ? "live conviction tier landed and its position was persisted"
                : stored.status === "failed_pre_submit"
                  ? `live conviction tier failed safely before submission${update.errorCode ? ` (${update.errorCode})` : ""}`
                  : "live conviction tier outcome is uncertain; retry is blocked",
            ],
            metadata: {
              tierId: stored.tierId,
              status: stored.status,
              tradingMode: stored.tradingMode,
            },
          },
        ]),
      );
    }
    // The tier row is the execution-safety authority. A secondary snapshot or
    // diagnostic write must not make a successfully persisted lifecycle step
    // appear to fail; both are reconstructible from durable events and tiers.
    await Promise.allSettled(secondaryWrites);
    return stored;
  }

  private cacheTier(tier: StoredConvictionTier): void {
    const index = this.durableTiers.findIndex((candidate) => candidate.id === tier.id);
    if (index >= 0) this.durableTiers[index] = tier;
    else this.durableTiers.push(tier);
  }

  private cacheEvent(event: ConvictionEvent): void {
    const index = this.durableEvents.findIndex((candidate) => candidate.eventId === event.eventId);
    if (index >= 0) this.durableEvents[index] = event;
    else this.durableEvents.push(event);
  }

  observe(
    event: ConvictionEvent,
    options: {
      globalEntriesEnabled: boolean;
      actionable?: boolean;
      /** Authoritative open-position cost exposure read immediately before observation. */
      currentPositionUsd?: number;
    },
  ): Promise<ConvictionRuntimeResult> {
    return this.runExclusive(() => this.observeUnlocked(event, options));
  }

  private async observeUnlocked(
    event: ConvictionEvent,
    options: {
      globalEntriesEnabled: boolean;
      actionable?: boolean;
      currentPositionUsd?: number;
    },
  ): Promise<ConvictionRuntimeResult> {
    await this.initializeUnlocked();
    const previous = this.engine.snapshot(event.tokenMint);
    const writeResult = await this.store.insertEvent(event);
    const pendingClaimRetry = this.pendingTierClaimEvents.has(event.eventId);
    if (writeResult !== "duplicate") this.cacheEvent(event);

    let update: ConvictionEngineUpdate;
    if (writeResult === "upgraded") {
      const exposures = new Map(
        this.engine
          .snapshots()
          .map((snapshot) => [snapshot.mint, snapshot.ourCurrentPositionUsd] as const),
      );
      const rankBaseline = new Map(this.lastRanks);
      this.rebuildEngine(exposures, rankBaseline);
      const rebuilt = this.engine.process(event);
      const upgradeTransitions: ConvictionTransition[] = [];
      const upgradeBreakouts: ConvictionBreakout[] = [];
      if (previous && previous.convictionState !== rebuilt.snapshot.convictionState) {
        upgradeTransitions.push({
          mint: event.tokenMint,
          timestampMs: event.timestampMs,
          previousState: previous.convictionState,
          newState: rebuilt.snapshot.convictionState,
          previousScore: previous.convictionScore,
          newScore: rebuilt.snapshot.convictionScore,
          reasons: [...rebuilt.snapshot.scoreReasons],
        });
        if (
          (previous.convictionState === "TESTING" || previous.convictionState === "WATCHING") &&
          ["ACCUMULATING", "BETTING", "HIGH_CONVICTION"].includes(
            rebuilt.snapshot.convictionState,
          ) &&
          rebuilt.snapshot.convictionScore >= this.engine.config.breakoutMinScore
        ) {
          const primaryWindowSeconds = this.engine.config.primaryLeaderboardWindowMinutes * 60;
          const primary = rebuilt.snapshot.rolling[String(primaryWindowSeconds)];
          upgradeBreakouts.push({
            kind: "CONVICTION_BREAKOUT",
            mint: event.tokenMint,
            timestampMs: event.timestampMs,
            previousScore: previous.convictionScore,
            newScore: rebuilt.snapshot.convictionScore,
            netClusterInvestmentUsd: rebuilt.snapshot.netClusterInvestmentUsd,
            capitalVelocityUsdPerMinute: primary?.capitalVelocityUsdPerMinute ?? 0,
            walletConvergence: rebuilt.snapshot.convergedWalletCount,
            marketCapUsd: rebuilt.snapshot.marketCapUsd,
            liquidityUsd: rebuilt.snapshot.liquidityUsd,
            reasons: [...rebuilt.snapshot.scoreReasons],
          });
        }
      }
      update = {
        ...rebuilt,
        duplicate: false,
        transitions: upgradeTransitions,
        breakouts: upgradeBreakouts,
        countedTowardCapital:
          (this.engine.config.clusterWallets.length === 0 ||
            this.engine.config.clusterWallets.includes(event.wallet)) &&
          (event.type === "DEX_BUY" || event.type === "DEX_SELL")
            ? event.classificationReliable === true
            : false,
      };
    } else {
      update = this.engine.process(event);
    }
    if (options.currentPositionUsd !== undefined) {
      this.engine.setPositionUsd(event.tokenMint, options.currentPositionUsd);
      const snapshot = this.engine.snapshot(event.tokenMint)!;
      const rank =
        snapshot.ranks[String(this.engine.config.primaryLeaderboardWindowMinutes)]?.currentRank;
      const nextTier = nextConvictionTier(snapshot, this.engine.config, {
        nowMs: event.timestampMs,
        rank,
        globalEntriesEnabled: options.globalEntriesEnabled,
      });
      update = {
        ...update,
        snapshot,
        nextTier,
        entry: evaluateConvictionEntry(snapshot, this.engine.config, {
          nowMs: event.timestampMs,
          rank,
          globalEntriesEnabled: options.globalEntriesEnabled,
          requestedBuyUsd: nextTier.amountUsd,
        }),
      };
    }
    if ((writeResult === "duplicate" || update.duplicate) && !pendingClaimRetry) {
      // The event may have been durably inserted immediately before an earlier
      // persistence interruption. Re-save the reconstructed snapshot without
      // counting or claiming the event again.
      await Promise.allSettled([this.store.saveState(update.snapshot)]);
      return { duplicate: true, update };
    }

    const rankingAtMs = update.timestampMs;
    const ranks = this.changedRanks(rankingAtMs, event.tokenMint);
    const transitions = this.runtimeTransitions(event, previous, update, ranks);
    // Avoid a write-amplifying full leaderboard rewrite for every target
    // event. Persist the event token plus tokens whose state or rank changed.
    const changedMints = new Set([
      event.tokenMint,
      ...update.transitions.map((transition) => transition.mint),
      ...ranks.map((rank) => rank.mint),
      ...this.droppedRankMints,
    ]);
    // Keep the dashboard's authoritative current Top 10 fresh without writing
    // every historical token on every event (at most 30 rows before overlap).
    for (const window of [5, 30, 60] as const) {
      for (const row of this.engine.leaderboard(window, rankingAtMs).slice(0, 10)) {
        changedMints.add(row.mint);
      }
    }
    const changedSnapshots = this.engine
      .snapshots()
      .filter((snapshot) => changedMints.has(snapshot.mint));
    await Promise.allSettled([
      ...changedSnapshots.map((snapshot) => this.store.saveState(snapshot)),
      ranks.length > 0 ? this.store.saveRanks(ranks, rankingAtMs) : Promise.resolve(),
      transitions.length > 0 ? this.store.saveTransitions(transitions) : Promise.resolve(),
    ]);

    // State, distribution, and rankings react to every classified event, but
    // a tier may only originate from a newly verified cluster DEX buy. A sell,
    // transfer, UNKNOWN observation, or unreliable attribution can never turn
    // a pre-existing score into an entry side effect.
    const eligibleEntryTrigger =
      options.actionable !== false &&
      (update.countedTowardCapital || pendingClaimRetry || writeResult === "upgraded") &&
      event.type === "DEX_BUY" &&
      event.classificationReliable === true;
    if (!eligibleEntryTrigger) {
      if (event.type === "DEX_BUY" || event.type === "UNKNOWN") {
        await Promise.allSettled([
          this.store.saveTransitions([
            {
              eventType: "CONVICTION_TRADE_SKIPPED",
              eventKey: `skip-trigger:${event.eventId}`,
              mint: event.tokenMint,
              timestampMs: event.timestampMs,
              score: update.snapshot.convictionScore,
              reasons: [
                options.actionable === false
                  ? "historical or catch-up event reconstructed state without entry action"
                  : "event is not a reliably classified cluster DEX buy",
              ],
              metadata: {
                classification: event.type,
                classificationReliable: event.classificationReliable === true,
              },
            },
          ]),
        ]);
      }
      return { duplicate: pendingClaimRetry, update };
    }

    if (
      this.engine.config.tradingMode === "live" &&
      this.unresolvedLiveMints.has(event.tokenMint)
    ) {
      await Promise.allSettled([
        this.store.saveTransitions([
          {
            eventType: "CONVICTION_TRADE_SKIPPED",
            eventKey: `skip-in-flight:${event.eventId}`,
            mint: event.tokenMint,
            timestampMs: event.timestampMs,
            score: update.snapshot.convictionScore,
            reasons: ["a prior live conviction tier is unresolved; scale-in is blocked"],
            metadata: { tradingMode: "live" },
          },
        ]),
      ]);
      return { duplicate: false, update };
    }

    const primaryRank =
      update.snapshot.ranks[String(this.engine.config.primaryLeaderboardWindowMinutes)]
        ?.currentRank;
    const tierDecision = nextConvictionTier(update.snapshot, this.engine.config, {
      nowMs: event.timestampMs,
      rank: primaryRank,
      globalEntriesEnabled: options.globalEntriesEnabled,
    });
    const entryDecision = evaluateConvictionEntry(update.snapshot, this.engine.config, {
      nowMs: event.timestampMs,
      rank: primaryRank,
      globalEntriesEnabled: options.globalEntriesEnabled,
      requestedBuyUsd: tierDecision.amountUsd,
    });
    const liveAuthorizationMissing =
      this.engine.config.tradingMode === "live" &&
      tierDecision.eligible &&
      entryDecision.eligible &&
      (!tierDecision.authorizedToSubmit || !entryDecision.authorizedToSubmit);
    if (
      !tierDecision.eligible ||
      !tierDecision.tier ||
      !entryDecision.eligible ||
      liveAuthorizationMissing
    ) {
      await Promise.allSettled([
        this.store.saveTransitions([
          {
            eventType: "CONVICTION_TRADE_SKIPPED",
            eventKey: `skip:${event.eventId}`,
            mint: event.tokenMint,
            timestampMs: event.timestampMs,
            score: update.snapshot.convictionScore,
            reasons: [
              tierDecision.reason,
              ...entryDecision.failedGates,
              ...(liveAuthorizationMissing && !options.globalEntriesEnabled
                ? ["global Entries switch is off"]
                : []),
            ].filter((reason, index, rows) => Boolean(reason) && rows.indexOf(reason) === index),
            metadata: { tradingMode: this.engine.config.tradingMode },
          },
        ]),
      ]);
      return { duplicate: false, update };
    }

    const tierNumber =
      this.engine.config.tiers.findIndex((tier) => tier.id === tierDecision.tier?.id) + 1;
    const status = this.engine.config.tradingMode === "shadow" ? "shadowed" : "claimed";
    const claimInput: ConvictionTierClaimInput = {
      tokenMint: event.tokenMint,
      tierId: tierDecision.tier.id,
      tierNumber,
      tradingMode: this.engine.config.tradingMode,
      status,
      amountUsd: tierDecision.amountUsd,
      commitmentUsd: update.snapshot.netClusterInvestmentUsd,
      score: update.snapshot.convictionScore,
      sourceEventKey: event.eventId,
      reason: tierDecision.reason,
    };
    let claim: ConvictionTierClaimResult;
    let claimAttemptHadTransientFailure = false;
    try {
      claim = await this.store.claimTier(claimInput);
    } catch {
      // The first response may have been lost after the unique row committed.
      // One immediate idempotent retry recovers that exact row without waiting
      // for a feed replay or counting the event twice.
      claimAttemptHadTransientFailure = true;
      try {
        claim = await this.store.claimTier(claimInput);
      } catch (error) {
        // Remember only this exact event in-process. A restart deliberately
        // waits for a new verified buy rather than retroactively actioning an
        // event that may originally have been observed while Entries was off.
        this.pendingTierClaimEvents.add(event.eventId);
        throw error;
      }
    }
    this.cacheTier(claim.row);
    const resumedOrphanClaim =
      (pendingClaimRetry || claimAttemptHadTransientFailure) &&
      !claim.claimed &&
      claim.row.status === "claimed" &&
      claim.row.tradingMode === "live" &&
      claim.row.sourceEventKey === event.eventId &&
      !this.unresolvedLiveMints.has(event.tokenMint);
    this.pendingTierClaimEvents.delete(event.eventId);
    if (!claim.claimed && !resumedOrphanClaim) {
      if (unresolvedLiveTier(claim.row)) {
        this.unresolvedLiveMints.add(claim.row.tokenMint);
      }
      if (
        claim.row.tradingMode === this.engine.config.tradingMode &&
        consumesTier(claim.row.status)
      ) {
        this.engine.recordTierExecution(event.tokenMint, claim.row.tierId, {
          amountUsd: claim.row.amountUsd,
          mode: claim.row.tradingMode,
          reference: claim.row.reference ?? claim.row.id,
        });
      }
      return { duplicate: false, update };
    }

    this.engine.recordTierExecution(event.tokenMint, claim.row.tierId, {
      amountUsd: claim.row.amountUsd,
      mode: claim.row.tradingMode,
      reference: claim.row.reference ?? claim.row.id,
    });
    if (unresolvedLiveTier(claim.row)) this.unresolvedLiveMints.add(claim.row.tokenMint);
    const claimedSnapshot = this.engine.snapshot(event.tokenMint)!;
    await Promise.allSettled([this.store.saveState(claimedSnapshot)]);
    const tierIndex = Math.max(0, tierNumber - 1);
    const shouldRecordClaimTransition =
      status === "shadowed" || this.engine.config.rapidFollowEnabled;
    if (shouldRecordClaimTransition) {
      await Promise.allSettled([
        this.store.saveTransitions([
          {
            eventType:
              status === "shadowed"
                ? tierIndex === 0
                  ? "CONVICTION_TRADE_EXECUTED"
                  : "RAPID_FOLLOW_SCALE_IN"
                : tierIndex === 0
                  ? "RAPID_FOLLOW_STARTED"
                  : "RAPID_FOLLOW_SCALE_IN",
            eventKey: `tier:${event.eventId}:${claim.row.tierId}:${status}`,
            mint: event.tokenMint,
            timestampMs: event.timestampMs,
            score: claimedSnapshot.convictionScore,
            reasons: [
              status === "shadowed"
                ? "hypothetical tier recorded; no transaction submitted"
                : "live tier durably claimed; final safety gates still required",
            ],
            metadata: {
              tierId: claim.row.tierId,
              amountUsd: claim.row.amountUsd,
              tradingMode: claim.row.tradingMode,
              hypothetical: status === "shadowed",
            },
          },
        ]),
      ]);
    }

    if (status === "shadowed") return { duplicate: false, update };
    if (!tierDecision.authorizedToSubmit || !entryDecision.authorizedToSubmit) {
      return { duplicate: false, update };
    }
    return {
      duplicate: false,
      update,
      action: { claim: claim.row, event, snapshot: claimedSnapshot },
    };
  }

  private captureRanks() {
    for (const window of [5, 30, 60] as const) {
      for (const row of this.engine.leaderboard(window)) {
        this.lastRanks.set(`${window}:${row.mint}`, row.rank);
      }
    }
  }

  private changedRanks(nowMs: number, observedMint: string): ConvictionLeaderboardRow[] {
    const changed: ConvictionLeaderboardRow[] = [];
    this.droppedRankMints.clear();
    for (const window of [5, 30, 60] as const) {
      const seen = new Set<string>();
      for (const row of this.engine.leaderboard(window, nowMs)) {
        const key = `${window}:${row.mint}`;
        const previousRank = this.lastRanks.get(key);
        const currentRelevant = row.rank <= 10;
        const previousRelevant = previousRank !== undefined && previousRank <= 10;
        if (
          (previousRank !== row.rank || row.mint === observedMint) &&
          (currentRelevant || previousRelevant || row.mint === observedMint)
        ) {
          changed.push({
            ...row,
            previousRank,
            rankDirection:
              previousRank === undefined
                ? "new"
                : row.rank < previousRank
                  ? "up"
                  : row.rank > previousRank
                    ? "down"
                    : "flat",
          });
        }
        this.lastRanks.set(key, row.rank);
        seen.add(key);
      }
      for (const key of this.lastRanks.keys()) {
        if (key.startsWith(`${window}:`) && !seen.has(key)) {
          const previousRank = this.lastRanks.get(key);
          this.lastRanks.delete(key);
          if (previousRank !== undefined && previousRank <= 10) {
            this.droppedRankMints.add(key.slice(key.indexOf(":") + 1));
          }
        }
      }
    }
    return changed;
  }

  private runtimeTransitions(
    event: ConvictionEvent,
    previous: ConvictionTokenSnapshot | undefined,
    update: ConvictionEngineUpdate,
    changedRanks: ConvictionLeaderboardRow[],
  ): ConvictionRuntimeTransition[] {
    const rows: ConvictionRuntimeTransition[] = [];
    for (const transition of update.transitions) {
      rows.push({
        eventType: "CONVICTION_STATE_CHANGE",
        eventKey: `state:${event.eventId}:${transition.mint}:${transition.newState}`,
        mint: transition.mint,
        timestampMs: transition.timestampMs,
        transition,
        score: transition.newScore,
        reasons: transition.reasons,
      });
    }
    for (const breakout of update.breakouts) {
      rows.push({
        eventType: "CONVICTION_BREAKOUT",
        eventKey: `breakout:${event.eventId}:${breakout.mint}`,
        mint: breakout.mint,
        timestampMs: breakout.timestampMs,
        breakout,
        score: breakout.newScore,
        reasons: breakout.reasons,
      });
    }
    const previousConvergence = previous?.convergedWalletCount ?? 0;
    if (update.snapshot.convergedWalletCount > previousConvergence) {
      rows.push({
        eventType: "WALLET_CONVERGENCE",
        eventKey: `convergence:${event.eventId}:${update.snapshot.convergedWalletCount}`,
        mint: event.tokenMint,
        timestampMs: event.timestampMs,
        score: update.snapshot.convictionScore,
        reasons: [
          `${update.snapshot.convergedWalletCount}/${this.engine.config.requiredClusterWalletCount} cluster wallets converged`,
        ],
      });
    }
    for (const rank of changedRanks) {
      const enteredTop10 =
        rank.rank <= 10 && (rank.previousRank === undefined || rank.previousRank > 10);
      const enteredTop3 =
        rank.rank <= 3 && (rank.previousRank === undefined || rank.previousRank > 3);
      for (const threshold of [enteredTop10 ? 10 : undefined, enteredTop3 ? 3 : undefined]) {
        if (!threshold) continue;
        rows.push({
          eventType: threshold === 3 ? "TOP_3_ENTRY" : "TOP_10_ENTRY",
          eventKey: `rank:${event.eventId}:${rank.windowMinutes}:${rank.mint}:top-${threshold}`,
          mint: rank.mint,
          timestampMs: event.timestampMs,
          score: rank.score,
          reasons: [`entered Top ${threshold} on the ${rank.windowMinutes}-minute leaderboard`],
        });
      }
    }
    if (!previous?.distributionDetected && update.snapshot.distributionDetected) {
      rows.push({
        eventType: "DISTRIBUTION_DETECTED",
        eventKey: `distribution:${event.eventId}:${event.tokenMint}`,
        mint: event.tokenMint,
        timestampMs: event.timestampMs,
        score: update.snapshot.convictionScore,
        reasons: update.snapshot.scoreReasons,
      });
    }
    if (
      previous?.rapidFollowStatus === "active" &&
      update.snapshot.rapidFollowStatus === "stopped"
    ) {
      rows.push({
        eventType: "RAPID_FOLLOW_STOPPED",
        eventKey: `rapid-stop:${event.eventId}:${event.tokenMint}`,
        mint: event.tokenMint,
        timestampMs: event.timestampMs,
        score: update.snapshot.convictionScore,
        reasons: update.snapshot.distributionDetected
          ? ["meaningful target-wallet distribution detected"]
          : ["one or more Rapid Follow continuation gates failed"],
      });
    }
    return rows;
  }

  /** Persist state changes caused by wall-clock decay even when no feed event arrives. */
  private clockTransitions(
    before: Map<string, ConvictionTokenSnapshot>,
    after: ConvictionTokenSnapshot[],
    nowMs: number,
  ): ConvictionRuntimeTransition[] {
    const rows: ConvictionRuntimeTransition[] = [];
    for (const snapshot of after) {
      const previous = before.get(snapshot.mint);
      if (!previous) continue;
      if (previous.convictionState !== snapshot.convictionState) {
        rows.push({
          eventType: "CONVICTION_STATE_CHANGE",
          eventKey: `clock:state:${snapshot.mint}:${previous.convictionState}:${snapshot.convictionState}:${snapshot.lastActivityAtMs}`,
          mint: snapshot.mint,
          timestampMs: nowMs,
          transition: {
            mint: snapshot.mint,
            timestampMs: nowMs,
            previousState: previous.convictionState,
            newState: snapshot.convictionState,
            previousScore: previous.convictionScore,
            newScore: snapshot.convictionScore,
            reasons: [...snapshot.scoreReasons],
          },
          score: snapshot.convictionScore,
          reasons: [...snapshot.scoreReasons],
          metadata: { cause: "clock-decay" },
        });
      }
      if (previous.rapidFollowStatus === "active" && snapshot.rapidFollowStatus === "stopped") {
        rows.push({
          eventType: "RAPID_FOLLOW_STOPPED",
          eventKey: `clock:rapid-stop:${snapshot.mint}:${snapshot.lastActivityAtMs}:${snapshot.lastClusterBuyAtMs ?? 0}`,
          mint: snapshot.mint,
          timestampMs: nowMs,
          score: snapshot.convictionScore,
          reasons: snapshot.distributionDetected
            ? ["meaningful target-wallet distribution detected"]
            : ["one or more Rapid Follow continuation gates expired during market silence"],
          metadata: { cause: "clock-decay" },
        });
      }
    }
    return rows;
  }
}
