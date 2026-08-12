import type { FeedEvent } from "./geyser.js";
import { transferEventForRecipient, transferRecipients } from "./transfer-batch.js";

export type StrategySource = "geyser" | "rpc" | "unknown";
export type StrategyRelationship = "target" | "follower" | "observed";
export type StrategyDecision =
  | "filtered"
  | "skipped"
  | "copy_submitted"
  | "copied"
  | "mirror_submitted"
  | "mirrored"
  | "tracked"
  | "failed";

export type StrategyObservation = {
  user_id: string;
  target_wallet: string;
  event_key: string;
  tx_sig: string;
  slot: number;
  source: StrategySource;
  event_at: string;
  detected_at: string;
  relationship: StrategyRelationship;
  event_kind: "swap" | "transfer";
  side?: "buy" | "sell";
  actor_wallet: string;
  from_wallet?: string;
  to_wallet?: string;
  token_mint: string;
  amount_tokens: number;
  decimals: number;
  sol_delta?: number;
  amount_usd?: number;
  is_pump_fun?: boolean;
  position_id?: string;
  market_cap_usd?: number;
  liquidity_usd?: number;
  has_socials?: boolean;
  bot_decision?: StrategyDecision;
  bot_reason?: string;
  bot_tx_sig?: string;
  reaction_ms?: number;
  execution_ms?: number;
  metadata: Record<string, unknown>;
};

export type StrategyObservationPatch = Partial<
  Pick<
    StrategyObservation,
    | "position_id"
    | "amount_usd"
    | "market_cap_usd"
    | "liquidity_usd"
    | "has_socials"
    | "bot_decision"
    | "bot_reason"
    | "bot_tx_sig"
    | "reaction_ms"
    | "execution_ms"
    | "metadata"
  >
>;

export type StrategyObservationContext = {
  userId: string;
  targetWallet: string;
  relationship: StrategyRelationship;
  positionId?: string;
};

/** Strategy Lab stores one row per destination, never an aggregate split row. */
export function strategyEventsFromFeedEvent(event: FeedEvent): FeedEvent[] {
  if (event.kind !== "transfer") return [event];
  return transferRecipients(event).map((recipient) => transferEventForRecipient(event, recipient));
}

/**
 * Feed source and wall-clock detection time are deliberately absent. The same
 * transaction delivered by Geyser and RPC must resolve to one database row.
 */
