import { type Connection, PublicKey } from "@solana/web3.js";

export type ExactRawAmountInput = number | string | bigint;

const RAW_INTEGER = /^\d+$/;
const DECIMAL_NUMBER = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function checkedDecimals(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("token decimals are outside the supported range");
  }
  return decimals;
}

export function exactRawAmount(value: ExactRawAmountInput, label = "raw token amount"): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${label} must be unsigned`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`${label} must be a finite unsigned integer`);
    }
    // BigInt(number) preserves the integer represented by JavaScript, including
    // legacy requested amounts above Number.MAX_SAFE_INTEGER. The live-chain cap
    // below then prevents that approximation from exceeding the wallet balance.
    return BigInt(value);
  }
  const canonical = value.trim();
  if (!RAW_INTEGER.test(canonical)) {
    throw new Error(`${label} must be an unsigned integer string`);
  }
  return BigInt(canonical);
}

export function capExitRawAmount(
  requestedRaw: ExactRawAmountInput,
  liveBalanceRaw: ExactRawAmountInput,
): bigint {
  const requested = exactRawAmount(requestedRaw, "requested exit amount");
  const liveBalance = exactRawAmount(liveBalanceRaw, "live wallet balance");
  return requested <= liveBalance ? requested : liveBalance;
}

/** Convert a UI numeric value to raw units without multiplying an unsafe Number. */
export function uiAmountToRawFloor(value: number | string, decimals: number): bigint {
  const scaleDecimals = checkedDecimals(decimals);
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
    throw new Error("UI token amount must be finite and non-negative");
  }
  const text = String(value).trim();
  const match = DECIMAL_NUMBER.exec(text);
  if (!match) throw new Error("UI token amount is malformed");

  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new Error("UI token amount exponent is outside the supported range");
  }

  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  const rawExponent = scaleDecimals + exponent - fraction.length;
  const magnitude = BigInt(digits);
  return rawExponent >= 0
    ? magnitude * 10n ** BigInt(rawExponent)
    : magnitude / 10n ** BigInt(-rawExponent);
}

export function rawAmountToUiString(raw: ExactRawAmountInput, decimals: number): string {
  const amount = exactRawAmount(raw);
  const scaleDecimals = checkedDecimals(decimals);
  if (scaleDecimals === 0) return amount.toString();

  const padded = amount.toString().padStart(scaleDecimals + 1, "0");
  const whole = padded.slice(0, -scaleDecimals);
  const fraction = padded.slice(-scaleDecimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function rawAmountToUiNumber(raw: ExactRawAmountInput, decimals: number): number {
  const value = Number(rawAmountToUiString(raw, decimals));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("raw token amount cannot be represented in the UI ledger");
  }
  return value;
}

export function decrementUiAmountByRaw(
  currentUi: number | string,
  soldRaw: ExactRawAmountInput,
  decimals: number,
): { remainingRaw: bigint; remainingUi: number } {
  const currentRaw = uiAmountToRawFloor(currentUi, decimals);
  const sold = exactRawAmount(soldRaw, "executed exit amount");
  if (sold > currentRaw) {
    throw new Error("executed exit amount exceeds the persisted position balance");
  }
  const remainingRaw = currentRaw - sold;
  return {
    remainingRaw,
    remainingUi: rawAmountToUiNumber(remainingRaw, decimals),
  };
}

export function remainingUiAfterExactExit(
  currentUi: number | string,
  executedRaw: ExactRawAmountInput,
  liveBalanceRaw: ExactRawAmountInput,
  decimals: number,
): { remainingRaw: bigint; remainingUi: number; walletDepleted: boolean } {
  const executed = exactRawAmount(executedRaw, "executed exit amount");
  const liveBalance = exactRawAmount(liveBalanceRaw, "live wallet balance");
  if (executed <= 0n || executed > liveBalance) {
    throw new Error("executed exit amount is inconsistent with the verified live wallet balance");
  }
  if (executed === liveBalance) {
    return { remainingRaw: 0n, remainingUi: 0, walletDepleted: true };
  }
  return {
    ...decrementUiAmountByRaw(currentUi, executed, decimals),
    walletDepleted: false,
  };
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function exactWalletBalanceFromParsedAccounts(
  rows: readonly unknown[],
  expectedMint: string,
  expectedDecimals: number,
): bigint {
  checkedDecimals(expectedDecimals);
  let total = 0n;
  for (const rowValue of rows) {
    const row = record(rowValue);
    const account = record(row?.account);
    const data = record(account?.data);
    const parsed = record(data?.parsed);
    const info = record(parsed?.info);
    const tokenAmount = record(info?.tokenAmount);
    const mint = info?.mint;
    const amount = tokenAmount?.amount;
    const decimals = tokenAmount?.decimals;
    if (
      parsed?.type !== "account" ||
      mint !== expectedMint ||
      typeof amount !== "string" ||
      !RAW_INTEGER.test(amount) ||
      typeof decimals !== "number" ||
      !Number.isInteger(decimals) ||
      decimals !== expectedDecimals
    ) {
      throw new Error("RPC returned malformed or inconsistent live token balance evidence");
    }
    total += BigInt(amount);
  }
  return total;
}

export async function readExactWalletTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  expectedDecimals: number,
  timeoutMs = 3_000,
): Promise<bigint> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      connection.getParsedTokenAccountsByOwner(owner, { mint }, "processed"),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("live wallet token-balance RPC timed out")),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
    if (!response || !Array.isArray(response.value)) {
      throw new Error("RPC returned malformed live token-balance evidence");
    }
    return exactWalletBalanceFromParsedAccounts(response.value, mint.toBase58(), expectedDecimals);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
