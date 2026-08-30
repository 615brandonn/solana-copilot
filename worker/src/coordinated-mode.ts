import type { BotConfigRow } from "./db.js";
import type { TokenMeta } from "./filters.js";

export type TargetBuyObservation = {
  wallet: string;
  tokenMint: string;
  amountUsd: number | undefined;
  firstBuy: boolean;
  timestampMs: number;
  txSig: string;
  slot: number;
  decimals: number;
};

export type CoordinationDecision =
  | { ready: false; reason: string; qualifyingWallets: number; retryAtMs?: number }
  | {
      ready: true;
      observations: TargetBuyObservation[];
      qualifyingWallets: number;
      /** Opaque, instance-local token that must be settled exactly once. */
      reservationId: string;
      /** Absolute fail-closed deadline; validate again immediately before submission. */
      expiresAtMs: number;
    };

export type CoordinationDeferral = {
  /** First time at which retry() may return this reserved cluster again. */
  retryAtMs: number;
  /** Hard deadline after which the pinned cluster is discarded. */
  expiresAtMs: number;
};

type PendingCoordination = {
  id: string;
  tokenMint: string;
  fingerprint: string;
  observations: TargetBuyObservation[];
  qualifyingWallets: number;
  configFingerprint: string;
  targetScopeFingerprint: string;
  state: "reserved" | "deferred";
  leaseExpiresAtMs: number;
  tombstoneExpiresAtMs: number;
  retryAtMs?: number;
  expiresAtMs?: number;
};

type SeenObservation = { timestampMs: number; tokenMint: string };
type TriggerTombstone = { fingerprint: string; expiresAtMs: number };

export type CoordinatedBuyTrackerOptions = {
  /** Fail-closed lease for callers that forget to settle a reservation. */
  reservationLeaseMs?: number;
  maxSeenTransactions?: number;
  maxTrackedMints?: number;
  maxTriggerTombstones?: number;
  maxPendingReservations?: number;
};

const DEFAULT_RESERVATION_LEASE_MS = 60_000;
const DEFAULT_MAX_SEEN_TRANSACTIONS = 20_000;
const DEFAULT_MAX_TRACKED_MINTS = 5_000;
const DEFAULT_MAX_TRIGGER_TOMBSTONES = 10_000;
const DEFAULT_MAX_PENDING_RESERVATIONS = 1_000;

function eventKey(observation: TargetBuyObservation) {
  return `${observation.wallet}:${observation.tokenMint}:${observation.txSig || observation.slot}`;
}

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function coordinationConfigFingerprint(cfg: BotConfigRow) {
  return JSON.stringify([
    Number(cfg.coordinated_window_seconds),
    Number(cfg.coordinated_target_wallet_count),
    Number(cfg.coordinated_target_buy_min_usd),
    Number(cfg.coordinated_target_buy_max_usd),
    cfg.coordinated_first_buy_only === true,
    Number(cfg.coordinated_mc_min_usd),
    Number(cfg.coordinated_mc_max_usd),
    Number(cfg.coordinated_coin_age_min_minutes),
    Number(cfg.coordinated_coin_age_max_minutes),
    cfg.coordinated_once_per_token === true,
    Number(cfg.coordinated_fixed_buy_usd),
    Number(cfg.coordinated_three_wallet_buy_usd),
  ]);
}

function observationQualifies(cfg: BotConfigRow, observation: TargetBuyObservation) {
  return (
    observation.amountUsd !== undefined &&
    observation.amountUsd >= Number(cfg.coordinated_target_buy_min_usd) &&
    observation.amountUsd <= Number(cfg.coordinated_target_buy_max_usd) &&
    (!cfg.coordinated_first_buy_only || observation.firstBuy)
  );
}

export class CoordinatedBuyTracker {
  private byMint = new Map<string, Map<string, TargetBuyObservation>>();
  private seen = new Map<string, SeenObservation>();
  private lastTriggerFingerprint = new Map<string, TriggerTombstone>();
  private pendingByMint = new Map<string, PendingCoordination>();
  private pendingById = new Map<string, PendingCoordination>();
  private nextReservationId = 1;
  private readonly reservationLeaseMs: number;
  private readonly maxSeenTransactions: number;
  private readonly maxTrackedMints: number;
  private readonly maxTriggerTombstones: number;
  private readonly maxPendingReservations: number;

