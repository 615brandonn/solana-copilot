// Follower monitor. When the bot lands a copy buy, we start listening for the
// target wallet's outbound SPL transfers of that same mint. Every recipient
// becomes a "follower" of the position. As followers sell their bag, we
// aggregate the sold fraction and the executor mirrors it on our position.
// Once the bot's position is flat, all follower wallets are released.

import pino from "pino";
import { db } from "./db.js";
import type { GeyserFeed } from "./geyser.js";
import { env } from "./env.js";

const log = pino({ level: env.LOG_LEVEL });

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

  constructor(private feed: GeyserFeed) {}

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
  async recordTransfer(positionId: string, recipient: string, amount: number) {
    const { data: existing } = await db.from("follower_wallets")
      .select("initial_amount,current_amount")
      .eq("position_id", positionId).eq("wallet", recipient).maybeSingle();

    if (existing) {
      await db.from("follower_wallets").update({
        initial_amount: Number(existing.initial_amount) + amount,
        current_amount: Number(existing.current_amount) + amount,
        last_updated: new Date().toISOString(),
      }).eq("position_id", positionId).eq("wallet", recipient);
    } else {
      await db.from("follower_wallets").insert({
        position_id: positionId,
        wallet: recipient,
        initial_amount: amount,
        current_amount: amount,
        last_updated: new Date().toISOString(),
      });
    }
    await this.feed.watch(recipient);
    log.info({ positionId, recipient, amount }, "follower registered / topped up");
  }

  /** Decrement follower's current bag after they sell. Returns the new aggregate sold fraction. */
  async recordFollowerSell(positionId: string, wallet: string, soldAmount: number): Promise<number | null> {
    const { data: row } = await db.from("follower_wallets")
      .select("initial_amount,current_amount")
      .eq("position_id", positionId).eq("wallet", wallet).maybeSingle();
    if (!row) return null;

    const newAmount = Math.max(0, Number(row.current_amount) - soldAmount);
    await db.from("follower_wallets").update({
      current_amount: newAmount,
      last_updated: new Date().toISOString(),
    }).eq("position_id", positionId).eq("wallet", wallet);

    const { data: agg } = await db.from("follower_wallets")
      .select("initial_amount,current_amount").eq("position_id", positionId);
    if (!agg?.length) return null;
    const init = agg.reduce((s, r) => s + Number(r.initial_amount), 0);
    const cur = agg.reduce((s, r) => s + Number(r.current_amount), 0);
    if (init === 0) return 0;
    return 1 - cur / init;
  }

  /** Called after the bot sells its whole bag on this position. Stops watching all followers. */
  async releasePosition(positionId: string) {
    const ctx = this.active.get(positionId);
    const { data: rows } = await db.from("follower_wallets").select("wallet").eq("position_id", positionId);
    for (const r of rows ?? []) await this.feed.unwatch(r.wallet);
    await db.from("follower_wallets").delete().eq("position_id", positionId);
    this.active.delete(positionId);
    if (ctx) this.byMint.delete(ctx.tokenMint);
    log.info({ positionId }, "follower monitoring released");
  }
}
