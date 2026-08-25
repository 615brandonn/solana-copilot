export type BackgroundScheduleResult = "scheduled" | "duplicate" | "full";

/**
 * A small process-local pressure valve for recoverable hot-feed work. Durable
 * RPC recovery remains authoritative when this queue is full.
 */
export class BoundedBackgroundQueue {
  private readonly pending: Array<{ key: string; task: () => Promise<void> }> = [];
  private readonly retainedKeys = new Set<string>();
  private active = 0;

  constructor(
    private readonly concurrency: number,
    private readonly maxQueued: number,
  ) {
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new Error("background queue concurrency must be positive");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("background queue capacity cannot be negative");
    }
  }

  schedule(key: string, task: () => Promise<void>): BackgroundScheduleResult {
    if (!key || this.retainedKeys.has(key)) return "duplicate";
    if (this.active >= this.concurrency && this.pending.length >= this.maxQueued) return "full";
    this.retainedKeys.add(key);
    if (this.active < this.concurrency) this.start({ key, task });
    else this.pending.push({ key, task });
    return "scheduled";
  }

  health(): { active: number; queued: number; retained: number } {
    return {
      active: this.active,
      queued: this.pending.length,
      retained: this.retainedKeys.size,
    };
  }

  private start(item: { key: string; task: () => Promise<void> }): void {
    this.active += 1;
    void Promise.resolve()
      .then(item.task)
      .catch(() => undefined)
      .finally(() => {
        this.active -= 1;
        this.retainedKeys.delete(item.key);
        const next = this.pending.shift();
        if (next) this.start(next);
      });
  }
}
