import { createHash } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { FRESH_TAIL_PARSER_ABIS, type FreshTailParserDomain } from "./fresh-tail-parser-abis.js";
import {
  buildVerifiedFreshRootBuyEvidence,
  type VerifiedFreshRootBuyEvidence,
} from "./fresh-tail-root-buy-evidence.js";
import {
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_STANDARD_TOTAL_SUPPLY_RAW,
  pumpFunBondingCurveAddress,
} from "./pump-fun-supply.js";

const PUMP_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const PUMP_FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

const BUY_DISCRIMINATOR = "66063d1201daebea";
const BUY_EXACT_SOL_IN_DISCRIMINATOR = "38fc74089edfcd5f";
const BUY_V2_DISCRIMINATOR = "b817ee6167c5d33d";
const BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR = "c2ab1c46684d5b2f";
const SELL_DISCRIMINATOR = "33e685a4017f83ad";
const SELL_V2_DISCRIMINATOR = "5df6823ce7e940b2";
const EVENT_CPI_DISCRIMINATOR = "e445a52e51cb9a1d";
const TRADE_EVENT_DISCRIMINATOR = "bddb7fd34ee661ee";

type PumpTradeVariant =
  | "buy"
  | "buy_exact_sol_in"
  | "buy_v2"
  | "buy_exact_quote_in_v2"
  | "sell"
  | "sell_v2";

export type FreshTailMintContract = {
  mint: string;
  bondingCurve: string;
  creator: string;
  createVariant: "classic_v1" | "create_v2_token2022";
  tokenProgram: string;
  totalSupplyRaw: string;
  decimals: number;
};

export type FreshTailWalletRole = "root" | "descendant";

export type FreshTailRawRecipient = {
  wallet: string;
  amountRaw: string;
  preRaw: string;
  postRaw: string;
};

export type FreshTailRecipientClassification = FreshTailRawRecipient & {
  classification: string;
  classificationReliable: boolean;
  watchable: boolean;
};

type FreshTailEventCommon = {
  eventKey: string;
  payloadFingerprint: string;
  txSig: string;
  slot: number;
  blockTimeMs: number;
  tokenMint: string;
  amountRaw: string;
  decimals: number;
  parserDomain: FreshTailParserDomain;
  parserAbiFingerprint: string;
};

export type FreshTailSupplyEvent = FreshTailEventCommon & {
  ledger: "supply";
  side: "BUY" | "SELL";
  targetWallet: string;
  totalSupplyRaw: string;
  pumpFunVerified: true;
  classificationReliable: true;
};

export type FreshTailCustodyEventDraft = Omit<FreshTailEventCommon, "payloadFingerprint"> & {
  ledger: "custody";
  eventKind: "TARGET_BUY" | "TRANSFER" | "SELL" | "UNRESOLVED_OUTFLOW" | "TERMINAL_OUTFLOW";
  sourceWallet: string;
  sourcePreRaw: string;
  sourcePostRaw: string;
  classification: string;
  classificationReliable: boolean;
  watchable: boolean;
  recipients: FreshTailRawRecipient[];
};

export type FreshTailCustodyEvent = Omit<FreshTailCustodyEventDraft, "recipients"> & {
  payloadFingerprint: string;
  recipients: FreshTailRecipientClassification[];
};

export type FreshTailDecodeSuccess = {
  ok: true;
  supplyEvents: FreshTailSupplyEvent[];
  custodyEvents: FreshTailCustodyEventDraft[];
  rootBuyEvidence?: VerifiedFreshRootBuyEvidence;
  pumpTradeEventEvidence?: FreshTailPumpTradeEventEvidence;
};

export type FreshTailDecodeFailureCode =
  | "invalid_request"
  | "transaction_identity_invalid"
  | "token_balance_invalid"
  | "pump_instruction_conflict";

export type FreshTailDecodeResult =
  | FreshTailDecodeSuccess
  | {
      ok: false;
      code: FreshTailDecodeFailureCode;
      reason: string;
      retryable: false;
    };

export type FreshTailRootBuyDiscovery = {
  tokenMint: string;
  contract: FreshTailMintContract;
  decoded: FreshTailDecodeResult;
};

export type FreshTailRootBuyDiscoveryResult =
  | { ok: true; discoveries: FreshTailRootBuyDiscovery[] }
  | {
      ok: false;
      code: "transaction_identity_invalid" | "pump_instruction_conflict";
      reason: string;
      retryable: false;
    };

type AccountEntry = { pubkey: string; signer: boolean; writable: boolean };

type InstructionView = {
  programId: string;
  accounts: string[];
  data: Buffer | null;
};

type OwnerBalance = {
  owner: string;
  preRaw: bigint;
  postRaw: bigint;
  accountIndexes: number[];
};

type RelevantAccountBalance = {
  accountIndex: number;
  accountAddress: string;
  owner: string;
  preRaw: bigint;
  postRaw: bigint;
};

type TokenLedger = {
  owners: Map<string, OwnerBalance>;
  accounts: RelevantAccountBalance[];
  netDeltaRaw: bigint;
};

type PumpTrade = {
  side: "buy" | "sell";
  variant: PumpTradeVariant;
  user: string;
  instructionAmountRaw: bigint;
  baseTokenAccount: string;
};

export type FreshTailPumpTradeEventEvidence = {
  mint: string;
  user: string;
  side: "buy" | "sell";
  tokenAmountRaw: string;
  solAmountLamports: string;
  timestampSeconds: number;
  virtualSolReservesLamports: string;
  virtualTokenReservesRaw: string;
  realSolReservesLamports: string;
  realTokenReservesRaw: string;
  creator: string;
  quoteMint: string;
  quoteAmountRaw: string;
  virtualQuoteReservesRaw: string;
  realQuoteReservesRaw: string;
  instructionName: "buy" | "buy_exact_sol_in" | "buy_exact_quote_in" | "sell";
  eventPayloadFingerprint: string;
};

type PumpTradeParse =
  | { kind: "absent" }
  | { kind: "valid"; trade: PumpTrade }
  | { kind: "conflict"; reason: string };

type PumpTradeEventParse =
  | { kind: "absent" }
  | { kind: "valid"; event: FreshTailPumpTradeEventEvidence }
  | { kind: "conflict"; reason: string };

function failure(code: FreshTailDecodeFailureCode, reason: string): FreshTailDecodeResult {
  return { ok: false, code, reason, retryable: false };
}

