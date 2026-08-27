import { createHash } from "node:crypto";
import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  decodeFreshTailFinalizedTransaction,
  discoverFreshTailRootPumpBuys,
  finalizeFreshTailCustodyEvent,
  type FreshTailDecodeSuccess,
  type FreshTailMintContract,
  type FreshTailPumpTradeEventEvidence,
  type FreshTailSupplyEvent,
} from "./fresh-tail-event-decoder.js";
import {
  resolveFreshTailExactFinalizedBlock,
  sampleFreshTailFinalizedHead,
  type FreshTailFinalizedHead,
} from "./fresh-tail-finalized-head.js";
import {
  freshTailBoundaryForCursor,
  freshTailCandidateIsActionable,
  processFreshTailLane,
  type FreshTailLaneCursor,
} from "./fresh-tail-lane-runtime.js";
import { FRESH_TAIL_ROOT_BUY_PARSER_ABI } from "./fresh-tail-root-buy-evidence.js";
import { classifyFreshTailRecipients } from "./fresh-tail-recipient-classifier.js";
import {
  scanFreshTailFinalizedSignatures,
  type FreshTailSignatureScanResult,
} from "./fresh-tail-signature-scan.js";
import {
  loadFreshTailFinalizedTransactions,
  type FreshTailParsedTransaction,
} from "./fresh-tail-transaction-loader.js";
import type {
  FreshTailActiveEpoch,
  FreshTailBackscanRange,
  FreshTailLease,
  FreshTailMutationResult,
  FreshTailRetirementCandidate,
  FreshTailStore,
  FreshTailWork,
  FreshTailWorkCursor,
  FreshTailWorkMint,
  FreshTailWorkRequest,
} from "./fresh-tail-store.js";
import {
  attestFreshPumpFunCreate,
  PUMP_FUN_CREATE_PROOF_ABI,
  type PumpFunCreateProofFailureCode,
} from "./pump-fun-create-proof.js";
import { loadPumpFunSupplySnapshot, type PumpFunSupplySnapshot } from "./pump-fun-supply.js";

const DEFAULT_CYCLE_BUDGET_MS = 45_000;
const DEFAULT_LEASE_SECONDS = 75;
const DEFAULT_RPC_TIMEOUT_MS = 4_000;
const REQUEST_RESERVE_MS = 4_000;
const PRICE_MAX_AGE_MS = 5_000;
const MAX_FIXED_POINT_STEPS = 512;
const MAX_RETIREMENTS_PER_CYCLE = 25;
const LAUNCH_CAMPAIGN_RETENTION_SECONDS = 60 * 60;

export type FreshTailObserverConfig = {
  observerEnabled: boolean;
  entriesEnabled: boolean;
  shadow: boolean;
  rootWallets: readonly [string, string, string];
  windowSeconds: number;
};

export type FreshTailSolPriceQuote = {
  usd: number;
  observedAtMs: number;
};

export type FreshTailObserverCycleResult = {
  status: "idle" | "lease_busy" | "observed";
  epochId: string | null;
  leaseGeneration: number | null;
  finalizedHeadSlot: number | null;
  requestsSettled: number;
};

export type FreshTailObserverOptions = {
  rpc: Connection;
  store: FreshTailStore;
  workerId: string;
  getSolPriceUsd: (deadlineMs: number) => Promise<FreshTailSolPriceQuote>;
  nowMs?: () => number;
  cycleBudgetMs?: number;
  leaseSeconds?: number;
  rpcCallTimeoutMs?: number;
  pageSize?: number;
  maxPages?: number;
};

type RootScan = {
  root: string;
  cursor: FreshTailWorkCursor;
  scan: Extract<FreshTailSignatureScanResult, { ok: true }>;
  transactions: FreshTailParsedTransaction[];
};

type RootOccurrence = FreshTailParsedTransaction & {
  root: string;
  rootOrdinal: number;
  blockIndex: number;
};

type RequestCandidate = {
  event: FreshTailSupplyEvent;
  contract: FreshTailMintContract;
};

type PersistResult = {
  scopeRevision: number;
  requestCandidates: RequestCandidate[];
  poisoned: boolean;
};

/**
 * Selects only launch watches outside v1's fixed one-hour launch campaign.
 * Retirement is permanent: a later revival is intentionally not eligible for
 * this lane. The database repeats the binding/position/intent/time checks under
 * the mint advisory lock, so this snapshot is only an optimization.
 */
export function selectFreshTailRetirementCandidates(
  work: Pick<FreshTailWork, "mints" | "requests" | "armedBindings">,
  finalizedHeadBlockTimeMs: number,
  limit = MAX_RETIREMENTS_PER_CYCLE,
): FreshTailRetirementCandidate[] {
  if (
    !Number.isSafeInteger(finalizedHeadBlockTimeMs) ||
    finalizedHeadBlockTimeMs <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return [];
  }
  // A malformed binding snapshot must never be interpreted as permission to
  // retire. getWork is a service-only RPC, but fail closed on contract drift.
  if (
    work.armedBindings.some(
      (binding) => typeof binding.tokenMint !== "string" || binding.tokenMint.length === 0,
    )
  ) {
    return [];
  }
  const armed = new Set(work.armedBindings.map((binding) => binding.tokenMint));
  const liveRequestMints = new Set(
    work.requests
      .filter(
        (request) =>
          (request.status === "pending" || request.status === "settled") &&
          parseIsoMs(request.expiresAt) > finalizedHeadBlockTimeMs,
      )
      .map((request) => request.tokenMint),
  );
  const dormantBeforeMs = finalizedHeadBlockTimeMs - LAUNCH_CAMPAIGN_RETENTION_SECONDS * 1_000;
  return work.mints
    .filter((mint) => {
      if (mint.status !== "active" || armed.has(mint.tokenMint)) return false;
      if (liveRequestMints.has(mint.tokenMint)) return false;
      if (mint.poisoned) return true;
      const lastEventMs = parseIsoMs(mint.lastSupplyEventBlockTime);
      return lastEventMs > 0 && lastEventMs <= dormantBeforeMs;
    })
    .sort((left, right) => {
      const leftTime = parseIsoMs(left.lastSupplyEventBlockTime);
      const rightTime = parseIsoMs(right.lastSupplyEventBlockTime);
      return leftTime - rightTime || left.tokenMint.localeCompare(right.tokenMint);
    })
    .slice(0, limit)
    .map((mint) => ({
      tokenMint: mint.tokenMint,
      scopeRevision: mint.scopeRevision,
      reason: mint.poisoned ? "unsupported_after_enrollment" : "dormant_below_threshold",
    }));
}

export class FreshTailObserverError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "FreshTailObserverError";
  }
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new FreshTailObserverError("invalid_configuration", false, `${name} is invalid`);
  }
  return parsed;
}

function normalizedRoots(values: readonly string[]): [string, string, string] {
  const roots = values.map((value) => {
    try {
      return new PublicKey(value).toBase58();
    } catch {
      throw new FreshTailObserverError(
        "invalid_configuration",
        false,
        "fresh-tail requires three valid root wallets",
      );
    }
  });
  roots.sort();
  if (roots.length !== 3 || new Set(roots).size !== 3) {
    throw new FreshTailObserverError(
      "invalid_configuration",
      false,
      "fresh-tail requires exactly three unique root wallets",
    );
  }
  return roots as [string, string, string];
}

function sameRoots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function contractFromMint(mint: FreshTailWorkMint): FreshTailMintContract {
  return {
    mint: mint.tokenMint,
    bondingCurve: mint.bondingCurve,
    creator: mint.creator,
    createVariant: mint.createVariant,
    tokenProgram: mint.tokenProgram,
    totalSupplyRaw: mint.totalSupplyRaw,
    decimals: mint.decimals,
  };
}