  constructor(options: CoordinatedBuyTrackerOptions = {}) {
    this.reservationLeaseMs = positiveInteger(
      options.reservationLeaseMs,
      DEFAULT_RESERVATION_LEASE_MS,
    );
    this.maxSeenTransactions = positiveInteger(
      options.maxSeenTransactions,
      DEFAULT_MAX_SEEN_TRANSACTIONS,
    );
    this.maxTrackedMints = positiveInteger(options.maxTrackedMints, DEFAULT_MAX_TRACKED_MINTS);
    this.maxTriggerTombstones = positiveInteger(
      options.maxTriggerTombstones,
      DEFAULT_MAX_TRIGGER_TOMBSTONES,
    );
    this.maxPendingReservations = positiveInteger(
      options.maxPendingReservations,
      DEFAULT_MAX_PENDING_RESERVATIONS,
    );
  }

  record(
    cfg: BotConfigRow,
    observation: TargetBuyObservation,
    targetScopeFingerprint = "",
  ): CoordinationDecision {
    const nowMs = observation.timestampMs;
    const windowMs = Math.max(1, Number(cfg.coordinated_window_seconds)) * 1000;
    this.prune(nowMs, windowMs);

    const key = eventKey(observation);
    if (this.seen.has(key)) {
      return {
        ready: false,
        reason: "duplicate target transaction",
        qualifyingWallets: this.byMint.get(observation.tokenMint)?.size ?? 0,
      };
    }
    this.seen.set(key, { timestampMs: nowMs, tokenMint: observation.tokenMint });
    this.trimOldest(this.seen, this.maxSeenTransactions);

    if (observation.amountUsd === undefined) {
      return { ready: false, reason: "target buy size unavailable", qualifyingWallets: 0 };
    }
    if (
      observation.amountUsd < Number(cfg.coordinated_target_buy_min_usd) ||
      observation.amountUsd > Number(cfg.coordinated_target_buy_max_usd)
    ) {
      return {
        ready: false,
        reason: "target buy outside coordinated USD range",
        qualifyingWallets: 0,
      };
    }
    if (cfg.coordinated_first_buy_only && !observation.firstBuy) {
      return { ready: false, reason: "not target wallet's first buy", qualifyingWallets: 0 };
    }

    const observations = this.byMint.get(observation.tokenMint) ?? new Map();
    observations.set(observation.wallet, observation);
    this.byMint.set(observation.tokenMint, observations);
    this.trimTrackedMints();

    return this.reserve(cfg, observation.tokenMint, nowMs, targetScopeFingerprint);
  }

  /**
   * Re-checks an already recorded mint and atomically reserves its eligible
   * cluster. This is also the retry entry point for a deferred cluster.
   *
   * Reservations are deliberately instance-local. A durable database entry
   * claim remains the cross-process/restart idempotency boundary.
   */
  retry(
    cfg: BotConfigRow,
    tokenMint: string,
    nowMs = Date.now(),
    targetScopeFingerprint = "",
  ): CoordinationDecision {
    const windowMs = Math.max(1, Number(cfg.coordinated_window_seconds)) * 1000;
    this.prune(nowMs, windowMs);
    return this.reserve(cfg, tokenMint, nowMs, targetScopeFingerprint);
  }

  /**
   * Consumes the exact cluster immediately before handing it to a generic
   * money-moving path whose null/throw result may be ambiguous. The database
   * entry claim remains the cross-process idempotency boundary.
   */
  commit(reservationId: string, nowMs = Date.now()): boolean {
    if (!this.isReservationActive(reservationId, nowMs)) return false;
    const pending = this.pendingById.get(reservationId);
    if (!pending) return false;

    this.removePending(pending);
    this.rememberFingerprint(pending);
    return true;
  }

  /**
   * Releases a reservation without consuming its fingerprint. If its source
   * observations are still in the rolling window, retry() can reserve it
   * immediately. A stale reservation ID can never release a replacement.
   */
  release(reservationId: string): boolean {
    const pending = this.pendingById.get(reservationId);
    if (!pending || this.pendingByMint.get(pending.tokenMint)?.id !== reservationId) return false;

    this.removePending(pending);
    return true;
  }