function keyText(value: unknown): string | null {
  try {
    return new PublicKey(
      typeof value === "string"
        ? value
        : ((value as { toBase58?: () => string } | null)?.toBase58?.() ?? String(value ?? "")),
    ).toBase58();
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "number") return Number.isFinite(item) ? item : String(item);
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item === "object") {
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

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function messageAccounts(tx: ParsedTransactionWithMeta): AccountEntry[] | null {
  const message = tx.transaction.message as unknown as {
    accountKeys?: unknown[];
    staticAccountKeys?: unknown[];
    header?: {
      numRequiredSignatures?: number;
      numReadonlySignedAccounts?: number;
      numReadonlyUnsignedAccounts?: number;
    };
  };
  const raw = message.accountKeys ?? message.staticAccountKeys;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const required = Number(message.header?.numRequiredSignatures ?? 0);
  const readonlySigned = Number(message.header?.numReadonlySignedAccounts ?? 0);
  const readonlyUnsigned = Number(message.header?.numReadonlyUnsignedAccounts ?? 0);
  const result: AccountEntry[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index] as { pubkey?: unknown; signer?: unknown; writable?: unknown };
    const pubkey = keyText(entry?.pubkey ?? raw[index]);
    if (!pubkey) return null;
    const signer =
      typeof entry?.signer === "boolean" ? entry.signer : required > 0 && index < required;
    const writable =
      typeof entry?.writable === "boolean"
        ? entry.writable
        : signer
          ? index < Math.max(0, required - readonlySigned)
          : index < Math.max(required, raw.length - readonlyUnsigned);
    result.push({ pubkey, signer, writable });
  }
  return result;
}

function instructionView(
  instruction: unknown,
  accountKeys: readonly string[],
): InstructionView | null {
  const row = instruction as {
    programId?: unknown;
    programIdIndex?: unknown;
    accounts?: unknown;
    data?: unknown;
  };
  const directProgram = keyText(row?.programId);
  const programIndex = Number(row?.programIdIndex);
  const programId =
    directProgram ??
    (Number.isSafeInteger(programIndex) && programIndex >= 0
      ? (accountKeys[programIndex] ?? null)
      : null);
  if (!programId || !Array.isArray(row.accounts)) return null;
  const accounts = row.accounts.map((entry) => {
    if (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0) {
      return accountKeys[entry] ?? null;
    }
    return keyText(entry);
  });
  if (accounts.some((entry) => entry === null)) return null;
  let data: Buffer | null = null;
  if (typeof row.data === "string" && row.data.length > 0) {
    try {
      data = Buffer.from(bs58.decode(row.data));
    } catch {
      return null;
    }
  }
  return { programId, accounts: accounts as string[], data };
}

function transactionInstructions(
  tx: ParsedTransactionWithMeta,
  accountKeys: readonly string[],
): { views: InstructionView[]; malformedPumpInstruction: boolean } {
  const message = tx.transaction.message as unknown as { instructions?: unknown[] };
  const raw: unknown[] = Array.isArray(message.instructions) ? [...message.instructions] : [];
  for (const group of tx.meta?.innerInstructions ?? []) {
    if (Array.isArray(group.instructions)) raw.push(...group.instructions);
  }
  const views: InstructionView[] = [];
  let malformedPumpInstruction = false;
  for (const instruction of raw) {
    const view = instructionView(instruction, accountKeys);
    if (view) {
      views.push(view);
      continue;
    }
    const directProgram = keyText((instruction as { programId?: unknown })?.programId);
    const programIndex = Number((instruction as { programIdIndex?: unknown })?.programIdIndex);
    const programId =
      directProgram ??
      (Number.isSafeInteger(programIndex) && programIndex >= 0
        ? accountKeys[programIndex]
        : undefined);
    if (programId === PUMP_FUN_PROGRAM_ID.toBase58()) malformedPumpInstruction = true;
  }
  return { views, malformedPumpInstruction };
}

function parseRaw(value: unknown): bigint | null {
  const text = typeof value === "string" ? value : "";
  if (!/^[0-9]+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function buildTokenLedger(
  tx: ParsedTransactionWithMeta,
  accountEntries: readonly AccountEntry[],
  contract: FreshTailMintContract,
): TokenLedger | string {
  type SideRow = {
    accountIndex: number;
    owner: string;
    amountRaw: bigint;
    programId: string;
    decimals: number;
  };
  const pre = new Map<number, SideRow>();
  const post = new Map<number, SideRow>();
  const ingest = (rawRows: readonly any[], destination: Map<number, SideRow>): string | null => {
    for (const row of rawRows) {
      if (String(row?.mint ?? "") !== contract.mint) continue;
      const accountIndex = Number(row?.accountIndex);
      const owner = keyText(row?.owner);
      const programId = keyText(row?.programId);
      const amountRaw = parseRaw(row?.uiTokenAmount?.amount);
      const decimals = Number(row?.uiTokenAmount?.decimals);
      if (
        !Number.isSafeInteger(accountIndex) ||
        accountIndex < 0 ||
        accountIndex >= accountEntries.length ||
        !owner ||
        programId !== contract.tokenProgram ||
        amountRaw === null ||
        !Number.isSafeInteger(decimals) ||
        decimals !== contract.decimals ||
        destination.has(accountIndex)
      ) {
        return "enrolled-mint token balance row is malformed, duplicated, or changes ABI";
      }
      destination.set(accountIndex, { accountIndex, owner, amountRaw, programId, decimals });
    }
    return null;
  };
  const preError = ingest((tx.meta?.preTokenBalances ?? []) as any[], pre);
  if (preError) return preError;
  const postError = ingest((tx.meta?.postTokenBalances ?? []) as any[], post);
  if (postError) return postError;

  const accountIndexes = new Set([...pre.keys(), ...post.keys()]);
  const accounts: RelevantAccountBalance[] = [];
  const owners = new Map<string, OwnerBalance>();
  for (const accountIndex of [...accountIndexes].sort((left, right) => left - right)) {
    const before = pre.get(accountIndex);
    const after = post.get(accountIndex);
    if (
      before &&
      after &&
      (before.owner !== after.owner ||
        before.programId !== after.programId ||
        before.decimals !== after.decimals)
    ) {
      return "token account identity changed between pre and post balances";
    }
    const identity = before ?? after;
    if (!identity) return "token account identity is missing";
    const row: RelevantAccountBalance = {
      accountIndex,
      accountAddress: accountEntries[accountIndex]!.pubkey,
      owner: identity.owner,
      preRaw: before?.amountRaw ?? 0n,
      postRaw: after?.amountRaw ?? 0n,
    };
    accounts.push(row);
    const owner = owners.get(row.owner) ?? {
      owner: row.owner,
      preRaw: 0n,
      postRaw: 0n,
      accountIndexes: [],
    };
    owner.preRaw += row.preRaw;
    owner.postRaw += row.postRaw;
    owner.accountIndexes.push(accountIndex);
    owners.set(row.owner, owner);
  }
  const net = [...owners.values()].reduce((sum, row) => sum + row.postRaw - row.preRaw, 0n);
  return { owners, accounts, netDeltaRaw: net };
}

function pda(seeds: readonly Buffer[], program = PUMP_FUN_PROGRAM_ID): string {
  return PublicKey.findProgramAddressSync([...seeds], program)[0].toBase58();
}

function ata(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): string {
  return getAssociatedTokenAddressSync(
    mint,
    owner,
    true,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ).toBase58();
}

function u64(data: Buffer, offset: number): bigint | null {
  try {
    return data.readBigUInt64LE(offset);
  } catch {
    return null;
  }
}

class BorshReader {
  private offset = 0;

  constructor(private readonly data: Buffer) {}

  private take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.data.length) {
      throw new Error("borsh payload is truncated");
    }
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  bytes(length: number): Buffer {
    return this.take(length);
  }

  bool(): boolean {
    const value = this.take(1)[0]!;
    if (value !== 0 && value !== 1) throw new Error("borsh bool is non-canonical");
    return value === 1;
  }

  u16(): number {
    return this.take(2).readUInt16LE(0);
  }

  u32(): number {
    return this.take(4).readUInt32LE(0);
  }

  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }

  i64(): bigint {
    return this.take(8).readBigInt64LE(0);
  }

  publicKey(): string {
    return new PublicKey(this.take(32)).toBase58();
  }

  string(maxBytes: number): string {
    const length = this.u32();
    if (length > maxBytes) throw new Error("borsh string exceeds reviewed maximum");
    const bytes = this.take(length);
    const value = bytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(bytes)) {
      throw new Error("borsh string is not canonical UTF-8");
    }
    return value;
  }

  done(): boolean {
    return this.offset === this.data.length;
  }
}