function resultNumber(result: FreshTailMutationResult, field: string): number {
  const value = Number(result[field]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FreshTailObserverError(
      "store_contract_invalid",
      false,
      `fresh-tail store result omitted ${field}`,
    );
  }
  return value;
}

function requireMutation(
  operation: string,
  result: FreshTailMutationResult,
): FreshTailMutationResult {
  if (!result.ok) {
    throw new FreshTailObserverError(
      `${operation}_${result.reason}`,
      true,
      `${operation} failed: ${result.reason}`,
    );
  }
  return result;
}

function durableTerminalConflict(result: FreshTailMutationResult): boolean {
  return (
    result.ok === false &&
    result.reason === "payload_conflict" &&
    result.durableConflict === true &&
    result.terminalPoison === true
  );
}

function requestResultIsCheckpointable(result: FreshTailMutationResult): boolean {
  return new Set([
    "threshold_not_reached",
    "trigger_not_eligible",
    "trigger_expired",
    "same_slot_trigger_ambiguous",
    "fresh_sell_or_poison_seen",
    "live_request_exists",
    "entry_claim_already_bound",
    "strategy_not_enabled",
    "window_identity_mismatch",
    "mint_not_active",
    "enrollment_evidence_missing",
  ]).has(result.reason);
}

function parseIsoMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ensureDeadline(deadlineMs: number, nowMs: () => number, operation: string): void {
  if (deadlineMs - Number(nowMs()) <= 0) {
    throw new FreshTailObserverError(
      "deadline_exceeded",
      true,
      `fresh-tail deadline elapsed before ${operation}`,
    );
  }
}

/** Exact post-trade market cap from the reviewed Pump TradeEvent reserve pair. */
export function freshTailTradeMarketCapUsd(
  evidence: FreshTailPumpTradeEventEvidence,
  totalSupplyRaw: string,
  quote: FreshTailSolPriceQuote,
  nowMs: number,
): number | null {
  if (
    evidence.quoteMint !== "11111111111111111111111111111111" ||
    !/^[1-9][0-9]*$/.test(totalSupplyRaw) ||
    !/^[1-9][0-9]*$/.test(evidence.virtualSolReservesLamports) ||
    !/^[1-9][0-9]*$/.test(evidence.virtualTokenReservesRaw) ||
    !Number.isFinite(quote.usd) ||
    quote.usd <= 0 ||
    quote.usd > 100_000 ||
    !Number.isSafeInteger(quote.observedAtMs) ||
    quote.observedAtMs > nowMs + 1_000 ||
    nowMs - quote.observedAtMs > PRICE_MAX_AGE_MS
  ) {
    return null;
  }
  const supply = BigInt(totalSupplyRaw);
  const virtualSol = BigInt(evidence.virtualSolReservesLamports);
  const virtualToken = BigInt(evidence.virtualTokenReservesRaw);
  const capSol = (Number(supply) * Number(virtualSol)) / Number(virtualToken) / 1e9;
  const capUsd = capSol * quote.usd;
  return Number.isFinite(capUsd) && capUsd > 0 ? capUsd : null;
}

function rejectionCode(code: PumpFunCreateProofFailureCode): string | null {
  if (
    code === "deadline_exceeded" ||
    code === "rpc_error" ||
    code === "activation_block_unavailable" ||
    code === "head_block_unavailable" ||
    code === "creation_block_unavailable" ||
    code === "signature_history_pruned" ||
    code === "signature_page_limit" ||
    code === "transaction_unavailable" ||
    code === "trigger_transaction_unavailable" ||
    code === "curve_state_unavailable"
  ) {
    return null;
  }
  if (code === "curve_completed") return "already_graduated";
  if (code === "create_not_found") return "create_not_found";
  if (code === "pre_activation_activity") return "created_before_epoch";
  if (code === "malformed_create_instruction") return "unsupported_create";
  if (
    code === "activation_block_mismatch" ||
    code === "head_block_mismatch" ||
    code === "transaction_identity_conflict" ||
    code === "trigger_evidence_invalid" ||
    code === "creation_not_before_trigger" ||
    code === "same_slot_order_unproved" ||
    code === "create_conflict" ||
    code === "curve_state_invalid"
  ) {
    return "permanent_state_conflict";
  }
  return "reviewed_abi_mismatch";
}

function rejectionFingerprint(fields: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function requestSort(left: FreshTailWorkRequest, right: FreshTailWorkRequest): number {
  return (
    left.requestedHeadSlot - right.requestedHeadSlot ||
    parseIsoMs(left.triggerBlockTime) - parseIsoMs(right.triggerBlockTime) ||
    left.requestId.localeCompare(right.requestId)
  );
}

function cursorIsPastHead(cursor: FreshTailWorkCursor, headSlot: number): boolean {
  return (
    (cursor.coveredThroughSlot !== null && cursor.coveredThroughSlot > headSlot) ||
    (cursor.lastSlot !== null && cursor.lastSlot > headSlot)
  );
}

/**
 * Returns the only mint/account identities that can make an enrolled decoder
 * produce evidence for this transaction. Malformed account metadata returns
 * null so callers fall back to the exhaustive fail-closed path.
 */
export function freshTailTransactionLookupKeys(
  transaction: ParsedTransactionWithMeta,
): ReadonlySet<string> | null {
  const normalize = (value: unknown): string | null => {
    try {
      return new PublicKey(
        typeof value === "string"
          ? value
          : ((value as { toBase58?: () => string } | null)?.toBase58?.() ?? String(value ?? "")),
      ).toBase58();
    } catch {
      return null;
    }
  };
  const message = transaction.transaction.message as unknown as {
    accountKeys?: unknown[];
    staticAccountKeys?: unknown[];
  };
  const rawAccounts = message.accountKeys ?? message.staticAccountKeys;
  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) return null;
  const keys = new Set<string>();
  for (const entry of rawAccounts) {
    const key = normalize((entry as { pubkey?: unknown } | null)?.pubkey ?? entry);
    if (!key) return null;
    keys.add(key);
  }
  const loaded = (
    transaction.meta as unknown as {
      loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] };
    } | null
  )?.loadedAddresses;
  for (const entry of [...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])]) {
    const key = normalize(entry);
    if (!key) return null;
    keys.add(key);
  }
  for (const row of [
    ...(transaction.meta?.preTokenBalances ?? []),
    ...(transaction.meta?.postTokenBalances ?? []),
  ]) {
    const mint = normalize((row as { mint?: unknown }).mint);
    if (!mint) return null;
    keys.add(mint);
  }
  return keys;
}

export class FreshTailObserver {
  private readonly rpc: Connection;
  private readonly store: FreshTailStore;
  private readonly workerId: string;
  private readonly getSolPriceUsd: FreshTailObserverOptions["getSolPriceUsd"];
  private readonly nowMs: () => number;
  private readonly cycleBudgetMs: number;
  private readonly leaseSeconds: number;
  private readonly rpcCallTimeoutMs: number;
  private readonly pageSize: number | undefined;
  private readonly maxPages: number | undefined;
  private epoch: FreshTailActiveEpoch | null = null;
  private lease: FreshTailLease | null = null;
  private latestAttestedHead: FreshTailFinalizedHead | null = null;

