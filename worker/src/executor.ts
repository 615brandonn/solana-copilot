// Executor: builds the swap tx and sends it either through Jito (default)
// or straight through the RPC. Uses Jupiter aggregator for routed tokens and
// falls back to direct Pump.fun instructions when a fresh bonding-curve token
// has no Jupiter route yet.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher.js";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types.js";
import bs58 from "bs58";
import { fetch } from "undici";
import pino from "pino";
import { env } from "./env.js";
import { safeDiagnostic } from "./diagnostics.js";
import { confirmedTokenReceiptFromTx } from "./execution-accounting.js";
import { capExitRawAmount, exactRawAmount, readExactWalletTokenBalance } from "./exit-sizing.js";
import { buildPumpFunDirectSwap } from "./pump-fun-direct.js";
import { submitKnownSignatureWithTimeout } from "./rpc-submission.js";
import {
  SubmissionUncertainError,
  SubmissionCancelledBeforeSendError,
  SubmittedTransactionFailedError,
  assertSubmissionAuthorized,
  isPostSubmissionError,
  mayTryAlternateExecution,
  parseUniqueCsvSetting,
  type SubmissionRoute,
} from "./execution-safety.js";

const log = pino({ level: env.LOG_LEVEL });
const conn = new Connection(env.RPC_URL, { commitment: "processed" });
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const LANDING_TIMEOUT_MS = 15_000;
const SOLANA_RPC_CALL_TIMEOUT_MS = 2_500;
const PUMP_TRANSACTION_DETAILS_TIMEOUT_MS = 4_000;
const RAW_SUBMISSION_TIMEOUT_MS = 5_000;
const JUPITER_QUOTE_TIMEOUT_MS = 10_000;
const JUPITER_BUILD_TIMEOUT_MS = 10_000;

const JITO_TIP_ACCOUNTS = parseUniqueCsvSetting(env.JITO_TIP_ACCOUNTS, "JITO_TIP_ACCOUNTS").map(
  (value, index) => {
    try {
      return new PublicKey(value);
    } catch {
      throw new Error(`JITO_TIP_ACCOUNTS contains an invalid public key at position ${index + 1}`);
    }
  },
);

export type PreparedTransaction = {
  txSig: string;
  recentBlockhash: string;
  /** Aggregator responses do not all expose the exact expiry height. */
  lastValidBlockHeight?: number;
};

export type ExecuteInput = {
  signerSecret: string; // base58 secret key of funding wallet
  inputMint: string; // e.g. So1111... for SOL
  outputMint: string;
  amountLamports: number | string | bigint;
  slippageBps: number;
  route: "jito" | "rpc";
  jitoTipSol: number;
  outputDecimals?: number; // needed to compute UI amount received (Jupiter v6 doesn't return this)
  /** Required for exits so the executor can verify and cap the exact raw wallet balance. */
  inputDecimals?: number;
  /** Publishes the exact raw amount every exit route will build and submit. */
  onInputAmountCapped?: (amount: {
    requestedRaw: string;
    liveBalanceRaw: string;
    amountRaw: string;
    decimals: number;
  }) => void;
  /** Skip aggregators for a curve-proven Pump.fun entry. Exits never set this. */
  pumpFunDirectOnly?: boolean;
  /** Prefer Pump.fun for an exit, with alternate routes allowed only after a proven pre-submit failure. */
  pumpFunDirectFirst?: boolean;
  /**
   * Called for every locally signed transaction after serialization and before
   * the caller's final gate or first network send. Throwing cancels submission
   * and blocks alternate-route fallback so the exact attempt can be durable.
   */
  onPrepared?: (prepared: PreparedTransaction) => void | Promise<void>;
  /** Rechecked immediately before the first network submission begins. */
  beforeSubmit?: () => boolean | Promise<boolean>;
};

export type ExecuteResult = {
  txSig: string;
  latencyMs: number;
  route: "jito" | "rpc";
  outUiAmount?: number;
  /** Exact raw receipt when the route exposes authoritative transaction meta. */
  outRawAmount?: string;
  outDecimals?: number;
};

const JUPITER_BASE_URLS = [
  { base: "https://api.jup.ag/swap/v1", requiresKey: true },
  { base: "https://lite-api.jup.ag/swap/v1", requiresKey: false },
];
const JUPITER_V2_BASE = "https://api.jup.ag/swap/v2";

type FetchResponseLike = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