  /**
   * Pins a qualified snapshot while transient metadata is unavailable or a
   * token is younger than the configured minimum. The snapshot survives the
   * original coordination window, but only until the caller-supplied deadline.
   */
  defer(reservationId: string, deferral: CoordinationDeferral, nowMs = Date.now()): boolean {
    if (!this.isReservationActive(reservationId, nowMs)) return false;
    const pending = this.pendingById.get(reservationId);
    if (
      !pending ||
      pending.state !== "reserved" ||
      this.pendingByMint.get(pending.tokenMint)?.id !== reservationId ||
      !Number.isFinite(deferral.retryAtMs) ||
      !Number.isFinite(deferral.expiresAtMs) ||
      deferral.retryAtMs < pending.observations[0]!.timestampMs ||
      deferral.expiresAtMs <= deferral.retryAtMs
    ) {
      return false;
    }

    pending.state = "deferred";
    pending.retryAtMs = deferral.retryAtMs;
    pending.expiresAtMs = deferral.expiresAtMs;
    pending.tombstoneExpiresAtMs = Math.max(
      pending.tombstoneExpiresAtMs,
      deferral.expiresAtMs + 60_000,
    );
    return true;
  }

  /**
   * Validates the instance-local reservation immediately before a durable
   * claim or transaction submission. Expired reservations are tombstoned.
   */
  isReservationActive(reservationId: string, nowMs = Date.now()): boolean {
    const pending = this.pendingById.get(reservationId);
    if (
      !pending ||
      pending.state !== "reserved" ||
      this.pendingByMint.get(pending.tokenMint)?.id !== reservationId
    ) {
      return false;
    }
    const deadline = Math.min(
      pending.leaseExpiresAtMs,
      pending.expiresAtMs ?? Number.POSITIVE_INFINITY,
    );
    if (nowMs >= deadline) {
      this.rememberFingerprint(pending);
      this.removePending(pending);
      return false;
    }
    return true;
  }

  /**
   * Permanently cancels the current pending fingerprint and clears all source
   * observations for a mint. Call this on a target sell or mint-local abort.
   */
  cancelMint(tokenMint: string): boolean {
    let changed = false;
    const pending = this.pendingByMint.get(tokenMint);
    if (pending) {
      this.rememberFingerprint(pending);
      this.removePending(pending);
      changed = true;
    }
    if (this.byMint.delete(tokenMint)) changed = true;
    for (const [key, observation] of this.seen) {
      if (observation.tokenMint === tokenMint) this.seen.delete(key);
    }
    return changed;
  }

  /** Alias that makes the target-sell integration intent explicit. */
  onTargetSell(tokenMint: string): boolean {
    return this.cancelMint(tokenMint);
  }

  /**
   * Cancels all in-flight signals before a coordinated config or target-set
   * replacement. Existing trigger tombstones remain intact.
   */
  cancelAll(): number {
    const pending = Array.from(this.pendingByMint.values());
    for (const reservation of pending) this.rememberFingerprint(reservation);
    this.pendingByMint.clear();
    this.pendingById.clear();
    this.byMint.clear();
    this.seen.clear();
    return pending.length;
  }

  /** Full in-memory reset; reservation IDs stay monotonic so stale IDs stay stale. */
  reset(): void {
    this.pendingByMint.clear();
    this.pendingById.clear();
    this.byMint.clear();
    this.seen.clear();
    this.lastTriggerFingerprint.clear();
  }

