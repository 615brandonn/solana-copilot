import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import bs58 from "bs58";
import { createHash } from "node:crypto";
import {
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_STANDARD_TOTAL_SUPPLY_RAW,
  decodeReviewedPumpFunSupplyAccounts,
  pumpFunBondingCurveAddress,
  solanaRpcWithTimeout,
  type PumpFunSupplySnapshot,
} from "./pump-fun-supply.js";
import {
  verifyFreshRootBuyEvidenceIdentity,
  type VerifiedFreshRootBuyEvidence,
} from "./fresh-tail-root-buy-evidence.js";

export const PUMP_FUN_CREATE_DISCRIMINATOR = Uint8Array.from([24, 30, 200, 40, 5, 28, 7, 119]);
export const PUMP_FUN_FINALIZED_IDL_SHA256 =
  "ecf91ed5050c2c8e3e618bd330091f56d7433789eff724dfcc81fd47d1bab7d4";
export const PUMP_FUN_CREATE_PROOF_ABI =
  "ebe9ae1c8f38c24c3c6d4da1a3c9b90ffce4bf27e36f562bc67b090e9b7c343f";
export const PUMP_FUN_CREATE_V2_DISCRIMINATOR = Uint8Array.from([
  214, 144, 76, 236, 95, 139, 49, 180,
]);

const PUMP_FUN_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const CLASSIC_CREATE_ACCOUNT_COUNT = 14;
const V2_CREATE_ACCOUNT_COUNT = 16;
const MAYHEM_PROGRAM_ID = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
const SIGNATURE_PAGE_SIZE = 1_000;
const DEFAULT_MAX_SIGNATURE_PAGES = 8;
const DEFAULT_RPC_TIMEOUT_MS = 4_000;
const DEFAULT_OPERATION_BUDGET_MS = 45_000;
const MAX_CREATE_ARGUMENT_BYTES = 4_096;

export type FinalizedBlockBoundary = {
  slot: number;
  blockhash: string;
};

export type PumpFunCreateProof = {
  abi: typeof PUMP_FUN_CREATE_PROOF_ABI;
  fingerprint: string;
  mint: string;
  creator: string;
  txSig: string;
  slot: number;
  blockTimeMs: number;
  blockhash: string;
  bondingCurve: string;
  createVariant: "classic_v1" | "create_v2_token2022";
  tokenProgram: string;
  mintLayoutFingerprint: string;
  totalSupplyRaw: string;
  decimals: number;
  stateObservedSlot: number;
  activationSlot: number;
  activationBlockhash: string;
  requestedHeadSlot: number;
};

export type PumpFunCreateProofFailureCode =
  | "invalid_request"
  | "deadline_exceeded"
  | "activation_block_unavailable"
  | "activation_block_mismatch"
  | "head_block_unavailable"
  | "head_block_mismatch"
  | "creation_block_unavailable"
  | "signature_history_pruned"
  | "signature_page_limit"
  | "signature_page_conflict"
  | "pre_activation_activity"
  | "transaction_unavailable"
  | "transaction_identity_conflict"
  | "malformed_create_instruction"
  | "trigger_evidence_invalid"
  | "trigger_transaction_unavailable"
  | "creation_not_before_trigger"
  | "same_slot_order_unproved"
  | "create_not_found"
  | "create_conflict"
  | "curve_completed"
  | "curve_state_invalid"
  | "curve_state_unavailable"
  | "rpc_error";

export type PumpFunCreateProofResult =
  | { ok: true; proof: PumpFunCreateProof; snapshot: PumpFunSupplySnapshot }
  | {
      ok: false;
      code: PumpFunCreateProofFailureCode;
      reason: string;
      retryable: boolean;
    };

export type PumpFunCreateAttestationRequest = {
  mint: string;
  activation: FinalizedBlockBoundary;
  requestedHead: FinalizedBlockBoundary;
  triggerSlot: number;
  triggerTxSig: string;
  triggerBuyEvidence: VerifiedFreshRootBuyEvidence;
  maxSignaturePages?: number;
  rpcCallTimeoutMs?: number;
  /** Absolute wall-clock deadline; callers must reserve time to settle/send. */
  deadlineMs?: number;
  nowMs?: () => number;
};

export type PumpFunCreateProofConnection = Pick<
  Connection,
  | "getBlock"
  | "getBlockSignatures"
  | "getFirstAvailableBlock"
  | "getSignaturesForAddress"
  | "getParsedTransactions"
  | "getMultipleAccountsInfoAndContext"