  constructor(options: FreshTailObserverOptions) {
    if (!options.workerId.trim()) {
      throw new FreshTailObserverError("invalid_configuration", false, "worker ID is empty");
    }
    this.rpc = options.rpc;
    this.store = options.store;
    this.workerId = options.workerId;
    this.getSolPriceUsd = options.getSolPriceUsd;
    this.nowMs = options.nowMs ?? Date.now;
    this.cycleBudgetMs = positiveInteger(
      options.cycleBudgetMs ?? DEFAULT_CYCLE_BUDGET_MS,
      "cycle budget",
    );
    this.leaseSeconds = positiveInteger(
      options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      "lease duration",
    );
    this.rpcCallTimeoutMs = positiveInteger(
      options.rpcCallTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
      "RPC timeout",
    );
    this.pageSize = options.pageSize;
    this.maxPages = options.maxPages;
  }

  private assertLease(): void {
    const lease = this.lease;
    const epoch = this.epoch;
    if (!lease || !epoch || lease.epochId !== epoch.epochId) {
      throw new FreshTailObserverError("lease_lost", true, "fresh-tail lease identity is absent");
    }
    const expiresAt = Date.parse(lease.leaseExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Number(this.nowMs())) {
      this.lease = null;
      throw new FreshTailObserverError("lease_lost", true, "fresh-tail lease expired locally");
    }
  }

  private async ensureEpoch(
    config: FreshTailObserverConfig,
    deadlineMs: number,
  ): Promise<FreshTailActiveEpoch | null> {
    const roots = normalizedRoots(config.rootWallets);
    ensureDeadline(deadlineMs, this.nowMs, "active epoch lookup");
    let active = await this.store.loadActiveEpoch();
    if (active) {
      if (!sameRoots(active.rootWallets, roots)) {
        throw new FreshTailObserverError(
          "active_epoch_root_mismatch",
          false,
          "configured roots differ from the durable active fresh-tail epoch",
        );
      }
      this.epoch = active;
      return active;
    }
    this.epoch = null;
    this.lease = null;
    if (!config.observerEnabled) return null;
    if (config.entriesEnabled) {
      throw new FreshTailObserverError(
        "activation_requires_entries_off",
        false,
        "first fresh-tail activation requires global Entries to be OFF",
      );
    }
    const sampled = await sampleFreshTailFinalizedHead(this.rpc, {
      minimumSlot: 1,
      rpcCallTimeoutMs: this.rpcCallTimeoutMs,
      deadlineMs,
      nowMs: this.nowMs,
    });
    if (!sampled.ok) {
      throw new FreshTailObserverError(sampled.code, sampled.retryable, sampled.reason);
    }
    requireMutation("activate", await this.store.activate(roots, sampled.head));
    active = await this.store.loadActiveEpoch();
    if (!active || !sameRoots(active.rootWallets, roots)) {
      throw new FreshTailObserverError(
        "activation_identity_missing",
        false,
        "fresh-tail activation did not round-trip its exact durable epoch identity",
      );
    }
    this.epoch = active;
    return active;
  }

  private async acquireLease(epoch: FreshTailActiveEpoch): Promise<boolean> {
    const expected = this.lease?.epochId === epoch.epochId ? this.lease : null;
    const acquired = await this.store.acquireLease(
      epoch.epochId,
      this.workerId,
      this.leaseSeconds,
      expected,
    );
    if (!acquired) {
      this.lease = null;
      return false;
    }
    this.lease = acquired;
    this.assertLease();
    return true;
  }

  private async attestHead(head: FreshTailFinalizedHead): Promise<void> {
    this.assertLease();
    requireMutation(
      "attest_head",
      await this.store.attestHead(this.epoch!.epochId, this.lease!, head),
    );
    if (!this.latestAttestedHead || head.slot > this.latestAttestedHead.slot) {
      this.latestAttestedHead = head;
    } else if (
      head.slot === this.latestAttestedHead.slot &&
      (head.blockhash !== this.latestAttestedHead.blockhash ||
        head.blockTimeMs !== this.latestAttestedHead.blockTimeMs)
    ) {
      throw new FreshTailObserverError(
        "finalized_head_conflict",
        false,
        "same finalized slot resolved to conflicting block identity",
      );
    }
  }

  private async exactHead(
    slot: number,
    deadlineMs: number,
    expectedBlockTimeMs?: number,
    expectedBlockhash?: string,
  ): Promise<FreshTailFinalizedHead> {
    const resolved = await resolveFreshTailExactFinalizedBlock(this.rpc, {
      slot,
      expectedBlockTimeMs,
      rpcCallTimeoutMs: this.rpcCallTimeoutMs,
      deadlineMs,
      nowMs: this.nowMs,
    });
    if (!resolved.ok) {
      throw new FreshTailObserverError(resolved.code, resolved.retryable, resolved.reason);
    }
    if (expectedBlockhash && resolved.head.blockhash !== expectedBlockhash) {
      throw new FreshTailObserverError(
        "finalized_head_conflict",
        false,
        `finalized slot ${slot} does not match its durable requested blockhash`,
      );
    }
    await this.attestHead(resolved.head);
    return resolved.head;
  }

  private activeContracts(work: FreshTailWork): Map<string, FreshTailMintContract> {
    return new Map(
      work.mints
        .filter((mint) => mint.status === "active" && !mint.poisoned)
        .map((mint) => [mint.tokenMint, contractFromMint(mint)]),
    );
  }

  private scopeRevisions(work: FreshTailWork): Map<string, number> {
    return new Map(
      work.mints
        .filter((mint) => mint.status === "active")
        .map((mint) => [mint.tokenMint, mint.scopeRevision]),
    );
  }

  private async rejectDiscovery(
    mint: string,
    signature: ConfirmedSignatureInfo,
    code: string,
    head: FreshTailFinalizedHead,
    detail: string,
  ): Promise<void> {
    const result = await this.store.rejectMint(this.epoch!.epochId, this.lease!, {
      tokenMint: mint,
      sourceTxSig: signature.signature,
      sourceSlot: signature.slot,
      rejectionCode: code,
      parserAbiFingerprint: FRESH_TAIL_ROOT_BUY_PARSER_ABI,
      proofFingerprint: rejectionFingerprint({
        mint,
        signature: signature.signature,
        slot: signature.slot,
        code,
        detail,
        headSlot: head.slot,
        headBlockhash: head.blockhash,
      }),
      finalizedHead: head,
    });
    requireMutation("reject_mint", result);
  }