export function strategyEventKey(event: FeedEvent): string {
  const transactionIdentity =
    event.txSig ||
    (event.slot > 0 ? `slot-${event.slot}` : `observed-${Math.floor(event.timestampMs / 1000)}`);
  if (event.kind === "transfer") {
    return ["transfer", transactionIdentity, event.from, event.to, event.tokenMint].join(":");
  }
  return ["swap", transactionIdentity, event.wallet, event.side, event.tokenMint].join(":");
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function safeDate(value: number, fallback: number): string {
  return new Date(Number.isFinite(value) && value > 0 ? value : fallback).toISOString();
}

export function strategyReactionMs(
  event: FeedEvent,
  nowMs = Date.now(),
  minimumExecutionMs = 0,
): number {
  const execution = Number.isFinite(minimumExecutionMs) ? Math.max(0, minimumExecutionMs) : 0;
  const elapsed =
    Number.isFinite(nowMs) && Number.isFinite(event.timestampMs)
      ? Math.max(0, nowMs - event.timestampMs)
      : 0;
  return Math.min(2_147_483_647, Math.round(Math.max(execution, elapsed)));
}

export function observationFromEvent(
  event: FeedEvent,
  context: StrategyObservationContext,
  patch: StrategyObservationPatch = {},
  nowMs = Date.now(),
): StrategyObservation {
  const base: StrategyObservation = {
    user_id: context.userId,
    target_wallet: context.targetWallet,
    event_key: strategyEventKey(event),
    tx_sig: event.txSig,
    slot: event.slot,
    source: event.source ?? "unknown",
    event_at: safeDate(event.timestampMs, nowMs),
    detected_at: safeDate(nowMs, Date.now()),
    relationship: context.relationship,
    event_kind: event.kind,
    actor_wallet: event.kind === "swap" ? event.wallet : event.from,
    token_mint: event.tokenMint,
    amount_tokens: Number.isFinite(event.amountTokens) ? Math.max(0, event.amountTokens) : 0,
    decimals: Number.isFinite(event.decimals) ? Math.max(0, Math.trunc(event.decimals)) : 0,
    metadata: {},
    ...(context.positionId ? { position_id: context.positionId } : {}),
  };

  if (event.kind === "swap") {
    base.side = event.side;
    base.sol_delta = finite(event.solDelta);
    base.amount_usd = finite(event.amountUsd);
    base.is_pump_fun = event.isPumpFun;
  } else {
    base.from_wallet = event.from;
    base.to_wallet = event.to;
  }

  return {
    ...base,
    ...patch,
    metadata: { ...base.metadata, ...(patch.metadata ?? {}) },
  };
}

const relationshipRank: Record<StrategyRelationship, number> = {
  observed: 0,
  follower: 1,
  target: 2,
};

const sourceRank: Record<StrategySource, number> = {
  unknown: 0,
  rpc: 1,
  geyser: 2,
};

const decisionRank: Record<StrategyDecision, number> = {
  tracked: 1,
  skipped: 2,
  filtered: 2,
  copy_submitted: 3,
  mirror_submitted: 3,
  failed: 4,
  copied: 5,
  mirrored: 5,
};

/** Preserve the richest/most final version when duplicate feeds race. */
export function mergeStrategyObservations(
  existing: StrategyObservation,
  incoming: StrategyObservation,
): StrategyObservation {
  const keepExistingDecision =
    existing.bot_decision !== undefined &&
    (incoming.bot_decision === undefined ||
      decisionRank[existing.bot_decision] > decisionRank[incoming.bot_decision]);
  const relationship =
    relationshipRank[incoming.relationship] > relationshipRank[existing.relationship]
      ? incoming.relationship
      : existing.relationship;
  const source =
    sourceRank[incoming.source] > sourceRank[existing.source] ? incoming.source : existing.source;

  const merged: StrategyObservation = {
    ...existing,
    ...incoming,
    source,
    relationship,
    event_at:
      Date.parse(existing.event_at) <= Date.parse(incoming.event_at)
        ? existing.event_at
        : incoming.event_at,
    detected_at:
      Date.parse(existing.detected_at) <= Date.parse(incoming.detected_at)
        ? existing.detected_at
        : incoming.detected_at,
    amount_usd: incoming.amount_usd ?? existing.amount_usd,
    position_id: incoming.position_id ?? existing.position_id,
    market_cap_usd: incoming.market_cap_usd ?? existing.market_cap_usd,
    liquidity_usd: incoming.liquidity_usd ?? existing.liquidity_usd,
    has_socials: incoming.has_socials ?? existing.has_socials,
    metadata: { ...existing.metadata, ...incoming.metadata },
  };

  if (keepExistingDecision) {
    merged.bot_decision = existing.bot_decision;
    merged.bot_reason = existing.bot_reason;
    merged.bot_tx_sig = existing.bot_tx_sig;
    merged.reaction_ms = existing.reaction_ms;
    merged.execution_ms = existing.execution_ms;
  } else {
    merged.bot_decision = incoming.bot_decision ?? existing.bot_decision;
    merged.bot_reason = incoming.bot_reason ?? existing.bot_reason;
    merged.bot_tx_sig = incoming.bot_tx_sig ?? existing.bot_tx_sig;
    merged.reaction_ms = incoming.reaction_ms ?? existing.reaction_ms;
    merged.execution_ms = incoming.execution_ms ?? existing.execution_ms;
  }
  return merged;
}

type RecorderOptions = {
  maxPending?: number;
  maxRecent?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  onError?: (error: unknown) => void;
  onDrop?: (dropped: number) => void;
};

/**
 * Bounded write-behind buffer. record() performs no I/O, so Strategy Lab can
 * never add Supabase latency to Geyser decoding or trade execution.
 */
export class StrategyRecorder {
  private pending = new Map<string, StrategyObservation>();
  private recent = new Map<string, StrategyObservation>();
  private flushing = false;
  private timer?: NodeJS.Timeout;
  private dropped = 0;
  private written = 0;
  private readonly maxPending: number;
  private readonly maxRecent: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(
    private readonly writeBatch: (rows: StrategyObservation[]) => Promise<void>,
    private readonly options: RecorderOptions = {},
  ) {
    this.maxPending = Math.max(1, options.maxPending ?? 2_000);
    this.maxRecent = Math.max(this.maxPending, options.maxRecent ?? 5_000);
    this.batchSize = Math.max(1, options.batchSize ?? 100);
    this.flushIntervalMs = Math.max(10, options.flushIntervalMs ?? 1_000);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch((error) => this.options.onError?.(error));
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  record(row: StrategyObservation): "queued" | "merged" {
    const identity = `${row.user_id}:${row.event_key}`;
    const existing = this.pending.get(identity) ?? this.recent.get(identity);
    const merged = existing ? mergeStrategyObservations(existing, row) : row;

    if (!this.pending.has(identity) && this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest) this.pending.delete(oldest);
      this.dropped += 1;
      this.options.onDrop?.(this.dropped);
    }

    this.pending.set(identity, merged);
    this.recent.delete(identity);
    this.recent.set(identity, merged);
    while (this.recent.size > this.maxRecent) {
      const oldest = this.recent.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recent.delete(oldest);
    }
    return existing ? "merged" : "queued";
  }

  async flush() {
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;
    const batch = Array.from(this.pending.entries()).slice(0, this.batchSize);
    try {
      await this.writeBatch(batch.map(([, row]) => row));
      for (const [key, row] of batch) {
        if (this.pending.get(key) === row) this.pending.delete(key);
      }
      this.written += batch.length;
    } finally {
      this.flushing = false;
    }
  }

  health() {
    return {
      pending: this.pending.size,
      maxPending: this.maxPending,
      recent: this.recent.size,
      written: this.written,
      dropped: this.dropped,
      flushing: this.flushing,
    };
  }
}
