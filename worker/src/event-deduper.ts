export class RecentEventDeduper {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly maxEntries = 20_000,
  ) {}

  claim(key: string, nowMs = Date.now()): boolean {
    const prior = this.seen.get(key);
    if (prior !== undefined && nowMs - prior <= this.ttlMs) return false;
    this.seen.set(key, nowMs);
    this.prune(nowMs);
    return true;
  }

  release(key: string): void {
    this.seen.delete(key);
  }

  private prune(nowMs: number) {
    if (this.seen.size <= this.maxEntries) return;
    for (const [key, timestampMs] of this.seen) {
      if (nowMs - timestampMs > this.ttlMs) this.seen.delete(key);
    }
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

type AsyncResultEntry<T> = {
  createdAt: number;
  result: Promise<T>;
};

/**
 * Shares one idempotent observation write across Geyser/RPC copies while
 * preserving its result (for example, whether this was the target's first
 * observed buy). Failed writes are removed so a richer feed copy can retry.
 */
export class RecentAsyncResultCache<T> {
  private readonly entries = new Map<string, AsyncResultEntry<T>>();

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly maxEntries = 20_000,
  ) {}

  getOrCreate(key: string, factory: () => Promise<T>, nowMs = Date.now()): Promise<T> {
    const prior = this.entries.get(key);
    if (prior && nowMs - prior.createdAt <= this.ttlMs) return prior.result;

    const result = Promise.resolve()
      .then(factory)
      .catch((error) => {
        if (this.entries.get(key)?.result === result) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, { createdAt: nowMs, result });
    this.prune(nowMs);
    return result;
  }

  private prune(nowMs: number) {
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.createdAt > this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Serializes work for the same key while allowing different keys to proceed.
 * Distinct target buys are queued rather than dropped while an earlier event
 * for the same mint is still being checked.
 */
export class KeyedExecutionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(
      () => current,
      () => current,
    );
    this.tails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