async function readJsonOrThrow<T extends Record<string, unknown>>(
  resp: FetchResponseLike,
  label: string,
): Promise<T> {
  const text = await resp.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  const apiError = json.error ?? json.message;
  if (!resp.ok) {
    throw new Error(
      `${label} HTTP ${resp.status}: ${safeDiagnostic(apiError ?? text.slice(0, 180))}`,
    );
  }
  if (apiError) throw new Error(`${label}: ${safeDiagnostic(apiError)}`);
  return json as T;
}

type JupiterV1Quote = Record<string, unknown> & {
  outAmount: string;
  outputDecimals?: number;
};

type JupiterV1Swap = Record<string, unknown> & {
  swapTransaction: string;
  outputDecimals?: number;
  lastValidBlockHeight?: number;
};

async function fetchJupiterQuote(input: ExecuteInput) {
  const errors: string[] = [];
  for (const endpoint of JUPITER_BASE_URLS) {
    if (endpoint.requiresKey && !env.JUPITER_API_KEY) continue;
    try {
      const base = endpoint.base;
      const quoteUrl = new URL(`${base}/quote`);
      quoteUrl.searchParams.set("inputMint", input.inputMint);
      quoteUrl.searchParams.set("outputMint", input.outputMint);
      quoteUrl.searchParams.set("amount", String(input.amountLamports));
      quoteUrl.searchParams.set("slippageBps", String(input.slippageBps));
      const quote = await readJsonOrThrow<JupiterV1Quote>(
        await fetch(quoteUrl, {
          headers:
            endpoint.requiresKey && env.JUPITER_API_KEY
              ? { "x-api-key": env.JUPITER_API_KEY }
              : undefined,
          signal: AbortSignal.timeout(JUPITER_QUOTE_TIMEOUT_MS),
        }),
        "Jupiter quote",
      );
      if (!quote?.outAmount) throw new Error("Jupiter quote did not include outAmount");
      return { base, quote, requiresKey: endpoint.requiresKey };
    } catch (err) {
      errors.push(safeDiagnostic(err));
    }
  }
  throw new Error(`All Jupiter quote endpoints failed: ${errors.join(" | ")}`);
}

async function fetchJupiterSwap(
  base: string,
  quote: JupiterV1Quote,
  signer: Keypair,
  requiresKey: boolean,
) {
  const swap = await readJsonOrThrow<JupiterV1Swap>(
    await fetch(`${base}/swap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(requiresKey && env.JUPITER_API_KEY ? { "x-api-key": env.JUPITER_API_KEY } : {}),
      },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
      signal: AbortSignal.timeout(JUPITER_BUILD_TIMEOUT_MS),
    }),
    "Jupiter swap",
  );
  if (!swap?.swapTransaction) throw new Error("Jupiter swap did not return a transaction");
  return swap;
}

// --- DFlow aggregator route (Jupiter-compatible quote/swap shape) ------------
// DFlow is the venue the tracked operator fills through. It returns a base64
// swapTransaction just like Jupiter v1, so we sign and submit through the exact
// same Jito+RPC-backup path. Enabled only when env.DFLOW_ENABLED is true; any
// failure falls back to the existing Jupiter → Pump.fun chain.
type DflowQuote = Record<string, unknown> & { outAmount: string };
type DflowSwap = Record<string, unknown> & {
  swapTransaction: string;
  lastValidBlockHeight?: number;
};
const DFLOW_QUOTE_TIMEOUT_MS = 10_000;
const DFLOW_BUILD_TIMEOUT_MS = 10_000;

function dflowHeaders(): Record<string, string> {
  return env.DFLOW_API_KEY ? { "x-api-key": env.DFLOW_API_KEY } : {};
}

async function fetchDflowQuote(input: ExecuteInput): Promise<DflowQuote> {
  const url = new URL(`${env.DFLOW_BASE_URL}/quote`);
  url.searchParams.set("inputMint", input.inputMint);
  url.searchParams.set("outputMint", input.outputMint);
  url.searchParams.set("amount", String(input.amountLamports));
  url.searchParams.set("slippageBps", String(input.slippageBps));
  const quote = await readJsonOrThrow<DflowQuote>(
    await fetch(url, {
      headers: dflowHeaders(),
      signal: AbortSignal.timeout(DFLOW_QUOTE_TIMEOUT_MS),
    }),
    "DFlow quote",
  );
  if (!quote?.outAmount) throw new Error("DFlow quote did not include outAmount");
  return quote;
}

async function fetchDflowSwap(quote: DflowQuote, signer: Keypair): Promise<DflowSwap> {
  const swap = await readJsonOrThrow<DflowSwap>(
    await fetch(`${env.DFLOW_BASE_URL}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json", ...dflowHeaders() },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
      signal: AbortSignal.timeout(DFLOW_BUILD_TIMEOUT_MS),
    }),
    "DFlow swap",
  );
  if (!swap?.swapTransaction) throw new Error("DFlow swap did not return a transaction");
  return swap;
}

