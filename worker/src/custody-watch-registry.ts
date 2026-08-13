import pino from "pino";
import { env } from "./env.js";
import type { RpcBackfillPoller } from "./poller.js";
import type { ActiveCustodyWatch, CustodyRecordResult } from "./custody-types.js";

const log = pino({ level: env.LOG_LEVEL });

/**
 * Reference-counted subscription ownership for the observation-only worker.
 * A target role and any number of journey roles may share one low-level watch.
 */
export class CustodyWatchRegistry {
  private ownersByWallet = new Map<string, Set<string>>();
  private targetWallets = new Set<string>();

  constructor(private poller: RpcBackfillPoller) {}

  watchedWalletCount(): number {
    return this.ownersByWallet.size;
  }

  isWatched(wallet: string): boolean {
    return this.ownersByWallet.has(wallet);
  }

  async setTargets(wallets: Iterable<string>): Promise<void> {
    const next = new Set(Array.from(wallets).filter(Boolean));
    for (const wallet of next) {
      if (!this.targetWallets.has(wallet)) await this.retain(wallet, `target:${wallet}`);
    }
    for (const wallet of this.targetWallets) {
      if (!next.has(wallet)) await this.release(wallet, `target:${wallet}`);
    }
    this.targetWallets = next;
  }

  async restore(rows: ActiveCustodyWatch[]): Promise<void> {
    for (const row of rows) {
      await this.retain(row.wallet, `journey:${row.journeyId}`, row.anchorSlot);
    }
  }

  async reconcileJourneyWatches(rows: ActiveCustodyWatch[]): Promise<void> {
    const desiredByOwner = new Map<string, Set<string>>();
    for (const row of rows) {
      const owner = `journey:${row.journeyId}`;
      const wallets = desiredByOwner.get(owner) ?? new Set<string>();
      wallets.add(row.wallet);
      desiredByOwner.set(owner, wallets);
      await this.retain(row.wallet, owner, row.anchorSlot);
    }
    const releases: Array<Promise<void>> = [];
    for (const [wallet, owners] of this.ownersByWallet) {
      for (const owner of owners) {
        if (!owner.startsWith("journey:")) continue;
        if (desiredByOwner.get(owner)?.has(wallet)) continue;
        releases.push(this.release(wallet, owner));
      }
    }
    await Promise.all(releases);
  }

  async clear(): Promise<void> {
    const releases: Array<Promise<void>> = [];
    for (const [wallet, owners] of this.ownersByWallet) {
      for (const owner of owners) releases.push(this.release(wallet, owner));
    }
    await Promise.all(releases);
    this.targetWallets.clear();
  }

  async apply(result: CustodyRecordResult, anchorSlot?: number): Promise<void> {
    if (!result.journeyId) return;
    const owner = `journey:${result.journeyId}`;
    for (const wallet of result.watchedWallets) await this.retain(wallet, owner, anchorSlot);
    for (const wallet of result.releasedWallets) await this.release(wallet, owner);
  }

  private async retain(wallet: string, owner: string, anchorSlot?: number): Promise<void> {
    const owners = this.ownersByWallet.get(wallet) ?? new Set<string>();
    const first = owners.size === 0;
    owners.add(owner);
    this.ownersByWallet.set(wallet, owners);
    this.poller.watch(wallet, { anchorSlot });
    if (first) log.debug({ wallet }, "custody confirmed-RPC watch retained");
  }

  private async release(wallet: string, owner: string): Promise<void> {
    const owners = this.ownersByWallet.get(wallet);
    if (!owners) return;
    owners.delete(owner);
    if (owners.size > 0) return;
    this.ownersByWallet.delete(wallet);
    this.poller.unwatch(wallet);
    log.debug({ wallet }, "custody confirmed-RPC watch released");
  }
}
