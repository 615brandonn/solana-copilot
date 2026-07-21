// Follower monitor: after a successful copy buy, watch the target wallet for
// outbound token transfers of the SAME mint. Each recipient becomes a
// "follower" whose exits we mirror proportionally. When the bot is flat on
// that token, unsubscribe everyone.

import pino from "pino";
import { db } from "./db.js";
import type { GeyserFeed, SwapEvent } from "./geyser.js";
import { env } from "./env.js";

const log = pino({ level: env.LOG_LEVEL });

export class FollowerMonitor {
  constructor(private feed: GeyserFeed) {}

  async onCopyBuy(positionId: string, tokenMint: string, targetWallet: string) {
    // The feed already receives the target wallet's transfers because we watch
    // it globally. In parallel we listen for SPL transfers *from* target *of*
    // this mint. When we see one, we register the recipient.
    log.info({ positionId, tokenMint, targetWallet }, "follower monitor armed");
  }

  async recordTransfer(positionId: string, recipient: string, amount: number) {
    await db.from("follower_wallets").upsert(
      { position_id: positionId, wallet: recipient, initial_amount: amount, current_amount: amount, last_updated: new Date().toISOString() },
      { onConflict: "position_id,wallet" }
    );
    await this.feed.watch(recipient);
    log.info({ positionId, recipient, amount }, "follower added");
  }

  // Called on every observed follower swap. Returns the aggregate sold fraction
  // across all followers of this position since we started monitoring, used to
  // mirror sells proportionally.
  async onFollowerSwap(event: SwapEvent, positionId: string): Promise<{ soldFraction: number } | null> {
    if (event.side !== "sell") return null;
    // Update current_amount for this follower
    const { data: row } = await db
      .from("follower_wallets")
      .select("initial_amount,current_amount")
      .eq("position_id", positionId)
      .eq("wallet", event.wallet)
      .maybeSingle();
    if (!row) return null;
    const newAmount = Math.max(0, row.current_amount - event.amountTokens);
    await db.from("follower_wallets").update({ current_amount: newAmount, last_updated: new Date().toISOString() })
      .eq("position_id", positionId).eq("wallet", event.wallet);

    // Aggregate sold fraction across all followers
    const { data: agg } = await db.from("follower_wallets")
      .select("initial_amount,current_amount").eq("position_id", positionId);
    if (!agg?.length) return null;
    const init = agg.reduce((s, r) => s + Number(r.initial_amount), 0);
    const cur = agg.reduce((s, r) => s + Number(r.current_amount), 0);
    const soldFraction = init === 0 ? 0 : 1 - cur / init;
    return { soldFraction };
  }

  async releaseAllForPosition(positionId: string) {
    const { data: rows } = await db.from("follower_wallets").select("wallet").eq("position_id", positionId);
    for (const r of rows ?? []) await this.feed.unwatch(r.wallet);
    await db.from("follower_wallets").delete().eq("position_id", positionId);
    log.info({ positionId }, "follower monitoring released");
  }
}
