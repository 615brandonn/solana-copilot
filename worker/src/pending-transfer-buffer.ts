import type { TransferEvent } from "./geyser.js";

export type PendingTransferBufferOptions = {
  ttlMs?: number;
  maxEntries?: number;
  maxEntriesPerMint?: number;
};

type BufferedTransfer = {
  event: TransferEvent;
  observedAtMs: number;
};

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_ENTRIES_PER_MINT = 500;

/**
 * Temporarily retains transfers that can arrive before a copied position has
 * landed. Entries are process-local by design; persistence and feed recovery
 * belong to the caller.
 */
export class PendingTransferBuffer {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerMint: number;
  private readonly entries = new Map<string, BufferedTransfer>();
  private readonly entriesByMint = new Map<string, Map<string, BufferedTransfer>>();

  constructor(options: PendingTransferBufferOptions = {}) {
    this.ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
    this.maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
    this.maxEntriesPerMint = positiveInteger(
      options.maxEntriesPerMint ?? DEFAULT_MAX_ENTRIES_PER_MINT,
      "maxEntriesPerMint",
    );
  }

  get size(): number {
    return this.entries.size;
  }

  sizeForMint(tokenMint: string): number {
    return this.entriesByMint.get(tokenMint)?.size ?? 0;
  }

  /** Returns false when an equivalent transfer is already buffered. */
  add(event: TransferEvent, nowMs = Date.now()): boolean {
    this.pruneExpired(nowMs);

    const key = transferKey(event);
    if (this.entries.has(key)) return false;

    const buffered = { event, observedAtMs: nowMs };
    let mintEntries = this.entriesByMint.get(event.tokenMint);
    if (!mintEntries) {
      mintEntries = new Map<string, BufferedTransfer>();
      this.entriesByMint.set(event.tokenMint, mintEntries);
    }
    mintEntries.set(key, buffered);
    this.entries.set(key, buffered);

    while (mintEntries.size > this.maxEntriesPerMint) {
      const oldestKey = mintEntries.keys().next().value;
      if (oldestKey === undefined) break;
      this.remove(oldestKey);
    }
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.remove(oldestKey);
    }
    return true;
  }

  /**
   * Consumes pending transfers for a landed buy. When both sides have a usable
   * slot, pre-entry transfers are rejected. A missing slot falls back to the
   * normal TTL check performed before the mint is drained.
   */
  drainForLandedBuy(tokenMint: string, entrySlot?: number, nowMs = Date.now()): TransferEvent[] {
    this.pruneExpired(nowMs);
    const mintEntries = this.entriesByMint.get(tokenMint);
    if (!mintEntries) return [];

    const drained: TransferEvent[] = [];
    for (const [key, buffered] of mintEntries) {
      this.entries.delete(key);
      if (hasPositiveSlot(entrySlot) && hasPositiveSlot(buffered.event.slot)) {
        if (buffered.event.slot < entrySlot) continue;
      }
      drained.push(buffered.event);
    }
    this.entriesByMint.delete(tokenMint);
    return drained;
  }

  pruneExpired(nowMs = Date.now()): number {
    let removed = 0;
    for (const [key, buffered] of this.entries) {
      if (nowMs - buffered.observedAtMs <= this.ttlMs) continue;
      this.remove(key);
      removed += 1;
    }
    return removed;
  }

  private remove(key: string): void {
    const buffered = this.entries.get(key);
    if (!buffered) return;

    this.entries.delete(key);
    const mintEntries = this.entriesByMint.get(buffered.event.tokenMint);
    mintEntries?.delete(key);
    if (mintEntries?.size === 0) this.entriesByMint.delete(buffered.event.tokenMint);
  }
}

function transferKey(event: TransferEvent): string {
  // A conserving split is one atomic sender/mint batch. Recipient addresses
  // are deliberately absent so Geyser/RPC delivery of the same batch dedupes.
  return JSON.stringify([event.txSig, event.from, event.tokenMint]);
}

function hasPositiveSlot(slot: number | undefined): slot is number {
  return Number.isFinite(slot) && (slot ?? 0) > 0;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}