function parsePumpTradeEvent(instruction: InstructionView): PumpTradeEventParse {
  if (instruction.programId !== PUMP_FUN_PROGRAM_ID.toBase58() || !instruction.data) {
    return { kind: "absent" };
  }
  const prefix = instruction.data.subarray(0, 8).toString("hex");
  if (prefix !== EVENT_CPI_DISCRIMINATOR) return { kind: "absent" };
  if (
    instruction.accounts.length !== 1 ||
    instruction.accounts[0] !== PUMP_EVENT_AUTHORITY.toBase58()
  ) {
    return { kind: "conflict", reason: "Pump TradeEvent CPI account contract changed" };
  }
  try {
    const reader = new BorshReader(instruction.data);
    if (
      reader.bytes(8).toString("hex") !== EVENT_CPI_DISCRIMINATOR ||
      reader.bytes(8).toString("hex") !== TRADE_EVENT_DISCRIMINATOR
    ) {
      return { kind: "conflict", reason: "Pump TradeEvent discriminator changed" };
    }
    const full = {
      mint: reader.publicKey(),
      solAmountLamports: reader.u64(),
      tokenAmountRaw: reader.u64(),
      isBuy: reader.bool(),
      user: reader.publicKey(),
      timestampSeconds: reader.i64(),
      virtualSolReservesLamports: reader.u64(),
      virtualTokenReservesRaw: reader.u64(),
      realSolReservesLamports: reader.u64(),
      realTokenReservesRaw: reader.u64(),
      feeRecipient: reader.publicKey(),
      feeBasisPoints: reader.u64(),
      feeLamports: reader.u64(),
      creator: reader.publicKey(),
      creatorFeeBasisPoints: reader.u64(),
      creatorFeeLamports: reader.u64(),
      trackVolume: reader.bool(),
      totalUnclaimedTokensRaw: reader.u64(),
      totalClaimedTokensRaw: reader.u64(),
      currentSolVolumeLamports: reader.u64(),
      lastUpdateTimestamp: reader.i64(),
      instructionName: reader.string(64),
      mayhemMode: reader.bool(),
      cashbackFeeBasisPoints: reader.u64(),
      cashbackLamports: reader.u64(),
      buybackFeeBasisPoints: reader.u64(),
      buybackFeeLamports: reader.u64(),
      shareholders: [] as Array<{ address: string; shareBps: number }>,
      quoteMint: "",
      quoteAmountRaw: 0n,
      virtualQuoteReservesRaw: 0n,
      realQuoteReservesRaw: 0n,
    };
    const shareholderCount = reader.u32();
    if (shareholderCount > 128) {
      return { kind: "conflict", reason: "Pump TradeEvent shareholder vector is unbounded" };
    }
    const shareholderAddresses = new Set<string>();
    let shareholderBps = 0;
    for (let index = 0; index < shareholderCount; index += 1) {
      const address = reader.publicKey();
      const shareBps = reader.u16();
      if (
        shareholderAddresses.has(address) ||
        shareBps <= 0 ||
        shareBps > 10_000 ||
        shareholderBps + shareBps > 10_000
      ) {
        return { kind: "conflict", reason: "Pump TradeEvent shareholder vector is invalid" };
      }
      shareholderAddresses.add(address);
      shareholderBps += shareBps;
      full.shareholders.push({ address, shareBps });
    }
    full.quoteMint = reader.publicKey();
    full.quoteAmountRaw = reader.u64();
    full.virtualQuoteReservesRaw = reader.u64();
    full.realQuoteReservesRaw = reader.u64();
    if (!reader.done()) {
      return { kind: "conflict", reason: "Pump TradeEvent has unreviewed trailing fields" };
    }
    if (
      full.solAmountLamports <= 0n ||
      full.tokenAmountRaw <= 0n ||
      full.virtualSolReservesLamports <= 0n ||
      full.virtualTokenReservesRaw <= 0n ||
      full.realTokenReservesRaw < 0n ||
      full.realSolReservesLamports < 0n ||
      full.timestampSeconds <= 0n ||
      full.timestampSeconds > BigInt(Number.MAX_SAFE_INTEGER) ||
      !["buy", "buy_exact_sol_in", "buy_exact_quote_in", "sell"].includes(full.instructionName)
    ) {
      return { kind: "conflict", reason: "Pump TradeEvent values are outside reviewed bounds" };
    }
    const eventPayloadFingerprint = fingerprint(full);
    return {
      kind: "valid",
      event: {
        mint: full.mint,
        user: full.user,
        side: full.isBuy ? "buy" : "sell",
        tokenAmountRaw: full.tokenAmountRaw.toString(),
        solAmountLamports: full.solAmountLamports.toString(),
        timestampSeconds: Number(full.timestampSeconds),
        virtualSolReservesLamports: full.virtualSolReservesLamports.toString(),
        virtualTokenReservesRaw: full.virtualTokenReservesRaw.toString(),
        realSolReservesLamports: full.realSolReservesLamports.toString(),
        realTokenReservesRaw: full.realTokenReservesRaw.toString(),
        creator: full.creator,
        quoteMint: full.quoteMint,
        quoteAmountRaw: full.quoteAmountRaw.toString(),
        virtualQuoteReservesRaw: full.virtualQuoteReservesRaw.toString(),
        realQuoteReservesRaw: full.realQuoteReservesRaw.toString(),
        instructionName: full.instructionName as FreshTailPumpTradeEventEvidence["instructionName"],
        eventPayloadFingerprint,
      },
    };
  } catch {
    return { kind: "conflict", reason: "Pump TradeEvent is not exact reviewed Borsh" };
  }
}

