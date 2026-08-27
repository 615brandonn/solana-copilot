import { createHash } from "node:crypto";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { pumpFunBondingCurveAddress } from "./pump-fun-supply.js";
import { FRESH_TAIL_PARSER_ABIS } from "./fresh-tail-parser-abis.js";

/** Bumped only after the pure finalized fresh event decoder is re-reviewed. */
export const FRESH_TAIL_ROOT_BUY_PARSER_ABI = FRESH_TAIL_PARSER_ABIS.pump_root_buy_v1;

export type VerifiedFreshRootBuyEvidence = {
  parserAbiFingerprint: string;
  evidenceFingerprint: string;
  transactionFingerprint: string;
  txSig: string;
  slot: number;
  blockTimeMs: number;
  rootWallet: string;
  mint: string;
  bondingCurve: string;
  grossAmountRaw: string;
  successful: true;
  finalized: true;
  pumpFunVerified: true;
};

export type VerifiedFreshRootBuyEvidenceInput = Omit<
  VerifiedFreshRootBuyEvidence,
  "parserAbiFingerprint" | "evidenceFingerprint" | "transactionFingerprint"
>;

function publicKeyText(value: unknown): string {
  try {
    return new PublicKey(
      typeof value === "string"
        ? value
        : ((value as { toBase58?: () => string } | null)?.toBase58?.() ?? String(value ?? "")),
    ).toBase58();
  } catch {
    return String(value ?? "");
  }
}

function instructionIdentity(instruction: any, accountKeys: string[]) {
  const programId = instruction?.programId
    ? publicKeyText(instruction.programId)
    : Number.isSafeInteger(instruction?.programIdIndex)
      ? (accountKeys[instruction.programIdIndex] ?? "")
      : "";
  const accounts = Array.isArray(instruction?.accounts)
    ? instruction.accounts.map((account: unknown) =>
        Number.isSafeInteger(account)
          ? (accountKeys[Number(account)] ?? "")
          : publicKeyText(account),
      )
    : [];
  return {
    programId,
    accounts,
    data: typeof instruction?.data === "string" ? instruction.data : null,
    parsed: instruction?.parsed ?? null,
  };
}

function tokenBalanceIdentity(row: any) {
  return {
    accountIndex: Number(row?.accountIndex),
    mint: String(row?.mint ?? ""),
    owner: String(row?.owner ?? ""),
    programId: String(row?.programId ?? ""),
    amount: String(row?.uiTokenAmount?.amount ?? ""),
    decimals: Number(row?.uiTokenAmount?.decimals),
  };
}

function stableJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : String(item);
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Uint8Array) return Buffer.from(item).toString("base64");
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item === "object") {
      const keyText = (item as { toBase58?: () => string }).toBase58?.();
      if (typeof keyText === "string") return keyText;
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, visit(nested)]),
      );
    }
    return String(item ?? "");
  };
  return JSON.stringify(visit(value));
}

/**
 * Canonical transaction identity only. It deliberately does not decide that a
 * transaction is a buy; the reviewed fresh event decoder owns that decision
 * once and attaches its ABI fingerprint to the evidence.
 */
export function fingerprintFreshFinalizedParsedTransaction(tx: ParsedTransactionWithMeta): string {
  const message: any = tx.transaction.message;
  const accountKeys = (message?.accountKeys ?? []).map((entry: any) =>
    publicKeyText(entry?.pubkey ?? entry),
  );
  const meta: any = tx.meta;
  const identity = {
    signature: String(tx.transaction.signatures[0] ?? ""),
    slot: Number(tx.slot),
    blockTime: Number(tx.blockTime),
    accountKeys: (message?.accountKeys ?? []).map((entry: any, index: number) => ({
      pubkey: accountKeys[index] ?? "",
      signer: Boolean(entry?.signer),
      writable: Boolean(entry?.writable),
    })),
    instructions: (message?.instructions ?? []).map((instruction: any) =>
      instructionIdentity(instruction, accountKeys),
    ),
    innerInstructions: (meta?.innerInstructions ?? []).map((group: any) => ({
      index: Number(group?.index),
      instructions: (group?.instructions ?? []).map((instruction: any) =>
        instructionIdentity(instruction, accountKeys),
      ),
    })),
    err: meta?.err ?? null,
    fee: String(meta?.fee ?? ""),
    preBalances: (meta?.preBalances ?? []).map(String),
    postBalances: (meta?.postBalances ?? []).map(String),
    preTokenBalances: (meta?.preTokenBalances ?? []).map(tokenBalanceIdentity),
    postTokenBalances: (meta?.postTokenBalances ?? []).map(tokenBalanceIdentity),
    logMessages: meta?.logMessages ?? [],
  };
  return createHash("sha256").update(stableJson(identity)).digest("hex");
}

