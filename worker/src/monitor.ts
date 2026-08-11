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
import { isFollowerWalletRetained as isWalletRetainedByFollowerPosition } from "./watch-lifecycle.js";

const log = pino({ level: env.LOG_LEVEL });
const MAX_FOLLOW_HOPS = 3;
const MAX_FOLLOWER_WALLETS_PER_POSITION = 100;
const MIN_DESCENDANT_TRANSFER_FRACTION = 0.0001;

export type PositionCtx = {
  positionId: string;
  tokenMint: string;
  targetWallet: string;
};

export class FollowerMonitor {
  // positionId -> ctx
  private active = new Map<string, PositionCtx>();
  // tokenMint -> positionId (for quick reverse lookup on incoming swap/transfer events)
  private byMint = new Map<string, string>();
  // positionId -> follower wallets retained by that position.
  private followersByPosition = new Map<string, Set<string>>();
  // Primary plus additional target wallets. These remain subscribed
  // even when they are also temporary custody buckets for an open position.
  private targetWallets = new Set<string>();

  constructor(
    private feed: GeyserFeed,
    private poller?: RpcBackfillPoller,
  ) {}

  activeForMint(mint: string): PositionCtx | undefined {
    const id = this.byMint.get(mint);
    return id ? this.active.get(id) : undefined;
  }

  isFollower(positionId: string, wallet: string): boolean {
    return this.followersByPosition.get(positionId)?.has(wallet) ?? false;
  }

  isFollowerWalletRetained(wallet: string): boolean {
    return isWalletRetainedByFollowerPosition(this.followersByPosition, wallet);
  }

  setTargetWallets(wallets: ReadonlySet<string>) {
    this.targetWallets = new Set(wallets);
    for (const followers of this.followersByPosition.values()) {
      for (const wallet of this.targetWallets) followers.delete(wallet);
    }
  }

  async onCopyBuy(ctx: PositionCtx) {
    const existing = this.activeForMint(ctx.tokenMint);
    if (existing && existing.positionId !== ctx.positionId) {
      throw new Error(`Cannot monitor two open positions for mint ${ctx.tokenMint}`);
    }
    this.active.set(ctx.positionId, ctx);
    this.byMint.set(ctx.tokenMint, ctx.positionId);
    if (!this.followersByPosition.has(ctx.positionId)) {
      this.followersByPosition.set(ctx.positionId, new Set());
    }
    log.info(ctx, "follower monitor armed");
  }

  async restoreFollower(
    positionId: string,
    wallet: string,
    lastSeenSlot?: number,
    lastSeenSignature?: string,
  ) {
    await this.retainFollower(positionId, wallet, lastSeenSlot, lastSeenSignature);
  }

  /**
   * Recover ownership from Supabase when an event arrives before the temporary
   * in-memory watch set has been restored. Supabase remains authoritative, so
   * an unrelated wallet can never trigger a mirrored sell through this path.
   */
  async ensureFollower(
    positionId: string,
    wallet: string,
    observedSlot?: number,
    observedSignature?: string,
  ): Promise<boolean> {
    if (this.isFollower(positionId, wallet)) return true;
    if (this.targetWallets.has(wallet)) return false;

    const { data, error } = await db
      .from("follower_wallets")
      .select("wallet,last_seen_slot,last_seen_signature,current_amount,hop_depth")
      .eq("position_id", positionId)
      .eq("wallet", wallet)
      .gt("hop_depth", 0)
      .gt("current_amount", 0)
      .maybeSingle();
    if (error) throw new Error(`follower ownership recovery failed: ${error.message}`);
    if (!data) {
      log.info(
        { positionId, wallet, observedSlot, observedSignature },
        "active-position wallet rejected by database ownership check",
      );
      return false;
    }

    await this.retainFollower(
      positionId,
      wallet,
      observedSlot ??
        (data.last_seen_slot === null || data.last_seen_slot === undefined
          ? undefined
          : Number(data.last_seen_slot)),
      observedSignature ?? data.last_seen_signature ?? undefined,
    );
    log.warn(
      { positionId, wallet },
      "follower ownership recovered from database before exit processing",
    );
    return true;
  }