function exactAccountContract(
  instruction: InstructionView,
  contract: FreshTailMintContract,
  variant: PumpTradeVariant,
): { user: string; amount: bigint; baseTokenAccount: string } | string {
  const mint = new PublicKey(contract.mint);
  const curve = new PublicKey(contract.bondingCurve);
  const creator = new PublicKey(contract.creator);
  const tokenProgram = new PublicKey(contract.tokenProgram);
  const global = pda([Buffer.from("global")]);
  const creatorVault = pda([Buffer.from("creator-vault"), creator.toBuffer()]);
  const feeConfig = pda(
    [Buffer.from("fee_config"), PUMP_FUN_PROGRAM_ID.toBuffer()],
    PUMP_FEE_PROGRAM,
  );
  const data = instruction.data!;
  const amount = u64(data, 8);
  if (amount === null || amount <= 0n) return "Pump trade amount is not a positive u64";

  if (variant === "buy" || variant === "buy_exact_sol_in" || variant === "sell") {
    const isSell = variant === "sell";
    const baseCount = isSell ? 14 : 16;
    const permittedCounts = isSell ? [14, 16] : [16, 18];
    if (!permittedCounts.includes(instruction.accounts.length)) {
      return "legacy Pump trade account count is outside the reviewed contract";
    }
    const accounts = instruction.accounts;
    const user = accounts[6]!;
    const expectedBase = isSell
      ? [
          global,
          null,
          contract.mint,
          contract.bondingCurve,
          ata(mint, curve, tokenProgram),
          null,
          user,
          SystemProgram.programId.toBase58(),
          creatorVault,
          contract.tokenProgram,
          PUMP_EVENT_AUTHORITY.toBase58(),
          PUMP_FUN_PROGRAM_ID.toBase58(),
          feeConfig,
          PUMP_FEE_PROGRAM.toBase58(),
        ]
      : [
          global,
          null,
          contract.mint,
          contract.bondingCurve,
          ata(mint, curve, tokenProgram),
          null,
          user,
          SystemProgram.programId.toBase58(),
          contract.tokenProgram,
          creatorVault,
          PUMP_EVENT_AUTHORITY.toBase58(),
          PUMP_FUN_PROGRAM_ID.toBase58(),
          pda([Buffer.from("global_volume_accumulator")]),
          pda([Buffer.from("user_volume_accumulator"), new PublicKey(user).toBuffer()]),
          feeConfig,
          PUMP_FEE_PROGRAM.toBase58(),
        ];
    if (expectedBase.length !== baseCount) return "internal legacy account contract mismatch";
    for (let index = 0; index < baseCount; index += 1) {
      if (expectedBase[index] !== null && accounts[index] !== expectedBase[index]) {
        return `legacy Pump trade account ${index} does not match the frozen contract`;
      }
    }
    if (
      accounts.length === baseCount + 2 &&
      accounts[baseCount] !== pda([Buffer.from("bonding-curve-v2"), mint.toBuffer()])
    ) {
      return "legacy Pump trade bonding-curve-v2 remaining account is invalid";
    }
    return { user, amount, baseTokenAccount: accounts[5]! };
  }

  const isSell = variant === "sell_v2";
  const expectedCount = isSell ? 26 : 27;
  if (instruction.accounts.length !== expectedCount) {
    return "Pump V2 trade account count does not match the frozen contract";
  }
  const accounts = instruction.accounts;
  const user = accounts[13]!;
  const quoteTokenProgram = TOKEN_PROGRAM_ID;
  const quoteMint = WSOL_MINT;
  const feeRecipient = new PublicKey(accounts[6]!);
  const buybackRecipient = new PublicKey(accounts[8]!);
  const userKey = new PublicKey(user);
  const userVolume = pda([Buffer.from("user_volume_accumulator"), userKey.toBuffer()]);
  const sharingConfig = pda([Buffer.from("sharing-config"), mint.toBuffer()], PUMP_FEE_PROGRAM);
  const common = [
    global,
    contract.mint,
    quoteMint.toBase58(),
    contract.tokenProgram,
    quoteTokenProgram.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    accounts[6],
    ata(quoteMint, feeRecipient, quoteTokenProgram),
    accounts[8],
    ata(quoteMint, buybackRecipient, quoteTokenProgram),
    contract.bondingCurve,
    ata(mint, curve, tokenProgram),
    ata(quoteMint, curve, quoteTokenProgram),
    user,
    accounts[14],
    ata(quoteMint, userKey, quoteTokenProgram),
    creatorVault,
    ata(quoteMint, new PublicKey(creatorVault), quoteTokenProgram),
    sharingConfig,
  ];
  const tail = isSell
    ? [
        userVolume,
        ata(quoteMint, new PublicKey(userVolume), quoteTokenProgram),
        feeConfig,
        PUMP_FEE_PROGRAM.toBase58(),
        SystemProgram.programId.toBase58(),
        PUMP_EVENT_AUTHORITY.toBase58(),
        PUMP_FUN_PROGRAM_ID.toBase58(),
      ]
    : [
        pda([Buffer.from("global_volume_accumulator")]),
        userVolume,
        ata(quoteMint, new PublicKey(userVolume), quoteTokenProgram),
        feeConfig,
        PUMP_FEE_PROGRAM.toBase58(),
        SystemProgram.programId.toBase58(),
        PUMP_EVENT_AUTHORITY.toBase58(),
        PUMP_FUN_PROGRAM_ID.toBase58(),
      ];
  const expected = [...common, ...tail];
  for (let index = 0; index < expected.length; index += 1) {
    if (accounts[index] !== expected[index]) {
      return `Pump V2 trade account ${index} does not match the frozen contract`;
    }
  }
  return { user, amount, baseTokenAccount: accounts[14]! };
}

