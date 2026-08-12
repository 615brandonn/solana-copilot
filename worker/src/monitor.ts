// Follower monitor. When the bot lands a copy buy, we start listening for the
// target wallet's outbound SPL transfers of that same mint. Every recipient
// becomes a "follower" of the position. As followers sell their bag, we
// aggregate the sold fraction and the executor mirrors it on our position.
// Once the bot's position is flat, all follower wallets are released.

import pino from "pino";
import { db } from "./db.js";
import type { GeyserFeed } from "./geyser.js";
import type { RpcBackfillPoller } from "./poller.js";
import { env } from "./env.js";
import { chainedTransferAmount } from "./follower-math.js";
import { safeDiagnostic } from "./diagnostics.js";
import type { ClassifiedTransferRecipient } from "./transfer-batch.js";
import {
  parseFollowerSellAccountingResult,
  parseRootFollowerTransferResult,
} from "./follower-accounting.js";

const log = pino({ level: env.LOG_LEVEL });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retryDb<T>(
  label: string,
  operation: () => PromiseLike<{ data: T; error: { message: string } | null }>,
  attempts = 4,
): Promise<T> {
  let lastError = "unknown database error";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await operation();
      if (!result.error) return result.data;
      lastError = safeDiagnostic(result.error.message);
    } catch (err) {
      lastError = safeDiagnostic(err);
    }
    if (attempt < attempts) {
      log.warn({ label, attempt, lastError }, "follower database operation failed — retrying");
      await delay(attempt * 500);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError}`);
}

export type PositionCtx = {
  positionId: string;
  tokenMint: string;
  targetWallet: string;
  entrySlot?: number;
};

export type FollowerSellState = {
  soldFraction: number;
  distinctSellerCount: number;
  firstSellByWallet: boolean;
  triggerEligible: boolean;
  freshForAction: boolean;
  duplicate: boolean;
};

export type TerminalOutflowState = {
  movedAmount: number;
  hopDepth: number;
  triggerEligible: boolean;
};

export type ChainedTransferBatchState = {
  applied: boolean;
  duplicate: boolean;
  reason?: string;
  movedAmount: number;
  trackedAmount: number;
  terminalAmount: number;
  hopDepth?: number;
  sourceTriggerEligible: boolean;
  trackedWallets: string[];
  terminalWallets: string[];
};

type FollowerRetentionRequest = {
  positionId: string;
  wallet: string;
  anchorSlot?: number;
};

export class FollowerMonitor {
  // positionId -> ctx
  private active = new Map<string, PositionCtx>();
  // tokenMint -> positionId (for quick reverse lookup on incoming swap/transfer events)
  private byMint = new Map<string, string>();
  // positionId -> follower wallets currently retained by that position.  The
  // feed itself is keyed only by wallet, so this map provides the reference
  // counting needed when the same wallet holds more than one copied token.
  private followersByPosition = new Map<string, Set<string>>();
  // Configured targets are also permanent feed consumers. A wallet can be a
  // target and a follower at the same time, so releasing either role must not
  // tear down the other role's subscription.
  private baseWatchedWallets = new Set<string>();
  private reconcilingFollowers = false;

  constructor(
    private feed: GeyserFeed,
    private poller?: RpcBackfillPoller,
  ) {}

  activeForMint(mint: string): PositionCtx | undefined {
    const id = this.byMint.get(mint);
    return id ? this.active.get(id) : undefined;
  }

  setBaseWatchedWallets(wallets: Iterable<string>) {
    this.baseWatchedWallets = new Set(Array.from(wallets).filter(Boolean));
  }

  isFollowerRetained(wallet: string): boolean {
    return this.isWalletRetained(wallet);
  }

  async onCopyBuy(ctx: PositionCtx) {
    this.active.set(ctx.positionId, ctx);
    this.byMint.set(ctx.tokenMint, ctx.positionId);
    if (!this.followersByPosition.has(ctx.positionId)) {
      this.followersByPosition.set(ctx.positionId, new Set());
    }
    log.info(ctx, "follower monitor armed");
  }

  /**
   * Restore all persisted follower wallets for every open position. This is
   * intentionally idempotent and is safe to run at startup and periodically.
   * It repairs subscriptions lost during a process/stream restart or a
   * temporary database failure without changing any sell percentages.
   */
  async reconcileFollowersFromDatabase(): Promise<number> {
    if (this.reconcilingFollowers) return 0;
    const positionIds = Array.from(this.active.keys());
    if (positionIds.length === 0) return 0;

    this.reconcilingFollowers = true;
    try {
      const rows = await retryDb<Array<{
        position_id: string;
        wallet: string;
        current_amount: number;
        last_seen_slot: number | null;
      }> | null>("reconcile follower subscriptions", () =>
        db
          .from("follower_wallets")
          .select("position_id,wallet,current_amount,last_seen_slot")
          .in("position_id", positionIds)
          .is("released_at", null)
          .gt("current_amount", 0),
      );

      let recovered = 0;
      const registrations: FollowerRetentionRequest[] = [];
      for (const row of rows ?? []) {
        if (!this.active.has(row.position_id)) continue;
        const followers = this.followersByPosition.get(row.position_id);
        const alreadyRetained = followers?.has(row.wallet) === true;
        // Always retry the underlying feed registrations. A previous gRPC
        // subscription write may have failed after the durable database row
        // was saved, and both feed implementations are intentionally
        // idempotent.
        registrations.push({
          positionId: row.position_id,
          wallet: row.wallet,
          anchorSlot: row.last_seen_slot ?? undefined,
        });
        if (!alreadyRetained) recovered += 1;
      }
      // Register every durable RPC watch before attempting any fallible Geyser
      // update. One bad hot-path subscription must not starve later wallets.
      await this.retainFollowers(registrations);
      if (recovered > 0) {
        log.warn(
          { recovered, openPositions: positionIds.length },
          "follower subscriptions repaired from database",
        );
      }
      return recovered;
    } finally {
      this.reconcilingFollowers = false;
    }
  }

  /** Register (or top up) a follower wallet after target transfers tokens to it. */
  async recordTransfer(
    positionId: string,
    recipient: string,
    amount: number,
    lineage: {
      hopDepth?: number;
      parentWallet?: string;
      txSig?: string;
      slot?: number;
      triggerEligible?: boolean;
    } = {},
  ): Promise<boolean> {
    const ctx = this.active.get(positionId);
    if (!ctx || !Number.isFinite(amount) || amount <= 0) return false;
    const sourceWallet = lineage.parentWallet ?? ctx.targetWallet;
    const txSig = lineage.txSig || `slot-${Math.max(0, Number(lineage.slot) || 0)}`;
    const { data, error } = await db.rpc("record_root_follower_transfer", {
      p_position_id: positionId,
      p_source_wallet: sourceWallet,
      p_follower_wallet: recipient,
      p_token_mint: ctx.tokenMint,
      p_tx_sig: txSig,
      p_slot: lineage.slot ?? null,
      p_amount: amount,
      p_trigger_eligible: Boolean(lineage.triggerEligible ?? false),
    });
    if (error) {
      throw new Error(`atomic root follower transfer failed: ${safeDiagnostic(error)}`);
    }
    const result = parseRootFollowerTransferResult(data);
    if (!result) return false;

    // The database claim and feed registration are intentionally separate. A
    // replay after a process/gRPC failure repairs both subscriptions without
    // crediting the same transfer again.
    await this.retainFollower(positionId, recipient, lineage.slot);
    log.info(
      { positionId, recipient, amount, duplicate: result.duplicate },
      result.duplicate
        ? "duplicate root follower transfer repaired"
        : "follower registered / topped up",
    );
    return result.applied;
  }

  /** Follow a token transfer made by an already tracked recipient, up to three hops. */
  async recordChainedTransfer(
    tokenMint: string,
    sender: string,
    recipient: string,
    amount: number,
    tx: { txSig?: string; slot?: number; recipientPreAmount?: number } = {},
  ): Promise<boolean> {
    const state = await this.recordChainedTransferBatch(
      tokenMint,
      sender,
      [
        {
          wallet: recipient,
          amountTokens: amount,
          recipientPreAmount: tx.recipientPreAmount,
          track: true,
          triggerEligible: Math.max(0, Number(tx.recipientPreAmount ?? 0)) <= 1e-9,
          destinationClass: "follower",
        },
      ],
      tx,
    );
    return state.applied || state.duplicate;
  }

  /** Atomically debit one source cohort and credit its complete recipient set. */
  async recordChainedTransferBatch(
    tokenMint: string,
    sender: string,
    recipients: ClassifiedTransferRecipient[],
    tx: { txSig?: string; slot?: number } = {},
  ): Promise<ChainedTransferBatchState> {
    const ctx = this.activeForMint(tokenMint);
    if (!ctx) return emptyBatchState("no_active_position");
    const txSig = tx.txSig || `slot-${Math.max(0, Number(tx.slot) || 0)}`;
    const { data, error } = await db.rpc("record_follower_transfer_batch", {
      p_position_id: ctx.positionId,
      p_source_wallet: sender,
      p_token_mint: tokenMint,
      p_tx_sig: txSig,
      p_slot: tx.slot ?? null,
      p_recipients: recipients.map((recipient) => ({
        wallet: recipient.wallet,
        amountTokens: recipient.amountTokens,
        track: recipient.track,
        triggerEligible: recipient.triggerEligible,
        destinationClass: recipient.destinationClass,
      })),
    });
    if (error) {
      throw new Error(`atomic follower transfer batch failed: ${safeDiagnostic(error)}`);
    }
    const row = (data ?? {}) as Record<string, unknown>;
    const trackedWallets = stringArray(row.trackedWallets);
    // Also runs on an idempotent retry, repairing subscriptions if the process
    // stopped after the database transaction committed. All RPC watches are
    // installed before any Geyser failure can be returned to the caller.
    await this.retainFollowers(
      trackedWallets.map((wallet) => ({
        positionId: ctx.positionId,
        wallet,
        anchorSlot: tx.slot,
      })),
    );
    const state: ChainedTransferBatchState = {
      applied: row.applied === true,
      duplicate: row.duplicate === true,
      reason: typeof row.reason === "string" ? row.reason : undefined,
      movedAmount: finiteNumber(row.movedAmount) ?? 0,
      trackedAmount: finiteNumber(row.trackedAmount) ?? 0,
      terminalAmount: finiteNumber(row.terminalAmount) ?? 0,
      hopDepth: finiteNumber(row.hopDepth),
      sourceTriggerEligible: row.sourceTriggerEligible === true,
      trackedWallets,
      terminalWallets: stringArray(row.terminalWallets),
    };
    log.info(
      {
        positionId: ctx.positionId,
        sender,
        txSig,
        applied: state.applied,
        duplicate: state.duplicate,
        movedAmount: state.movedAmount,
        trackedAmount: state.trackedAmount,
        terminalAmount: state.terminalAmount,
        hopDepth: state.hopDepth,
        recipientCount: recipients.length,
      },
      "follower transfer batch accounted atomically",
    );
    return state;
  }

  /** Decrement follower's current bag after they sell. Returns the new aggregate sold fraction. */
  async recordFollowerSell(
    positionId: string,
    wallet: string,
    soldAmount: number,
    tx: { txSig?: string; slot?: number; countAsDistinctSeller?: boolean } = {},
  ): Promise<FollowerSellState | null> {
    const ctx = this.active.get(positionId);
    if (!ctx || !Number.isFinite(soldAmount) || soldAmount <= 0) return null;
    const txSig = tx.txSig || `slot-${Math.max(0, Number(tx.slot) || 0)}`;
    const { data, error } = await db.rpc("record_follower_sell_event", {
      p_position_id: positionId,
      p_follower_wallet: wallet,
      p_token_mint: ctx.tokenMint,
      p_tx_sig: txSig,
      p_slot: tx.slot ?? null,
      p_sold_amount: soldAmount,
      p_count_as_distinct_seller: tx.countAsDistinctSeller !== false,
    });
    if (error) throw new Error(`atomic follower sell failed: ${safeDiagnostic(error)}`);
    const result = parseFollowerSellAccountingResult(data);
    if (!result) return null;
    return {
      soldFraction: result.soldFraction,
      distinctSellerCount: result.distinctSellerCount,
      firstSellByWallet: result.firstSellByWallet,
      triggerEligible: result.triggerEligible,
      freshForAction: result.freshForAction,
      duplicate: result.duplicate,
    };
  }

  /** Record tokens leaving a retained wallet for a destination we cannot safely follow. */
  async recordTerminalOutflow(
    positionId: string,
    wallet: string,
    amount: number,
    tx: { txSig?: string; slot?: number } = {},
  ): Promise<TerminalOutflowState | null> {
    const row = await retryDb<{
      current_amount: number;
      unexplained_outflow_amount: number;
      hop_depth: number;
      trigger_eligible: boolean;
      last_seen_signature: string | null;
    } | null>("load follower before terminal outflow", () =>
      db
        .from("follower_wallets")
        .select(
          "current_amount,unexplained_outflow_amount,hop_depth,trigger_eligible,last_seen_signature",
        )
        .eq("position_id", positionId)
        .eq("wallet", wallet)
        .is("released_at", null)
        .maybeSingle(),
    );
    if (!row) return null;
    if (tx.txSig && row.last_seen_signature === tx.txSig) return null;
    const movedAmount = chainedTransferAmount(row.current_amount, amount);
    if (movedAmount <= 0) return null;
    await retryDb("save terminal follower outflow", () =>
      db
        .from("follower_wallets")
        .update({
          current_amount: Math.max(0, Number(row.current_amount) - movedAmount),
          unexplained_outflow_amount:
            Math.max(0, Number(row.unexplained_outflow_amount)) + movedAmount,
          last_seen_signature: tx.txSig ?? row.last_seen_signature,
          last_seen_slot: tx.slot ?? null,
          last_updated: new Date().toISOString(),
        })
        .eq("position_id", positionId)
        .eq("wallet", wallet),
    );
    return {
      movedAmount,
      hopDepth: Math.max(1, Number(row.hop_depth) || 1),
      triggerEligible: Boolean(row.trigger_eligible),
    };
  }

  /** Called after the bot sells its whole bag on this position. Stops watching all followers. */
  async releasePosition(positionId: string) {
    const ctx = this.active.get(positionId);
    const rows = await retryDb<Array<{ wallet: string }> | null>("load followers for release", () =>
      db.from("follower_wallets").select("wallet").eq("position_id", positionId),
    );
    const retained = this.followersByPosition.get(positionId) ?? new Set<string>();
    for (const row of rows ?? []) retained.add(row.wallet);

    // Remove this position before checking whether another open position still
    // owns the same follower wallet.
    this.followersByPosition.delete(positionId);
    this.active.delete(positionId);
    if (ctx) this.byMint.delete(ctx.tokenMint);
    for (const wallet of retained) {
      if (this.isWalletRetained(wallet) || this.baseWatchedWallets.has(wallet)) continue;
      this.poller?.unwatch(wallet);
      try {
        await this.feed.unwatch(wallet);
      } catch (error) {
        // Geyser retains the desired removal and schedules a reconnect. Do not
        // leave a flat position unarchived merely because that best-effort
        // server update failed; RPC coverage is already stopped.
        log.warn(
          { positionId, wallet, error: safeDiagnostic(error) },
          "follower Geyser unsubscribe deferred to reconnect",
        );
      }
    }
    await retryDb("archive released followers", () =>
      db
        .from("follower_wallets")
        .update({ released_at: new Date().toISOString() })
        .eq("position_id", positionId),
    );
    log.info({ positionId }, "follower monitoring released");
  }

  private isWalletRetained(wallet: string): boolean {
    for (const followers of this.followersByPosition.values()) {
      if (followers.has(wallet)) return true;
    }
    return false;
  }

  private async retainFollower(positionId: string, wallet: string, anchorSlot?: number) {
    await this.retainFollowers([{ positionId, wallet, anchorSlot }]);
  }

  private async retainFollowers(registrations: FollowerRetentionRequest[]) {
    if (registrations.length === 0) return;

    const uniqueWallets = new Map<string, Set<string>>();
    for (const registration of registrations) {
      const followers = this.followersByPosition.get(registration.positionId) ?? new Set<string>();
      followers.add(registration.wallet);
      this.followersByPosition.set(registration.positionId, followers);
      // Establish durable RPC coverage for the complete set first. If any
      // gRPC write fails, every recipient still has a replayable cursor.
      this.poller?.watch(registration.wallet, { anchorSlot: registration.anchorSlot });
      const positions = uniqueWallets.get(registration.wallet) ?? new Set<string>();
      positions.add(registration.positionId);
      uniqueWallets.set(registration.wallet, positions);
    }

    const wallets = Array.from(uniqueWallets.keys());
    const results = await Promise.allSettled(wallets.map((wallet) => this.feed.watch(wallet)));
    let failureCount = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      failureCount += 1;
      const wallet = wallets[index]!;
      log.warn(
        {
          wallet,
          positionCount: uniqueWallets.get(wallet)?.size ?? 0,
          error: safeDiagnostic(result.reason),
        },
        "follower Geyser subscription failed — RPC coverage remains active",
      );
    }
    if (failureCount > 0) {
      throw new Error(
        `${failureCount} follower Geyser subscription update(s) failed; RPC coverage remains active`,
      );
    }
  }
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function emptyBatchState(reason: string): ChainedTransferBatchState {
  return {
    applied: false,
    duplicate: false,
    reason,
    movedAmount: 0,
    trackedAmount: 0,
    terminalAmount: 0,
    sourceTriggerEligible: false,
    trackedWallets: [],
    terminalWallets: [],
  };
}