async function executeDflowSwap(
  input: ExecuteInput,
  signer: Keypair,
  t0: number,
): Promise<ExecuteResult> {
  const quote = await fetchDflowQuote(input);
  const swapResp = await fetchDflowSwap(quote, signer);

  const tx = VersionedTransaction.deserialize(Buffer.from(swapResp.swapTransaction, "base64"));
  tx.sign([signer]);
  const knownSig = signedTransactionSignature(tx);

  const outAmountRaw = Number(quote?.outAmount ?? 0);
  const outDecimals = Number(input.outputDecimals ?? 0);
  const outUiAmount = outDecimals > 0 ? outAmountRaw / Math.pow(10, outDecimals) : outAmountRaw;

  return submitSignedSwapTx(
    tx,
    signer,
    knownSig,
    input,
    t0,
    outUiAmount,
    "dflow",
    swapResp.lastValidBlockHeight,
  );
}

function createPreparedTransactionNotifier(
  input: ExecuteInput,
  tx: VersionedTransaction,
  knownSig: string,
  lastValidBlockHeight?: number,
): { serialized: Uint8Array; ensurePrepared: () => Promise<void> } {
  // Local serialization must succeed before the durable callback publishes an
  // attempt. The exact bytes are then reused for every RPC rebroadcast.
  const serialized = tx.serialize();
  let prepared = false;
  return {
    serialized,
    ensurePrepared: async () => {
      if (prepared) return;
      await notifyTransactionPrepared(input, {
        txSig: knownSig,
        recentBlockhash: tx.message.recentBlockhash,
        ...(Number.isSafeInteger(lastValidBlockHeight) && Number(lastValidBlockHeight) > 0
          ? { lastValidBlockHeight: Number(lastValidBlockHeight) }
          : {}),
      });
      prepared = true;
    },
  };
}

// Shared Jito+RPC-backup submission used by the DFlow route. Mirrors the proven
// executeJupiterSwap submission semantics: one signed transaction, same bytes
// re-broadcast so a second attempt can never create a second trade.
async function submitSignedSwapTx(
  tx: VersionedTransaction,
  signer: Keypair,
  knownSig: string,
  input: ExecuteInput,
  t0: number,
  outUiAmount: number,
  label: string,
  lastValidBlockHeight?: number,
): Promise<ExecuteResult> {
  const { serialized, ensurePrepared } = createPreparedTransactionNotifier(
    input,
    tx,
    knownSig,
    lastValidBlockHeight,
  );
  if (input.route === "jito" && JITO_TIP_ACCOUNTS.length > 0) {
    let jitoAccepted = false;
    let submissionMayHaveOccurred = false;
    try {
      await sendViaJito(
        tx,
        signer,
        input.jitoTipSol,
        t0,
        knownSig,
        input.beforeSubmit,
        ensurePrepared,
      );
      jitoAccepted = true;
      submissionMayHaveOccurred = true;
    } catch (err) {
      if (!mayTryAlternateExecution(err) && !isPostSubmissionError(err)) throw err;
      submissionMayHaveOccurred = isPostSubmissionError(err);
    }
    try {
      await sendRawViaRpc(
        tx,
        t0,
        `${label}-rpc-backup`,
        knownSig,
        submissionMayHaveOccurred ? undefined : input.beforeSubmit,
        true,
        "rpc",
        serialized,
        ensurePrepared,
      );
      submissionMayHaveOccurred = true;
    } catch (err) {
      if (!submissionMayHaveOccurred && !isPostSubmissionError(err)) throw err;
      submissionMayHaveOccurred ||= isPostSubmissionError(err);
    }
    if (!submissionMayHaveOccurred)
      throw new Error(`${label}: Jito and RPC failed before submission`);
    await waitForLanding(knownSig, t0, `${label}/rpc-backup`, jitoAccepted ? "jito" : "rpc");
    return {
      txSig: knownSig,
      latencyMs: Date.now() - t0,
      route: jitoAccepted ? "jito" : "rpc",
      outUiAmount,
    };
  }

  try {
    await sendRawViaRpc(
      tx,
      t0,
      label,
      knownSig,
      input.beforeSubmit,
      true,
      "rpc",
      serialized,
      ensurePrepared,
    );
  } catch (err) {
    if (!isPostSubmissionError(err)) throw err;
  }
  await waitForLanding(knownSig, t0, label, "rpc");
  return { txSig: knownSig, latencyMs: Date.now() - t0, route: "rpc", outUiAmount };
}