function parsePumpTrade(
  instruction: InstructionView,
  contract: FreshTailMintContract,
): PumpTradeParse {
  if (instruction.programId !== PUMP_FUN_PROGRAM_ID.toBase58() || !instruction.data) {
    return { kind: "absent" };
  }
  const discriminator = instruction.data.subarray(0, 8).toString("hex");
  let variant: PumpTradeVariant | null = null;
  let expectedLengths: readonly number[] = [];
  if (discriminator === BUY_DISCRIMINATOR) {
    variant = "buy";
    expectedLengths = [24, 25];
  } else if (discriminator === BUY_EXACT_SOL_IN_DISCRIMINATOR) {
    variant = "buy_exact_sol_in";
    expectedLengths = [25];
  } else if (discriminator === BUY_V2_DISCRIMINATOR) {
    variant = "buy_v2";
    expectedLengths = [24];
  } else if (discriminator === BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR) {
    variant = "buy_exact_quote_in_v2";
    expectedLengths = [24];
  } else if (discriminator === SELL_DISCRIMINATOR) {
    variant = "sell";
    expectedLengths = [24];
  } else if (discriminator === SELL_V2_DISCRIMINATOR) {
    variant = "sell_v2";
    expectedLengths = [24];
  } else {
    return { kind: "absent" };
  }

  const mintIndex = variant.endsWith("_v2") || variant.includes("quote_in_v2") ? 1 : 2;
  if (instruction.accounts[mintIndex] !== contract.mint) return { kind: "absent" };
  if (!expectedLengths.includes(instruction.data.length)) {
    return { kind: "conflict", reason: "Pump trade data length changed from the reviewed ABI" };
  }
  if (instruction.data.length === 25 && ![0, 1].includes(instruction.data[24]!)) {
    return { kind: "conflict", reason: "Pump trade option-bool encoding is invalid" };
  }
  let exact: { user: string; amount: bigint; baseTokenAccount: string } | string;
  try {
    exact = exactAccountContract(instruction, contract, variant);
  } catch {
    return { kind: "conflict", reason: "Pump trade contains an invalid public key contract" };
  }
  if (typeof exact === "string") return { kind: "conflict", reason: exact };
  return {
    kind: "valid",
    trade: {
      side: variant === "sell" || variant === "sell_v2" ? "sell" : "buy",
      variant,
      user: exact.user,
      instructionAmountRaw: exact.amount,
      baseTokenAccount: exact.baseTokenAccount,
    },
  };
}

function expectedTradeEventName(
  variant: PumpTradeVariant,
): FreshTailPumpTradeEventEvidence["instructionName"] {
  if (variant === "sell" || variant === "sell_v2") return "sell";
  if (variant === "buy_exact_sol_in") return "buy_exact_sol_in";
  if (variant === "buy_exact_quote_in_v2") return "buy_exact_quote_in";
  return "buy";
}

function bindTradeEvent(
  trade: PumpTrade,
  candidates: readonly FreshTailPumpTradeEventEvidence[],
  contract: FreshTailMintContract,
  blockTimeSeconds: number,
  exactTokenAmountRaw: bigint,
): FreshTailPumpTradeEventEvidence | string {
  const matches = candidates.filter(
    (event) => event.mint === contract.mint && event.user === trade.user,
  );
  if (matches.length !== 1) {
    return `reviewed Pump trade has ${matches.length} matching exact TradeEvent payloads`;
  }
  const event = matches[0]!;
  if (
    event.side !== trade.side ||
    event.tokenAmountRaw !== exactTokenAmountRaw.toString() ||
    event.timestampSeconds !== blockTimeSeconds ||
    event.creator !== contract.creator ||
    event.quoteMint !== SystemProgram.programId.toBase58() ||
    event.instructionName !== expectedTradeEventName(trade.variant)
  ) {
    return "reviewed Pump trade and exact TradeEvent identity/reserves do not bind";
  }
  return event;
}

function normalizeContract(contract: FreshTailMintContract): FreshTailMintContract | null {
  const mint = keyText(contract.mint);
  const creator = keyText(contract.creator);
  const bondingCurve = keyText(contract.bondingCurve);
  const tokenProgram = keyText(contract.tokenProgram);
  if (
    !mint ||
    !creator ||
    !bondingCurve ||
    !tokenProgram ||
    bondingCurve !== pumpFunBondingCurveAddress(new PublicKey(mint)).toBase58() ||
    contract.totalSupplyRaw !== PUMP_FUN_STANDARD_TOTAL_SUPPLY_RAW.toString() ||
    contract.decimals !== 6 ||
    (contract.createVariant === "classic_v1"
      ? tokenProgram !== TOKEN_PROGRAM_ID.toBase58()
      : contract.createVariant === "create_v2_token2022"
        ? tokenProgram !== TOKEN_2022_PROGRAM_ID.toBase58()
        : true)
  ) {
    return null;
  }
  return { ...contract, mint, creator, bondingCurve, tokenProgram };
}

function eventKey(
  txSig: string,
  tokenMint: string,
  ledger: "supply" | "custody",
  kind: string,
  wallet: string,
): string {
  return `${txSig}:${tokenMint}:${ledger}:${kind}:${wallet}`;
}

function supplyEvent(
  common: {
    txSig: string;
    slot: number;
    blockTimeMs: number;
    contract: FreshTailMintContract;
    wallet: string;
    amountRaw: bigint;
  },
  side: "BUY" | "SELL",
): FreshTailSupplyEvent {
  const parserDomain: FreshTailParserDomain =
    side === "BUY" ? "pump_root_buy_v1" : "supply_sell_v1";
  const stable = {
    ledger: "supply" as const,
    side,
    txSig: common.txSig,
    slot: common.slot,
    blockTimeMs: common.blockTimeMs,
    targetWallet: common.wallet,
    tokenMint: common.contract.mint,
    amountRaw: common.amountRaw.toString(),
    totalSupplyRaw: common.contract.totalSupplyRaw,
    decimals: common.contract.decimals,
    pumpFunVerified: true as const,
    classificationReliable: true as const,
    parserDomain,
    parserAbiFingerprint: FRESH_TAIL_PARSER_ABIS[parserDomain],
  };
  return {
    eventKey: eventKey(common.txSig, common.contract.mint, "supply", side, common.wallet),
    payloadFingerprint: fingerprint(stable),
    ...stable,
  };
}

function custodyDraft(
  input: Omit<FreshTailCustodyEventDraft, "eventKey">,
): FreshTailCustodyEventDraft {
  return {
    eventKey: eventKey(
      input.txSig,
      input.tokenMint,
      "custody",
      input.eventKind,
      input.sourceWallet,
    ),
    ...input,
  };
}

function ownerRow(ledger: TokenLedger, wallet: string): OwnerBalance {
  return (
    ledger.owners.get(wallet) ?? {
      owner: wallet,
      preRaw: 0n,
      postRaw: 0n,
      accountIndexes: [],
    }
  );
}

function positiveRecipients(
  ledger: TokenLedger,
  excluded: ReadonlySet<string>,
): FreshTailRawRecipient[] {
  return [...ledger.owners.values()]
    .filter((row) => !excluded.has(row.owner) && row.postRaw > row.preRaw)
    .map((row) => ({
      wallet: row.owner,
      amountRaw: (row.postRaw - row.preRaw).toString(),
      preRaw: row.preRaw.toString(),
      postRaw: row.postRaw.toString(),
    }))
    .sort((left, right) => left.wallet.localeCompare(right.wallet));
}

