import pino from "pino";
import { PublicKey, type Connection } from "@solana/web3.js";
import { env } from "./env.js";
import { classifyCustodyWallet } from "./custody-classifier.js";
import type { FeedEvent, SwapEvent, TransferEvent, TransferRecipient } from "./geyser.js";
import type { UnresolvedOutflowEvent } from "./poller.js";
import { safeDiagnostic } from "./diagnostics.js";
import type {
  ActiveCustodyWatch,
  CustodyRecordResult,
  CustodyStore,
  CustodyTransferRecipient,
} from "./custody-types.js";

const log = pino({ level: env.LOG_LEVEL });

function hasPositiveTokenAmount(event: SwapEvent): boolean {
  const exact = event.grossAmountRaw ?? event.amountRaw;
  if (typeof exact === "string" && /^\d+$/.test(exact)) {
    try {
      return BigInt(exact) > 0n;
    } catch {
      return false;
    }
  }
  return (event.grossAmountTokens ?? event.amountTokens) > 0;
}

function custodyTransferRecipients(event: TransferEvent): TransferRecipient[] {
  const source = event.recipients?.length
    ? event.recipients
    : [
        {
          wallet: event.to,
          amountTokens: event.amountTokens,
          recipientPreAmount: event.recipientPreAmount,
          recipientPostAmount: event.recipientPostAmount,
        },
      ];
  return source.filter((recipient) => {
    if (!recipient.wallet || recipient.wallet === event.from) return false;
    if (typeof recipient.amountRaw === "string" && /^\d+$/.test(recipient.amountRaw)) {
      try {
        return BigInt(recipient.amountRaw) > 0n;
      } catch {
        return false;
      }
    }
    return Number.isFinite(recipient.amountTokens) && recipient.amountTokens > 0;
  });
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function isValidOnCurveWallet(wallet: string): boolean {
  try {
    const key = new PublicKey(wallet);
    return PublicKey.isOnCurve(key.toBytes());
  } catch {
    return false;
  }
}

export type CustodyResultHandler = (
  result: CustodyRecordResult,
  event: FeedEvent | UnresolvedOutflowEvent,
) => Promise<void> | void;

export type CustodyRuntimeOptions = {
  classificationLookupTimeoutMs?: number;
};

/**
 * Observation-only event router. This module deliberately has no import path
 * to the executor, funding key, positions, Entries state, or sell policies.
 */
export class CustodyRuntime {
  private classifications = new Map<
    string,
    {
      expiresAt: number;
      value: Promise<Awaited<ReturnType<typeof classifyCustodyWallet>>>;
    }
  >();
  private activeAttributionScopes = new Set<string>();
  private activeCustodyWallets = new Set<string>();

  private static readonly CLASSIFICATION_CACHE_MS = 10 * 60_000;
  private static readonly CLASSIFICATION_CACHE_MAX = 2_000;

  constructor(
    private store: CustodyStore,
    private connection: Pick<Connection, "getAccountInfo">,
    private onResult: CustodyResultHandler = () => undefined,
    private options: CustodyRuntimeOptions = {},
  ) {}

  clearClassificationCache(): void {
    this.classifications.clear();
  }

  /**
   * Replaces the in-memory wallet+mint attribution scope from the complete
   * durable watch snapshot. Events already in scope may still enter pending
   * replay if their upstream transfer is observed out of order.
   */
  reconcileActiveWatches(rows: ActiveCustodyWatch[]): void {
    this.activeAttributionScopes = new Set(
      rows
        .filter((row) => row.wallet && row.tokenMint)
        .map((row) => attributionScopeKey(row.wallet, row.tokenMint)),
    );
    this.activeCustodyWallets = new Set(rows.filter((row) => row.wallet).map((row) => row.wallet));
  }

  async observe(
    event: FeedEvent,
    options: { enabled: boolean; targetWallets: ReadonlySet<string> },
  ): Promise<CustodyRecordResult | null> {
    if (!options.enabled) return null;
    let result: CustodyRecordResult | null = null;

    if (event.kind === "swap") {
      if (
        event.side === "buy" &&
        options.targetWallets.has(event.wallet) &&
        event.verifiedSwap === true &&
        hasPositiveTokenAmount(event)
      ) {
        result = await this.store.recordTargetBuy(event);
      } else if (isVerifiedCustodySell(event)) {
        if (
          await this.shouldPersistPotentialCustodyEvent(
            event.wallet,
            event.tokenMint,
            options.targetWallets,
          )
        ) {
          result = await this.store.recordVerifiedSell(event);
        }
      }
    } else {
      result = await this.recordTransfer(event, options.targetWallets);
    }

    return result ? this.completeObservation(result, event) : null;
  }

  async observeUnresolvedOutflow(
    event: UnresolvedOutflowEvent,
    options: { enabled: boolean; targetWallets: ReadonlySet<string> },
  ): Promise<CustodyRecordResult | null> {
    if (!options.enabled) return null;
    if (
      !(await this.shouldPersistPotentialCustodyEvent(
        event.wallet,
        event.tokenMint,
        options.targetWallets,
      ))
    ) {
      return null;
    }
    const result = await this.store.recordUnresolvedOutflow(event);
    return this.completeObservation(result, event);
  }

  private async completeObservation(
    result: CustodyRecordResult,
    event: FeedEvent | UnresolvedOutflowEvent,
  ): Promise<CustodyRecordResult> {
    this.applyAttributionScopeResult(result, event);
    await this.onResult(result, event);
    if (result.payloadMismatch) {
      log.warn(
        { eventKind: event.kind, mint: event.tokenMint, reason: result.reason },
        "custody duplicate payload conflict quarantined; cursor may continue",
      );
    }
    log.info(
      {
        eventKind: event.kind,
        mint: event.tokenMint,
        applied: result.applied,
        duplicate: result.duplicate,
        reason: result.reason,
        watchedCount: result.watchedWallets.length,
        releasedCount: result.releasedWallets.length,
        journeyStatus: result.journeyStatus,
      },
      "custody journey observation persisted",
    );
    return result;
  }

  private async recordTransfer(
    event: TransferEvent,
    targets: ReadonlySet<string>,
  ): Promise<CustodyRecordResult | null> {
    if (!(await this.shouldPersistPotentialCustodyEvent(event.from, event.tokenMint, targets))) {
      return null;
    }
    const recipients = await mapWithConcurrency(
      custodyTransferRecipients(event),
      8,
      async (recipient): Promise<CustodyTransferRecipient> => {
        const now = Date.now();
        this.pruneClassificationCache(now);
        let cached = this.classifications.get(recipient.wallet);
        if (!cached || cached.expiresAt <= now) {
          cached = {
            expiresAt: now + CustodyRuntime.CLASSIFICATION_CACHE_MS,
            value: classifyCustodyWallet(this.connection, recipient.wallet, targets, {
              lookupTimeoutMs: this.options.classificationLookupTimeoutMs,
            }),
          };
          this.classifications.set(recipient.wallet, cached);
        }
        try {
          const classification = await cached.value;
          if (classification.transientFailure) {
            this.classifications.delete(recipient.wallet);
            throw new Error("custody destination classification is temporarily unavailable");
          }
          return {
            ...recipient,
            ...classification,
          };
        } catch (error) {
          this.classifications.delete(recipient.wallet);
          log.warn(
            { wallet: recipient.wallet, error: safeDiagnostic(error) },
            "custody destination classification failed closed",
          );
          throw new Error(
            `custody destination classification unavailable for ${isValidOnCurveWallet(recipient.wallet) ? "wallet" : "program address"}`,
          );
        }
      },
    );
    return this.store.recordTransfer(event, recipients);
  }

  private async hasActiveAttribution(wallet: string, tokenMint: string): Promise<boolean> {
    const key = attributionScopeKey(wallet, tokenMint);
    if (this.activeAttributionScopes.has(key)) return true;
    const active = await this.store.hasActiveAttribution(wallet, tokenMint);
    if (active) {
      this.activeAttributionScopes.add(key);
      this.activeCustodyWallets.add(wallet);
    }
    return active;
  }

  /**
   * A wallet-wide RPC cursor may already be active for another mint. Persist
   * its new-mint event into the DB's dormant staging path so an upstream
   * transfer processed later can wake it without rewinding the wallet cursor.
   */
  private async shouldPersistPotentialCustodyEvent(
    wallet: string,
    tokenMint: string,
    targets: ReadonlySet<string>,
  ): Promise<boolean> {
    if (this.activeCustodyWallets.has(wallet) || targets.has(wallet)) return true;
    return this.hasActiveAttribution(wallet, tokenMint);
  }

  private applyAttributionScopeResult(
    result: CustodyRecordResult,
    event: FeedEvent | UnresolvedOutflowEvent,
  ): void {
    if (result.journeyReleased || result.journeyStatus === "flat") {
      const suffix = `\u0000${event.tokenMint}`;
      for (const key of this.activeAttributionScopes) {
        if (key.endsWith(suffix)) this.activeAttributionScopes.delete(key);
      }
      this.rebuildActiveCustodyWallets();
      return;
    }
    for (const wallet of result.releasedWallets) {
      this.activeAttributionScopes.delete(attributionScopeKey(wallet, event.tokenMint));
    }
    if (!result.journeyId || result.journeyStatus !== "active") return;
    for (const wallet of result.watchedWallets) {
      this.activeAttributionScopes.add(attributionScopeKey(wallet, event.tokenMint));
      this.activeCustodyWallets.add(wallet);
    }
    if (event.kind === "swap" && event.side === "buy" && (result.applied || result.duplicate)) {
      this.activeAttributionScopes.add(attributionScopeKey(event.wallet, event.tokenMint));
      this.activeCustodyWallets.add(event.wallet);
    }
    for (const wallet of result.releasedWallets) this.refreshActiveWallet(wallet);
  }

  private rebuildActiveCustodyWallets(): void {
    this.activeCustodyWallets = new Set(
      Array.from(this.activeAttributionScopes, (key) => key.slice(0, key.indexOf("\u0000"))),
    );
  }

  private refreshActiveWallet(wallet: string): void {
    const prefix = `${wallet}\u0000`;
    if (Array.from(this.activeAttributionScopes).some((key) => key.startsWith(prefix))) {
      this.activeCustodyWallets.add(wallet);
    } else {
      this.activeCustodyWallets.delete(wallet);
    }
  }

  private pruneClassificationCache(nowMs: number): void {
    for (const [wallet, cached] of this.classifications) {
      if (cached.expiresAt <= nowMs) this.classifications.delete(wallet);
    }
    while (this.classifications.size >= CustodyRuntime.CLASSIFICATION_CACHE_MAX) {
      const oldest = this.classifications.keys().next().value;
      if (typeof oldest !== "string") break;
      this.classifications.delete(oldest);
    }
  }
}

function attributionScopeKey(wallet: string, tokenMint: string): string {
  return `${wallet}\u0000${tokenMint}`;
}

export function isVerifiedCustodySell(event: SwapEvent): boolean {
  return (
    event.side === "sell" &&
    event.verifiedSwap === true &&
    event.sellAttribution?.verified === true &&
    hasPositiveTokenAmount(event)
  );
}
