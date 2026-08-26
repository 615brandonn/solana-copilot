import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { safeDiagnostic } from "./diagnostics.js";

const PUMP_ROOT_BUY_PARSER_ABI =
  "b8b6dbdcce44a2b61c55ba2fd74cd385fae489a95be291504eb8e7b15f88262d";
const PUMP_CREATE_PROOF_ABI =
  "ebe9ae1c8f38c24c3c6d4da1a3c9b90ffce4bf27e36f562bc67b090e9b7c343f";
const PUMP_SNAPSHOT_PARSER_ABI =
  "2f5de97b6527d4ec94082069d65abd2bf30523e45bf562aabe1e770e5eb4ad1d";
const PUMP_STANDARD_SUPPLY_RAW = "1000000000000000";
const PUMP_STANDARD_DECIMALS = 6;

type RpcResponse = { data: unknown; error: unknown };

export type FreshTailEntryDbClient = {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<RpcResponse>;
};

export type FreshTailEntryCandidate = {
  epochId: string;
  requestId: string;
  tokenMint: string;
  triggerEventKey: string;
  txSig: string;
  slot: number;
  triggerBlockTime: string;
  targetWallet: string;
  expiresAt: string;
  requestedHeadSlot: number;
  requestedHeadBlockhash: string;
  requestedHeadBlockTime: string;
  proofObservedAt: string;
  windowStartedAt: string;
  amountRaw: string;
  decimals: number;
  totalSupplyRaw: string;
  netAcquiredRaw: string;
  netSupplyPct: number;
  thresholdPct: number;
  rootWallets: [string, string, string];
  marketCapUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  createVariant: "classic_v1" | "create_v2_token2022";
  tokenProgram: string;
  bondingCurve: string;
  creator: string;
  mintLayoutFingerprint: string;
  creationParserAbiFingerprint: string;
  eventParserDomain: "pump_root_buy_v1";
  eventParserAbiFingerprint: string;
  headSnapshotParserAbiFingerprint: string;
  headCurveStateFingerprint: string;
  headCurveObservedSlot: number;
  headCurveComplete: false;
  headVirtualTokenReservesRaw: string;
  headVirtualSolReservesLamports: string;
  headRealTokenReservesRaw: string;
  headRealSolReservesLamports: string;
  headCurveTotalSupplyRaw: string;
  headMintLayoutFingerprint: string;
  headTokenProgram: string;
  headMintSupplyRaw: string;
  headMintDecimals: number;
  scopeRevision: number;
  settledRevision: number;
  settledLeaseGeneration: number;
};

export type FreshTailClaimBinding = {
  claimId: string;
  epochId: string;
  requestId: string;
  positionId: string;
  armedAt: string;
};

export type FreshTailEntryReceipt = {
  claimId: string;
  positionId: string;
  botTxSig: string;
  receivedAmountRaw: string;
  receivedTokenDecimals: number;
  landedAt: string;
  status: "landed" | "persisted";
  replay: boolean;
};

export type FreshTailReceiptBinding = {
  epochId: string;
  requestId: string;
  tokenDecimals: number;
  totalSupplyRaw?: string;
};

export class FreshTailClaimBindingRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`fresh-tail claim binding failed: ${reason}`);
    this.name = "FreshTailClaimBindingRejectedError";
    this.reason = reason;
  }
}

function object(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${operation} returned a malformed JSON object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`fresh-tail ${field} is missing`);
  }
  return value.trim();
}

function exactRaw(value: unknown, field: string, allowZero = false): string {
  const raw = text(value, field);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw) || raw.length > 78 || (!allowZero && raw === "0")) {
    throw new Error(`fresh-tail ${field} is not a canonical raw integer`);
  }
  return raw;
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`fresh-tail ${field} is not a safe integer`);
  }
  return parsed;
}

function finiteNumber(value: unknown, field: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`fresh-tail ${field} is not finite`);
  }
  return parsed;
}

function iso(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`fresh-tail ${field} is invalid`);
  return parsed;
}