function isExactTokenBurn(
  instructions: readonly InstructionView[],
  accountEntries: readonly AccountEntry[],
  ledger: TokenLedger,
  contract: FreshTailMintContract,
  wallet: string,
  amountRaw: bigint,
): boolean {
  const negativeAccounts = ledger.accounts.filter(
    (row) => row.owner === wallet && row.preRaw > row.postRaw,
  );
  if (negativeAccounts.length !== 1) return false;
  const source = negativeAccounts[0]!;
  const matches = instructions.filter((instruction) => {
    if (
      instruction.programId !== contract.tokenProgram ||
      !instruction.data ||
      instruction.accounts.length !== 3 ||
      instruction.accounts[0] !== source.accountAddress ||
      instruction.accounts[1] !== contract.mint ||
      instruction.accounts[2] !== wallet
    ) {
      return false;
    }
    const tag = instruction.data[0];
    if (tag === 8 && instruction.data.length === 9) {
      return u64(instruction.data, 1) === amountRaw;
    }
    return (
      tag === 15 &&
      instruction.data.length === 10 &&
      u64(instruction.data, 1) === amountRaw &&
      instruction.data[9] === contract.decimals
    );
  });
  const signer = accountEntries.find((entry) => entry.pubkey === wallet)?.signer === true;
  return signer && matches.length === 1;
}

/**
 * Pure, env-free decoder for one exact finalized parsed transaction and one
 * enrolled epoch mint/watched wallet. It never reads legacy cursor/state.
 */
