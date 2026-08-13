import type { TransferEvent, TransferRecipient } from "./geyser.js";

export type ClassifiedTransferRecipient = TransferRecipient & {
  track: boolean;
  triggerEligible: boolean;
  destinationClass: string;
};

export type AllocatedTransferRecipient = ClassifiedTransferRecipient & {
  movedAmount: number;
};

export type CohortTransferAllocation = {
  recipients: AllocatedTransferRecipient[];
  movedAmount: number;
  trackedAmount: number;
  actionableTrackedAmount: number;
  terminalAmount: number;
  unresolvedAmount: number;
};

/**
 * Returns one deterministic recipient list for both new batched events and
 * legacy single-recipient events. Duplicate owner rows are combined so the
 * same transaction can never credit one wallet twice accidentally.
 */
export function transferRecipients(event: TransferEvent): TransferRecipient[] {
  const source = event.recipients?.length
    ? event.recipients
    : [
        {
          wallet: event.to,
          amountTokens: event.amountTokens,
          recipientPreAmount: event.recipientPreAmount,
        },
      ];
  const byWallet = new Map<string, TransferRecipient>();
  for (const recipient of source) {
    const wallet = String(recipient.wallet ?? "").trim();
    const amountTokens = Math.max(0, Number(recipient.amountTokens) || 0);
    if (!wallet || wallet === event.from || amountTokens <= 1e-12) continue;
    const existing = byWallet.get(wallet);
    if (existing) {
      existing.amountTokens += amountTokens;
      existing.recipientPreAmount = Math.max(
        0,
        Number(existing.recipientPreAmount ?? 0),
        Number(recipient.recipientPreAmount ?? 0),
      );
      if (recipient.recipientPostAmount !== undefined) {
        existing.recipientPostAmount = Math.max(
          Number(existing.recipientPostAmount ?? 0),
          Number(recipient.recipientPostAmount),
        );
      }
      if (existing.amountRaw !== undefined && recipient.amountRaw !== undefined) {
        try {
          existing.amountRaw = (
            BigInt(existing.amountRaw) + BigInt(recipient.amountRaw)
          ).toString();
        } catch {
          existing.amountRaw = undefined;
        }
      } else {
        delete existing.amountRaw;
      }
      // Multiple token accounts owned by the same wallet are aggregated by
      // the decoders. Preserve exact owner-level raw balances only when every
      // contributing row provides exact evidence.
      if (
        existing.recipientPreRaw !== undefined &&
        existing.recipientPostRaw !== undefined &&
        recipient.recipientPreRaw !== undefined &&
        recipient.recipientPostRaw !== undefined
      ) {
        try {
          existing.recipientPreRaw = (
            BigInt(existing.recipientPreRaw) + BigInt(recipient.recipientPreRaw)
          ).toString();
          existing.recipientPostRaw = (
            BigInt(existing.recipientPostRaw) + BigInt(recipient.recipientPostRaw)
          ).toString();
        } catch {
          delete existing.recipientPreRaw;
          delete existing.recipientPostRaw;
        }
      } else {
        delete existing.recipientPreRaw;
        delete existing.recipientPostRaw;
      }
    } else {
      const normalized: TransferRecipient = {
        wallet,
        amountTokens,
        recipientPreAmount: Math.max(0, Number(recipient.recipientPreAmount ?? 0)),
      };
      if (recipient.amountRaw !== undefined) normalized.amountRaw = recipient.amountRaw;
      if (recipient.recipientPostAmount !== undefined) {
        normalized.recipientPostAmount = Math.max(0, Number(recipient.recipientPostAmount));
      }
      if (recipient.recipientPreRaw !== undefined) {
        normalized.recipientPreRaw = recipient.recipientPreRaw;
      }
      if (recipient.recipientPostRaw !== undefined) {
        normalized.recipientPostRaw = recipient.recipientPostRaw;
      }
      byWallet.set(wallet, normalized);
    }
  }
  return Array.from(byWallet.values()).sort((a, b) => a.wallet.localeCompare(b.wallet));
}

/** Build a legacy-shaped child event for logging and Strategy Lab rows. */
export function transferEventForRecipient(
  event: TransferEvent,
  recipient: TransferRecipient,
  amountTokens = recipient.amountTokens,
): TransferEvent {
  const { recipients: _recipients, ...base } = event;
  return {
    ...base,
    to: recipient.wallet,
    amountTokens,
    recipientPreAmount: recipient.recipientPreAmount,
    recipientPostAmount: recipient.recipientPostAmount,
  };
}

/**
 * Pure mirror of the database batch allocator. When the retained cohort is
 * smaller than the wallet's real transfer, each recipient receives the same
 * proportional share. This keeps total cohort supply conserved and avoids
 * recipient-order inflation.
 */
export function allocateCohortTransfer(
  currentAmount: number,
  recipients: ClassifiedTransferRecipient[],
): CohortTransferAllocation {
  const normalized = recipients
    .filter((recipient) => recipient.wallet && Number(recipient.amountTokens) > 1e-12)
    .map((recipient) => ({
      ...recipient,
      amountTokens: Math.max(0, Number(recipient.amountTokens) || 0),
    }))
    .sort((a, b) => a.wallet.localeCompare(b.wallet));
  const requested = normalized.reduce((sum, recipient) => sum + recipient.amountTokens, 0);
  const available = Math.max(0, Number(currentAmount) || 0);
  const scale = requested > 0 ? Math.min(1, available / requested) : 0;
  let trackedAmount = 0;
  let actionableTrackedAmount = 0;
  let terminalAmount = 0;
  let unresolvedAmount = 0;
  const allocated = normalized.map((recipient) => {
    const movedAmount = recipient.amountTokens * scale;
    if (recipient.track) trackedAmount += movedAmount;
    else terminalAmount += movedAmount;
    if (recipient.track && recipient.triggerEligible) actionableTrackedAmount += movedAmount;
    else unresolvedAmount += movedAmount;
    return { ...recipient, movedAmount };
  });
  return {
    recipients: allocated,
    movedAmount: trackedAmount + terminalAmount,
    trackedAmount,
    actionableTrackedAmount,
    terminalAmount,
    unresolvedAmount,
  };
}