export async function executeSwap(input: ExecuteInput): Promise<ExecuteResult> {
  const t0 = Date.now();
  const decodedSecret = bs58.decode(input.signerSecret.trim());
  if (decodedSecret.length !== 64) {
    throw new Error(
      `Funding private key decoded to ${decodedSecret.length} bytes; Phantom/base58 secret keys must decode to 64 bytes`,
    );
  }
  const signer = Keypair.fromSecretKey(decodedSecret);

  if (input.outputMint === WSOL_MINT) {
    const decimals = input.inputDecimals;
    if (
      typeof decimals !== "number" ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255
    ) {
      throw new Error("exit blocked: valid input token decimals are required");
    }
    const requestedRaw = exactRawAmount(input.amountLamports, "requested exit amount");
    const liveBalanceRaw = await readExactWalletTokenBalance(
      conn,
      signer.publicKey,
      new PublicKey(input.inputMint),
      decimals,
    );
    // Never infer position ownership from the wallet's aggregate mint balance:
    // unrelated/manual holdings may coexist in the same token account. Capping
    // the requested position amount fixes unsafe round-up without sweeping
    // tokens that were not attributed to this position.
    const amountRaw = capExitRawAmount(requestedRaw, liveBalanceRaw);
    if (amountRaw <= 0n) {
      throw new Error("exit blocked: live wallet token balance has no executable raw amount");
    }
    input.onInputAmountCapped?.({
      requestedRaw: requestedRaw.toString(),
      liveBalanceRaw: liveBalanceRaw.toString(),
      amountRaw: amountRaw.toString(),
      decimals,
    });
    if (amountRaw !== requestedRaw) {
      log.warn(
        {
          inputMint: input.inputMint,
          requestedRaw: requestedRaw.toString(),
          liveBalanceRaw: liveBalanceRaw.toString(),
          amountRaw: amountRaw.toString(),
        },
        "exit amount capped to exact live wallet balance",
      );
    }
    input = { ...input, amountLamports: amountRaw };
  }

  if (input.pumpFunDirectOnly === true) {
    return executePumpFunSwap(input, signer, t0);
  }
  if (input.pumpFunDirectFirst === true && input.outputMint !== WSOL_MINT) {
    throw new Error("pumpFunDirectFirst is only valid for SOL exits");
  }

  const failures: string[] = [];
  const pumpFunDirectFirst = input.pumpFunDirectFirst === true;
  if (pumpFunDirectFirst) {
    try {
      return await executePumpFunSwap(input, signer, t0);
    } catch (err) {
      // Construction, blockhash and serialization failures are known to be
      // pre-submission and may safely use another route. A revoked final gate,
      // failed preparation callback, or any possible submission must stop.
      if (!mayTryAlternateExecution(err)) {
        log.error(
          submissionLogFields(err, input),
          "Pump.fun direct-first exit requires reconciliation or was cancelled; alternate routes blocked",
        );
        throw err;
      }
      failures.push(`Pump.fun direct-first: ${errorMessage(err)}`);
      log.warn(
        {
          err: safeDiagnostic(err),
          inputMint: input.inputMint,
          outputMint: input.outputMint,
        },
        "Pump.fun direct-first exit failed before submission — falling back to aggregators",
      );
    }
  }

  // DFlow first when enabled; fall through to the full Jupiter → Pump.fun chain
  // on any recoverable failure so behaviour is unchanged when it is off.
  if (env.DFLOW_ENABLED) {
    try {
      return await executeDflowSwap(input, signer, t0);
    } catch (err) {
      if (!mayTryAlternateExecution(err)) {
        log.error(
          submissionLogFields(err, input),
          "DFlow submission requires reconciliation; alternate routes blocked",
        );
        throw err;
      }
      failures.push(`DFlow: ${errorMessage(err)}`);
      log.warn(
        { err: safeDiagnostic(err), inputMint: input.inputMint, outputMint: input.outputMint },
        "DFlow route failed — falling back to Jupiter",
      );
    }
  }

  try {
    return await executeJupiterSwap(input, signer, t0);
  } catch (err) {
    if (!mayTryAlternateExecution(err)) {
      log.error(
        submissionLogFields(err, input),
        "Jupiter V1 transaction submission requires reconciliation; alternate routes blocked",
      );
      throw err;
    }
    failures.push(`Jupiter V1/Jito: ${errorMessage(err)}`);
    log.warn(
      {
        err: safeDiagnostic(err),
        inputMint: input.inputMint,
        outputMint: input.outputMint,
      },
      "Jupiter V1/Jito swap failed — checking managed Jupiter V2 fallback",
    );
  }

  if (env.JUPITER_API_KEY) {
    try {
      return await executeJupiterManagedV2(input, signer, t0);
    } catch (err) {
      if (!mayTryAlternateExecution(err)) {
        log.error(
          submissionLogFields(err, input),
          "managed Jupiter V2 submission requires reconciliation; Pump.fun fallback blocked",
        );
        throw err;
      }
      failures.push(`Jupiter V2: ${errorMessage(err)}`);
      log.warn(
        {
          err: safeDiagnostic(err),
          inputMint: input.inputMint,
          outputMint: input.outputMint,
        },
        "managed Jupiter V2 fallback failed — checking Pump.fun fallback",
      );
    }
  } else {
    failures.push("Jupiter V2: JUPITER_API_KEY is not configured");
  }

  // A direct-first attempt already proved that this Pump.fun path could not be
  // prepared. Do not build a second Pump.fun transaction after the aggregator
  // fallbacks, which would invoke onPrepared twice with a different signature.
  if (pumpFunDirectFirst) {
    log.error(
      {
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        failures,
      },
      "all swap execution paths failed",
    );
    throw new Error(`All swap execution paths failed: ${failures.join(" | ")}`);
  }

  try {
    return await executePumpFunSwap(input, signer, t0);
  } catch (err) {
    if (!mayTryAlternateExecution(err)) throw err;
    failures.push(`Pump.fun: ${errorMessage(err)}`);
    log.error(
      {
        err: safeDiagnostic(err),
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        failures,
      },
      "all swap execution paths failed",
    );
    throw new Error(`All swap execution paths failed: ${failures.join(" | ")}`);
  }
}