export function decodeFreshTailFinalizedTransaction(
  tx: ParsedTransactionWithMeta,
  rawContract: FreshTailMintContract,
  observedWalletInput: string,
  role: FreshTailWalletRole,
): FreshTailDecodeResult {
  const contract = normalizeContract(rawContract);
  const observedWallet = keyText(observedWalletInput);
  if (!contract || !observedWallet) {
    return failure("invalid_request", "fresh-tail mint contract or watched wallet is invalid");
  }
  const txSig = String(tx?.transaction?.signatures?.[0] ?? "").trim();
  const slot = Number(tx?.slot);
  const blockTime = Number(tx?.blockTime);
  if (
    !txSig ||
    !Number.isSafeInteger(slot) ||
    slot <= 0 ||
    !Number.isSafeInteger(blockTime) ||
    blockTime <= 0 ||
    !tx.meta
  ) {
    return failure(
      "transaction_identity_invalid",
      "fresh-tail finalized transaction identity/time/meta is invalid",
    );
  }
  if (tx.meta.err !== null) {
    return { ok: true, supplyEvents: [], custodyEvents: [] };
  }
  const blockTimeMs = blockTime * 1_000;
  if (!Number.isSafeInteger(blockTimeMs)) {
    return failure("transaction_identity_invalid", "transaction block time overflows milliseconds");
  }
  const accounts = messageAccounts(tx);
  if (!accounts) {
    return failure("transaction_identity_invalid", "transaction account keys are malformed");
  }
  const accountKeys = accounts.map((entry) => entry.pubkey);
  const signerKeys = new Set(accounts.filter((entry) => entry.signer).map((entry) => entry.pubkey));
  const instructionSet = transactionInstructions(tx, accountKeys);
  if (instructionSet.malformedPumpInstruction) {
    return failure("pump_instruction_conflict", "a Pump instruction could not be decoded exactly");
  }
  const parsedTrades = instructionSet.views.map((instruction) =>
    parsePumpTrade(instruction, contract),
  );
  const conflict = parsedTrades.find((result) => result.kind === "conflict");
  if (conflict?.kind === "conflict") {
    return failure("pump_instruction_conflict", conflict.reason);
  }
  const trades = parsedTrades.flatMap((result) => (result.kind === "valid" ? [result.trade] : []));
  const parsedTradeEvents = instructionSet.views.map(parsePumpTradeEvent);
  const eventConflict = parsedTradeEvents.find((result) => result.kind === "conflict");
  if (eventConflict?.kind === "conflict") {
    return failure("pump_instruction_conflict", eventConflict.reason);
  }
  const tradeEvents = parsedTradeEvents.flatMap((result) =>
    result.kind === "valid" ? [result.event] : [],
  );
  const walletTrades = trades.filter((trade) => trade.user === observedWallet);
  if (walletTrades.length > 1) {
    return failure(
      "pump_instruction_conflict",
      "more than one reviewed Pump trade targets the watched wallet/mint",
    );
  }

  const builtLedger = buildTokenLedger(tx, accounts, contract);
  if (typeof builtLedger === "string") {
    return failure("token_balance_invalid", builtLedger);
  }
  const ledger = builtLedger;
  const observed = ownerRow(ledger, observedWallet);
  const curve = ownerRow(ledger, contract.bondingCurve);
  const observedDelta = observed.postRaw - observed.preRaw;
  const curveDelta = curve.postRaw - curve.preRaw;
  const trade = walletTrades[0];
  const common = { txSig, slot, blockTimeMs, contract, wallet: observedWallet };

  if (role === "root" && trade?.side === "buy") {
    if (!signerKeys.has(observedWallet) || curveDelta >= 0n || observedDelta < 0n) {
      return failure(
        "pump_instruction_conflict",
        "reviewed root buy signer or raw curve/root direction is invalid",
      );
    }
    const grossRaw = -curveDelta;
    const boundTradeEvent = bindTradeEvent(trade, tradeEvents, contract, blockTime, grossRaw);
    if (typeof boundTradeEvent === "string") {
      return failure("pump_instruction_conflict", boundTradeEvent);
    }
    if (trade.variant === "buy" && trade.instructionAmountRaw !== grossRaw) {
      return failure(
        "pump_instruction_conflict",
        "legacy Pump buy amount does not equal the exact curve outflow",
      );
    }
    const negativeOwners = [...ledger.owners.values()].filter((row) => row.postRaw < row.preRaw);
    if (
      ledger.netDeltaRaw !== 0n ||
      negativeOwners.length !== 1 ||
      negativeOwners[0]!.owner !== contract.bondingCurve ||
      observedDelta > grossRaw
    ) {
      return failure(
        "token_balance_invalid",
        "root Pump buy has an extra source or acquires less than the root final delta",
      );
    }
    const recipients = positiveRecipients(ledger, new Set([contract.bondingCurve, observedWallet]));
    const forwardedRaw = recipients.reduce(
      (sum, recipient) => sum + BigInt(recipient.amountRaw),
      0n,
    );
    if (observedDelta + forwardedRaw !== grossRaw) {
      return failure(
        "token_balance_invalid",
        "root Pump buy outputs do not exactly equal the curve raw outflow",
      );
    }
    const targetPost = observed.preRaw + grossRaw;
    const supply = supplyEvent({ ...common, amountRaw: grossRaw }, "BUY");
    const targetBuy = custodyDraft({
      ledger: "custody",
      eventKind: "TARGET_BUY",
      txSig,
      slot,
      blockTimeMs,
      tokenMint: contract.mint,
      sourceWallet: observedWallet,
      amountRaw: grossRaw.toString(),
      sourcePreRaw: observed.preRaw.toString(),
      sourcePostRaw: targetPost.toString(),
      decimals: contract.decimals,
      classification: "reviewed_pump_root_buy_logical_cohort",
      classificationReliable: true,
      watchable: true,
      recipients: [],
      parserDomain: "custody_target_buy_v1",
      parserAbiFingerprint: FRESH_TAIL_PARSER_ABIS.custody_target_buy_v1,
    });
    const custodyEvents: FreshTailCustodyEventDraft[] = [targetBuy];
    if (forwardedRaw > 0n) {
      custodyEvents.push(
        custodyDraft({
          ledger: "custody",
          eventKind: "TRANSFER",
          txSig,
          slot,
          blockTimeMs,
          tokenMint: contract.mint,
          sourceWallet: observedWallet,
          amountRaw: forwardedRaw.toString(),
          sourcePreRaw: targetPost.toString(),
          sourcePostRaw: observed.postRaw.toString(),
          decimals: contract.decimals,
          classification: "same_transaction_acquisition_conserving_transfer",
          classificationReliable: true,
          watchable: true,
          recipients,
          parserDomain: "custody_transfer_v1",
          parserAbiFingerprint: FRESH_TAIL_PARSER_ABIS.custody_transfer_v1,
        }),
      );
    }
    return {
      ok: true,
      supplyEvents: [supply],
      custodyEvents,
      pumpTradeEventEvidence: boundTradeEvent,
      rootBuyEvidence: buildVerifiedFreshRootBuyEvidence(tx, {
        txSig,
        slot,
        blockTimeMs,
        rootWallet: observedWallet,
        mint: contract.mint,
        bondingCurve: contract.bondingCurve,
        grossAmountRaw: grossRaw.toString(),
        successful: true,
        finalized: true,
        pumpFunVerified: true,
      }),
    };
  }

  if (observedDelta >= 0n) {
    return { ok: true, supplyEvents: [], custodyEvents: [] };
  }
  const outflowRaw = -observedDelta;

  if (trade?.side === "sell") {
    const boundTradeEvent = bindTradeEvent(trade, tradeEvents, contract, blockTime, outflowRaw);
    if (typeof boundTradeEvent === "string") {
      return failure("pump_instruction_conflict", boundTradeEvent);
    }
    const sourceAccounts = ledger.accounts.filter(
      (row) => row.owner === observedWallet && row.preRaw > row.postRaw,
    );
    const otherDeltas = [...ledger.owners.values()].filter(
      (row) =>
        row.owner !== observedWallet &&
        row.owner !== contract.bondingCurve &&
        row.preRaw !== row.postRaw,
    );
    if (
      ledger.netDeltaRaw !== 0n ||
      !signerKeys.has(observedWallet) ||
      trade.instructionAmountRaw !== outflowRaw ||
      curveDelta !== outflowRaw ||
      sourceAccounts.length !== 1 ||
      sourceAccounts[0]!.accountAddress !== trade.baseTokenAccount ||
      otherDeltas.length !== 0
    ) {
      return failure(
        "pump_instruction_conflict",
        "reviewed Pump sell does not exactly conserve source outflow into the curve",
      );
    }
    if (role === "root") {
      return {
        ok: true,
        supplyEvents: [supplyEvent({ ...common, amountRaw: outflowRaw }, "SELL")],
        custodyEvents: [],
        pumpTradeEventEvidence: boundTradeEvent,
      };
    }
    return {
      ok: true,
      supplyEvents: [],
      custodyEvents: [
        custodyDraft({
          ledger: "custody",
          eventKind: "SELL",
          txSig,
          slot,
          blockTimeMs,
          tokenMint: contract.mint,
          sourceWallet: observedWallet,
          amountRaw: outflowRaw.toString(),
          sourcePreRaw: observed.preRaw.toString(),
          sourcePostRaw: observed.postRaw.toString(),
          decimals: contract.decimals,
          classification: "reviewed_pump_descendant_sell",
          classificationReliable: true,
          watchable: true,
          recipients: [],
          parserDomain: "custody_sell_v1",
          parserAbiFingerprint: FRESH_TAIL_PARSER_ABIS.custody_sell_v1,
        }),
      ],
      pumpTradeEventEvidence: boundTradeEvent,
    };
  }

  if (
    ledger.netDeltaRaw === -outflowRaw &&
    isExactTokenBurn(instructionSet.views, accounts, ledger, contract, observedWallet, outflowRaw)
  ) {
    return {
      ok: true,
      supplyEvents: [],
      custodyEvents: [
        custodyDraft({
          ledger: "custody",
          eventKind: "TERMINAL_OUTFLOW",
          txSig,
          slot,
          blockTimeMs,
          tokenMint: contract.mint,
          sourceWallet: observedWallet,
          amountRaw: outflowRaw.toString(),
          sourcePreRaw: observed.preRaw.toString(),
          sourcePostRaw: observed.postRaw.toString(),
          decimals: contract.decimals,
          classification: "reviewed_token_burn",
          classificationReliable: true,
          watchable: false,
          recipients: [],
          parserDomain: "custody_terminal_v1",
          parserAbiFingerprint: FRESH_TAIL_PARSER_ABIS.custody_terminal_v1,
        }),
      ],
    };
  }

  const negativeOwners = [...ledger.owners.values()].filter((row) => row.postRaw < row.preRaw);
  const recipients = positiveRecipients(ledger, new Set([observedWallet]));
  const receivedRaw = recipients.reduce((sum, recipient) => sum + BigInt(recipient.amountRaw), 0n);
  if (
    ledger.netDeltaRaw === 0n &&
    signerKeys.has(observedWallet) &&
    negativeOwners.length === 1 &&
    negativeOwners[0]!.owner === observedWallet &&
    recipients.length > 0 &&
    receivedRaw === outflowRaw
  ) {
    return {
      ok: true,
      supplyEvents: [],
      custodyEvents: [
        custodyDraft({
          ledger: "custody",
          eventKind: "TRANSFER",
          txSig,
          slot,
          blockTimeMs,
          tokenMint: contract.mint,
          sourceWallet: observedWallet,
          amountRaw: outflowRaw.toString(),
          sourcePreRaw: observed.preRaw.toString(),
          sourcePostRaw: observed.postRaw.toString(),
          decimals: contract.decimals,
          classification: "single_source_raw_conserving_transfer",
          classificationReliable: true,
          watchable: true,
          recipients,
          parserDomain: "custody_transfer_v1",
          parserAbiFingerprint: FRESH_TAIL_PARSER_ABIS.custody_transfer_v1,
        }),
      ],
    };
  }

  return {
    ok: true,
    supplyEvents: [],
    custodyEvents: [
      custodyDraft({
        ledger: "custody",
        eventKind: "UNRESOLVED_OUTFLOW",
        txSig,
        slot,
        blockTimeMs,
        tokenMint: contract.mint,
        sourceWallet: observedWallet,
        amountRaw: outflowRaw.toString(),
        sourcePreRaw: observed.preRaw.toString(),
        sourcePostRaw: observed.postRaw.toString(),
        decimals: contract.decimals,
        classification: "negative_raw_delta_not_exactly_attributed",
        classificationReliable: true,
        watchable: false,
        recipients: [],
        parserDomain: "custody_unresolved_v1",
        parserAbiFingerprint: FRESH_TAIL_PARSER_ABIS.custody_unresolved_v1,
      }),
    ],
  };
}

