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
  type Transaction,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { AnchorProvider, type Wallet } from "@coral-xyz/anchor";
import {
  TokenAccountNotFoundError,
  getAccount,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher.js";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types.js";
import { PumpFunSDK } from "pumpdotfun-sdk";
import bs58 from "bs58";
import { fetch } from "undici";
import pino from "pino";
import { env } from "./env.js";
import { safeDiagnostic } from "./diagnostics.js";
import { attributablePositiveBalanceDelta } from "./execution-accounting.js";
import {
  SubmissionUncertainError,
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

export type ExecuteInput = {
  signerSecret: string; // base58 secret key of funding wallet
  inputMint: string; // e.g. So1111... for SOL
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
  route: "jito" | "rpc";
  jitoTipSol: number;
  outputDecimals?: number; // needed to compute UI amount received (Jupiter v6 doesn't return this)
  /** Rechecked immediately before the first network submission begins. */
  beforeSubmit?: () => boolean | Promise<boolean>;
};

export type ExecuteResult = {
  txSig: string;
  latencyMs: number;
  route: "jito" | "rpc";
  outUiAmount?: number;
};

class KeypairWallet implements Wallet {
  public readonly publicKey: PublicKey;
  public readonly payer: Keypair;

  constructor(payer: Keypair) {
    this.payer = payer;
    this.publicKey = payer.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if ("version" in tx) tx.sign([this.payer]);
    else tx.partialSign(this.payer);
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((tx) => this.signTransaction(tx)));
  }
}

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

export async function executeSwap(input: ExecuteInput): Promise<ExecuteResult> {
  const t0 = Date.now();
  const decodedSecret = bs58.decode(input.signerSecret.trim());
  if (decodedSecret.length !== 64) {
    throw new Error(
      `Funding private key decoded to ${decodedSecret.length} bytes; Phantom/base58 secret keys must decode to 64 bytes`,
    );
  }
  const signer = Keypair.fromSecretKey(decodedSecret);

  const failures: string[] = [];
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

  if (input.route === "jito" && JITO_TIP_ACCOUNTS.length > 0) {
    let jitoAccepted = false;
    let submissionMayHaveOccurred = false;
    try {
      await sendViaJito(tx, signer, input.jitoTipSol, t0, knownSig, input.beforeSubmit);
      jitoAccepted = true;
      submissionMayHaveOccurred = true;
    } catch (err) {
      // A caller-owned final safety gate is an explicit cancellation, not a
      // route failure. Never let it fall through to the same-signature backup
      // (or any later execution path) if authorization was revoked.
      if (!mayTryAlternateExecution(err) && !isPostSubmissionError(err)) throw err;
      submissionMayHaveOccurred = isPostSubmissionError(err);
      log.warn(
        {
          err: safeDiagnostic(err),
          txSig: submissionMayHaveOccurred ? knownSig : undefined,
        },
        submissionMayHaveOccurred
          ? "Jito submission outcome uncertain — broadcasting only the same signed swap through RPC"
          : "Jito failed before a confirmed submission attempt — broadcasting the signed swap through RPC",
      );
    }

    // A second broadcast of these exact serialized bytes has the same signature,
    // so it cannot create a second trade. Never build a different transaction
    // once either submission path may have accepted this one.
    try {
      await sendRawViaRpc(
        tx,
        t0,
        "jito-rpc-backup",
        knownSig,
        submissionMayHaveOccurred ? undefined : input.beforeSubmit,
      );
      submissionMayHaveOccurred = true;
    } catch (err) {
      if (!submissionMayHaveOccurred && !isPostSubmissionError(err)) throw err;
      submissionMayHaveOccurred ||= isPostSubmissionError(err);
      log.warn(
        { err: safeDiagnostic(err), txSig: knownSig },
        "same-signature RPC broadcast did not return a definitive result; reconciling signature",
      );
    }

    if (!submissionMayHaveOccurred) {
      throw new Error("Jito and RPC failed before transaction submission");
    }
    await waitForLanding(knownSig, t0, "jito/rpc-backup", jitoAccepted ? "jito" : "rpc");
    return {
      txSig: knownSig,
      latencyMs: Date.now() - t0,
      route: jitoAccepted ? "jito" : "rpc",
      outUiAmount,
    };
  }

  try {
    await sendRawViaRpc(tx, t0, "rpc", knownSig, input.beforeSubmit);
  } catch (err) {
    if (!isPostSubmissionError(err)) throw err;
    log.warn(
      { err: safeDiagnostic(err), txSig: knownSig },
      "RPC submission did not return a definitive result; reconciling signature",
    );
  }
  await waitForLanding(knownSig, t0, "rpc", "rpc");
  return { txSig: knownSig, latencyMs: Date.now() - t0, route: "rpc", outUiAmount };
}

type JupiterOrder = {
  transaction?: string | null;
  requestId?: string;
  outAmount?: string;
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
  const signedTransaction = Buffer.from(tx.serialize()).toString("base64");
  let executed: JupiterExecute & Record<string, unknown>;
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
  const provider = new AnchorProvider(conn, new KeypairWallet(signer), {
    commitment: "processed",
    preflightCommitment: "processed",
  });
  const sdk = new PumpFunSDK(provider);

  // Snapshot the existing balance before a BUY so the fallback can calculate
  // only newly received tokens. Returning the full ATA balance would corrupt
  // scale-ins and positions that coexist with manually held tokens.
  const preBuyTokenBalanceUi = isBuy
    ? await tokenBalanceUi(signer.publicKey, mint, input.outputDecimals)
    : 0;

  // Use the SDK only to construct deterministic instructions. We own the
  // blockhash, signature and RPC call, which puts the caller's final safety
  // gate immediately before the actual network-send boundary.
  const pumpInstructions = isBuy
    ? await sdk.getBuyInstructionsBySolAmount(
        signer.publicKey,
        mint,
        BigInt(input.amountLamports),
        BigInt(input.slippageBps),
        "processed",
      )
    : await sdk.getSellInstructionsByTokenAmount(
        signer.publicKey,
        mint,
        BigInt(input.amountLamports),
        BigInt(input.slippageBps),
        "processed",
      );
  const { blockhash } = await conn.getLatestBlockhash("processed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 }),
        ...pumpInstructions.instructions,
      ],
    }).compileToV0Message(),
  );
  tx.sign([signer]);
  const knownSig = signedTransactionSignature(tx);

  try {
    await sendRawViaRpc(tx, t0, "pump.fun", knownSig, input.beforeSubmit, false, "pump.fun");
  } catch (err) {
    if (!isPostSubmissionError(err)) throw err;
    log.warn(
      { err: safeDiagnostic(err), txSig: knownSig },
      "Pump.fun RPC submission was not definitive; reconciling the exact signature",
    );
  }
  await waitForLanding(knownSig, t0, "pump.fun", "pump.fun", "confirmed");

  let landedTx: VersionedTransactionResponse | null = null;
  try {
    landedTx = await conn.getTransaction(knownSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    log.warn(
      { err: safeDiagnostic(err), txSig: knownSig },
      "Pump.fun transaction details were unavailable; reconciling from wallet balance",
    );
  }

  let outUiAmount: number | undefined;
  if (isBuy) {
    outUiAmount = tokenDeltaFromTx(
      landedTx ?? undefined,
      signer.publicKey.toBase58(),
      mint.toBase58(),
    );
    if (outUiAmount === undefined) {
      let postBuyTokenBalanceUi: number;
      try {
        postBuyTokenBalanceUi = await tokenBalanceUi(signer.publicKey, mint, input.outputDecimals);
      } catch (err) {
        throw new SubmissionUncertainError({
          route: "pump.fun",
          txSig: knownSig,
          detail: `landed buy balance reconciliation failed: ${safeDiagnostic(err)}`,
        });
      }
      const balanceDelta = attributablePositiveBalanceDelta(
        preBuyTokenBalanceUi,
        postBuyTokenBalanceUi,
      );
      if (balanceDelta === undefined) {
        throw new SubmissionUncertainError({
          route: "pump.fun",
          txSig: knownSig,
          detail: "landed buy did not produce a positive attributable token balance delta",
        });
      }
      outUiAmount = balanceDelta;
    }
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
  return { txSig: knownSig, latencyMs: Date.now() - t0, route: "rpc", outUiAmount };
}

function tokenDeltaFromTx(
  tx: VersionedTransactionResponse | undefined,
  owner: string,
  mint: string,
): number | undefined {
  const pre = (tx?.meta?.preTokenBalances ?? [])
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce(
      (sum, b) => sum + Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0),
      0,
    );
  const post = (tx?.meta?.postTokenBalances ?? [])
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce(
      (sum, b) => sum + Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0),
      0,
    );
  const delta = post - pre;
  return delta > 0 ? delta : undefined;
}

async function tokenBalanceUi(owner: PublicKey, mint: PublicKey, decimals = 6): Promise<number> {
  const ata = await getAssociatedTokenAddress(mint, owner, false);
  try {
    const account = await getAccount(conn, ata, "processed");
    return Number(account.amount) / Math.pow(10, decimals);
  } catch (err) {
    // A missing ATA before the first buy is an authoritative zero balance.
    // RPC and malformed-account failures remain errors so execution does not
    // fabricate a received amount.
    if (err instanceof TokenAccountNotFoundError) return 0;
    throw err;
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
) {
  // Serialization is local and therefore a proven pre-submission operation.
  const serialized = tx.serialize();
  await assertSubmissionAuthorized(beforeSubmit);
  let returnedSig: string;
  try {
    returnedSig = await conn.sendRawTransaction(serialized, {
      skipPreflight,
      maxRetries: 2,
    });
  } catch (err) {
    throw new SubmissionUncertainError({ route: submissionRoute, txSig: knownSig, detail: err });
  }
  if (returnedSig !== knownSig) {
    throw new SubmissionUncertainError({
      route: submissionRoute,
      txSig: knownSig,
      detail: "RPC returned a different transaction signature",
    });
  }
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
      ({ value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }));
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