>;

type SignatureRow = Awaited<ReturnType<Connection["getSignaturesForAddress"]>>[number];

type ParsedCreate = {
  creator: string;
  bondingCurve: string;
  variant: "classic_v1" | "create_v2_token2022";
  tokenProgram: string;
  name: string;
  symbol: string;
  uri: string;
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
};

type ParseResult =
  | { kind: "absent" }
  | { kind: "valid"; value: ParsedCreate }
  | { kind: "malformed"; reason: string };

type ReviewedPumpStateSnapshot = PumpFunSupplySnapshot & {
  tokenProgram: string;
  mintLayoutFingerprint: string;
};

type PumpFunCreateDeadline = {
  deadlineMs: number;
  rpcCallTimeoutMs: number;
  nowMs: () => number;
};

function remainingRpcTimeout(deadline: PumpFunCreateDeadline): number | null {
  const remaining = deadline.deadlineMs - Number(deadline.nowMs());
  return Number.isFinite(remaining) && remaining > 0
    ? Math.max(1, Math.min(deadline.rpcCallTimeoutMs, Math.floor(remaining)))
    : null;
}

function deadlineFailure(operation: string): PumpFunCreateProofResult {
  return failure(
    "deadline_exceeded",
    `fresh Pump creation proof exhausted its absolute wall-clock budget before ${operation}`,
    true,
  );
}