function publicKey(value: unknown, field: string): string {
  try {
    return new PublicKey(text(value, field)).toBase58();
  } catch {
    throw new Error(`fresh-tail ${field} is not a public key`);
  }
}

function fingerprint(value: unknown, field: string): string {
  const parsed = text(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new Error(`fresh-tail ${field} is invalid`);
  return parsed;
}

function uuid(value: unknown, field: string): string {
  const parsed = text(value, field).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed)) {
    throw new Error(`fresh-tail ${field} is not a UUID`);
  }
  return parsed;
}

function base58Bytes(value: unknown, field: string, bytes: number): string {
  const parsed = text(value, field);
  try {
    if (bs58.decode(parsed).length !== bytes) throw new Error("wrong byte length");
  } catch {
    throw new Error(`fresh-tail ${field} is not a ${bytes}-byte base58 value`);
  }
  return parsed;
}

function parseCandidate(value: unknown): FreshTailEntryCandidate {
  const row = object(value, "candidate");
  if (row.safe !== true || row.reason !== "fresh_custody_safe") {
    throw new Error("fresh-tail candidate is not an affirmative custody certificate");
  }
  const roots = Array.isArray(row.rootWallets)
    ? row.rootWallets.map((root, index) => publicKey(root, `rootWallets[${index}]`))
    : [];
  if (roots.length !== 3 || new Set(roots).size !== 3) {
    throw new Error("fresh-tail candidate does not contain exactly three roots");
  }
  const epochId = uuid(row.epochId, "epochId");
  const requestId = uuid(row.requestId, "requestId");
  const slot = safeInteger(row.slot, "slot", 1);
  const requestedHeadSlot = safeInteger(row.requestedHeadSlot, "requestedHeadSlot", slot);
  const headCurveObservedSlot = safeInteger(
    row.headCurveObservedSlot,
    "headCurveObservedSlot",
    requestedHeadSlot,
  );
  if (headCurveObservedSlot !== requestedHeadSlot || row.headCurveComplete !== false) {
    throw new Error("fresh-tail candidate head curve is stale or completed");
  }
  if (requestedHeadSlot < slot) {
    throw new Error("fresh-tail candidate head precedes its trigger");
  }
  const scopeRevision = safeInteger(row.scopeRevision, "scopeRevision");
  const settledRevision = safeInteger(row.settledRevision, "settledRevision");
  if (settledRevision !== scopeRevision) {
    throw new Error("fresh-tail candidate scope is not at a fixed point");
  }
  const decimals = safeInteger(row.decimals, "decimals");
  const headMintDecimals = safeInteger(row.headMintDecimals, "headMintDecimals");
  if (decimals !== headMintDecimals) {
    throw new Error("fresh-tail candidate mint decimals changed at the finalized head");
  }
  const totalSupplyRaw = exactRaw(row.totalSupplyRaw, "totalSupplyRaw");
  const headCurveTotalSupplyRaw = exactRaw(
    row.headCurveTotalSupplyRaw,
    "headCurveTotalSupplyRaw",
  );
  const headMintSupplyRaw = exactRaw(row.headMintSupplyRaw, "headMintSupplyRaw");
  if (totalSupplyRaw !== headCurveTotalSupplyRaw || totalSupplyRaw !== headMintSupplyRaw) {
    throw new Error("fresh-tail candidate supply changed at the finalized head");
  }
  if (decimals !== PUMP_STANDARD_DECIMALS || totalSupplyRaw !== PUMP_STANDARD_SUPPLY_RAW) {
    throw new Error("fresh-tail candidate is not a reviewed standard Pump launch");
  }
  const tokenProgram = publicKey(row.tokenProgram, "tokenProgram");
  const headTokenProgram = publicKey(row.headTokenProgram, "headTokenProgram");
  if (tokenProgram !== headTokenProgram) {
    throw new Error("fresh-tail candidate token program changed at the finalized head");
  }
  const mintLayoutFingerprint = fingerprint(
    row.mintLayoutFingerprint,
    "mintLayoutFingerprint",
  );
  const headMintLayoutFingerprint = fingerprint(
    row.headMintLayoutFingerprint,
    "headMintLayoutFingerprint",
  );
  if (mintLayoutFingerprint !== headMintLayoutFingerprint) {
    throw new Error("fresh-tail candidate mint layout changed at the finalized head");
  }
  const expiresAt = iso(row.expiresAt, "expiresAt");
  const proofObservedAt = iso(row.proofObservedAt, "proofObservedAt");
  if (Date.parse(expiresAt) <= Date.parse(proofObservedAt)) {
    throw new Error("fresh-tail candidate was already expired when certified");
  }
  const triggerBlockTime = iso(row.triggerBlockTime, "triggerBlockTime");
  const requestedHeadBlockTime = iso(row.requestedHeadBlockTime, "requestedHeadBlockTime");
  const windowStartedAt = iso(row.windowStartedAt, "windowStartedAt");
  if (
    Date.parse(windowStartedAt) >= Date.parse(triggerBlockTime) ||
    Date.parse(requestedHeadBlockTime) < Date.parse(triggerBlockTime) ||
    Date.parse(proofObservedAt) < Date.parse(requestedHeadBlockTime)
  ) {
    throw new Error("fresh-tail candidate timestamps are not causally ordered");
  }
  const minMarketCapUsd = finiteNumber(row.minMarketCapUsd, "minMarketCapUsd");
  const maxMarketCapUsd = finiteNumber(row.maxMarketCapUsd, "maxMarketCapUsd", 1);
  const marketCapUsd = finiteNumber(row.marketCapUsd, "marketCapUsd", 1);
  if (
    minMarketCapUsd >= maxMarketCapUsd ||
    maxMarketCapUsd > 20_000 ||
    marketCapUsd < minMarketCapUsd ||
    marketCapUsd >= maxMarketCapUsd
  ) {
    throw new Error("fresh-tail candidate is outside the strict market-cap range");
  }
  if (row.eventParserDomain !== "pump_root_buy_v1") {
    throw new Error("fresh-tail candidate uses an unreviewed event parser domain");
  }
  const createVariant = row.createVariant;
  if (createVariant !== "classic_v1" && createVariant !== "create_v2_token2022") {
    throw new Error("fresh-tail candidate create variant is unsupported");
  }
  const expectedTokenProgram =
    createVariant === "classic_v1" ? TOKEN_PROGRAM_ID.toBase58() : TOKEN_2022_PROGRAM_ID.toBase58();
  if (tokenProgram !== expectedTokenProgram) {
    throw new Error("fresh-tail candidate create variant and token program disagree");
  }
  const targetWallet = publicKey(row.targetWallet, "targetWallet");
  if (!roots.includes(targetWallet)) {
    throw new Error("fresh-tail trigger wallet is not one of the epoch roots");
  }
  const amountRaw = exactRaw(row.amountRaw, "amountRaw");
  const netAcquiredRaw = exactRaw(row.netAcquiredRaw, "netAcquiredRaw", true);
  if (BigInt(amountRaw) > BigInt(totalSupplyRaw) || BigInt(netAcquiredRaw) > BigInt(totalSupplyRaw)) {
    throw new Error("fresh-tail candidate raw amounts exceed the mint supply");
  }
  const thresholdPct = finiteNumber(row.thresholdPct, "thresholdPct", 10);
  const netSupplyPct = finiteNumber(row.netSupplyPct, "netSupplyPct", thresholdPct);
  if (
    thresholdPct > 20 ||
    netSupplyPct > 100 ||
    BigInt(netAcquiredRaw) * 10_000n <
      BigInt(totalSupplyRaw) * BigInt(Math.round(thresholdPct * 100))
  ) {
    throw new Error("fresh-tail candidate does not meet the exact reviewed threshold");
  }
  const creationParserAbiFingerprint = fingerprint(
    row.creationParserAbiFingerprint,
    "creationParserAbiFingerprint",
  );
  const eventParserAbiFingerprint = fingerprint(
    row.eventParserAbiFingerprint,
    "eventParserAbiFingerprint",
  );
  const headSnapshotParserAbiFingerprint = fingerprint(
    row.headSnapshotParserAbiFingerprint,
    "headSnapshotParserAbiFingerprint",
  );
  if (
    creationParserAbiFingerprint !== PUMP_CREATE_PROOF_ABI ||
    eventParserAbiFingerprint !== PUMP_ROOT_BUY_PARSER_ABI ||
    headSnapshotParserAbiFingerprint !== PUMP_SNAPSHOT_PARSER_ABI
  ) {
    throw new Error("fresh-tail candidate uses an unreviewed parser ABI");
  }
  return {
    epochId,
    requestId,
    tokenMint: publicKey(row.tokenMint, "tokenMint"),
    triggerEventKey: text(row.triggerEventKey, "triggerEventKey"),
    txSig: base58Bytes(row.txSig, "txSig", 64),
    slot,
    triggerBlockTime,
    targetWallet,
    expiresAt,
    requestedHeadSlot,
    requestedHeadBlockhash: base58Bytes(row.requestedHeadBlockhash, "requestedHeadBlockhash", 32),
    requestedHeadBlockTime,
    proofObservedAt,
    windowStartedAt,
    amountRaw,
    decimals,
    totalSupplyRaw,
    netAcquiredRaw,
    netSupplyPct,
    thresholdPct,
    rootWallets: roots as [string, string, string],
    marketCapUsd,
    minMarketCapUsd,
    maxMarketCapUsd,
    createVariant,
    tokenProgram,
    bondingCurve: publicKey(row.bondingCurve, "bondingCurve"),
    creator: publicKey(row.creator, "creator"),
    mintLayoutFingerprint,
    creationParserAbiFingerprint,
    eventParserDomain: "pump_root_buy_v1",
    eventParserAbiFingerprint,
    headSnapshotParserAbiFingerprint,
    headCurveStateFingerprint: fingerprint(
      row.headCurveStateFingerprint,
      "headCurveStateFingerprint",
    ),
    headCurveObservedSlot,
    headCurveComplete: false,
    headVirtualTokenReservesRaw: exactRaw(
      row.headVirtualTokenReservesRaw,
      "headVirtualTokenReservesRaw",
    ),
    headVirtualSolReservesLamports: exactRaw(
      row.headVirtualSolReservesLamports,
      "headVirtualSolReservesLamports",
    ),
    headRealTokenReservesRaw: exactRaw(
      row.headRealTokenReservesRaw,
      "headRealTokenReservesRaw",
    ),
    headRealSolReservesLamports: exactRaw(
      row.headRealSolReservesLamports,
      "headRealSolReservesLamports",
      true,
    ),
    headCurveTotalSupplyRaw,
    headMintLayoutFingerprint,
    headTokenProgram,
    headMintSupplyRaw,
    headMintDecimals,
    scopeRevision,
    settledRevision,
    settledLeaseGeneration: safeInteger(
      row.settledLeaseGeneration,
      "settledLeaseGeneration",
      1,
    ),
  };
}

