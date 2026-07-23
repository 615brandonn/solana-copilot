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
};

export type ExecuteResult = { txSig: string; latencyMs: number; route: "jito" | "rpc"; outUiAmount?: number };

export async function executeSwap(input: ExecuteInput): Promise<ExecuteResult> {
  const t0 = Date.now();
  const signer = Keypair.fromSecretKey(bs58.decode(input.signerSecret));

  // 1. Get Jupiter quote + swap tx
  const quoteUrl = new URL("https://quote-api.jup.ag/v6/quote");
  quoteUrl.searchParams.set("inputMint", input.inputMint);
  quoteUrl.searchParams.set("outputMint", input.outputMint);
  quoteUrl.searchParams.set("amount", String(input.amountLamports));
  quoteUrl.searchParams.set("slippageBps", String(input.slippageBps));
  const quote = await (await fetch(quoteUrl)).json() as any;

  const swapResp = await (
    await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: "auto",
      }),
    })
  ).json() as any;

  const tx = VersionedTransaction.deserialize(Buffer.from(swapResp.swapTransaction, "base64"));
  tx.sign([signer]);

  if (input.route === "jito" && JITO_TIP_ACCOUNTS.length > 0) {
    return await sendViaJito(tx, signer, input.jitoTipSol, t0);
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 });
  log.info({ sig, ms: Date.now() - t0 }, "rpc sent");
  return { txSig: sig, latencyMs: Date.now() - t0, route: "rpc" };
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