  /** Repair subscriptions that were missed or lost after a stream/process restart. */
  async reconcileFollowersFromDatabase(): Promise<number> {
    const positionIds = Array.from(this.active.keys());
    if (positionIds.length === 0) return 0;
    const { data, error } = await db
      .from("follower_wallets")
      .select("position_id,wallet,last_seen_slot,last_seen_signature,current_amount,hop_depth")
      .in("position_id", positionIds)
      .gt("hop_depth", 0)
      .gt("current_amount", 0);
    if (error) throw new Error(`follower subscription reconciliation failed: ${error.message}`);

    let recovered = 0;
    for (const row of data ?? []) {
      if (this.isFollower(row.position_id, row.wallet)) continue;
      await this.retainFollower(
        row.position_id,
        row.wallet,
        row.last_seen_slot === null ? undefined : Number(row.last_seen_slot),
        row.last_seen_signature ?? undefined,
      );
      recovered += 1;
    }
    if (recovered > 0) {
      log.warn({ recovered, openPositions: positionIds.length }, "follower subscriptions repaired");
    }
    return recovered;
  }

  /** Register (or top up) a follower wallet after target transfers tokens to it. */
  async recordTransfer(
    positionId: string,
    recipient: string,
    amount: number,
    observedSlot?: number,
    observedSignature?: string,
  ) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const { data: existing, error: existingError } = await db
      .from("follower_wallets")
      .select("initial_amount,current_amount")
      .eq("position_id", positionId)
      .eq("wallet", recipient)
      .maybeSingle();
    if (existingError) throw new Error(`follower lookup failed: ${existingError.message}`);

