import type { FeedEvent, SwapEvent, TransferEvent } from "./geyser.js";
import type { UnresolvedOutflowEvent } from "./poller.js";

export const CUSTODY_MAX_HOPS = 8;
export const CUSTODY_MAX_WALLETS_PER_JOURNEY = 250;

export type CustodyWalletType =
  | "unknown"
  | "target"
  | "custody"
  | "exchange"
  | "exchange_candidate"
  | "cold_storage_candidate"
  | "hot_wallet_candidate"
  | "routing_wallet"
  | "dex_pool"
  | "router"
  | "bridge"
  | "vault"
  | "escrow"
  | "program"
  | "burn"
  | "other";

export type CustodyWalletClassification = {
  wallet: string;
  watchable: boolean;
  /** True only when persistence must retry instead of making a durable boundary decision. */
  transientFailure?: boolean;
  inferredType: CustodyWalletType;
  inferredLabel: string | null;
  confidence: number;
  source: "configured_target" | "known_program" | "onchain_account" | "unknown";
  evidence: string;
};

export type CustodyTransferRecipient = CustodyWalletClassification & {
  amountTokens: number;
  amountRaw?: string;
  recipientPreAmount?: number;
  recipientPostAmount?: number;
  recipientPreRaw?: string;
  recipientPostRaw?: string;
};

export type CustodyRecordResult = {
  applied: boolean;
  duplicate: boolean;
  payloadMismatch: boolean;
  reason: string;
  journeyId: string | null;
  eventId: string | null;
  journeyStatus: "active" | "flat" | null;
  appliedAmountTokens: number;
  watchedWallets: string[];
  releasedWallets: string[];
  journeyReleased: boolean;
};

export type ActiveCustodyWatch = {
  journeyId: string;
  wallet: string;
  tokenMint: string;
  anchorSlot?: number;
};

export type CustodyPendingReplayItem = CustodyRecordResult & {
  pendingId: string;
  eventKey: string;
  slot?: number;
  status: "pending" | "applied" | "expired" | "terminal";
};

export type CustodyPendingReplayResult = {
  processedCount: number;
  appliedCount: number;
  pendingCount: number;
  expiredCount: number;
  terminalCount: number;
  results: CustodyPendingReplayItem[];
};

export interface CustodyStore {
  recordTargetBuy(event: SwapEvent): Promise<CustodyRecordResult>;
  recordTransfer(
    event: TransferEvent,
    recipients: CustodyTransferRecipient[],
  ): Promise<CustodyRecordResult>;
  recordVerifiedSell(event: SwapEvent): Promise<CustodyRecordResult>;
  recordUnresolvedOutflow(event: UnresolvedOutflowEvent): Promise<CustodyRecordResult>;
  hasActiveAttribution(wallet: string, tokenMint: string): Promise<boolean>;
  loadActiveWatches(): Promise<ActiveCustodyWatch[]>;
  replayPending(limit?: number): Promise<CustodyPendingReplayResult>;
  /** Creates custody journeys for open positions that have none. Returns the count of journeys created. */
  backfillMissingJourneys(targetWallets: string[]): Promise<number>;
}

export type CustodyObservation = {
  event: FeedEvent;
  targetWallets: ReadonlySet<string>;
};