export function freshTailCandidateIsUsable(
  candidate: FreshTailEntryCandidate,
  nowMs = Date.now(),
  maximumProofAgeMs = 4_000,
): boolean {
  const observedAt = Date.parse(candidate.proofObservedAt);
  return (
    Number.isSafeInteger(nowMs) &&
    nowMs >= observedAt &&
    nowMs - observedAt <= maximumProofAgeMs &&
    nowMs < Date.parse(candidate.expiresAt)
  );
}

export function createFreshTailEntryStore(client: FreshTailEntryDbClient, userId: string) {
  const canonicalUserId = uuid(userId, "userId");
  const invoke = async (
    name: string,
    parameters: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const response = await client.rpc(name, parameters);
    if (response.error) throw new Error(`${name} failed: ${safeDiagnostic(response.error)}`);
    return object(response.data, name);
  };

  const gateParams = (candidate: FreshTailEntryCandidate, claimId: string | null) => ({
    p_user_id: canonicalUserId,
    p_token_mint: candidate.tokenMint,
    p_window_started_at: candidate.windowStartedAt,
    p_trigger_event_key: candidate.triggerEventKey,
    p_trigger_tx_sig: candidate.txSig,
    p_trigger_slot: candidate.slot,
    p_target_wallet: candidate.targetWallet,
    p_epoch_id: candidate.epochId,
    p_request_id: candidate.requestId,
    p_claim_id: claimId,
  });

  const recordBoundReceipt = async (
    binding: FreshTailReceiptBinding,
    claimId: string,
    expectedPositionId: string,
    botTxSig: string,
    receivedAmountRaw: string,
    receivedTokenDecimals: number,
  ): Promise<FreshTailEntryReceipt> => {
    const canonicalClaimId = uuid(claimId, "claimId");
    const canonicalPositionId = uuid(expectedPositionId, "positionId");
    const canonicalEpochId = uuid(binding.epochId, "epochId");
    const canonicalRequestId = uuid(binding.requestId, "requestId");
    const canonicalSignature = base58Bytes(botTxSig, "botTxSig", 64);
    const canonicalRaw = exactRaw(receivedAmountRaw, "receivedAmountRaw");
    const canonicalDecimals = safeInteger(receivedTokenDecimals, "receivedTokenDecimals");
    if (canonicalDecimals !== binding.tokenDecimals) {
      throw new Error("fresh-tail receipt does not match the certified mint");
    }
    if (
      binding.totalSupplyRaw !== undefined &&
      BigInt(canonicalRaw) > BigInt(exactRaw(binding.totalSupplyRaw, "totalSupplyRaw"))
    ) {
      throw new Error("fresh-tail receipt does not match the certified mint");
    }
    const result = await invoke("record_supply_entry_claim_fresh_tail_receipt", {
      p_user_id: canonicalUserId,
      p_claim_id: canonicalClaimId,
      p_epoch_id: canonicalEpochId,
      p_request_id: canonicalRequestId,
      p_bot_tx_sig: canonicalSignature,
      p_received_amount_raw: canonicalRaw,
      p_received_token_decimals: canonicalDecimals,
    });
    if (result.ok !== true || (result.replay !== true && result.replay !== false)) {
      throw new Error(`fresh-tail exact receipt failed: ${String(result.reason ?? "unknown")}`);
    }
    const status = text(result.status, "status");
    if (status !== "landed" && status !== "persisted") {
      throw new Error("fresh-tail exact receipt returned an invalid lifecycle state");
    }
    const receipt: FreshTailEntryReceipt = {
      claimId: uuid(result.claimId, "claimId"),
      positionId: uuid(result.positionId, "positionId"),
      botTxSig: base58Bytes(result.botTxSig, "botTxSig", 64),
      receivedAmountRaw: exactRaw(result.receivedAmountRaw, "receivedAmountRaw"),
      receivedTokenDecimals: safeInteger(
        result.receivedTokenDecimals,
        "receivedTokenDecimals",
      ),
      landedAt: iso(result.landedAt, "landedAt"),
      status,
      replay: result.replay,
    };
    if (
      receipt.claimId !== canonicalClaimId ||
      receipt.positionId !== canonicalPositionId ||
      receipt.botTxSig !== canonicalSignature ||
      receipt.receivedAmountRaw !== canonicalRaw ||
      receipt.receivedTokenDecimals !== canonicalDecimals
    ) {
      throw new Error("fresh-tail exact receipt returned a different durable identity");
    }
    return receipt;
  };

  return {
    async loadCandidates(limit = 25): Promise<FreshTailEntryCandidate[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("fresh-tail candidate limit is invalid");
      }
      const result = await invoke("get_custody_fresh_tail_entry_candidates", {
        p_user_id: canonicalUserId,
        p_limit: limit,
      });
      if (result.ok !== true || result.reason !== "loaded" || !Array.isArray(result.candidates)) {
        throw new Error("fresh-tail candidate RPC did not return a complete result");
      }
      return result.candidates.map(parseCandidate);
    },

    async recheck(
      candidate: FreshTailEntryCandidate,
      claimId: string | null,
    ): Promise<FreshTailEntryCandidate | null> {
      const result = await invoke(
        "check_supply_accumulation_fresh_custody_gate",
        gateParams(candidate, claimId),
      );
      if (result.safe !== true) return null;
      const parsed = parseCandidate(result);
      if (
        parsed.epochId !== candidate.epochId ||
        parsed.requestId !== candidate.requestId ||
        parsed.triggerEventKey !== candidate.triggerEventKey ||
        parsed.tokenMint !== candidate.tokenMint ||
        parsed.txSig !== candidate.txSig ||
        parsed.slot !== candidate.slot ||
        parsed.targetWallet !== candidate.targetWallet ||
        parsed.requestedHeadSlot !== candidate.requestedHeadSlot ||
        parsed.requestedHeadBlockhash !== candidate.requestedHeadBlockhash ||
        parsed.headCurveStateFingerprint !== candidate.headCurveStateFingerprint ||
        parsed.mintLayoutFingerprint !== candidate.mintLayoutFingerprint ||
        parsed.creationParserAbiFingerprint !== candidate.creationParserAbiFingerprint ||
        parsed.eventParserAbiFingerprint !== candidate.eventParserAbiFingerprint ||
        parsed.headSnapshotParserAbiFingerprint !== candidate.headSnapshotParserAbiFingerprint
      ) {
        throw new Error("fresh-tail final gate changed the immutable candidate identity");
      }
      return parsed;
    },

    async bindClaim(
      candidate: FreshTailEntryCandidate,
      claimId: string,
      expectedPositionId: string,
    ): Promise<FreshTailClaimBinding> {
      const canonicalClaimId = uuid(claimId, "claimId");
      const canonicalPositionId = uuid(expectedPositionId, "positionId");
      const result = await invoke("bind_supply_entry_claim_fresh_tail", {
        p_user_id: canonicalUserId,
        p_claim_id: canonicalClaimId,
        p_epoch_id: candidate.epochId,
        p_request_id: candidate.requestId,
        p_source_tx_sig: candidate.txSig,
        p_source_wallet: candidate.targetWallet,
        p_token_mint: candidate.tokenMint,
        p_source_slot: candidate.slot,
      });
      if (result.ok !== true || result.bound !== true) {
        throw new FreshTailClaimBindingRejectedError(String(result.reason ?? "unknown"));
      }
      const binding = {
        claimId: uuid(result.claimId, "claimId"),
        epochId: uuid(result.epochId, "epochId"),
        requestId: uuid(result.requestId, "requestId"),
        positionId: uuid(result.positionId, "positionId"),
        armedAt: iso(result.armedAt, "armedAt"),
      };
      if (
        binding.claimId !== canonicalClaimId ||
        binding.epochId !== candidate.epochId ||
        binding.requestId !== candidate.requestId ||
        binding.positionId !== canonicalPositionId
      ) {
        throw new Error("fresh-tail claim binding returned a different durable identity");
      }
      return binding;
    },

    async recordReceipt(
      candidate: FreshTailEntryCandidate,
      claimId: string,
      expectedPositionId: string,
      botTxSig: string,
      receivedAmountRaw: string,
      receivedTokenDecimals: number,
    ): Promise<FreshTailEntryReceipt> {
      return recordBoundReceipt(
        {
          epochId: candidate.epochId,
          requestId: candidate.requestId,
          tokenDecimals: candidate.decimals,
          totalSupplyRaw: candidate.totalSupplyRaw,
        },
        claimId,
        expectedPositionId,
        botTxSig,
        receivedAmountRaw,
        receivedTokenDecimals,
      );
    },

    recordBoundReceipt,
  };
}

export type FreshTailEntryStore = ReturnType<typeof createFreshTailEntryStore>;