  private async enrollDiscovery(
    transaction: ParsedTransactionWithMeta,
    signature: ConfirmedSignatureInfo,
    root: string,
    provisional: FreshTailMintContract,
    decoded: FreshTailDecodeSuccess,
    head: FreshTailFinalizedHead,
    deadlineMs: number,
  ): Promise<FreshTailMintContract | null> {
    const buy = decoded.supplyEvents.find(
      (event) => event.side === "BUY" && event.targetWallet === root,
    );
    if (!buy || !decoded.rootBuyEvidence) {
      await this.rejectDiscovery(
        provisional.mint,
        signature,
        "reviewed_abi_mismatch",
        head,
        "root discovery omitted exact buy evidence",
      );
      return null;
    }
    const proofResult = await attestFreshPumpFunCreate(this.rpc, {
      mint: provisional.mint,
      activation: {
        slot: this.epoch!.activationSlot,
        blockhash: this.epoch!.activationBlockhash,
      },
      requestedHead: { slot: head.slot, blockhash: head.blockhash },
      triggerSlot: signature.slot,
      triggerTxSig: signature.signature,
      triggerBuyEvidence: decoded.rootBuyEvidence,
      rpcCallTimeoutMs: this.rpcCallTimeoutMs,
      deadlineMs,
      nowMs: this.nowMs,
    });
    if (!proofResult.ok) {
      const permanentCode = rejectionCode(proofResult.code);
      if (!permanentCode) {
        throw new FreshTailObserverError(
          `create_proof_${proofResult.code}`,
          proofResult.retryable,
          proofResult.reason,
        );
      }
      await this.rejectDiscovery(
        provisional.mint,
        signature,
        permanentCode,
        head,
        `${proofResult.code}:${proofResult.reason}`,
      );
      return null;
    }
    const proof = proofResult.proof;
    const contract: FreshTailMintContract = {
      mint: proof.mint,
      bondingCurve: proof.bondingCurve,
      creator: proof.creator,
      createVariant: proof.createVariant,
      tokenProgram: proof.tokenProgram,
      totalSupplyRaw: proof.totalSupplyRaw,
      decimals: proof.decimals,
    };
    const rebound = decodeFreshTailFinalizedTransaction(transaction, contract, root, "root");
    if (!rebound.ok || !rebound.rootBuyEvidence || rebound.supplyEvents.length !== 1) {
      await this.rejectDiscovery(
        provisional.mint,
        signature,
        "reviewed_abi_mismatch",
        head,
        rebound.ok ? "proved contract did not reproduce one root buy" : rebound.reason,
      );
      return null;
    }
    const creationHead = await this.exactHead(
      proof.slot,
      deadlineMs,
      proof.blockTimeMs,
      proof.blockhash,
    );
    const enrollmentHead = await this.exactHead(
      signature.slot,
      deadlineMs,
      Number(transaction.blockTime) * 1_000,
    );
    const attestation = await this.store.attestMintCreation(this.epoch!.epochId, this.lease!, {
      enrollmentEventKey: rebound.supplyEvents[0]!.eventKey,
      enrollmentTxSig: signature.signature,
      enrollmentSlot: signature.slot,
      enrollmentBlock: enrollmentHead,
      enrollmentTargetWallet: root,
      proof,
      finalizedHead: head.slot >= enrollmentHead.slot ? head : enrollmentHead,
    });
    // Bounded work snapshots intentionally omit historical tombstones and
    // retired mints. A later root buy for either identity is permanently
    // checkpointable, not a reason to pin the shared root cursor forever.
    if (
      !attestation.ok &&
      (attestation.reason === "mint_tombstoned" || attestation.reason === "mint_retired")
    ) {
      return null;
    }
    const attested = requireMutation("attest_mint_creation", attestation);
    if (String(attested.tokenMint ?? proof.mint) !== proof.mint) {
      throw new FreshTailObserverError(
        "store_contract_invalid",
        false,
        "mint creation attestation returned a different mint identity",
      );
    }
    void creationHead;
    return contract;
  }

  private async valuationFor(
    event: FreshTailSupplyEvent,
    evidence: FreshTailPumpTradeEventEvidence | undefined,
    deadlineMs: number,
  ): Promise<{ marketCapUsd: number | null; reliable: boolean }> {
    let marketCapUsd: number | null = null;
    if (evidence && evidence.mint === event.tokenMint) {
      try {
        const quote = await this.getSolPriceUsd(deadlineMs);
        marketCapUsd = freshTailTradeMarketCapUsd(
          evidence,
          event.totalSupplyRaw,
          quote,
          Number(this.nowMs()),
        );
      } catch {
        marketCapUsd = null;
      }
    }
    if (marketCapUsd !== null) return { marketCapUsd, reliable: true };
    if (
      event.side === "BUY" &&
      freshTailCandidateIsActionable(event.blockTimeMs, Number(this.nowMs()))
    ) {
      throw new FreshTailObserverError(
        "fresh_buy_valuation_unavailable",
        true,
        "an actionable fresh root buy has no strict post-trade SOL/USD valuation",
      );
    }
    return { marketCapUsd: null, reliable: false };
  }

  private async persistDecoded(
    decoded: FreshTailDecodeSuccess,
    contract: FreshTailMintContract,
    roots: ReadonlySet<string>,
    head: FreshTailFinalizedHead,
    deadlineMs: number,
    currentRevision: number,
  ): Promise<PersistResult> {
    const requestCandidates: RequestCandidate[] = [];
    for (const event of decoded.supplyEvents) {
      this.assertLease();
      const valuation = await this.valuationFor(event, decoded.pumpTradeEventEvidence, deadlineMs);
      const result = await this.store.recordSupplyEvent(
        this.epoch!.epochId,
        this.lease!,
        event,
        valuation,
        head,
      );
      if (durableTerminalConflict(result)) {
        return { scopeRevision: currentRevision, requestCandidates: [], poisoned: true };
      }
      requireMutation("record_supply_event", result);
      if (event.side === "BUY" && valuation.reliable) {
        requestCandidates.push({ event, contract });
      }
    }
    for (const draft of decoded.custodyEvents) {
      this.assertLease();
      const classified = await classifyFreshTailRecipients(
        this.rpc,
        draft.recipients,
        roots,
        head.slot,
        deadlineMs,
        this.nowMs,
      );
      if (!classified.ok) {
        throw new FreshTailObserverError(
          "recipient_classification_unavailable",
          classified.retryable,
          classified.reason,
        );
      }
      const event = finalizeFreshTailCustodyEvent(draft, classified.recipients);
      if (!event) {
        throw new FreshTailObserverError(
          "recipient_classification_conflict",
          false,
          "recipient classifications do not bind to the exact custody event",
        );
      }
      const result = await this.store.recordCustodyEvent(
        this.epoch!.epochId,
        this.lease!,
        event,
        head,
      );
      if (durableTerminalConflict(result)) {
        return { scopeRevision: currentRevision, requestCandidates: [], poisoned: true };
      }
      requireMutation("record_custody_event", result);
    }
    const synced = await this.store.syncScope(
      this.epoch!.epochId,
      this.lease!,
      contract.mint,
      currentRevision,
    );
    if (!synced.ok) {
      if (
        synced.reason === "fresh_custody_poison" ||
        synced.reason === "preexisting_legacy_journey" ||
        synced.reason === "mint_not_active"
      ) {
        return { scopeRevision: currentRevision, requestCandidates: [], poisoned: true };
      }
      throw new FreshTailObserverError(
        `sync_scope_${synced.reason}`,
        true,
        `scope sync failed: ${synced.reason}`,
      );
    }
    return {
      scopeRevision: resultNumber(synced, "scopeRevision"),
      requestCandidates,
      poisoned: false,
    };
  }