function errorMessage(err: unknown) {
  return safeDiagnostic(err);
}

function submissionLogFields(err: unknown, input: ExecuteInput) {
  return {
    err: safeDiagnostic(err),
    txSig: isPostSubmissionError(err) ? err.txSig : undefined,
    submissionRoute: isPostSubmissionError(err) ? err.route : undefined,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
  };
}

async function executeJupiterSwap(
  input: ExecuteInput,
  signer: Keypair,
  t0: number,
): Promise<ExecuteResult> {
  const { base, quote, requiresKey } = await fetchJupiterQuote(input);
  const swapResp = await fetchJupiterSwap(base, quote, signer, requiresKey);

  const tx = VersionedTransaction.deserialize(Buffer.from(swapResp.swapTransaction, "base64"));
  tx.sign([signer]);
  const knownSig = signedTransactionSignature(tx);

  // Jupiter v6 quote returns outAmount as a RAW string. It does not return
  // outputDecimals reliably, so callers pass it in (from the target-swap event).
  const outAmountRaw = Number(quote?.outAmount ?? 0);
  const outDecimals = Number(
    input.outputDecimals ?? quote?.outputDecimals ?? swapResp?.outputDecimals ?? 0,
  );
  const outUiAmount = outDecimals > 0 ? outAmountRaw / Math.pow(10, outDecimals) : outAmountRaw;

  return submitSignedSwapTx(
    tx,
    signer,
    knownSig,
    input,
    t0,
    outUiAmount,
    "jupiter",
    swapResp.lastValidBlockHeight,
  );
}

type JupiterOrder = {
  transaction?: string | null;
  requestId?: string;
  outAmount?: string;
  lastValidBlockHeight?: number;
  router?: string;
  errorCode?: number;
  errorMessage?: string;
};

type JupiterExecute = {
  status?: "Success" | "Failed";
  signature?: string;
  code?: number;
  totalOutputAmount?: string;
  error?: string;
};

