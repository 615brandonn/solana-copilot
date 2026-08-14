import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "./db.js";
import { env } from "./env.js";

const WSOL = "So11111111111111111111111111111111111111112";

async function main() {
  const { data, error } = await (db as any)
    .from("custody_journey_wallets")
    .select("wallet,last_tx_sig,token_mint")
    .gt("total_unresolved_outflow_tokens", 0)
    .not("last_tx_sig", "is", null)
    .order("total_unresolved_outflow_tokens", { ascending: false })
    .limit(25);
  if (error) throw new Error(`query failed: ${error.message}`);

  const rows = (Array.isArray(data) ? data : []).filter(
    (r: { last_tx_sig?: string }) => String(r.last_tx_sig ?? "").length > 40,
  );
  console.log(`Probing ${rows.length} delegated-sell transactions for proceeds destination...\n`);

  const conn = new Connection(env.RPC_URL, "confirmed");
  let solToWallet = 0;
  let solElsewhere = 0;
  let noSolAtAll = 0;
  let walletSignedSample = 0;

  for (const row of rows) {
    const wallet: string = String(row.wallet);
    const sig: string = String(row.last_tx_sig);
    const mint: string = String(row.token_mint);
    try {
      const tx = await conn.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx || !tx.meta) {
        console.log(`  ${sig.slice(0, 8)}  (not found)`);
        continue;
      }

      const keys = tx.transaction.message.accountKeys as Array<{ pubkey: PublicKey; signer: boolean }>;
      const walletSigned = keys.some((k) => k.pubkey.toBase58() === wallet && k.signer);
      if (walletSigned) walletSignedSample += 1;

      // Native SOL delta for the follower wallet (lamports pre/post by account index)
      const idx = keys.findIndex((k) => k.pubkey.toBase58() === wallet);
      const preL = tx.meta.preBalances?.[idx] ?? 0;
      const postL = tx.meta.postBalances?.[idx] ?? 0;
      const walletNativeSolDelta = (postL - preL) / 1e9;

      // WSOL token delta for the follower wallet
      const pre = (tx.meta.preTokenBalances ?? []) as Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number } }>;
      const post = (tx.meta.postTokenBalances ?? []) as Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number } }>;
      const wsolPre = pre.filter((b) => b.owner === wallet && b.mint === WSOL).reduce((s, b) => s + (b.uiTokenAmount?.uiAmount ?? 0), 0);
      const wsolPost = post.filter((b) => b.owner === wallet && b.mint === WSOL).reduce((s, b) => s + (b.uiTokenAmount?.uiAmount ?? 0), 0);
      const walletWsolDelta = wsolPost - wsolPre;

      const walletSolIn = walletNativeSolDelta + walletWsolDelta;

      // Was ANY WSOL/SOL produced in the tx at all (any account gained SOL)?
      const anyWsolPositive = post.some((b) => b.mint === WSOL && (b.uiTokenAmount?.uiAmount ?? 0) > 0);

      let verdict: string;
      if (walletSolIn > 0.0005) {
        solToWallet += 1;
        verdict = `SOL→wallet (+${walletSolIn.toFixed(4)})`;
      } else if (anyWsolPositive) {
        solElsewhere += 1;
        verdict = "SOL→ELSEWHERE (proceeds left the wallet)";
      } else {
        noSolAtAll += 1;
        verdict = "no SOL proceeds in tx (maybe pure transfer/bridge)";
      }
      console.log(`  ${sig.slice(0, 8)}  wallet-signed=${walletSigned ? "Y" : "n"}  ${verdict}`);
    } catch (err) {
      console.log(`  ${sig.slice(0, 8)}  error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`proceeds returned TO the follower wallet : ${solToWallet}`);
  console.log(`proceeds went ELSEWHERE (not the wallet) : ${solElsewhere}`);
  console.log(`no SOL proceeds in the tx at all         : ${noSolAtAll}`);
  console.log(`(of sample, wallet-signed: ${walletSignedSample})`);
  console.log(`\nIf most are SOL→wallet: a delegation-aware patch is SAFE (drop the signer requirement; balance logic already proves the sale).`);
  console.log(`If most are SOL→ELSEWHERE / no-SOL: attribution cannot safely call these sales; rely on crew/terminal exits instead.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
