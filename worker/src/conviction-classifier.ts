import type { SwapEvent, TransferEvent } from "./geyser.js";
import { transferRecipients } from "./transfer-batch.js";

export type ConvictionEventClassification =
  | "DEX_BUY"
  | "DEX_SELL"
  | "INTERNAL_CLUSTER_TRANSFER"
  | "EXTERNAL_TRANSFER_IN"
  | "EXTERNAL_TRANSFER_OUT"
  | "UNKNOWN";

export type ClassifiedConvictionTransfer = {
  classification: ConvictionEventClassification;
  reliable: boolean;
  fromWallet: string;
  toWallet: string;
  amountTokens: number;
  recipientPreAmount?: number;
};

export function classifyConvictionSwap(
  event: SwapEvent,
  clusterWallets: ReadonlySet<string>,
): { classification: ConvictionEventClassification; reliable: boolean } {
  if (!clusterWallets.has(event.wallet)) return { classification: "UNKNOWN", reliable: false };
  if (event.side === "buy") {
    return {
      classification: event.verifiedSwap ? "DEX_BUY" : "UNKNOWN",
      reliable: Boolean(event.verifiedSwap && event.amountUsd !== undefined),
    };
  }
  if (event.side === "sell") {
    return {
      classification:
        event.verifiedSwap && event.sellAttribution?.verified ? "DEX_SELL" : "UNKNOWN",
      reliable: Boolean(event.verifiedSwap && event.sellAttribution?.verified),
    };
  }
  return { classification: "UNKNOWN", reliable: false };
}

/**
 * Classifies each destination independently. Transfers within the configured
 * cluster are recorded for lineage but carry no new-capital meaning.
 */
export function classifyConvictionTransfers(
  event: TransferEvent,
  clusterWallets: ReadonlySet<string>,
): ClassifiedConvictionTransfer[] {
  const fromCluster = clusterWallets.has(event.from);
  return transferRecipients(event).map((recipient) => {
    const toCluster = clusterWallets.has(recipient.wallet);
    let classification: ConvictionEventClassification = "UNKNOWN";
    if (fromCluster && toCluster) classification = "INTERNAL_CLUSTER_TRANSFER";
    else if (fromCluster) classification = "EXTERNAL_TRANSFER_OUT";
    else if (toCluster) classification = "EXTERNAL_TRANSFER_IN";
    return {
      classification,
      // Balance-delta transfer attribution can establish movement. It cannot
      // establish that an external movement was an investment or a sale.
      reliable: classification !== "UNKNOWN",
      fromWallet: event.from,
      toWallet: recipient.wallet,
      amountTokens: recipient.amountTokens,
      recipientPreAmount: recipient.recipientPreAmount,
    };
  });
}