  private reserve(
    cfg: BotConfigRow,
    tokenMint: string,
    nowMs: number,
    targetScopeFingerprint: string,
  ): CoordinationDecision {
    const existing = this.pendingByMint.get(tokenMint);
    if (existing) {
      if (
        existing.configFingerprint !== coordinationConfigFingerprint(cfg) ||
        existing.targetScopeFingerprint !== targetScopeFingerprint ||
        existing.observations.some((observation) => !observationQualifies(cfg, observation)) ||
        existing.observations.length <
          Math.max(2, Math.floor(Number(cfg.coordinated_target_wallet_count)))
      ) {
        this.rememberFingerprint(existing);
        this.removePending(existing);
        this.byMint.delete(tokenMint);
        return {
          ready: false,
          reason: "coordinated cluster invalidated by configuration or target change",
          qualifyingWallets: 0,
        };
      }
      if (existing.state === "reserved") {
        return {
          ready: false,
          reason: "coordinated cluster reservation in progress",
          qualifyingWallets: existing.qualifyingWallets,
        };
      }

      if (nowMs < (existing.retryAtMs ?? Number.POSITIVE_INFINITY)) {
        return {
          ready: false,
          reason: "coordinated cluster deferred",
          qualifyingWallets: existing.qualifyingWallets,
          retryAtMs: existing.retryAtMs,
        };
      }

      existing.state = "reserved";
      existing.leaseExpiresAtMs = Math.min(
        nowMs + this.reservationLeaseMs,
        existing.expiresAtMs ?? Number.POSITIVE_INFINITY,
      );
      existing.retryAtMs = undefined;
      return this.readyDecision(existing);
    }

    const observations = this.byMint.get(tokenMint);
    const windowMs = Math.max(1, Number(cfg.coordinated_window_seconds)) * 1000;
    const matched = Array.from(observations?.values() ?? [])
      .filter((candidate) => nowMs - candidate.timestampMs <= windowMs)
      .sort((a, b) => a.timestampMs - b.timestampMs);
    const required = Math.max(2, Math.floor(Number(cfg.coordinated_target_wallet_count)));
    if (matched.length < required) {
      return {
        ready: false,
        reason: `waiting for ${required - matched.length} more target wallet(s)`,
        qualifyingWallets: matched.length,
      };
    }

    const selected = matched.slice(-required);
    const fingerprint = selected
      .map((candidate) => eventKey(candidate))
      .sort()
      .join("|");
    if (this.lastTriggerFingerprint.get(tokenMint)?.fingerprint === fingerprint) {
      return {
        ready: false,
        reason: "coordinated cluster already triggered",
        qualifyingWallets: matched.length,
      };
    }
    if (this.pendingByMint.size >= this.maxPendingReservations) {
      return {
        ready: false,
        reason: "coordinated reservation capacity reached",
        qualifyingWallets: matched.length,
      };
    }
    const tombstoneExpiresAtMs =
      Math.max(...selected.map((candidate) => candidate.timestampMs)) +
      Math.max(windowMs * 2, 60_000);
    const pending: PendingCoordination = {
      id: `coordination-${this.nextReservationId++}`,
      tokenMint,
      fingerprint,
      observations: selected,
      qualifyingWallets: matched.length,
      configFingerprint: coordinationConfigFingerprint(cfg),
      targetScopeFingerprint,
      state: "reserved",
      leaseExpiresAtMs: nowMs + this.reservationLeaseMs,
      tombstoneExpiresAtMs,
    };
    this.pendingByMint.set(tokenMint, pending);
    this.pendingById.set(pending.id, pending);
    return this.readyDecision(pending);
  }

  private readyDecision(pending: PendingCoordination): CoordinationDecision {
    return {
      ready: true,
      observations: pending.observations,
      qualifyingWallets: pending.qualifyingWallets,
      reservationId: pending.id,
      expiresAtMs: Math.min(
        pending.leaseExpiresAtMs,
        pending.expiresAtMs ?? Number.POSITIVE_INFINITY,
      ),
    };
  }

  private removePending(pending: PendingCoordination) {
    if (this.pendingByMint.get(pending.tokenMint)?.id === pending.id) {
      this.pendingByMint.delete(pending.tokenMint);
    }
    this.pendingById.delete(pending.id);
  }

  private rememberFingerprint(pending: PendingCoordination) {
    this.lastTriggerFingerprint.delete(pending.tokenMint);
    this.lastTriggerFingerprint.set(pending.tokenMint, {
      fingerprint: pending.fingerprint,
      expiresAtMs: pending.tombstoneExpiresAtMs,
    });
    this.trimOldest(this.lastTriggerFingerprint, this.maxTriggerTombstones);
  }

  private trimOldest<K, V>(map: Map<K, V>, maximum: number) {
    while (map.size > maximum) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
    }
  }

  private trimTrackedMints() {
    while (this.byMint.size > this.maxTrackedMints) {
      const oldest = this.byMint.keys().next();
      if (oldest.done) return;
      this.byMint.delete(oldest.value);
    }
  }

  private prune(nowMs: number, windowMs: number) {
    for (const [key, observation] of this.seen) {
      if (nowMs - observation.timestampMs > Math.max(windowMs * 2, 60_000)) {
        this.seen.delete(key);
      }
    }
    for (const [mint, observations] of this.byMint) {
      for (const [wallet, observation] of observations) {
        if (nowMs - observation.timestampMs > windowMs) observations.delete(wallet);
      }
      if (observations.size === 0) this.byMint.delete(mint);
    }
    for (const pending of this.pendingByMint.values()) {
      if (
        (pending.state === "deferred" &&
          pending.expiresAtMs !== undefined &&
          nowMs >= pending.expiresAtMs) ||
        (pending.state === "reserved" && nowMs >= pending.leaseExpiresAtMs)
      ) {
        // Expiry is fail-closed: it cannot turn stale observations back into a
        // fresh authorization merely because the caller failed to settle.
        this.rememberFingerprint(pending);
        this.removePending(pending);
      }
    }
    for (const [mint, tombstone] of this.lastTriggerFingerprint) {
      if (nowMs >= tombstone.expiresAtMs && !this.pendingByMint.has(mint)) {
        this.lastTriggerFingerprint.delete(mint);
      }
    }
  }
}

