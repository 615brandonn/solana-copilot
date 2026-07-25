// Executor: builds the swap tx and sends it either through Jito (default)
// or straight through the RPC. Uses Jupiter aggregator for route quoting.

import { Connection, Keypair, VersionedTransaction, PublicKey, SystemProgram, TransactionMessage } from "@solana/web3.js";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher.js";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types.js";
import bs58 from "bs58";
import { fetch } from "undici";
import pino from "pino";
import { env } from "./env.js";

const log = pino({ level: env.LOG_LEVEL });
const conn = new Connection(env.RPC_URL, { commitment: "processed" });

const JITO_TIP_ACCOUNTS = (env.JITO_TIP_ACCOUNTS ?? "").split(",").filter(Boolean).map((s) => new PublicKey(s));

export type ExecuteInput = {
  signerSecret: string;              // base58 secret key of funding wallet
  inputMint: string;                 // e.g. So1111... for SOL
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
  route: "jito" | "rpc";
  jitoTipSol: number;
  outputDecimals?: number;           // needed to compute UI amount received (Jupiter v6 doesn't return this)
};

export type ExecuteResult = { txSig: string; latencyMs: number; route: "jito" | "rpc"; outUiAmount?: number };

const JUPITER_BASE_URLS = [
  "https://lite-api.jup.ag/swap/v1",
  "https://quote-api.jup.ag/v6",
];

type FetchResponseLike = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

async function readJsonOrThrow(resp: FetchResponseLike, label: string) {
  const text = await resp.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!resp.ok) {
    throw new Error(`${label} HTTP ${resp.status}: ${json?.error ?? json?.message ?? text.slice(0, 180)}`);
  }
  if (json?.error) throw new Error(`${label}: ${json.error}`);
  return json;
}

async function fetchJupiterQuote(input: ExecuteInput) {
  const errors: string[] = [];
  for (const base of JUPITER_BASE_URLS) {
    try {
      const quoteUrl = new URL(`${base}/quote`);
      quoteUrl.searchParams.set("inputMint", input.inputMint);
      quoteUrl.searchParams.set("outputMint", input.outputMint);
      quoteUrl.searchParams.set("amount", String(input.amountLamports));
      quoteUrl.searchParams.set("slippageBps", String(input.slippageBps));
      const quote = await readJsonOrThrow(await fetch(quoteUrl), "Jupiter quote");
      if (!quote?.outAmount) throw new Error("Jupiter quote did not include outAmount");
      return { base, quote };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(`All Jupiter quote endpoints failed: ${errors.join(" | ")}`);
}

async function fetchJupiterSwap(base: string, quote: any, signer: Keypair) {
  const swap = await readJsonOrThrow(await fetch(`${base}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  }), "Jupiter swap");
  if (!swap?.swapTransaction) throw new Error(`Jupiter swap did not return a transaction: ${JSON.stringify(swap).slice(0, 220)}`);
  return swap;
}

export async function executeSwap(input: ExecuteInput): Promise<ExecuteResult> {
  const t0 = Date.now();
  const decodedSecret = bs58.decode(input.signerSecret.trim());
  if (decodedSecret.length !== 64) {
    throw new Error(`Funding private key decoded to ${decodedSecret.length} bytes; Phantom/base58 secret keys must decode to 64 bytes`);
  }
  const signer = Keypair.fromSecretKey(decodedSecret);

  // 1. Get Jupiter quote + swap tx
  const { base, quote } = await fetchJupiterQuote(input);
  const swapResp = await fetchJupiterSwap(base, quote, signer);

  const tx = VersionedTransaction.deserialize(Buffer.from(swapResp.swapTransaction, "base64"));
  tx.sign([signer]);

  // Jupiter v6 quote returns outAmount as a RAW string. It does not return
  // outputDecimals reliably, so callers pass it in (from the target-swap event).
  const outAmountRaw = Number(quote?.outAmount ?? 0);
  const outDecimals = Number(input.outputDecimals ?? quote?.outputDecimals ?? swapResp?.outputDecimals ?? 0);
  const outUiAmount = outDecimals > 0 ? outAmountRaw / Math.pow(10, outDecimals) : outAmountRaw;

  if (input.route === "jito" && JITO_TIP_ACCOUNTS.length > 0) {
    const r = await sendViaJito(tx, signer, input.jitoTipSol, t0);
    // Also push the exact same signed swap through RPC. Same signature means it
    // cannot double-buy, but it gives the trade a second path if Jito accepts a
    // bundle that never lands.
    sendRawViaRpc(tx, t0, "jito-rpc-backup").catch((err) => log.warn({ err }, "rpc backup submit failed"));
    return { ...r, outUiAmount };
  }
  const sig = await sendRawViaRpc(tx, t0, "rpc");
  return { txSig: sig, latencyMs: Date.now() - t0, route: "rpc", outUiAmount };
}

async function sendRawViaRpc(tx: VersionedTransaction, t0: number, label: string) {
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
  log.info({ sig, ms: Date.now() - t0, label }, "rpc transaction submitted");
  return sig;
}

async function sendViaJito(tx: VersionedTransaction, signer: Keypair, tipSol: number, t0: number): Promise<ExecuteResult> {
  const client = searcherClient(new URL(env.JITO_BLOCK_ENGINE_URL).host);
  const tipAcct = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  const { blockhash } = await conn.getLatestBlockhash("processed");
  const tipTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: tipAcct,
        lamports: Math.floor(tipSol * 1e9),
      })],
    }).compileToV0Message()
  );
  tipTx.sign([signer]);

  const bundle = new Bundle([tx, tipTx], 5);
  const res = await client.sendBundle(bundle);
  const sig = bs58.encode(tx.signatures[0]);
  log.info({ sig, bundleId: res, ms: Date.now() - t0 }, "jito bundle sent");
  return { txSig: sig, latencyMs: Date.now() - t0, route: "jito" };
}