/**
 * Finds current reviewed Pump buy candidates in a root-wallet transaction
 * before a mint is enrolled. It derives only a provisional immutable contract
 * from exact instruction positions plus the exact Pump TradeEvent creator;
 * `decodeFreshTailFinalizedTransaction` then re-validates the full contract.
 */
export function discoverFreshTailRootPumpBuys(
  tx: ParsedTransactionWithMeta,
  rootWalletInput: string,
): FreshTailRootBuyDiscoveryResult {
  const rootWallet = keyText(rootWalletInput);
  const accounts = messageAccounts(tx);
  if (!rootWallet || !accounts) {
    return {
      ok: false,
      code: "transaction_identity_invalid",
      reason: "root discovery wallet or transaction accounts are invalid",
      retryable: false,
    };
  }
  if (!tx.meta || tx.meta.err !== null) return { ok: true, discoveries: [] };
  const signers = new Set(accounts.filter((entry) => entry.signer).map((entry) => entry.pubkey));
  if (!signers.has(rootWallet)) return { ok: true, discoveries: [] };
  const instructionSet = transactionInstructions(
    tx,
    accounts.map((entry) => entry.pubkey),
  );
  if (instructionSet.malformedPumpInstruction) {
    return {
      ok: false,
      code: "pump_instruction_conflict",
      reason: "a root Pump instruction could not be decoded exactly",
      retryable: false,
    };
  }
  const parsedEvents = instructionSet.views.map(parsePumpTradeEvent);
  const eventConflict = parsedEvents.find((event) => event.kind === "conflict");
  if (eventConflict?.kind === "conflict") {
    return {
      ok: false,
      code: "pump_instruction_conflict",
      reason: eventConflict.reason,
      retryable: false,
    };
  }
  const events = parsedEvents.flatMap((event) => (event.kind === "valid" ? [event.event] : []));
  const candidates = new Map<string, FreshTailMintContract>();
  for (const instruction of instructionSet.views) {
    if (instruction.programId !== PUMP_FUN_PROGRAM_ID.toBase58() || !instruction.data) continue;
    const discriminator = instruction.data.subarray(0, 8).toString("hex");
    const legacy =
      discriminator === BUY_DISCRIMINATOR || discriminator === BUY_EXACT_SOL_IN_DISCRIMINATOR;
    const v2 =
      discriminator === BUY_V2_DISCRIMINATOR ||
      discriminator === BUY_EXACT_QUOTE_IN_V2_DISCRIMINATOR;
    if (!legacy && !v2) continue;
    const mint = instruction.accounts[v2 ? 1 : 2];
    const bondingCurve = instruction.accounts[v2 ? 10 : 3];
    const user = instruction.accounts[v2 ? 13 : 6];
    const tokenProgram = instruction.accounts[v2 ? 3 : 8];
    if (!mint || !bondingCurve || user !== rootWallet || !tokenProgram) continue;
    const eventMatches = events.filter((event) => event.mint === mint && event.user === rootWallet);
    if (eventMatches.length !== 1) {
      return {
        ok: false,
        code: "pump_instruction_conflict",
        reason: `root Pump buy candidate has ${eventMatches.length} exact TradeEvent creators`,
        retryable: false,
      };
    }
    const createVariant =
      tokenProgram === TOKEN_PROGRAM_ID.toBase58()
        ? "classic_v1"
        : tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58()
          ? "create_v2_token2022"
          : null;
    if (!createVariant) {
      return {
        ok: false,
        code: "pump_instruction_conflict",
        reason: "root Pump buy uses an unsupported token program",
        retryable: false,
      };
    }
    const provisional: FreshTailMintContract = {
      mint,
      bondingCurve,
      creator: eventMatches[0]!.creator,
      createVariant,
      tokenProgram,
      totalSupplyRaw: PUMP_FUN_STANDARD_TOTAL_SUPPLY_RAW.toString(),
      decimals: 6,
    };
    const previous = candidates.get(mint);
    if (previous && stableJson(previous) !== stableJson(provisional)) {
      return {
        ok: false,
        code: "pump_instruction_conflict",
        reason: "one root transaction contains conflicting provisional mint contracts",
        retryable: false,
      };
    }
    candidates.set(mint, provisional);
  }
  return {
    ok: true,
    discoveries: [...candidates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tokenMint, provisional]) => ({
        tokenMint,
        contract: provisional,
        decoded: decodeFreshTailFinalizedTransaction(tx, provisional, rootWallet, "root"),
      })),
  };
}

/**
 * Adds the finalized classification result before persistence. Missing,
 * duplicate, reordered, or raw-mismatched classifications fail closed.
 */
export function finalizeFreshTailCustodyEvent(
  draft: FreshTailCustodyEventDraft,
  classifications: readonly FreshTailRecipientClassification[],
): FreshTailCustodyEvent | null {
  const expected = [...draft.recipients].sort((left, right) =>
    left.wallet.localeCompare(right.wallet),
  );
  const provided = [...classifications].sort((left, right) =>
    left.wallet.localeCompare(right.wallet),
  );
  if (expected.length !== provided.length) return null;
  const seen = new Set<string>();
  for (let index = 0; index < expected.length; index += 1) {
    const raw = expected[index]!;
    const classified = provided[index]!;
    if (
      seen.has(classified.wallet) ||
      raw.wallet !== classified.wallet ||
      raw.amountRaw !== classified.amountRaw ||
      raw.preRaw !== classified.preRaw ||
      raw.postRaw !== classified.postRaw ||
      !classified.classification.trim()
    ) {
      return null;
    }
    seen.add(classified.wallet);
  }
  const recipients = provided;
  const stable = {
    ...draft,
    recipients,
    classificationReliable:
      draft.classificationReliable &&
      recipients.every((recipient) => recipient.classificationReliable),
    watchable: draft.watchable && recipients.every((recipient) => recipient.watchable),
  };
  return { ...stable, payloadFingerprint: fingerprint(stable) };
}