  private async persistRootTransaction(
    transaction: ParsedTransactionWithMeta,
    signature: ConfirmedSignatureInfo,
    root: string,
    contracts: Map<string, FreshTailMintContract>,
    contractsByCurve: Map<string, FreshTailMintContract>,
    revisions: Map<string, number>,
    rejectedMints: Set<string>,
    poisonedMints: Set<string>,
    roots: ReadonlySet<string>,
    head: FreshTailFinalizedHead,
    deadlineMs: number,
  ): Promise<RequestCandidate[]> {
    const output: RequestCandidate[] = [];
    const discovery = discoverFreshTailRootPumpBuys(transaction, root);
    if (!discovery.ok) {
      throw new FreshTailObserverError(discovery.code, discovery.retryable, discovery.reason);
    }
    for (const candidate of discovery.discoveries) {
      if (
        contracts.has(candidate.tokenMint) ||
        rejectedMints.has(candidate.tokenMint) ||
        poisonedMints.has(candidate.tokenMint)
      ) {
        continue;
      }
      if (!candidate.decoded.ok) {
        await this.rejectDiscovery(
          candidate.tokenMint,
          signature,
          "reviewed_abi_mismatch",
          head,
          candidate.decoded.reason,
        );
        rejectedMints.add(candidate.tokenMint);
        continue;
      }
      const contract = await this.enrollDiscovery(
        transaction,
        signature,
        root,
        candidate.contract,
        candidate.decoded,
        head,
        deadlineMs,
      );
      if (contract) {
        contracts.set(contract.mint, contract);
        contractsByCurve.set(contract.bondingCurve, contract);
        revisions.set(contract.mint, 0);
      } else {
        rejectedMints.add(candidate.tokenMint);
      }
    }

    const lookupKeys = freshTailTransactionLookupKeys(transaction);
    const relevantContracts =
      lookupKeys === null
        ? [...contracts.values()]
        : [...lookupKeys].flatMap((key) => {
            const byMint = contracts.get(key);
            const byCurve = contractsByCurve.get(key);
            return byMint && byCurve && byMint.mint !== byCurve.mint
              ? [byMint, byCurve]
              : [byMint ?? byCurve].filter(
                  (contract): contract is FreshTailMintContract => contract !== undefined,
                );
          });
    const uniqueContracts = new Map(
      relevantContracts.map((contract) => [contract.mint, contract] as const),
    );
    for (const [mint, contract] of [...uniqueContracts.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (poisonedMints.has(mint)) continue;
      const decoded = decodeFreshTailFinalizedTransaction(transaction, contract, root, "root");
      if (!decoded.ok) {
        throw new FreshTailObserverError(
          `decode_${decoded.code}`,
          false,
          `enrolled mint ${mint} failed exact root decoding: ${decoded.reason}`,
        );
      }
      if (decoded.supplyEvents.length === 0 && decoded.custodyEvents.length === 0) continue;
      const persisted = await this.persistDecoded(
        decoded,
        contract,
        roots,
        head,
        deadlineMs,
        revisions.get(mint) ?? 0,
      );
      revisions.set(mint, persisted.scopeRevision);
      if (persisted.poisoned) poisonedMints.add(mint);
      else output.push(...persisted.requestCandidates);
    }
    return output;
  }

  private async requestCandidate(
    candidate: RequestCandidate,
    config: FreshTailObserverConfig,
    deadlineMs: number,
  ): Promise<void> {
    const event = candidate.event;
    if (!freshTailCandidateIsActionable(event.blockTimeMs, Number(this.nowMs()))) return;
    ensureDeadline(deadlineMs, this.nowMs, "fresh request snapshot");
    let snapshot: PumpFunSupplySnapshot | null;
    try {
      snapshot = await loadPumpFunSupplySnapshot(this.rpc, event.tokenMint, {
        commitment: "finalized",
        minContextSlot: event.slot,
        rpcCallTimeoutMs: Math.min(
          this.rpcCallTimeoutMs,
          Math.max(1, deadlineMs - Number(this.nowMs)),
        ),
      });
    } catch (error) {
      throw new FreshTailObserverError(
        "head_snapshot_unavailable",
        true,
        `finalized head snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !snapshot ||
      snapshot.mint !== event.tokenMint ||
      snapshot.complete ||
      snapshot.totalSupplyRaw.toString() !== candidate.contract.totalSupplyRaw ||
      snapshot.decimals !== candidate.contract.decimals ||
      snapshot.createVariant !== candidate.contract.createVariant ||
      snapshot.tokenProgram !== candidate.contract.tokenProgram ||
      typeof snapshot.curveStateFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(snapshot.curveStateFingerprint) ||
      typeof snapshot.mintLayoutFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(snapshot.mintLayoutFingerprint)
    ) {
      throw new FreshTailObserverError(
        "head_snapshot_contract_invalid",
        false,
        "finalized Pump snapshot does not match the enrolled immutable mint contract",
      );
    }
    const snapshotHead = await this.exactHead(snapshot.observedSlot, deadlineMs);
    if (snapshotHead.blockTimeMs < event.blockTimeMs) {
      throw new FreshTailObserverError(
        "head_snapshot_time_invalid",
        false,
        "snapshot-context finalized head predates its trigger transaction",
      );
    }
    const windowMs = positiveInteger(config.windowSeconds, "accumulation window") * 1_000;
    const windowStartedAt = new Date(event.blockTimeMs - windowMs).toISOString();
    const result = await this.store.requestCoverage(this.epoch!.epochId, this.lease!, {
      tokenMint: event.tokenMint,
      windowStartedAt,
      triggerEventKey: event.eventKey,
      triggerTxSig: event.txSig,
      triggerSlot: event.slot,
      targetWallet: event.targetWallet,
      triggerBlockTime: new Date(event.blockTimeMs).toISOString(),
      finalizedHead: snapshotHead,
      snapshot: snapshot as PumpFunSupplySnapshot & {
        curveStateFingerprint: string;
        mintLayoutFingerprint: string;
        tokenProgram: string;
      },
    });
    if (!result.ok && !requestResultIsCheckpointable(result)) {
      throw new FreshTailObserverError(
        `request_coverage_${result.reason}`,
        true,
        `fresh coverage request failed: ${result.reason}`,
      );
    }
  }

  private async canonicalBlockIndexes(
    occurrences: RootOccurrence[],
    deadlineMs: number,
  ): Promise<void> {
    const bySlot = new Map<number, RootOccurrence[]>();
    for (const occurrence of occurrences) {
      const rows = bySlot.get(occurrence.signature.slot) ?? [];
      rows.push(occurrence);
      bySlot.set(occurrence.signature.slot, rows);
    }
    for (const [slot, rows] of bySlot) {
      const signatures = new Set(rows.map((row) => row.signature.signature));
      if (signatures.size <= 1) continue;
      ensureDeadline(deadlineMs, this.nowMs, "same-slot canonical ordering");
      let block: Awaited<ReturnType<Connection["getBlockSignatures"]>>;
      try {
        block = await Promise.race([
          this.rpc.getBlockSignatures(slot, "finalized"),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("block signature RPC timed out")),
              this.rpcCallTimeoutMs,
            ),
          ),
        ]);
      } catch (error) {
        throw new FreshTailObserverError(
          "same_slot_order_unavailable",
          true,
          `cannot resolve canonical transaction order at ${slot}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!block || typeof block.blockhash !== "string" || !Array.isArray(block.signatures)) {
        throw new FreshTailObserverError(
          "same_slot_order_unavailable",
          true,
          `finalized block signatures are unavailable at ${slot}`,
        );
      }
      const indexes = new Map(block.signatures.map((signature, index) => [signature, index]));
      for (const row of rows) {
        const index = indexes.get(row.signature.signature);
        if (index === undefined) {
          throw new FreshTailObserverError(
            "same_slot_order_conflict",
            false,
            `finalized block ${slot} omitted a scanned transaction signature`,
          );
        }
        row.blockIndex = index;
      }
    }
  }

  private async processRootLanes(
    work: FreshTailWork,
    head: FreshTailFinalizedHead,
    config: FreshTailObserverConfig,
    deadlineMs: number,
  ): Promise<void> {
    const rootCursors = work.cursors
      .filter((cursor) => cursor.role === "root" && cursor.scopeMint === "*")
      .sort((left, right) => left.wallet.localeCompare(right.wallet));
    if (rootCursors.length !== 3) {
      throw new FreshTailObserverError(
        "root_cursor_contract_invalid",
        false,
        "active epoch does not contain exactly three shared root cursors",
      );
    }
    const rootsByWallet = new Map(work.roots.map((root) => [root.wallet, root.ordinal]));
    if (
      rootsByWallet.size !== 3 ||
      rootCursors.some((cursor) => !rootsByWallet.has(cursor.wallet))
    ) {
      throw new FreshTailObserverError(
        "root_cursor_contract_invalid",
        false,
        "root cursor identities do not match the durable epoch roots",
      );
    }
    const scans: RootScan[] = [];
    for (const cursor of rootCursors) {
      this.assertLease();
      const boundary = freshTailBoundaryForCursor(cursor);
      const scan = await scanFreshTailFinalizedSignatures(this.rpc, {
        wallet: cursor.wallet,
        boundary,
        finalizedHeadSlot: head.slot,
        pageSize: this.pageSize,
        maxPages: this.maxPages,
        rpcCallTimeoutMs: this.rpcCallTimeoutMs,
        deadlineMs,
        nowMs: this.nowMs,
      });
      if (!scan.ok) {
        throw new FreshTailObserverError(scan.code, scan.retryable, scan.reason);
      }
      const loaded = await loadFreshTailFinalizedTransactions(this.rpc, {
        signatures: scan.signatures,
        rpcCallTimeoutMs: this.rpcCallTimeoutMs,
        deadlineMs,
        nowMs: this.nowMs,
      });
      if (!loaded.ok) {
        throw new FreshTailObserverError(loaded.code, loaded.retryable, loaded.reason);
      }
      scans.push({ root: cursor.wallet, cursor, scan, transactions: loaded.transactions });
    }
    const occurrences: RootOccurrence[] = scans.flatMap((rootScan) =>
      rootScan.transactions.map((row) => ({
        ...row,
        root: rootScan.root,
        rootOrdinal: rootsByWallet.get(rootScan.root)!,
        blockIndex: 0,
      })),
    );
    await this.canonicalBlockIndexes(occurrences, deadlineMs);
    occurrences.sort(
      (left, right) =>
        left.signature.slot - right.signature.slot ||
        left.blockIndex - right.blockIndex ||
        left.rootOrdinal - right.rootOrdinal ||
        left.signature.signature.localeCompare(right.signature.signature),
    );

    const contracts = this.activeContracts(work);
    const contractsByCurve = new Map(
      [...contracts.values()].map((contract) => [contract.bondingCurve, contract]),
    );
    const revisions = this.scopeRevisions(work);
    const rejected = new Set(
      work.rejections.map((row) => String(row.tokenMint ?? "")).filter(Boolean),
    );
    const poisoned = new Set(
      work.mints.filter((mint) => mint.poisoned).map((mint) => mint.tokenMint),
    );
    const roots = new Set(work.roots.map((root) => root.wallet));
    const candidates: RequestCandidate[] = [];
    for (const occurrence of occurrences) {
      this.assertLease();
      candidates.push(
        ...(await this.persistRootTransaction(
          occurrence.transaction,
          occurrence.signature,
          occurrence.root,
          contracts,
          contractsByCurve,
          revisions,
          rejected,
          poisoned,
          roots,
          head,
          deadlineMs,
        )),
      );
    }
    candidates.sort(
      (left, right) =>
        left.event.slot - right.event.slot ||
        left.event.txSig.localeCompare(right.event.txSig) ||
        left.event.targetWallet.localeCompare(right.event.targetWallet),
    );
    for (const candidate of candidates) {
      if (!poisoned.has(candidate.event.tokenMint)) {
        await this.requestCandidate(candidate, config, deadlineMs);
      }
    }

    // Every event, child edge, scope update, and coverage request above is
    // durable before the first shared parent cursor is allowed to advance.
    for (const rootScan of scans) {
      const checkpoint = rootScan.scan.checkpoint;
      const firstAvailableBlock =
        rootScan.scan.firstAvailableBlock ?? rootScan.cursor.firstAvailableBlock;
      if (!Number.isSafeInteger(firstAvailableBlock) || firstAvailableBlock! < 0) {
        throw new FreshTailObserverError(
          "history_floor_unproved",
          false,
          `root ${rootScan.root} lacks a first-available-block witness`,
        );
      }
      this.assertLease();
      requireMutation(
        "record_root_cursor",
        await this.store.recordCursor(this.epoch!.epochId, this.lease!, {
          scopeMint: "*",
          wallet: rootScan.root,
          expectedLastSignature: rootScan.cursor.lastSignature,
          nextLastSignature: checkpoint?.signature ?? rootScan.cursor.lastSignature,
          nextLastSlot: checkpoint?.slot ?? rootScan.cursor.lastSlot,
          lastBlockTimeSeconds: checkpoint?.blockTime ?? null,
          firstAvailableBlock: firstAvailableBlock!,
          coveredHead: head,
          coverageRevision: 0,
          backlogDetected: false,
          lastError: null,
        }),
      );
    }
  }

  private async persistScopedTransaction(
    transaction: ParsedTransactionWithMeta,
    wallet: string,
    contract: FreshTailMintContract,
    roots: ReadonlySet<string>,
    head: FreshTailFinalizedHead,
    deadlineMs: number,
    currentRevision: number,
  ): Promise<number> {
    const decoded = decodeFreshTailFinalizedTransaction(
      transaction,
      contract,
      wallet,
      "descendant",
    );
    if (!decoded.ok) {
      throw new FreshTailObserverError(
        `decode_${decoded.code}`,
        false,
        `enrolled mint ${contract.mint} failed descendant decoding: ${decoded.reason}`,
      );
    }
    if (decoded.supplyEvents.length === 0 && decoded.custodyEvents.length === 0) {
      return currentRevision;
    }
    const persisted = await this.persistDecoded(
      decoded,
      contract,
      roots,
      head,
      deadlineMs,
      currentRevision,
    );
    return persisted.scopeRevision;
  }

  private async processDescendantLane(
    work: FreshTailWork,
    cursor: FreshTailWorkCursor,
    head: FreshTailFinalizedHead,
    deadlineMs: number,
  ): Promise<void> {
    const mint = work.mints.find(
      (candidate) => candidate.tokenMint === cursor.scopeMint && candidate.status === "active",
    );
    if (!mint || mint.poisoned) return;
    const roots = new Set(work.roots.map((root) => root.wallet));
    const laneCursor: FreshTailLaneCursor = {
      scopeMint: cursor.scopeMint,
      wallet: cursor.wallet,
      role: "descendant",
      floorSlot: cursor.floorSlot,
      boundaryKind: cursor.boundaryKind,
      lastSignature: cursor.lastSignature,
      lastSlot: cursor.lastSlot,
      firstAvailableBlock: cursor.firstAvailableBlock,
      coverageRevision: cursor.coverageRevision,
    };
    await processFreshTailLane({
      rpc: this.rpc,
      cursor: laneCursor,
      head,
      deadlineMs,
      nowMs: this.nowMs,
      pageSize: this.pageSize,
      maxPages: this.maxPages,
      rpcCallTimeoutMs: this.rpcCallTimeoutMs,
      assertLease: () => this.assertLease(),
      persistTransaction: (transaction, _signature, revision) =>
        this.persistScopedTransaction(
          transaction,
          cursor.wallet,
          contractFromMint(mint),
          roots,
          head,
          deadlineMs,
          revision,
        ),
      persistCursor: async (write) => {
        requireMutation(
          "record_descendant_cursor",
          await this.store.recordCursor(this.epoch!.epochId, this.lease!, write),
        );
      },
    });
  }

  private async processBackscanLane(
    work: FreshTailWork,
    range: FreshTailBackscanRange,
    head: FreshTailFinalizedHead,
    deadlineMs: number,
  ): Promise<void> {
    const mint = work.mints.find(
      (candidate) => candidate.tokenMint === range.tokenMint && candidate.status === "active",
    );
    if (!mint || mint.poisoned) return;
    const roots = new Set(work.roots.map((root) => root.wallet));
    await processFreshTailLane({
      rpc: this.rpc,
      cursor: {
        scopeMint: range.tokenMint,
        wallet: range.wallet,
        role: "descendant",
        floorSlot: range.floorSlot,
        boundaryKind: range.boundaryKind,
        lastSignature: range.lastSignature,
        lastSlot: range.lastSlot,
        firstAvailableBlock: range.firstAvailableBlock,
        coverageRevision: range.coverageRevision,
      },
      head,
      deadlineMs,
      nowMs: this.nowMs,
      pageSize: this.pageSize,
      maxPages: this.maxPages,
      rpcCallTimeoutMs: this.rpcCallTimeoutMs,
      assertLease: () => this.assertLease(),
      persistTransaction: (transaction, _signature, revision) =>
        this.persistScopedTransaction(
          transaction,
          range.wallet,
          contractFromMint(mint),
          roots,
          head,
          deadlineMs,
          revision,
        ),
      persistCursor: async (write) => {
        requireMutation(
          "record_backscan_cursor",
          await this.store.recordBackscanCursor(this.epoch!.epochId, this.lease!, range.rangeId, {
            expectedLastSignature: write.expectedLastSignature,
            nextLastSignature: write.nextLastSignature,
            nextLastSlot: write.nextLastSlot,
            lastBlockTimeSeconds: write.lastBlockTimeSeconds,
            firstAvailableBlock: write.firstAvailableBlock,
            coveredHead: write.coveredHead,
            coverageRevision: write.coverageRevision,
            backlogDetected: write.backlogDetected,
            lastError: write.lastError,
          }),
        );
      },
    });
  }

  private async coverHead(
    head: FreshTailFinalizedHead,
    config: FreshTailObserverConfig,
    deadlineMs: number,
  ): Promise<FreshTailWork> {
    this.assertLease();
    let work = await this.store.getWork(this.epoch!.epochId, this.lease!);
    await this.processRootLanes(work, head, config, deadlineMs);
    const processed = new Set<string>();
    for (let step = 0; step < MAX_FIXED_POINT_STEPS; step += 1) {
      ensureDeadline(deadlineMs, this.nowMs, "descendant fixed point");
      this.assertLease();
      work = await this.store.getWork(this.epoch!.epochId, this.lease!);
      let scopeAdvanced = false;
      for (const mint of work.mints
        .filter((candidate) => candidate.status === "active" && !candidate.poisoned)
        .sort((left, right) => left.tokenMint.localeCompare(right.tokenMint))) {
        const synced = await this.store.syncScope(
          this.epoch!.epochId,
          this.lease!,
          mint.tokenMint,
          mint.scopeRevision,
        );
        if (!synced.ok) {
          if (
            synced.reason === "fresh_custody_poison" ||
            synced.reason === "preexisting_legacy_journey" ||
            synced.reason === "mint_not_active"
          ) {
            scopeAdvanced = true;
            break;
          }
          throw new FreshTailObserverError(
            `sync_scope_${synced.reason}`,
            true,
            `scope sync failed: ${synced.reason}`,
          );
        }
        const revision = resultNumber(synced, "scopeRevision");
        if (revision !== mint.scopeRevision) {
          scopeAdvanced = true;
          break;
        }
      }
      if (scopeAdvanced) continue;

      const descendants = work.cursors
        .filter((cursor) => cursor.role === "descendant")
        .sort(
          (left, right) =>
            left.scopeMint.localeCompare(right.scopeMint) ||
            left.wallet.localeCompare(right.wallet),
        );
      let progressed = false;
      for (const cursor of descendants) {
        const mint = work.mints.find((candidate) => candidate.tokenMint === cursor.scopeMint);
        if (!mint || mint.status !== "active" || mint.poisoned) continue;
        const key = `main:${cursor.scopeMint}:${cursor.wallet}:${mint.scopeRevision}:${head.slot}:${head.blockhash}`;
        if (processed.has(key)) continue;
        if (cursorIsPastHead(cursor, head.slot)) {
          throw new FreshTailObserverError(
            "coverage_head_not_rewindable",
            false,
            `descendant cursor ${cursor.wallet} is already past requested head ${head.slot}`,
          );
        }
        await this.processDescendantLane(work, cursor, head, deadlineMs);
        processed.add(key);
        progressed = true;
        break;
      }
      if (progressed) continue;

      for (const range of work.backscanRanges.sort(
        (left, right) =>
          left.tokenMint.localeCompare(right.tokenMint) ||
          left.wallet.localeCompare(right.wallet) ||
          left.rangeId.localeCompare(right.rangeId),
      )) {
        const mint = work.mints.find((candidate) => candidate.tokenMint === range.tokenMint);
        if (!mint || mint.status !== "active" || mint.poisoned) continue;
        const key = `backscan:${range.rangeId}:${mint.scopeRevision}:${head.slot}:${head.blockhash}`;
        if (processed.has(key)) continue;
        if (
          (range.coveredThroughSlot !== null && range.coveredThroughSlot > head.slot) ||
          (range.lastSlot !== null && range.lastSlot > head.slot)
        ) {
          throw new FreshTailObserverError(
            "coverage_head_not_rewindable",
            false,
            `backscan ${range.rangeId} is already past requested head ${head.slot}`,
          );
        }
        await this.processBackscanLane(work, range, head, deadlineMs);
        processed.add(key);
        progressed = true;
        break;
      }
      if (progressed) continue;
      return work;
    }
    throw new FreshTailObserverError(
      "scope_fixed_point_limit",
      true,
      "fresh-tail descendant scope did not converge within its fixed step budget",
    );
  }

  private async retireInactiveMints(
    head: FreshTailFinalizedHead,
    deadlineMs: number,
  ): Promise<number> {
    if (deadlineMs - Number(this.nowMs()) <= REQUEST_RESERVE_MS) return 0;
    this.assertLease();
    const work = await this.store.getWork(this.epoch!.epochId, this.lease!);
    const candidates = selectFreshTailRetirementCandidates(work, head.blockTimeMs);
    return this.retireCandidates(candidates, deadlineMs);
  }

  private async retireResourceOverflow(deadlineMs: number): Promise<number> {
    if (deadlineMs - Number(this.nowMs()) <= REQUEST_RESERVE_MS) return 0;
    this.assertLease();
    const candidates = await this.store.getRetirementCandidates(
      this.epoch!.epochId,
      this.lease!,
      MAX_RETIREMENTS_PER_CYCLE,
    );
    return this.retireCandidates(candidates, deadlineMs);
  }

  private async retireCandidates(
    candidates: readonly FreshTailRetirementCandidate[],
    deadlineMs: number,
  ): Promise<number> {
    let retired = 0;
    for (const candidate of candidates) {
      if (deadlineMs - Number(this.nowMs()) <= REQUEST_RESERVE_MS) break;
      this.assertLease();
      const result = await this.store.retireMint(
        this.epoch!.epochId,
        this.lease!,
        candidate.tokenMint,
        candidate.scopeRevision,
        candidate.reason,
      );
      if (result.ok) {
        retired += 1;
        continue;
      }
      // All of these mean authoritative state changed after getWork. They are
      // safe no-ops and will be reconsidered from a fresh snapshot next cycle.
      if (
        result.reason === "scope_revision_conflict" ||
        result.reason === "fresh_position_still_armed" ||
        result.reason === "fresh_exit_still_unresolved" ||
        result.reason === "fresh_request_still_live" ||
        result.reason === "mint_not_dormant" ||
        result.reason === "retirement_reason_conflict" ||
        result.reason === "mint_not_found"
      ) {
        continue;
      }
      throw new FreshTailObserverError(
        `retire_mint_${result.reason}`,
        true,
        `fresh-tail mint retirement failed: ${result.reason}`,
      );
    }
    return retired;
  }

  private requestCannotRewind(work: FreshTailWork, request: FreshTailWorkRequest): boolean {
    return (
      work.cursors.some(
        (cursor) =>
          (cursor.role === "root" || cursor.scopeMint === request.tokenMint) &&
          cursorIsPastHead(cursor, request.requestedHeadSlot),
      ) ||
      work.backscanRanges.some(
        (range) =>
          range.tokenMint === request.tokenMint &&
          ((range.coveredThroughSlot ?? 0) > request.requestedHeadSlot ||
            (range.lastSlot ?? 0) > request.requestedHeadSlot),
      )
    );
  }

  private async drainRequests(
    config: FreshTailObserverConfig,
    deadlineMs: number,
    completed: Set<string>,
  ): Promise<number> {
    let settled = 0;
    for (let iteration = 0; iteration < 128; iteration += 1) {
      this.assertLease();
      const work = await this.store.getWork(this.epoch!.epochId, this.lease!);
      const live = work.requests
        .filter((request) => request.status === "pending" || request.status === "settled")
        .sort(requestSort);
      const request = live.find((candidate) => {
        const key = `${candidate.requestId}:${candidate.scopeRevision}:${this.lease!.leaseGeneration}`;
        return !completed.has(key);
      });
      if (!request) return settled;
      const key = `${request.requestId}:${request.scopeRevision}:${this.lease!.leaseGeneration}`;
      const expiresAt = parseIsoMs(request.expiresAt);
      if (expiresAt <= Number(this.nowMs()) + REQUEST_RESERVE_MS) {
        completed.add(key);
        continue;
      }
      if (this.requestCannotRewind(work, request)) {
        if (request.status === "pending") {
          throw new FreshTailObserverError(
            "pending_request_cursor_ahead",
            false,
            `pending request ${request.requestId} cannot be certified after its cursor advanced`,
          );
        }
        // A prior-generation settled proof cannot safely be recreated after
        // its cursors advanced. It remains non-actionable and expires in SQL.
        completed.add(key);
        continue;
      }
      const requestDeadline = Math.min(deadlineMs, expiresAt - REQUEST_RESERVE_MS);
      const head = await this.exactHead(
        request.requestedHeadSlot,
        requestDeadline,
        undefined,
        request.requestedHeadBlockhash,
      );
      await this.coverHead(head, config, requestDeadline);
      const refreshed = await this.store.getWork(this.epoch!.epochId, this.lease!);
      const currentRequest = refreshed.requests.find(
        (candidate) => candidate.requestId === request.requestId,
      );
      const mint = refreshed.mints.find((candidate) => candidate.tokenMint === request.tokenMint);
      if (
        !currentRequest ||
        !mint ||
        mint.status !== "active" ||
        mint.poisoned ||
        (currentRequest.status !== "pending" && currentRequest.status !== "settled")
      ) {
        completed.add(key);
        continue;
      }
      const result = await this.store.settleRequest(
        this.epoch!.epochId,
        this.lease!,
        request.requestId,
        mint.scopeRevision,
      );
      if (!result.ok) {
        if (
          result.reason === "request_expired" ||
          result.reason === "request_not_live" ||
          result.reason === "mint_not_active"
        ) {
          completed.add(key);
          continue;
        }
        throw new FreshTailObserverError(
          `settle_request_${result.reason}`,
          true,
          `fresh request settlement failed: ${result.reason}`,
        );
      }
      completed.add(`${request.requestId}:${mint.scopeRevision}:${this.lease!.leaseGeneration}`);
      settled += 1;
    }
    throw new FreshTailObserverError(
      "request_drain_limit",
      true,
      "fresh-tail live request queue did not drain within its fixed bound",
    );
  }

  private async heartbeat(
    config: FreshTailObserverConfig,
    lastSuccessAt: string | null,
    lastError: string | null,
  ): Promise<void> {
    if (!this.latestAttestedHead) return;
    this.assertLease();
    requireMutation(
      "heartbeat",
      await this.store.saveHeartbeat({
        epochId: this.epoch!.epochId,
        workerId: this.workerId,
        lease: this.lease!,
        enabled: config.observerEnabled,
        shadow: config.shadow,
        latestHead: this.latestAttestedHead,
        lastSuccessAt,
        lastError,
      }),
    );
  }

  async cycle(config: FreshTailObserverConfig): Promise<FreshTailObserverCycleResult> {
    const startedAt = Number(this.nowMs());
    const deadlineMs = startedAt + this.cycleBudgetMs;
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) {
      throw new FreshTailObserverError("clock_invalid", false, "fresh-tail clock is invalid");
    }
    const windowSeconds = positiveInteger(config.windowSeconds, "accumulation window");
    if (windowSeconds < 30 || windowSeconds > 3_600) {
      throw new FreshTailObserverError(
        "invalid_configuration",
        false,
        "accumulation window must be between 30 and 3600 seconds",
      );
    }
    const epoch = await this.ensureEpoch(config, deadlineMs);
    if (!epoch) {
      return {
        status: "idle",
        epochId: null,
        leaseGeneration: null,
        finalizedHeadSlot: null,
        requestsSettled: 0,
      };
    }
    if (!(await this.acquireLease(epoch))) {
      return {
        status: "lease_busy",
        epochId: epoch.epochId,
        leaseGeneration: null,
        finalizedHeadSlot: null,
        requestsSettled: 0,
      };
    }

    let sampledHead: FreshTailFinalizedHead | null = null;
    try {
      const sampled = await sampleFreshTailFinalizedHead(this.rpc, {
        minimumSlot: epoch.activationSlot,
        rpcCallTimeoutMs: this.rpcCallTimeoutMs,
        deadlineMs,
        nowMs: this.nowMs,
      });
      if (!sampled.ok) {
        throw new FreshTailObserverError(sampled.code, sampled.retryable, sampled.reason);
      }
      sampledHead = sampled.head;
      await this.attestHead(sampled.head);
      // Capacity eviction has its own bounded RPC, so it remains available
      // even when a full work snapshot is intentionally rejected at the cap.
      await this.retireResourceOverflow(deadlineMs);
      const completedRequests = new Set<string>();
      let requestsSettled = await this.drainRequests(config, deadlineMs, completedRequests);
      await this.coverHead(sampled.head, config, deadlineMs);
      requestsSettled += await this.drainRequests(config, deadlineMs, completedRequests);
      await this.retireInactiveMints(sampled.head, deadlineMs);
      const successAt = new Date(Number(this.nowMs())).toISOString();
      await this.heartbeat(config, successAt, null);
      return {
        status: "observed",
        epochId: epoch.epochId,
        leaseGeneration: this.lease!.leaseGeneration,
        finalizedHeadSlot: this.latestAttestedHead?.slot ?? sampled.head.slot,
        requestsSettled,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.heartbeat(config, null, message.slice(0, 1_000));
      } catch {
        // The original error (often lease loss) is the authoritative failure.
      }
      if (error instanceof FreshTailObserverError) throw error;
      throw new FreshTailObserverError("observer_cycle_failed", true, message);
    } finally {
      void sampledHead;
    }
  }
}
