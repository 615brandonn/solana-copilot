import type { SupabaseClient } from "@supabase/supabase-js";
import { safeDiagnostic } from "./diagnostics.js";
import type { SwapEvent, TransferEvent } from "./geyser.js";
import type { UnresolvedOutflowEvent } from "./poller.js";
import type {
  ActiveCustodyWatch,
  CustodyRecordResult,
  CustodyPendingReplayResult,
  CustodyStore,
  CustodyTransferRecipient,
} from "./custody-types.js";

type RpcResult = { data: unknown; error: { message?: string } | null };

function finite(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`custody persistence returned an invalid ${label}`);
  }
  return parsed;
}

function objectRow(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`custody persistence returned an invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`custody persistence returned an invalid ${label}`);
  }
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`custody persistence returned an invalid ${label}`);
  }
  return Array.from(new Set(value.map((item) => String(item).trim())));
}

function count(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`custody persistence returned an invalid ${label}`);
  }
  return parsed;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`custody persistence returned an invalid ${label}`);
  }
  return value.trim();
}

export function parseCustodyRecordResult(value: unknown): CustodyRecordResult {
  const row = objectRow(value, "record result");
  const applied = boolean(row.applied, "applied flag");
  const duplicate = boolean(row.duplicate, "duplicate flag");
  const payloadMismatch = boolean(row.payloadMismatch, "payload mismatch flag");
  const rawReason = row.reason === null ? null : nullableText(row.reason, "reason");
  const journeyId = nullableText(row.journeyId, "journey id");
  const eventId = nullableText(row.eventId, "event id");
  const journeyStatus = row.journeyStatus;
  if (journeyStatus !== null && journeyStatus !== "active" && journeyStatus !== "flat") {
    throw new Error("custody persistence returned an invalid journey status");
  }
  if (applied && (!journeyId || !eventId)) {
    throw new Error("custody persistence applied an event without durable identifiers");
  }
  return {
    applied,
    duplicate,
    payloadMismatch,
    reason: rawReason ?? (applied ? "applied" : duplicate ? "duplicate" : "unknown"),
    journeyId,
    eventId,
    journeyStatus,
    appliedAmountTokens: finite(row.appliedAmountTokens, "applied token amount"),
    watchedWallets: strings(row.watchedWallets, "watched wallets"),
    releasedWallets: strings(row.releasedWallets, "released wallets"),
    journeyReleased: boolean(row.journeyReleased, "journey released flag"),
  };
}

export function parseCustodyPendingReplayResult(value: unknown): CustodyPendingReplayResult {
  const row = objectRow(value, "pending replay result");
  if (!Array.isArray(row.results)) {
    throw new Error("custody persistence returned invalid pending replay items");
  }
  const results = row.results;
  return {
    processedCount: count(row.processedCount, "processed count"),
    appliedCount: count(row.appliedCount, "applied count"),
    pendingCount: count(row.pendingCount, "pending count"),
    expiredCount: count(row.expiredCount, "expired count"),
    terminalCount: count(row.terminalCount, "terminal count"),
    results: results.flatMap((value) => {
      const item = objectRow(value, "pending replay item");
      const pendingId = nullableText(item.pendingId, "pending id");
      const eventKey = nullableText(item.eventKey, "pending event key");
      const status = ["pending", "applied", "expired", "terminal"].includes(String(item.status))
        ? (item.status as "pending" | "applied" | "expired" | "terminal")
        : null;
      if (!pendingId || !eventKey || !status) {
        throw new Error("custody persistence returned an invalid pending replay item");
      }
      const slot = Number(item.slot);
      if (!Number.isSafeInteger(slot) || slot <= 0) {
        throw new Error("custody persistence returned an invalid pending replay slot");
      }
      return [
        {
          ...parseCustodyRecordResult(item),
          pendingId,
          eventKey,
          status,
          slot,
        },
      ];
    }),
  };
}

type PersistedCustodyEvent = SwapEvent | TransferEvent | UnresolvedOutflowEvent;

function eventAt(event: PersistedCustodyEvent): string {
  const timestamp = event.blockTimeMs ?? event.timestampMs;
  return new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
}

function txIdentity(event: PersistedCustodyEvent): string {
  const signature = String(event.txSig ?? "").trim();
  if (!signature) {
    throw new Error("custody observation is missing its transaction signature");
  }
  return signature;
}

function metadata(event: PersistedCustodyEvent): Record<string, unknown> {
  return {
    source: event.source ?? "unknown",
    delivery: event.delivery ?? "live",
    observedAtMs: event.observedAtMs ?? event.timestampMs,
    blockTimeMs: event.blockTimeMs,
    decimals: event.decimals,
  };
}

const RAW_DIGITS = /^[0-9]+$/;

function isRawString(value: unknown): value is string {
  return typeof value === "string" && RAW_DIGITS.test(value.trim());
}
export function createSupabaseCustodyStore(client: SupabaseClient, userId: string): CustodyStore {
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CustodyRecordResult> => {
    const { data, error } = (await client.rpc(name, args)) as RpcResult;
    if (error) throw new Error(`${name} failed: ${safeDiagnostic(error)}`);
    return parseCustodyRecordResult(data);
  };

  return {
    recordTargetBuy(event) {
      const custodyAmountTokens = event.grossAmountTokens ?? event.amountTokens;
      const custodyAmountRaw = event.grossAmountRaw ?? event.amountRaw;
      return call("record_custody_target_buy", {
        p_user_id: userId,
        p_target_wallet: event.wallet,
        p_token_mint: event.tokenMint,
        p_event_key: `custody:buy:${txIdentity(event)}:${event.wallet}:${event.tokenMint}`,
        p_tx_sig: txIdentity(event),
        p_slot: event.slot,
        p_event_at: eventAt(event),
        p_amount_tokens: custodyAmountTokens,
        p_metadata: {
          ...metadata(event),
          amountRaw: custodyAmountRaw,
          legacyNetAmountTokens: event.amountTokens,
          legacyNetAmountRaw: event.amountRaw,
          grossAmountTokens: event.grossAmountTokens,
          grossAmountRaw: event.grossAmountRaw,
          tokenBalanceBefore: event.tokenBalanceBefore,
          tokenBalanceAfter: event.tokenBalanceAfter,
          tokenBalanceBeforeRaw: event.tokenBalanceBeforeRaw,
          tokenBalanceAfterRaw: event.tokenBalanceAfterRaw,
          amountUsd: event.amountUsd,
          verifiedSwap: event.verifiedSwap === true,
          sameTransactionRecipients:
            event.custodyForwardRecipients ?? event.inferredRecipients ?? [],
        },
      });
    },

    recordTransfer(event, recipients) {
      // The database treats raw balance evidence as all-or-nothing across the
      // entire payload (sender, chain, and every recipient). The feed can only
      // supply chain raws when the retained balance is exact, so a partial set
      // is possible here — and sending one makes record_custody_transfer raise
      // 'same-transaction acquisition raw evidence is incomplete' on every
      // retry, wedging the cursor. If the set is incomplete, drop ALL raw
      // fields and let the event validate through the decimal path instead.
      const rawEvidenceComplete =
        isRawString(event.senderPreRaw) &&
        isRawString(event.senderPostRaw) &&
        (event.sameTransactionAcquisition !== true ||
          (isRawString(event.chainSenderPreRaw) && isRawString(event.chainSenderPostRaw))) &&
        recipients.every(
          (recipient) =>
            isRawString(recipient.amountRaw) &&
            isRawString(recipient.recipientPreRaw) &&
            isRawString(recipient.recipientPostRaw),
        );
      return call("record_custody_transfer", {
        p_user_id: userId,
        p_token_mint: event.tokenMint,
        p_event_key: `custody:transfer:${txIdentity(event)}:${event.from}:${event.tokenMint}`,
        p_tx_sig: txIdentity(event),
        p_slot: event.slot,
        p_event_at: eventAt(event),
        p_source_wallet: event.from,
        p_recipients: recipients.map((recipient) => ({
          wallet: recipient.wallet,
          amountTokens: recipient.amountTokens,
          amountRaw: rawEvidenceComplete ? recipient.amountRaw : null,
          recipientPreAmount: recipient.recipientPreAmount ?? null,
          recipientPostAmount: recipient.recipientPostAmount ?? null,
          recipientPreRaw: rawEvidenceComplete ? (recipient.recipientPreRaw ?? null) : null,
          recipientPostRaw: rawEvidenceComplete ? (recipient.recipientPostRaw ?? null) : null,
          watchable: recipient.watchable,
          inferredType: recipient.inferredType,
          inferredLabel: recipient.inferredLabel,
          inferenceConfidence: recipient.confidence,
          inferenceSource: recipient.source,
          evidence: recipient.evidence,
        })),
        p_metadata: {
          ...metadata(event),
          senderPreAmount: event.senderPreAmount,
          senderPostAmount: event.senderPostAmount,
          senderPreRaw: rawEvidenceComplete ? event.senderPreRaw : undefined,
          senderPostRaw: rawEvidenceComplete ? event.senderPostRaw : undefined,
          sameTransactionAcquisition: event.sameTransactionAcquisition === true,
          chainSenderPreAmount: event.chainSenderPreAmount,
          chainSenderPostAmount: event.chainSenderPostAmount,
          chainSenderPreRaw: rawEvidenceComplete ? event.chainSenderPreRaw : undefined,
          chainSenderPostRaw: rawEvidenceComplete ? event.chainSenderPostRaw : undefined,
        },
      });
    },

    recordVerifiedSell(event) {
      return call("record_verified_custody_sell", {
        p_user_id: userId,
        p_token_mint: event.tokenMint,
        p_event_key: `custody:sell:${txIdentity(event)}:${event.wallet}:${event.tokenMint}`,
        p_tx_sig: txIdentity(event),
        p_slot: event.slot,
        p_event_at: eventAt(event),
        p_seller_wallet: event.wallet,
        p_sold_amount_tokens: event.amountTokens,
        p_metadata: {
          ...metadata(event),
          verifiedSwap: event.verifiedSwap === true,
          sellAttributionVerified: event.sellAttribution?.verified === true,
          amountRaw: event.amountRaw,
          soldFraction: event.sellAttribution?.soldFraction,
          tokenBalanceBefore: event.sellAttribution?.tokenBalanceBefore,
          tokenBalanceAfter: event.sellAttribution?.tokenBalanceAfter,
          tokenBalanceBeforeRaw: event.sellAttribution?.tokenBalanceBeforeRaw,
          tokenBalanceAfterRaw: event.sellAttribution?.tokenBalanceAfterRaw,
          soldAmountRaw: event.sellAttribution?.soldAmountRaw,
          proceedsMint: event.sellAttribution?.proceedsMint,
          proceedsAmount: event.sellAttribution?.proceedsAmount,
          proceedsAmountRaw: event.sellAttribution?.proceedsAmountRaw,
          proceedsDecimals: event.sellAttribution?.proceedsDecimals,
        },
      });
    },

    recordUnresolvedOutflow(event) {
      return call("record_custody_unresolved_outflow", {
        p_user_id: userId,
        p_token_mint: event.tokenMint,
        p_event_key: `custody:unresolved:${txIdentity(event)}:${event.wallet}:${event.tokenMint}`,
        p_tx_sig: txIdentity(event),
        p_slot: event.slot,
        p_event_at: eventAt(event),
        p_wallet: event.wallet,
        p_pre_amount_tokens: event.preAmount,
        p_post_amount_tokens: event.postAmount,
        p_metadata: {
          ...metadata(event),
          reason: event.reason,
          amountTokens: event.amountTokens,
          amountRaw: event.amountRaw,
          preRaw: event.preRaw,
          postRaw: event.postRaw,
        },
      });
    },

    async hasActiveAttribution(wallet, tokenMint): Promise<boolean> {
      const normalizedWallet = wallet.trim();
      const normalizedMint = tokenMint.trim();
      if (!normalizedWallet || !normalizedMint) return false;
      const { data, error } = await client
        .from("custody_journey_wallets")
        .select("journey_id")
        .eq("user_id", userId)
        .eq("wallet", normalizedWallet)
        .eq("token_mint", normalizedMint)
        .eq("watch_status", "active")
        .gt("current_attributed_tokens", 0)
        .limit(1);
      if (error) {
        throw new Error(`custody attribution scope check failed: ${safeDiagnostic(error)}`);
      }
      if (!Array.isArray(data)) {
        throw new Error("custody attribution scope check failed: invalid database response");
      }
      return data.length > 0;
    },

    async loadActiveWatches(): Promise<ActiveCustodyWatch[]> {
      const pageSize = 1_000;
      const maxRows = 100_000;
      const rows: Array<Record<string, unknown>> = [];
      for (let offset = 0; offset < maxRows; offset += pageSize) {
        const { data, error } = await client
          .from("custody_journey_wallets")
          .select(
            "journey_id,wallet,token_mint,watch_anchor_slot,last_slot,current_attributed_tokens",
          )
          .eq("user_id", userId)
          .eq("watch_status", "active")
          .gt("current_attributed_tokens", 0)
          .order("journey_id", { ascending: true })
          .order("wallet", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) throw new Error(`custody watch load failed: ${safeDiagnostic(error)}`);
        if (!Array.isArray(data)) {
          throw new Error("custody watch load failed: invalid database response");
        }
        rows.push(...data);
        if (data.length < pageSize) break;
        if (offset + pageSize >= maxRows) {
          throw new Error("custody watch load failed: active watch safety limit exceeded");
        }
      }
      return rows.flatMap((row) => {
        const journeyId = typeof row.journey_id === "string" ? row.journey_id : "";
        const wallet = typeof row.wallet === "string" ? row.wallet : "";
        const tokenMint = typeof row.token_mint === "string" ? row.token_mint : "";
        const slot = Number(row.watch_anchor_slot ?? row.last_slot ?? 0);
        return journeyId && wallet && tokenMint
          ? [
              {
                journeyId,
                wallet,
                tokenMint,
                anchorSlot: Number.isSafeInteger(slot) && slot > 0 ? slot : undefined,
              },
            ]
          : [];
      });
    },

    async replayPending(limit = 100): Promise<CustodyPendingReplayResult> {
      const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const { data, error } = (await client.rpc("replay_custody_pending_events", {
        p_user_id: userId,
        p_limit: boundedLimit,
      })) as RpcResult;
      if (error) {
        throw new Error(`custody pending replay failed: ${safeDiagnostic(error)}`);
      }
      return parseCustodyPendingReplayResult(data);
    },
  };
}