export type CoordinatedEntryDecision =
  | { pass: true; ageMinutes: number; ageSource: NonNullable<TokenMeta["tokenAgeSource"]> }
  | {
      pass: false;
      reason: string;
      code:
        | "market_cap_unavailable"
        | "market_cap_out_of_range"
        | "coin_age_unavailable"
        | "coin_age_invalid"
        | "coin_too_young"
        | "coin_too_old"
        | "already_traded";
      ageMinutes?: number;
      retryAfterMs?: number;
    };

export function checkCoordinatedEntry(
  cfg: BotConfigRow,
  meta: TokenMeta,
  alreadyTraded: boolean,
  nowMs = Date.now(),
): CoordinatedEntryDecision {
  if (meta.marketCapUsd === undefined)
    return { pass: false, reason: "market cap unavailable", code: "market_cap_unavailable" };
  if (
    meta.marketCapUsd < Number(cfg.coordinated_mc_min_usd) ||
    meta.marketCapUsd > Number(cfg.coordinated_mc_max_usd)
  ) {
    return {
      pass: false,
      reason: "coordinated market cap out of range",
      code: "market_cap_out_of_range",
    };
  }
  const pumpAge = meta.isPumpFun;
  const createdAtMs = pumpAge ? meta.tokenCreatedAtMs : meta.pairCreatedAtMs;
  const evaluatedAtMs = pumpAge ? meta.tokenAgeEvaluatedAtMs : nowMs;
  const ageSource = pumpAge ? meta.tokenAgeSource : "dexscreener_pair";
  if (
    createdAtMs === undefined ||
    evaluatedAtMs === undefined ||
    ageSource === undefined ||
    (pumpAge && ageSource !== "pump_finalized_create")
  ) {
    return { pass: false, reason: "coin age unavailable", code: "coin_age_unavailable" };
  }
  if (
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs <= 0 ||
    !Number.isSafeInteger(evaluatedAtMs) ||
    evaluatedAtMs <= 0 ||
    evaluatedAtMs < createdAtMs
  ) {
    return {
      pass: false,
      reason: "coin age evidence is invalid or from the future",
      code: "coin_age_invalid",
    };
  }
  const ageMinutes = (evaluatedAtMs - createdAtMs) / 60_000;
  const minimumAge = Number(cfg.coordinated_coin_age_min_minutes);
  const maximumAge = Number(cfg.coordinated_coin_age_max_minutes);
  if (ageMinutes < minimumAge) {
    return {
      pass: false,
      reason: `coin age ${ageMinutes.toFixed(1)}m is below ${cfg.coordinated_coin_age_min_minutes}m`,
      code: "coin_too_young",
      ageMinutes,
      retryAfterMs: Math.ceil((minimumAge - ageMinutes) * 60_000),
    };
  }
  if (ageMinutes > maximumAge) {
    return {
      pass: false,
      reason: `coin age ${ageMinutes.toFixed(1)}m exceeds ${cfg.coordinated_coin_age_max_minutes}m`,
      code: "coin_too_old",
      ageMinutes,
    };
  }
  if (cfg.coordinated_once_per_token && alreadyTraded) {
    return { pass: false, reason: "already copied this coin", code: "already_traded" };
  }
  return { pass: true, ageMinutes, ageSource };
}

export function inactivityDeadlineMs(lastTargetBuyAt: string | number | Date, hours: number) {
  const timestamp = new Date(lastTargetBuyAt).getTime();
  if (!Number.isFinite(timestamp)) return undefined;
  return timestamp + Math.max(0, Number(hours)) * 60 * 60_000;
}

export function shouldTriggerDistinctSellerExit(
  distinctSellerCount: number,
  requiredSellerCount: number,
  alreadyTriggered: boolean,
) {
  if (alreadyTriggered) return false;
  return (
    Math.max(0, Math.floor(distinctSellerCount)) >= Math.max(1, Math.floor(requiredSellerCount))
  );
}