function stableEvidenceFields(
  input: VerifiedFreshRootBuyEvidenceInput & { transactionFingerprint: string },
) {
  return {
    parserAbiFingerprint: FRESH_TAIL_ROOT_BUY_PARSER_ABI,
    transactionFingerprint: input.transactionFingerprint,
    txSig: input.txSig,
    slot: input.slot,
    blockTimeMs: input.blockTimeMs,
    rootWallet: input.rootWallet,
    mint: input.mint,
    bondingCurve: input.bondingCurve,
    grossAmountRaw: input.grossAmountRaw,
    successful: input.successful,
    finalized: input.finalized,
    pumpFunVerified: input.pumpFunVerified,
  } as const;
}

/** Called only after the fresh decoder has independently verified the buy. */
export function buildVerifiedFreshRootBuyEvidence(
  tx: ParsedTransactionWithMeta,
  input: VerifiedFreshRootBuyEvidenceInput,
): VerifiedFreshRootBuyEvidence {
  const transactionFingerprint = fingerprintFreshFinalizedParsedTransaction(tx);
  const stable = stableEvidenceFields({ ...input, transactionFingerprint });
  return {
    ...stable,
    evidenceFingerprint: createHash("sha256").update(stableJson(stable)).digest("hex"),
  };
}

export function verifyFreshRootBuyEvidenceIdentity(
  tx: ParsedTransactionWithMeta,
  evidence: VerifiedFreshRootBuyEvidence,
): string | null {
  if (evidence.parserAbiFingerprint !== FRESH_TAIL_ROOT_BUY_PARSER_ABI) {
    return "fresh root-buy parser ABI fingerprint does not match";
  }
  const transactionFingerprint = fingerprintFreshFinalizedParsedTransaction(tx);
  if (evidence.transactionFingerprint !== transactionFingerprint) {
    return "fresh root-buy transaction fingerprint does not match";
  }
  const stable = stableEvidenceFields({ ...evidence, transactionFingerprint });
  const evidenceFingerprint = createHash("sha256").update(stableJson(stable)).digest("hex");
  if (evidence.evidenceFingerprint !== evidenceFingerprint) {
    return "fresh root-buy evidence fingerprint does not match";
  }
  if (
    evidence.successful !== true ||
    evidence.finalized !== true ||
    evidence.pumpFunVerified !== true
  ) {
    return "fresh root-buy evidence is not finalized, successful, and Pump verified";
  }
  let root: PublicKey;
  let mint: PublicKey;
  try {
    root = new PublicKey(evidence.rootWallet);
    mint = new PublicKey(evidence.mint);
  } catch {
    return "fresh root-buy root or mint is invalid";
  }
  if (evidence.bondingCurve !== pumpFunBondingCurveAddress(mint).toBase58()) {
    return "fresh root-buy curve identity does not match its mint";
  }
  if (!/^[1-9][0-9]*$/.test(evidence.grossAmountRaw)) {
    return "fresh root-buy gross raw amount is not positive and exact";
  }
  const signature = String(tx.transaction.signatures[0] ?? "");
  const slot = Number(tx.slot);
  const blockTimeMs = Number(tx.blockTime) * 1_000;
  if (
    signature !== evidence.txSig ||
    slot !== evidence.slot ||
    !Number.isSafeInteger(blockTimeMs) ||
    blockTimeMs !== evidence.blockTimeMs ||
    tx.meta?.err !== null
  ) {
    return "fresh root-buy evidence does not match finalized transaction identity";
  }
  const accountEntries: any[] = (tx.transaction.message as any)?.accountKeys ?? [];
  const rootEntry = accountEntries.find(
    (entry) => publicKeyText(entry?.pubkey ?? entry) === root.toBase58(),
  );
  if (!rootEntry || rootEntry.signer !== true) {
    return "fresh root-buy root wallet is not a transaction signer";
  }
  if (!accountEntries.some((entry) => publicKeyText(entry?.pubkey ?? entry) === mint.toBase58())) {
    return "fresh root-buy mint is absent from the transaction accounts";
  }
  return null;
}
