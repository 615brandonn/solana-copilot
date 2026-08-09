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
import {
  chainedTransferAmount,
  followerSoldFraction,
  nextFollowerHop,
} from "./follower-math.js";
import { safeDiagnostic } from "./diagnostics.js";

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
};

export type FollowerSellState = {
  soldFraction: number;
  distinctSellerCount: number;
  firstSellByWallet: boolean;
};

export class FollowerMonitor {
  // positionId -> ctx
  private active = new Map<string, PositionCtx>();
  // tokenMint -> positionId (for quick reverse lookup on incoming swap/transfer events)
  private byMint = new Map<string, string>();

  constructor(
    private feed: GeyserFeed,
    private poller?: RpcBackfillPoller,
  ) {}

  activeForMint(mint: string): PositionCtx | undefined {
    const id = this.byMint.get(mint);
    return id ? this.active.get(id) : undefined;
  }

  async onCopyBuy(ctx: PositionCtx) {
    this.active.set(ctx.positionId, ctx);
    this.byMint.set(ctx.tokenMint, ctx.positionId);
    log.info(ctx, "follower monitor armed");
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
    } = {},
  ): Promise<boolean> {
    const existing = await retryDb<{
      initial_amount: number;
      current_amount: number;
      last_seen_signature: string | null;
    } | null>("load follower before transfer", () =>
      db
        .from("follower_wallets")
        .select("initial_amount,current_amount,last_seen_signature")
        .eq("position_id", positionId)
        .eq("wallet", recipient)
        .maybeSingle(),
    );

    if (lineage.txSig && existing?.last_seen_signature === lineage.txSig) {
      log.info(
        { positionId, recipient, txSig: lineage.txSig },
        "duplicate follower transfer ignored",
      );
      return false;
    }

    if (existing) {
      await retryDb("update follower transfer", () =>
        db
          .from("follower_wallets")
          .update({
            initial_amount: Number(existing.initial_amount) + amount,
            current_amount: Number(existing.current_amount) + amount,
            hop_depth: Math.min(Number(lineage.hopDepth ?? 1), 3),
            parent_wallet: lineage.parentWallet ?? null,
            last_seen_signature: lineage.txSig ?? existing.last_seen_signature ?? null,
            last_seen_slot: lineage.slot ?? null,
            last_updated: new Date().toISOString(),
          })
          .eq("position_id", positionId)
          .eq("wallet", recipient),
      );
    } else {
      await retryDb("insert follower transfer", () =>
        db.from("follower_wallets").insert({
          position_id: positionId,
          wallet: recipient,
          initial_amount: amount,
          current_amount: amount,
          hop_depth: Math.min(Number(lineage.hopDepth ?? 1), 3),
          parent_wallet: lineage.parentWallet ?? null,
          last_seen_signature: lineage.txSig ?? null,
          last_seen_slot: lineage.slot ?? null,
          last_updated: new Date().toISOString(),
        }),
      );
    }
    await this.feed.watch(recipient);
    this.poller?.watch(recipient);
    log.info({ positionId, recipient, amount }, "follower registered / topped up");
    return true;
  }

  /** Follow a token transfer made by an already tracked recipient, up to three hops. */
  async recordChainedTransfer(
    tokenMint: string,
    sender: string,
    recipient: string,
    amount: number,
    tx: { txSig?: string; slot?: number } = {},
  ): Promise<boolean> {
    const ctx = this.activeForMint(tokenMint);
    if (!ctx) return false;
    const parent = await retryDb<{
      hop_depth: number;
      initial_amount: number;
      current_amount: number;
      last_seen_signature: string | null;
    } | null>("load transfer-chain parent", () =>
      db
        .from("follower_wallets")
        .select("hop_depth,initial_amount,current_amount,last_seen_signature")
        .eq("position_id", ctx.positionId)
        .eq("wallet", sender)
        .maybeSingle(),
    );
    if (!parent) return false;
    const hopDepth = nextFollowerHop(parent.hop_depth);
    if (hopDepth === null) return false;
    const moved = chainedTransferAmount(parent.current_amount, amount);
    if (moved <= 0) return false;

    // Mark the sender first so a retry after a recipient-write failure cannot
    // subtract the same transfer twice. The recipient write has its own
    // signature guard, making both halves safely retryable.
    if (!tx.txSig || parent.last_seen_signature !== tx.txSig) {
      await retryDb("decrement transfer-chain sender", () =>
        db
          .from("follower_wallets")
          .update({
            initial_amount: Math.max(0, Number(parent.initial_amount) - moved),
            current_amount: Math.max(0, Number(parent.current_amount) - moved),
            last_seen_signature: tx.txSig ?? parent.last_seen_signature ?? null,
            last_seen_slot: tx.slot ?? null,
            last_updated: new Date().toISOString(),
          })
          .eq("position_id", ctx.positionId)
          .eq("wallet", sender),
      );
    }
    await this.recordTransfer(ctx.positionId, recipient, moved, {
      hopDepth,
      parentWallet: sender,
      txSig: tx.txSig,
      slot: tx.slot,
    });
    return true;
  }

  /** Decrement follower's current bag after they sell. Returns the new aggregate sold fraction. */
  async recordFollowerSell(
    positionId: string,
    wallet: string,
    soldAmount: number,
    tx: { txSig?: string; slot?: number } = {},
  ): Promise<FollowerSellState | null> {
    const row = await retryDb<{
      initial_amount: number;
      current_amount: number;
      first_sell_at: string | null;
      last_seen_signature: string | null;
    } | null>("load follower before sell", () =>
      db
        .from("follower_wallets")
        .select("initial_amount,current_amount,first_sell_at,last_seen_signature")
        .eq("position_id", positionId)
        .eq("wallet", wallet)
        .maybeSingle(),
    );
    if (!row) return null;
    if (tx.txSig && row.last_seen_signature === tx.txSig) {
      log.info({ positionId, wallet, txSig: tx.txSig }, "duplicate follower sell ignored");
      return null;
    }

    const newAmount = Math.max(0, Number(row.current_amount) - soldAmount);
    const firstSellByWallet = !row.first_sell_at;
    await retryDb("save follower sell", () =>
      db
        .from("follower_wallets")
        .update({
          current_amount: newAmount,
          first_sell_at: row.first_sell_at ?? new Date().toISOString(),
          last_seen_signature: tx.txSig ?? row.last_seen_signature ?? null,
          last_seen_slot: tx.slot ?? null,
          last_updated: new Date().toISOString(),
        })
        .eq("position_id", positionId)
        .eq("wallet", wallet),
    );

    const agg = await retryDb<Array<{ initial_amount: number; current_amount: number }> | null>(
      "load follower aggregate",
      () =>
        db
          .from("follower_wallets")
          .select("initial_amount,current_amount")
          .eq("position_id", positionId),
    );
    if (!agg?.length) return null;
    const count = await retryDb<number | null>("count distinct follower sellers", () =>
      db
        .from("follower_wallets")
        .select("id", { count: "exact", head: true })
        .eq("position_id", positionId)
        .not("first_sell_at", "is", null)
        .then((result) => ({ data: result.count, error: result.error })),
    );
    return {
      soldFraction: followerSoldFraction(agg),
      distinctSellerCount: Number(count ?? 0),
      firstSellByWallet,
    };
  }

  /** Called after the bot sells its whole bag on this position. Stops watching all followers. */
  async releasePosition(positionId: string) {
    const ctx = this.active.get(positionId);
    const rows = await retryDb<Array<{ wallet: string }> | null>("load followers for release", () =>
      db.from("follower_wallets").select("wallet").eq("position_id", positionId),
    );
    for (const r of rows ?? []) {
      const count = await retryDb<number | null>("count shared follower watches", () =>
        db
          .from("follower_wallets")
          .select("id", { count: "exact", head: true })
          .eq("wallet", r.wallet)
          .neq("position_id", positionId)
          .then((result) => ({ data: result.count, error: result.error })),
      );
      if (!count) {
        await this.feed.unwatch(r.wallet);
        this.poller?.unwatch(r.wallet);
      }
    }
    await retryDb("delete released followers", () =>
      db.from("follower_wallets").delete().eq("position_id", positionId),
    );
    this.active.delete(positionId);
    if (ctx) this.byMint.delete(ctx.tokenMint);
    log.info({ positionId }, "follower monitoring released");
  }
}