    if (existing) {
      const { error } = await db
        .from("follower_wallets")
        .update({
          initial_amount: Number(existing.initial_amount) + amount,
          current_amount: Number(existing.current_amount) + amount,
          hop_depth: 1,
          parent_wallet: null,
          last_seen_slot: observedSlot,
          last_seen_signature: observedSignature,
          last_updated: new Date().toISOString(),
        })
        .eq("position_id", positionId)
        .eq("wallet", recipient);
      if (error) throw new Error(`follower top-up failed: ${error.message}`);
    } else {
      const { error } = await db.from("follower_wallets").insert({
        position_id: positionId,
        wallet: recipient,
        initial_amount: amount,
        current_amount: amount,
        hop_depth: 1,
        parent_wallet: null,
        last_seen_slot: observedSlot,
        last_seen_signature: observedSignature,
        last_updated: new Date().toISOString(),
      });
      if (error) throw new Error(`follower insert failed: ${error.message}`);
    }
    await this.retainFollower(positionId, recipient, observedSlot, observedSignature);
    log.info({ positionId, recipient, amount }, "follower registered / topped up");
  }

  /**
   * Move attributed tokens from one retained follower to another. The database
   * operation is atomic and preserves the aggregate initial/current balances,
   * so a transfer cannot be mistaken for a sell.
   */
  async recordFollowerTransfer(
    positionId: string,
    fromWallet: string,
    toWallet: string,
    amount: number,
    observedSlot?: number,
    observedSignature?: string,
  ): Promise<boolean> {
    if (
      fromWallet === toWallet ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return false;
    }

    const { data, error } = await db.rpc("move_follower_tokens", {
      p_position_id: positionId,
      p_from_wallet: fromWallet,
      p_to_wallet: toWallet,
      p_amount: amount,
      p_slot: observedSlot ?? null,
      p_signature: observedSignature ?? null,
      p_max_depth: MAX_FOLLOW_HOPS,
      p_max_wallets: MAX_FOLLOWER_WALLETS_PER_POSITION,
      p_min_fraction: MIN_DESCENDANT_TRANSFER_FRACTION,
    });
    if (error) throw new Error(`follower ownership move failed: ${error.message}`);

    const result = (Array.isArray(data) ? data[0] : data) as {
      status?: string;
      moved_amount?: number | string;
      destination_depth?: number | string;
    } | null;
    if (result?.status !== "moved") {
      log.info(
        {
          positionId,
          fromWallet,
          toWallet,
          requestedAmount: amount,
          status: result?.status ?? "no_result",
        },
        "descendant follower transfer ignored by safety policy",
      );
      return false;
    }

    await this.retainFollower(positionId, toWallet, observedSlot, observedSignature);
    log.info(
      {
        positionId,
        fromWallet,
        toWallet,
        requestedAmount: amount,
        movedAmount: Number(result.moved_amount ?? 0),
        hopDepth: Number(result.destination_depth ?? 0),
      },
      "descendant follower transfer tracked",
    );
    return true;
  }

  /**
   * Preserve attributed inventory when a follower sends tokens back to the
   * configured target. The target is a custody bucket in the database, but is
   * not added to the follower watch set because it is already watched.
   */
  async recordFollowerReturnToTarget(
    positionId: string,
    fromWallet: string,
    targetWallet: string,
    amount: number,
    observedSlot?: number,
    observedSignature?: string,
  ): Promise<boolean> {
    if (
      fromWallet === targetWallet ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return false;
    }
    const { data, error } = await db.rpc("return_follower_tokens_to_target", {
      p_position_id: positionId,
      p_from_wallet: fromWallet,
      p_target_wallet: targetWallet,
      p_amount: amount,
      p_slot: observedSlot ?? null,
      p_signature: observedSignature ?? null,
    });
    if (error) throw new Error(`follower return-to-target move failed: ${error.message}`);
    const result = (Array.isArray(data) ? data[0] : data) as {
      status?: string;
      moved_amount?: number | string;
    } | null;
    if (result?.status === "duplicate") return true;
    if (result?.status !== "moved") {
      log.info(
        {
          positionId,
          fromWallet,
          targetWallet,
          requestedAmount: amount,
          status: result?.status ?? "no_result",
        },
        "follower return to target was not attributed",
      );
      return false;
    }
    log.info(
      {
        positionId,
        fromWallet,
        targetWallet,
        requestedAmount: amount,
        movedAmount: Number(result.moved_amount ?? 0),
      },
      "follower inventory returned to target custody",
    );
    return true;
  }

  /**
   * Move attributed custody between configured target wallets. If the source
   * target did not already hold all of the transferred inventory, the
   * unmatched amount is added as fresh network inventory. The destination
   * remains a target custody bucket (hop 0), not a mirrored follower wallet.
   */
  async recordTargetCustodyTransfer(
    positionId: string,
    fromTargetWallet: string,
    toTargetWallet: string,
    amount: number,
    observedSlot?: number,
    observedSignature?: string,
  ): Promise<boolean> {
    if (
      fromTargetWallet === toTargetWallet ||
      !this.targetWallets.has(fromTargetWallet) ||
      !this.targetWallets.has(toTargetWallet) ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return false;
    }
    const { data, error } = await db.rpc("record_target_custody_transfer", {
      p_position_id: positionId,
      p_from_target_wallet: fromTargetWallet,
      p_to_target_wallet: toTargetWallet,
      p_amount: amount,
      p_slot: observedSlot ?? null,
      p_signature: observedSignature ?? null,
      p_max_wallets: MAX_FOLLOWER_WALLETS_PER_POSITION,
    });
    if (error) throw new Error(`target custody move failed: ${error.message}`);
    const result = (Array.isArray(data) ? data[0] : data) as {
      status?: string;
      moved_from_custody?: number | string;
      newly_attributed?: number | string;
    } | null;
    if (!["recorded", "duplicate"].includes(result?.status ?? "")) {
      log.warn(
        {
          positionId,
          fromTargetWallet,
          toTargetWallet,
          requestedAmount: amount,
          status: result?.status ?? "no_result",
        },
        "target-to-target custody transfer was not retained",
      );
      return false;
    }
    log.info(
      {
        positionId,
        fromTargetWallet,
        toTargetWallet,
        requestedAmount: amount,
        movedFromCustody: Number(result?.moved_from_custody ?? 0),
        newlyAttributed: Number(result?.newly_attributed ?? 0),
        status: result?.status,
      },
      "target custody transfer reconciled",
    );
    return true;
  }

  /**
   * First redistribute any inventory held in the target custody bucket, then
   * treat only the unmatched remainder as newly distributed target inventory.
   */
  async recordTargetTransfer(
    positionId: string,
    targetWallet: string,
    recipient: string,
    amount: number,
    observedSlot?: number,
    observedSignature?: string,
  ): Promise<boolean> {
    if (targetWallet === recipient || !Number.isFinite(amount) || amount <= 0) {
      return false;
    }
    const { data, error } = await db.rpc("record_target_transfer", {
      p_position_id: positionId,
      p_target_wallet: targetWallet,
      p_recipient_wallet: recipient,
      p_amount: amount,
      p_slot: observedSlot ?? null,
      p_signature: observedSignature ?? null,
      p_max_wallets: MAX_FOLLOWER_WALLETS_PER_POSITION,
    });
    if (error) throw new Error(`atomic target transfer failed: ${error.message}`);
    const result = (Array.isArray(data) ? data[0] : data) as {
      status?: string;
      moved_from_custody?: number | string;
      newly_attributed?: number | string;
    } | null;
    if (!["recorded", "duplicate"].includes(result?.status ?? "")) {
      log.warn(
        {
          positionId,
          targetWallet,
          recipient,
          requestedAmount: amount,
          status: result?.status ?? "no_result",
        },
        "target transfer not retained because ownership safety policy rejected it",
      );
      return false;
    }
    await this.retainFollower(positionId, recipient, observedSlot, observedSignature);
    log.info(
      {
        positionId,
        targetWallet,
        recipient,
        requestedAmount: amount,
        movedFromCustody: Number(result?.moved_from_custody ?? 0),
        newlyAttributed: Number(result?.newly_attributed ?? 0),
        status: result?.status,
      },
      "target transfer ownership reconciled",
    );
    return true;
  }

  /** Decrement follower's current bag after they sell. Returns the new aggregate sold fraction. */
  async recordFollowerSell(
    positionId: string,
    wallet: string,
    soldAmount: number,
    observedSlot?: number,
    observedSignature?: string,
  ): Promise<number | null> {
    const { data, error } = await db.rpc("record_follower_sell", {
      p_position_id: positionId,
      p_wallet: wallet,
      p_sold_amount: soldAmount,
      p_slot: observedSlot ?? null,
      p_signature: observedSignature ?? null,
    });
    if (error) throw new Error(`atomic follower sell failed: ${error.message}`);

    const result = (Array.isArray(data) ? data[0] : data) as {
      status?: string;
      sold_fraction?: number | string | null;
      new_wallet_amount?: number | string | null;
    } | null;
    if (result?.status !== "recorded") {
      log.info(
        {
          positionId,
          wallet,
          observedSlot,
          observedSignature,
          status: result?.status ?? "no_result",
        },
        "follower sell was not recorded",
      );
      return null;
    }

    const soldFraction = Number(result.sold_fraction);
    if (!Number.isFinite(soldFraction)) {
      throw new Error("atomic follower sell returned an invalid sold fraction");
    }
    return Math.min(1, Math.max(0, soldFraction));
  }

  /** Called after the bot sells its whole bag on this position. Stops watching all followers. */
  async releasePosition(positionId: string) {
    const ctx = this.active.get(positionId);
    const retained = this.followersByPosition.get(positionId) ?? new Set<string>();
    const { data: rows, error: rowsError } = await db
      .from("follower_wallets")
      .select("wallet")
      .eq("position_id", positionId);
    if (rowsError) {
      log.warn(
        { err: rowsError, positionId },
        "follower release lookup failed; cleaning up known in-memory wallets",
      );
    } else {
      for (const r of rows ?? []) retained.add(r.wallet);
    }

    this.followersByPosition.delete(positionId);
    this.active.delete(positionId);
    if (ctx) this.byMint.delete(ctx.tokenMint);
    for (const wallet of retained) {
      if (
        !isWalletRetainedByFollowerPosition(this.followersByPosition, wallet) &&
        !this.targetWallets.has(wallet)
      ) {
        this.poller?.unwatch(wallet);
        try {
          await this.feed.unwatch(wallet);
        } catch (err) {
          log.warn(
            { err, positionId, wallet },
            "live follower unwatch failed; it will be corrected on stream reconnect",
          );
        }
      }
    }
    const { error: deleteError } = await db
      .from("follower_wallets")
      .delete()
      .eq("position_id", positionId);
    if (deleteError) {
      log.warn(
        { err: deleteError, positionId },
        "follower history cleanup failed; closed positions will not be restored",
      );
    }
    log.info({ positionId }, "follower monitoring released");
  }

  private async retainFollower(
    positionId: string,
    wallet: string,
    observedSlot?: number,
    observedSignature?: string,
  ) {
    if (this.targetWallets.has(wallet)) return;
    const followers = this.followersByPosition.get(positionId) ?? new Set<string>();
    if (followers.has(wallet)) return;
    const alreadyWatched =
      isWalletRetainedByFollowerPosition(this.followersByPosition, wallet) ||
      this.targetWallets.has(wallet);
    followers.add(wallet);
    this.followersByPosition.set(positionId, followers);
    if (!alreadyWatched) {
      this.poller?.watch(wallet, observedSlot, observedSignature);
      await this.feed.watch(wallet);
    }
  }
}