async function executeJupiterManagedV2(
  input: ExecuteInput,
  signer: Keypair,
  t0: number,
): Promise<ExecuteResult> {
  if (!env.JUPITER_API_KEY) throw new Error("JUPITER_API_KEY is required for Swap V2");

  const orderUrl = new URL(`${JUPITER_V2_BASE}/order`);
  orderUrl.searchParams.set("inputMint", input.inputMint);
  orderUrl.searchParams.set("outputMint", input.outputMint);
  orderUrl.searchParams.set("amount", String(input.amountLamports));
  orderUrl.searchParams.set("taker", signer.publicKey.toBase58());
  orderUrl.searchParams.set("slippageBps", String(input.slippageBps));

  const headers = { "x-api-key": env.JUPITER_API_KEY };
  const order = await readJsonOrThrow<JupiterOrder & Record<string, unknown>>(
    await fetch(orderUrl, { headers, signal: AbortSignal.timeout(10_000) }),
    "Jupiter V2 order",
  );
  if (!order.transaction || !order.requestId) {
    throw new Error(
      `Jupiter V2 could not build a transaction (${order.router ?? "unknown router"}/${order.errorCode ?? "unknown code"}): ${order.errorMessage ?? "missing transaction or requestId"}`,
    );
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([signer]);
  const knownSig = signedTransactionSignature(tx);
  const { serialized, ensurePrepared } = createPreparedTransactionNotifier(
    input,
    tx,
    knownSig,
    order.lastValidBlockHeight,
  );
  const signedTransaction = Buffer.from(serialized).toString("base64");
  let executed: JupiterExecute & Record<string, unknown>;
  await ensurePrepared();
  await assertSubmissionAuthorized(input.beforeSubmit);
  try {
    executed = await readJsonOrThrow<JupiterExecute & Record<string, unknown>>(
      await fetch(`${JUPITER_V2_BASE}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
        signal: AbortSignal.timeout(30_000),
      }),
      "Jupiter V2 execute",
    );
  } catch (err) {
    // Once the execute request starts, a lost/late HTTP response cannot prove
    // that Jupiter did not forward the signed transaction.
    throw new SubmissionUncertainError({
      route: "jupiter-v2",
      txSig: knownSig,
      detail: err,
    });
  }
  if (executed.status !== "Success" || !executed.signature) {
    throw new SubmittedTransactionFailedError({
      route: "jupiter-v2",
      txSig: knownSig,
      detail: `execute response ${executed.code ?? "unknown code"}: ${safeDiagnostic(executed.error ?? executed.status ?? "unknown status")}`,
    });
  }
  if (executed.signature !== knownSig) {
    throw new SubmissionUncertainError({
      route: "jupiter-v2",
      txSig: knownSig,
      detail: "execute response returned a different signature",
    });
  }

  await waitForLanding(knownSig, t0, "jupiter-v2", "jupiter-v2");

  const outAmountRaw = Number(executed.totalOutputAmount ?? order.outAmount ?? 0);
  const outDecimals = Number(input.outputDecimals ?? 0);
  const outUiAmount = outDecimals > 0 ? outAmountRaw / Math.pow(10, outDecimals) : outAmountRaw;
  log.info(
    {
      sig: knownSig,
      ms: Date.now() - t0,
      router: order.router,
      outUiAmount,
    },
    "managed Jupiter V2 swap landed",
  );
  // Trade rows currently distinguish the configured Jito path from all other
  // submission paths as `rpc`; keep that stable while logging the V2 router.
  return {
    txSig: knownSig,
    latencyMs: Date.now() - t0,
    route: "rpc",
    outUiAmount,
  };
}

async function executePumpFunSwap(
  input: ExecuteInput,
  signer: Keypair,
  t0: number,
): Promise<ExecuteResult> {
  const isBuy = input.inputMint === WSOL_MINT;
  const isSell = input.outputMint === WSOL_MINT;
  if (!isBuy && !isSell) throw new Error("Pump.fun fallback only supports SOL buys and SOL exits");

  const mint = new PublicKey(isBuy ? input.outputMint : input.inputMint);
  const direct = await buildPumpFunDirectSwap({
    connection: conn,
    owner: signer.publicKey,
    mint,
    side: isBuy ? "buy" : "sell",
    amountRaw: exactRawAmount(input.amountLamports, isBuy ? "buy SOL amount" : "sell amount"),
    slippageBps: input.slippageBps,
    commitment: "processed",
  });
  if (
    typeof input.outputDecimals === "number" &&
    isBuy &&
    direct.decimals !== input.outputDecimals
  ) {
    throw new Error("Pump.fun mint decimals disagree with the authorized entry");
  }
  if (
    typeof input.inputDecimals === "number" &&
    isSell &&
    direct.decimals !== input.inputDecimals
  ) {
    throw new Error("Pump.fun mint decimals disagree with the persisted position");
  }

  // The official current builder supports both legacy SPL and CreateV2
  // Token-2022 curves. We still own the blockhash, signature and network send,
  // preserving the durable prepared-signature and final authorization gates.
  const pumpInstructions = direct.instructions;
  const { blockhash, lastValidBlockHeight } = await executorRpcWithTimeout(
    conn.getLatestBlockhash("processed"),
    SOLANA_RPC_CALL_TIMEOUT_MS,
    "Pump.fun blockhash RPC",
  );
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 }),
        ...pumpInstructions,
      ],
    }).compileToV0Message(),
  );
  tx.sign([signer]);
  const knownSig = signedTransactionSignature(tx);
  const { serialized, ensurePrepared } = createPreparedTransactionNotifier(
    input,
    tx,
    knownSig,
    lastValidBlockHeight,
  );
  await ensurePrepared();

  try {
    await sendRawViaRpc(
      tx,
      t0,
      "pump.fun",
      knownSig,
      input.beforeSubmit,
      false,
      "pump.fun",
      serialized,
      ensurePrepared,
    );
  } catch (err) {
    if (!isPostSubmissionError(err)) throw err;
    log.warn(
      { err: safeDiagnostic(err), txSig: knownSig },
      "Pump.fun RPC submission was not definitive; reconciling the exact signature",
    );
  }
  await waitForLanding(knownSig, t0, "pump.fun", "pump.fun", "confirmed");

  const landedTx = await loadConfirmedPumpTransaction(knownSig);

  let outUiAmount: number | undefined;
  let outRawAmount: string | undefined;
  let outDecimals: number | undefined;
  if (isBuy) {
    const receipt = confirmedTokenReceiptFromTx(
      landedTx ?? undefined,
      signer.publicKey.toBase58(),
      mint.toBase58(),
    );
    if (!receipt || receipt.decimals !== direct.decimals) {
      throw new SubmissionUncertainError({
        route: "pump.fun",
        txSig: knownSig,
        detail: "landed buy lacks an exact matching transaction token receipt",
      });
    }
    outUiAmount = receipt.amountUi;
    outRawAmount = receipt.amountRaw;
    outDecimals = receipt.decimals;
  }
  log.info(
    {
      sig: knownSig,
      ms: Date.now() - t0,
      side: isBuy ? "buy" : "sell",
      mint: mint.toBase58(),
      outUiAmount,
    },
    "Pump.fun direct transaction landed",
  );
  return {
    txSig: knownSig,
    latencyMs: Date.now() - t0,
    route: "rpc",
    outUiAmount,
    outRawAmount,
    outDecimals,
  };
}

async function executorRpcWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadConfirmedPumpTransaction(
  signature: string,
): Promise<VersionedTransactionResponse | null> {
  const deadline = Date.now() + PUMP_TRANSACTION_DETAILS_TIMEOUT_MS;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      const tx = await executorRpcWithTimeout(
        conn.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }),
        Math.min(SOLANA_RPC_CALL_TIMEOUT_MS, remainingMs),
        "Pump.fun transaction-details RPC",
      );
      if (tx) return tx;
      lastError = "transaction details were null";
    } catch (err) {
      lastError = safeDiagnostic(err);
    }
    const pauseMs = Math.min(250, deadline - Date.now());
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  log.warn(
    { txSig: signature, diagnostic: lastError },
    "Pump.fun exact transaction receipt is not yet available",
  );
  return null;
}

async function notifyTransactionPrepared(
  input: ExecuteInput,
  prepared: PreparedTransaction,
): Promise<void> {
  if (!input.onPrepared) return;
  try {
    await input.onPrepared(prepared);
  } catch (err) {
    // Persistence is part of the caller-owned authorization contract. If it
    // fails, no network submission and no different transaction may follow.
    throw new SubmissionCancelledBeforeSendError(
      `prepared-transaction callback failed: ${safeDiagnostic(err)}`,
    );
  }
}

function signedTransactionSignature(tx: VersionedTransaction): string {
  const signature = tx.signatures[0];
  if (!signature || signature.every((byte) => byte === 0)) {
    throw new Error("signed transaction is missing its payer signature");
  }
  return bs58.encode(signature);
}

async function sendRawViaRpc(
  tx: VersionedTransaction,
  t0: number,
  label: string,
  knownSig: string,
  beforeSubmit?: () => boolean | Promise<boolean>,
  skipPreflight = true,
  submissionRoute: SubmissionRoute = "rpc",
  preparedSerialization?: Uint8Array,
  ensurePrepared?: () => Promise<void>,
) {
  // Serialization is local and therefore a proven pre-submission operation.
  const serialized = preparedSerialization ?? tx.serialize();
  await ensurePrepared?.();
  await assertSubmissionAuthorized(beforeSubmit);
  await submitKnownSignatureWithTimeout({
    route: submissionRoute,
    knownSig,
    timeoutMs: RAW_SUBMISSION_TIMEOUT_MS,
    send: () =>
      conn.sendRawTransaction(serialized, {
        skipPreflight,
        maxRetries: 2,
      }),
  });
  log.info({ sig: knownSig, ms: Date.now() - t0, label }, "rpc transaction submitted");
  return knownSig;
}

async function waitForLanding(
  sig: string,
  t0: number,
  label: string,
  route: SubmissionRoute,
  minimumConfirmation: "processed" | "confirmed" = "processed",
) {
  const deadline = Date.now() + LANDING_TIMEOUT_MS;
  let lastStatus: string | null = null;
  let lastRpcError: string | null = null;

  while (Date.now() < deadline) {
    let value;
    try {
      ({ value } = await executorRpcWithTimeout(
        conn.getSignatureStatuses([sig], { searchTransactionHistory: true }),
        Math.min(SOLANA_RPC_CALL_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        `${label} signature-status RPC`,
      ));
      lastRpcError = null;
    } catch (err) {
      lastRpcError = safeDiagnostic(err);
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    const status = value[0];
    if (status?.err) {
      throw new SubmittedTransactionFailedError({
        route,
        txSig: sig,
        detail: `${label} transaction failed on-chain: ${safeDiagnostic(JSON.stringify(status.err))}`,
      });
    }
    if (status) {
      lastStatus =
        status.confirmationStatus ?? (status.confirmations === null ? "finalized" : "processed");
      if (minimumConfirmation === "confirmed" && lastStatus === "processed") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      log.info(
        { sig, status: lastStatus, ms: Date.now() - t0, label },
        "transaction landed on-chain",
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new SubmissionUncertainError({
    route,
    txSig: sig,
    detail: `${label} transaction was not seen on-chain within ${LANDING_TIMEOUT_MS / 1000}s${lastStatus ? ` (last status: ${lastStatus})` : ""}${lastRpcError ? ` (last RPC error: ${lastRpcError})` : ""}`,
  });
}

async function sendViaJito(
  tx: VersionedTransaction,
  signer: Keypair,
  tipSol: number,
  t0: number,
  knownSig: string,
  beforeSubmit?: () => boolean | Promise<boolean>,
  ensurePrepared?: () => Promise<void>,
): Promise<ExecuteResult> {
  const client = searcherClient(new URL(env.JITO_BLOCK_ENGINE_URL).host);
  const tipAcct = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  const { blockhash } = await conn.getLatestBlockhash("processed");
  const tipTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: tipAcct,
          lamports: Math.floor(tipSol * 1e9),
        }),
      ],
    }).compileToV0Message(),
  );
  tipTx.sign([signer]);

  const bundle = new Bundle([tx, tipTx], 5);
  await ensurePrepared?.();
  await assertSubmissionAuthorized(beforeSubmit);
  let bundleId: string;
  try {
    const result = await client.sendBundle(bundle);
    if (!result.ok) {
      throw new SubmissionUncertainError({
        route: "jito",
        txSig: knownSig,
        detail: result.error,
      });
    }
    bundleId = result.value;
  } catch (err) {
    if (isPostSubmissionError(err)) throw err;
    throw new SubmissionUncertainError({ route: "jito", txSig: knownSig, detail: err });
  }
  log.info({ sig: knownSig, bundleId, ms: Date.now() - t0 }, "jito bundle sent");
  return { txSig: knownSig, latencyMs: Date.now() - t0, route: "jito" };
}