function rpcFailureOrDeadline(
  deadline: PumpFunCreateDeadline,
  operation: string,
  error: unknown,
): PumpFunCreateProofResult {
  if (remainingRpcTimeout(deadline) === null) return deadlineFailure(operation);
  return failure(
    "rpc_error",
    `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
    true,
  );
}

function failure(
  code: PumpFunCreateProofFailureCode,
  reason: string,
  retryable = false,
): PumpFunCreateProofResult {
  return { ok: false, code, reason, retryable };
}

function positiveSafeSlot(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function publicKeyString(value: unknown): string | null {
  try {
    const text =
      typeof value === "string"
        ? value
        : ((value as { toBase58?: () => string } | null)?.toBase58?.() ?? String(value ?? ""));
    return new PublicKey(text).toBase58();
  } catch {
    return null;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decodedInstructionData(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return bs58.decode(value);
  } catch {
    return null;
  }
}

function readBorshString(data: Uint8Array, start: number): { value: string; next: number } | null {
  if (start + 4 > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = view.getUint32(start, true);
  const next = start + 4 + length;
  if (length > MAX_CREATE_ARGUMENT_BYTES || next > data.length) return null;
  try {
    return {
      value: new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(start + 4, next)),
      next,
    };
  } catch {
    return null;
  }
}

function decodeCreateArguments(
  data: Uint8Array,
): Omit<ParsedCreate, "bondingCurve" | "tokenProgram"> | null {
  const classic = sameBytes(data.subarray(0, 8), PUMP_FUN_CREATE_DISCRIMINATOR);
  const v2 = sameBytes(data.subarray(0, 8), PUMP_FUN_CREATE_V2_DISCRIMINATOR);
  if (!classic && !v2) return null;
  if (data.length > MAX_CREATE_ARGUMENT_BYTES) return null;
  let offset = 8;
  const strings: string[] = [];
  for (let field = 0; field < 3; field += 1) {
    const decoded = readBorshString(data, offset);
    if (!decoded) return null;
    strings.push(decoded.value);
    offset = decoded.next;
  }
  const trailingBytes = classic ? 32 : 34;
  if (offset + trailingBytes !== data.length) return null;
  try {
    const creator = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    const isMayhemMode = v2 ? data[offset++] : 0;
    const isCashbackEnabled = v2 ? data[offset++] : 0;
    if (
      (isMayhemMode !== 0 && isMayhemMode !== 1) ||
      (isCashbackEnabled !== 0 && isCashbackEnabled !== 1)
    ) {
      return null;
    }
    return {
      creator,
      variant: v2 ? "create_v2_token2022" : "classic_v1",
      name: strings[0]!,
      symbol: strings[1]!,
      uri: strings[2]!,
      isMayhemMode: isMayhemMode === 1,
      isCashbackEnabled: isCashbackEnabled === 1,
    };
  } catch {
    return null;
  }
}

function messageAccountEntries(tx: ParsedTransactionWithMeta): Array<{
  pubkey: string;
  signer: boolean;
  writable: boolean;
}> {
  const message = tx.transaction.message as unknown as {
    accountKeys?: unknown[];
    staticAccountKeys?: unknown[];
    header?: {
      numRequiredSignatures?: number;
      numReadonlySignedAccounts?: number;
      numReadonlyUnsignedAccounts?: number;
    };
  };
  const raw = message.accountKeys ?? message.staticAccountKeys ?? [];
  const required = Number(message.header?.numRequiredSignatures ?? 0);
  const readonlySigned = Number(message.header?.numReadonlySignedAccounts ?? 0);
  const readonlyUnsigned = Number(message.header?.numReadonlyUnsignedAccounts ?? 0);
  return raw.flatMap((entry, index) => {
    const record = entry as {
      pubkey?: unknown;
      signer?: boolean;
      writable?: boolean;
    };
    const pubkey = publicKeyString(record?.pubkey ?? entry);
    if (!pubkey) return [];
    const signer =
      typeof record?.signer === "boolean" ? record.signer : required > 0 && index < required;
    let writable = record?.writable;
    if (typeof writable !== "boolean") {
      if (signer) writable = index < Math.max(0, required - readonlySigned);
      else writable = index < Math.max(required, raw.length - readonlyUnsigned);
    }
    return [{ pubkey, signer, writable }];
  });
}

function instructionProgramId(instruction: unknown, accountKeys: readonly string[]): string | null {
  const row = instruction as { programId?: unknown; programIdIndex?: unknown };
  const direct = publicKeyString(row?.programId);
  if (direct) return direct;
  const index = Number(row?.programIdIndex);
  return Number.isSafeInteger(index) && index >= 0 ? (accountKeys[index] ?? null) : null;
}

function instructionAccounts(
  instruction: unknown,
  accountKeys: readonly string[],
): string[] | null {
  const raw = (instruction as { accounts?: unknown })?.accounts;
  if (!Array.isArray(raw)) return null;
  const resolved = raw.map((entry) => {
    if (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0) {
      return accountKeys[entry] ?? null;
    }
    return publicKeyString(entry);
  });
  return resolved.some((entry) => entry === null) ? null : (resolved as string[]);
}

function transactionInstructions(tx: ParsedTransactionWithMeta): unknown[] {
  const message = tx.transaction.message as unknown as { instructions?: unknown[] };
  const topLevel = Array.isArray(message.instructions) ? message.instructions : [];
  const inner = Array.isArray(tx.meta?.innerInstructions)
    ? tx.meta.innerInstructions.flatMap((group) =>
        Array.isArray(group.instructions) ? group.instructions : [],
      )
    : [];
  return [...topLevel, ...inner];
}

function expectedCreateAccounts(mint: PublicKey, user: PublicKey): string[] {
  const mintAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("mint-authority")],
    PUMP_FUN_PROGRAM_ID,
  )[0];
  const bondingCurve = pumpFunBondingCurveAddress(mint);
  const associatedBondingCurve = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const global = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_FUN_PROGRAM_ID)[0];
  const metadata = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  )[0];
  return [
    mint,
    mintAuthority,
    bondingCurve,
    associatedBondingCurve,
    global,
    METADATA_PROGRAM_ID,
    metadata,
    user,
    SystemProgram.programId,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SYSVAR_RENT_PUBKEY,
    PUMP_FUN_EVENT_AUTHORITY,
    PUMP_FUN_PROGRAM_ID,
  ].map((key) => key.toBase58());
}

function expectedCreateV2Accounts(mint: PublicKey, user: PublicKey): string[] {
  const mintAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("mint-authority")],
    PUMP_FUN_PROGRAM_ID,
  )[0];
  const bondingCurve = pumpFunBondingCurveAddress(mint);
  const associatedBondingCurve = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const global = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_FUN_PROGRAM_ID)[0];
  const globalParams = PublicKey.findProgramAddressSync(
    [Buffer.from("global-params")],
    MAYHEM_PROGRAM_ID,
  )[0];
  const solVault = PublicKey.findProgramAddressSync(
    [Buffer.from("sol-vault")],
    MAYHEM_PROGRAM_ID,
  )[0];
  const mayhemState = PublicKey.findProgramAddressSync(
    [Buffer.from("mayhem-state"), mint.toBuffer()],
    MAYHEM_PROGRAM_ID,
  )[0];
  const mayhemTokenVault = getAssociatedTokenAddressSync(
    mint,
    solVault,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return [
    mint,
    mintAuthority,
    bondingCurve,
    associatedBondingCurve,
    global,
    user,
    SystemProgram.programId,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    MAYHEM_PROGRAM_ID,
    globalParams,
    solVault,
    mayhemState,
    mayhemTokenVault,
    PUMP_FUN_EVENT_AUTHORITY,
    PUMP_FUN_PROGRAM_ID,
  ].map((key) => key.toBase58());
}

/**
 * Strictly recognizes the installed Pump `create` ABI. A successful Pump
 * instruction with the create discriminator but a different layout is a
 * conflict, not a best-effort match: program upgrades must be reviewed before
 * they can establish a fresh-entry epoch.
 */
export function parsePumpFunCreateTransaction(
  tx: ParsedTransactionWithMeta,
  expectedMint: string,
): ParseResult {
  const mint = publicKeyString(expectedMint);
  if (!mint || !tx.meta || tx.meta.err !== null) return { kind: "absent" };
  const entries = messageAccountEntries(tx);
  const accountKeys = entries.map((entry) => entry.pubkey);
  const signerKeys = new Set(entries.filter((entry) => entry.signer).map((entry) => entry.pubkey));
  const writableKeys = new Set(
    entries.filter((entry) => entry.writable).map((entry) => entry.pubkey),
  );
  let match: ParsedCreate | null = null;

  for (const instruction of transactionInstructions(tx)) {
    if (instructionProgramId(instruction, accountKeys) !== PUMP_FUN_PROGRAM_ID.toBase58()) continue;
    const data = decodedInstructionData((instruction as { data?: unknown }).data);
    if (
      !data ||
      data.length < 8 ||
      (!sameBytes(data.subarray(0, 8), PUMP_FUN_CREATE_DISCRIMINATOR) &&
        !sameBytes(data.subarray(0, 8), PUMP_FUN_CREATE_V2_DISCRIMINATOR))
    ) {
      continue;
    }
    const args = decodeCreateArguments(data);
    const accounts = instructionAccounts(instruction, accountKeys);
    const accountCount =
      args?.variant === "create_v2_token2022"
        ? V2_CREATE_ACCOUNT_COUNT
        : CLASSIC_CREATE_ACCOUNT_COUNT;
    if (!args || !accounts || accounts.length !== accountCount) {
      return {
        kind: "malformed",
        reason: "Pump create instruction does not match the reviewed ABI",
      };
    }
    if (accounts[0] !== mint) {
      return { kind: "malformed", reason: "Pump create instruction names a different mint" };
    }
    const userIndex = args.variant === "create_v2_token2022" ? 5 : 7;
    const user = accounts[userIndex];
    let userKey: PublicKey;
    try {
      userKey = new PublicKey(user!);
    } catch {
      return { kind: "malformed", reason: "Pump create instruction has an invalid creator" };
    }
    const expected =
      args.variant === "create_v2_token2022"
        ? expectedCreateV2Accounts(new PublicKey(mint), userKey)
        : expectedCreateAccounts(new PublicKey(mint), userKey);
    if (accounts.some((account, index) => account !== expected[index])) {
      return { kind: "malformed", reason: "Pump create account contract does not match" };
    }
    const requiredWritableIndexes =
      args.variant === "create_v2_token2022" ? [0, 2, 3, 5, 9, 11, 12, 13] : [0, 2, 3, 6, 7];
    const requiredWritable = requiredWritableIndexes.map((index) => accounts[index]);
    if (
      mint === user ||
      !signerKeys.has(mint) ||
      !signerKeys.has(user!) ||
      requiredWritable.some((account) => !account || !writableKeys.has(account))
    ) {
      return {
        kind: "malformed",
        reason: "Pump create mint/creator signer contract does not match",
      };
    }
    if (args.creator !== user) {
      return {
        kind: "malformed",
        reason: "Pump create creator argument does not match its signer",
      };
    }
    const parsed: ParsedCreate = {
      ...args,
      creator: user!,
      bondingCurve: accounts[2]!,
      tokenProgram:
        args.variant === "create_v2_token2022"
          ? TOKEN_2022_PROGRAM_ID.toBase58()
          : TOKEN_PROGRAM_ID.toBase58(),
    };
    if (match && JSON.stringify(match) !== JSON.stringify(parsed)) {
      return { kind: "malformed", reason: "transaction contains conflicting Pump create proofs" };
    }
    match = parsed;
  }

  return match ? { kind: "valid", value: match } : { kind: "absent" };
}

async function loadReviewedPumpState(
  rpc: PumpFunCreateProofConnection,
  mint: PublicKey,
  create: ParsedCreate,
  headSlot: number,
  deadline: PumpFunCreateDeadline,
): Promise<ReviewedPumpStateSnapshot | null | PumpFunCreateProofResult> {
  const curveAddress = pumpFunBondingCurveAddress(mint);
  const timeoutMs = remainingRpcTimeout(deadline);
  if (timeoutMs === null) return deadlineFailure("the finalized curve-state read");
  const response = await solanaRpcWithTimeout(
    rpc.getMultipleAccountsInfoAndContext([curveAddress, mint], {
      commitment: "finalized",
      minContextSlot: headSlot,
    }),
    timeoutMs,
  );
  const [curveAccount, mintAccount] = response.value;
  if (!curveAccount || !mintAccount) return null;
  const snapshot = decodeReviewedPumpFunSupplyAccounts(
    mint,
    { owner: curveAccount.owner, data: curveAccount.data },
    { owner: mintAccount.owner, data: mintAccount.data },
    response.context.slot,
    {
      createVariant: create.variant,
      tokenProgram: create.tokenProgram,
      creator: create.creator,
      name: create.name,
      symbol: create.symbol,
      uri: create.uri,
      isMayhemMode: create.isMayhemMode,
      isCashbackEnabled: create.isCashbackEnabled,
    },
  );
  if (!snapshot?.tokenProgram || !snapshot.mintLayoutFingerprint) return null;
  return {
    ...snapshot,
    tokenProgram: snapshot.tokenProgram,
    mintLayoutFingerprint: snapshot.mintLayoutFingerprint,
  };
}

async function verifyBlockBoundary(
  rpc: PumpFunCreateProofConnection,
  boundary: FinalizedBlockBoundary,
  label: "activation" | "head",
  deadline: PumpFunCreateDeadline,
): Promise<PumpFunCreateProofResult | null> {
  const timeoutMs = remainingRpcTimeout(deadline);
  if (timeoutMs === null) return deadlineFailure(`${label} boundary verification`);
  let block: Awaited<ReturnType<Connection["getBlock"]>>;
  try {
    block = await solanaRpcWithTimeout(
      rpc.getBlock(boundary.slot, {
        commitment: "finalized",
        transactionDetails: "none",
        rewards: false,
        maxSupportedTransactionVersion: 0,
      }),
      timeoutMs,
    );
  } catch (error) {
    return rpcFailureOrDeadline(deadline, `${label} block verification`, error);
  }
  if (!block) {
    return failure(
      label === "activation" ? "activation_block_unavailable" : "head_block_unavailable",
      `${label} finalized block is unavailable`,
      true,
    );
  }
  if (block.blockhash !== boundary.blockhash) {
    return failure(
      label === "activation" ? "activation_block_mismatch" : "head_block_mismatch",
      `${label} finalized blockhash changed`,
    );
  }
  return null;
}

async function loadEpochSignatures(
  rpc: PumpFunCreateProofConnection,
  mint: PublicKey,
  activationSlot: number,
  requestedHeadSlot: number,
  maxPages: number,
  deadline: PumpFunCreateDeadline,
): Promise<{ rows: SignatureRow[] } | PumpFunCreateProofResult> {
  const rows: SignatureRow[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  let previousSlot = Number.POSITIVE_INFINITY;
  let crossedFloor = false;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const timeoutMs = remainingRpcTimeout(deadline);
    if (timeoutMs === null) return deadlineFailure("a finalized mint signature page");
    let page: SignatureRow[];
    try {
      page = await solanaRpcWithTimeout(
        rpc.getSignaturesForAddress(
          mint,
          {
            limit: SIGNATURE_PAGE_SIZE,
            ...(before ? { before } : {}),
            minContextSlot: requestedHeadSlot,
          },
          "finalized",
        ),
        timeoutMs,
      );
    } catch (error) {
      return rpcFailureOrDeadline(deadline, "finalized mint signature scan", error);
    }

    if (page.length === 0) {
      let firstAvailable: number;
      const floorTimeoutMs = remainingRpcTimeout(deadline);
      if (floorTimeoutMs === null) {
        return deadlineFailure("the first-available-block proof");
      }
      try {
        firstAvailable = await solanaRpcWithTimeout(rpc.getFirstAvailableBlock(), floorTimeoutMs);
      } catch (error) {
        return rpcFailureOrDeadline(deadline, "first available block check", error);
      }
      if (firstAvailable > activationSlot) {
        return failure(
          "signature_history_pruned",
          "RPC history does not reach the fresh-tail activation floor",
        );
      }
      crossedFloor = true;
      break;
    }

    for (const row of page) {
      const slot = positiveSafeSlot(row.slot);
      const signature = typeof row.signature === "string" ? row.signature.trim() : "";
      if (
        slot === null ||
        !signature ||
        seen.has(signature) ||
        slot > previousSlot ||
        row.confirmationStatus !== "finalized"
      ) {
        return failure(
          "signature_page_conflict",
          "finalized mint signature pages are duplicated, unordered, or malformed",
        );
      }
      seen.add(signature);
      previousSlot = slot;
      if (slot <= activationSlot) {
        crossedFloor = true;
        if (row.err === null) {
          return failure(
            "pre_activation_activity",
            "mint has successful on-chain activity at or before activation",
          );
        }
        continue;
      }
      if (slot <= requestedHeadSlot) rows.push(row);
    }

    if (crossedFloor) break;
    const tail = page[page.length - 1];
    if (!tail?.signature || tail.signature === before) {
      return failure("signature_page_conflict", "mint signature pagination made no progress");
    }
    before = tail.signature;
  }

  if (!crossedFloor) {
    return failure(
      "signature_page_limit",
      "mint signature history did not reach the activation floor within its fixed page budget",
    );
  }
  return { rows };
}

/**
 * Proves that `mint` was created by the reviewed Pump ABI strictly after a
 * common finalized activation boundary and no later than the finalized proof
 * head. This is intentionally independent of environment/config state and of
 * the legacy custody cursor.
 */
export async function attestFreshPumpFunCreate(
  rpc: PumpFunCreateProofConnection,
  request: PumpFunCreateAttestationRequest,
): Promise<PumpFunCreateProofResult> {
  const activationSlot = positiveSafeSlot(request.activation.slot);
  const headSlot = positiveSafeSlot(request.requestedHead.slot);
  const triggerSlot = positiveSafeSlot(request.triggerSlot);
  let mint: PublicKey;
  try {
    mint = new PublicKey(request.mint);
  } catch {
    return failure("invalid_request", "mint is not a Solana public key");
  }
  if (
    activationSlot === null ||
    headSlot === null ||
    triggerSlot === null ||
    !request.triggerTxSig?.trim() ||
    !request.activation.blockhash ||
    !request.requestedHead.blockhash ||
    headSlot <= activationSlot ||
    headSlot < triggerSlot
  ) {
    return failure("invalid_request", "fresh Pump proof boundaries are invalid");
  }
  const timeoutMs = Math.max(250, Math.trunc(request.rpcCallTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS));
  const nowMs = request.nowMs ?? Date.now;
  const startedAtMs = Number(nowMs());
  const deadlineMs = Number(request.deadlineMs ?? startedAtMs + DEFAULT_OPERATION_BUDGET_MS);
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs <= 0 || !Number.isSafeInteger(deadlineMs)) {
    return failure("invalid_request", "fresh Pump proof clock/deadline is invalid");
  }
  const deadline: PumpFunCreateDeadline = { deadlineMs, rpcCallTimeoutMs: timeoutMs, nowMs };
  const maxPages = Math.max(
    1,
    Math.min(32, Math.trunc(request.maxSignaturePages ?? DEFAULT_MAX_SIGNATURE_PAGES)),
  );

  const activationFailure = await verifyBlockBoundary(
    rpc,
    request.activation,
    "activation",
    deadline,
  );
  if (activationFailure) return activationFailure;
  const headFailure = await verifyBlockBoundary(rpc, request.requestedHead, "head", deadline);
  if (headFailure) return headFailure;

  const loaded = await loadEpochSignatures(rpc, mint, activationSlot, headSlot, maxPages, deadline);
  if (!("rows" in loaded)) return loaded;
  if (loaded.rows.length === 0) {
    return failure("create_not_found", "mint has no finalized post-activation transactions");
  }

  const ordered = [...loaded.rows].sort((left, right) => left.slot - right.slot);
  let create:
    | {
        row: SignatureRow;
        parsed: ParsedCreate;
        blockTimeMs: number;
      }
    | undefined;
  let triggerTransaction: ParsedTransactionWithMeta | undefined;
  for (let offset = 0; offset < ordered.length; offset += 50) {
    const batch = ordered.slice(offset, offset + 50);
    const batchTimeoutMs = remainingRpcTimeout(deadline);
    if (batchTimeoutMs === null) {
      return deadlineFailure("a finalized creation transaction batch");
    }
    let transactions: Array<ParsedTransactionWithMeta | null>;
    try {
      transactions = await solanaRpcWithTimeout(
        rpc.getParsedTransactions(
          batch.map((row) => row.signature),
          { commitment: "finalized", maxSupportedTransactionVersion: 0 },
        ),
        batchTimeoutMs,
      );
    } catch (error) {
      return rpcFailureOrDeadline(deadline, "finalized creation transaction load", error);
    }
    if (transactions.length !== batch.length || transactions.some((tx) => tx === null)) {
      return failure(
        "transaction_unavailable",
        "a finalized mint transaction required for creation proof is unavailable",
        true,
      );
    }

    // JSON-RPC batch responses are not ordered by contract. Bind every result
    // back to its exact first signature instead of trusting array position.
    const transactionsBySignature = new Map<string, ParsedTransactionWithMeta>();
    for (const candidate of transactions) {
      const tx = candidate!;
      const signature = String(tx.transaction.signatures[0] ?? "");
      if (!signature || transactionsBySignature.has(signature)) {
        return failure(
          "transaction_identity_conflict",
          "finalized transaction batch contains a missing or duplicate identity",
        );
      }
      transactionsBySignature.set(signature, tx);
    }
    if (
      transactionsBySignature.size !== batch.length ||
      batch.some((row) => !transactionsBySignature.has(row.signature))
    ) {
      return failure(
        "transaction_identity_conflict",
        "finalized transaction batch does not match the requested signature set",
      );
    }

    for (let index = 0; index < batch.length; index += 1) {
      const row = batch[index]!;
      const tx = transactionsBySignature.get(row.signature)!;
      const txSig = String(tx.transaction.signatures[0] ?? "");
      const txSlot = positiveSafeSlot(tx.slot);
      const txBlockTime = Number(tx.blockTime);
      if (
        txSig !== row.signature ||
        txSlot !== row.slot ||
        !Number.isSafeInteger(txBlockTime) ||
        txBlockTime <= 0 ||
        (row.blockTime !== null && row.blockTime !== txBlockTime) ||
        (row.err === null) !== (tx.meta?.err === null)
      ) {
        return failure(
          "transaction_identity_conflict",
          "finalized mint transaction does not match its signature-page identity",
        );
      }
      if (tx.meta?.err !== null) continue;
      if (txSig === request.triggerTxSig) triggerTransaction = tx;
      const parsed = parsePumpFunCreateTransaction(tx, mint.toBase58());
      if (parsed.kind === "malformed") {
        return failure("malformed_create_instruction", parsed.reason);
      }
      if (parsed.kind !== "valid") continue;
      if (tx.slot <= activationSlot || tx.slot > headSlot) {
        return failure(
          "malformed_create_instruction",
          "Pump create falls outside proof boundaries",
        );
      }
      if (tx.slot > triggerSlot) {
        return failure(
          "creation_not_before_trigger",
          "Pump create finalized after the enrollment trigger",
        );
      }
      if (create) {
        return failure("create_conflict", "more than one finalized Pump create proof exists");
      }
      create = {
        row,
        parsed: parsed.value,
        blockTimeMs: txBlockTime * 1_000,
      };
    }
  }

  if (!create) {
    return failure(
      "create_not_found",
      "reviewed Pump create instruction was not found after activation",
    );
  }
  if (!triggerTransaction) {
    return failure(
      "trigger_transaction_unavailable",
      "exact finalized root-buy trigger transaction is absent from the proved mint range",
      true,
    );
  }
  if (
    request.triggerBuyEvidence.txSig !== request.triggerTxSig ||
    request.triggerBuyEvidence.slot !== triggerSlot ||
    request.triggerBuyEvidence.mint !== mint.toBase58()
  ) {
    return failure(
      "trigger_evidence_invalid",
      "fresh root-buy evidence does not match the requested trigger identity",
    );
  }
  const evidenceFailure = verifyFreshRootBuyEvidenceIdentity(
    triggerTransaction,
    request.triggerBuyEvidence,
  );
  if (evidenceFailure) return failure("trigger_evidence_invalid", evidenceFailure);

  let creationBlock: { blockhash?: unknown; signatures?: unknown } | null;
  const creationBlockTimeoutMs = remainingRpcTimeout(deadline);
  if (creationBlockTimeoutMs === null) {
    return deadlineFailure("the finalized creation block proof");
  }
  try {
    creationBlock = (await solanaRpcWithTimeout(
      rpc.getBlockSignatures(create.row.slot, "finalized") as Promise<unknown>,
      creationBlockTimeoutMs,
    )) as { blockhash?: unknown; signatures?: unknown } | null;
  } catch (error) {
    return rpcFailureOrDeadline(deadline, "finalized creation block load", error);
  }
  if (!creationBlock) {
    return failure(
      "creation_block_unavailable",
      "finalized Pump creation block is unavailable",
      true,
    );
  }
  const creationBlockhash =
    typeof creationBlock.blockhash === "string" ? creationBlock.blockhash.trim() : "";
  if (
    !creationBlockhash ||
    !Array.isArray(creationBlock.signatures) ||
    !creationBlock.signatures.includes(create.row.signature)
  ) {
    return failure(
      "transaction_identity_conflict",
      "finalized creation block does not contain the proved Pump transaction",
    );
  }
  if (create.row.slot === triggerSlot) {
    const signatures = creationBlock.signatures.filter(
      (signature): signature is string => typeof signature === "string",
    );
    if (create.row.signature !== request.triggerTxSig) {
      const createIndex = signatures.indexOf(create.row.signature);
      const triggerIndex = signatures.indexOf(request.triggerTxSig);
      if (createIndex < 0 || triggerIndex < 0 || createIndex >= triggerIndex) {
        return failure(
          "same_slot_order_unproved",
          "same-slot Pump create is not canonically ordered before the root-buy trigger",
        );
      }
    }
  }

  let snapshot: ReviewedPumpStateSnapshot | null | PumpFunCreateProofResult;
  try {
    snapshot = await loadReviewedPumpState(rpc, mint, create.parsed, headSlot, deadline);
  } catch (error) {
    return rpcFailureOrDeadline(deadline, "finalized Pump curve read", error);
  }
  if (snapshot && "ok" in snapshot) return snapshot;
  if (!snapshot) {
    return failure(
      "curve_state_invalid",
      "finalized Pump curve and mint state do not match the reviewed classic/Token-2022 contract",
    );
  }
  if (snapshot.complete) {
    return failure(
      "curve_completed",
      "Pump curve is already completed or graduated and is not a fresh pre-graduation candidate",
    );
  }
  if (snapshot.totalSupplyRaw !== PUMP_FUN_STANDARD_TOTAL_SUPPLY_RAW || snapshot.decimals !== 6) {
    return failure(
      "curve_state_invalid",
      "fresh Pump launch does not have the frozen 1B-token/6-decimal supply contract",
      false,
    );
  }
  if (snapshot.observedSlot < headSlot) {
    return failure(
      "curve_state_unavailable",
      "finalized Pump state was returned below the requested proof head",
      true,
    );
  }

  const stableIdentityFields = {
    abi: PUMP_FUN_CREATE_PROOF_ABI,
    mint: mint.toBase58(),
    creator: create.parsed.creator,
    txSig: create.row.signature,
    slot: create.row.slot,
    blockTimeMs: create.blockTimeMs,
    blockhash: creationBlockhash,
    bondingCurve: create.parsed.bondingCurve,
    createVariant: create.parsed.variant,
    tokenProgram: snapshot.tokenProgram,
    mintLayoutFingerprint: snapshot.mintLayoutFingerprint,
    totalSupplyRaw: snapshot.totalSupplyRaw.toString(),
    decimals: snapshot.decimals,
    activationSlot,
    activationBlockhash: request.activation.blockhash,
  } as const;

  return {
    ok: true,
    proof: {
      fingerprint: createHash("sha256").update(JSON.stringify(stableIdentityFields)).digest("hex"),
      ...stableIdentityFields,
      stateObservedSlot: snapshot.observedSlot,
      requestedHeadSlot: headSlot,
    },
    snapshot,
  };
}
