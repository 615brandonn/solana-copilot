import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "./db.js";
import { env } from "./env.js";

const IGNORE = new Set<string>([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "Vote111111111111111111111111111111111111111",
]);

type Funder = { count: number; totalSol: number; sampleWallet: string };

async function oldestSignature(conn: Connection, wallet: PublicKey, maxPages: number): Promise<string | null> {
  let before: string | undefined = undefined;
  let oldest: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const sigs = await conn.getSignaturesForAddress(wallet, { limit: 1000, before });
    if (sigs.length === 0) break;
    oldest = sigs[sigs.length - 1]!.signature;
    if (sigs.length < 1000) break;
    before = oldest;
    await new Promise((r) => setTimeout(r, 120));
  }
  return oldest;
}

async function main() {
  // Top crew wallets (reused) + biggest burners.
  const { data, error } = await (db as any)
    .from("custody_journey_wallets")
    .select("wallet,hop_depth,total_unresolved_outflow_tokens")
    .gte("hop_depth", 1)
    .order("total_unresolved_outflow_tokens", { ascending: false })
    .limit(120);
  if (error) throw new Error(`query failed: ${error.message}`);

  const seen = new Set<string>();
  const wallets: string[] = [];
  for (const row of Array.isArray(data) ? data : []) {
    const w = String(row.wallet ?? "").trim();
    if (w && !seen.has(w)) { seen.add(w); wallets.push(w); }
    if (wallets.length >= 30) break;
  }
  console.log(`Tracing the funding source of ${wallets.length} of his wallets...\n`);

  const conn = new Connection(env.RPC_URL, "confirmed");
  const funders = new Map<string, Funder>();
  let traced = 0;

  for (const w of wallets) {
    try {
      const pk = new PublicKey(w);
      const oldestSig = await oldestSignature(conn, pk, 6);
      if (!oldestSig) { console.log(`  ${w.slice(0,8)}  (no history)`); continue; }
      const tx = await conn.getParsedTransaction(oldestSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!tx || !tx.meta) continue;
      traced += 1;

      const keys = tx.transaction.message.accountKeys as Array<{ pubkey: PublicKey }>;
      const pre = tx.meta.preBalances ?? [];
      const post = tx.meta.postBalances ?? [];
      const idx = keys.findIndex((k) => k.pubkey.toBase58() === w);
      const funded = idx >= 0 ? ((post[idx] ?? 0) - (pre[idx] ?? 0)) / 1e9 : 0;

      // The funder is the account that lost the most SOL in this first tx.
      let funder: string | null = null;
      let biggestOut = 0;
      for (let i = 0; i < keys.length; i++) {
        const addr = keys[i]!.pubkey.toBase58();
        if (addr === w || IGNORE.has(addr)) continue;
        const out = ((pre[i] ?? 0) - (post[i] ?? 0)) / 1e9;
        if (out > biggestOut) { biggestOut = out; funder = addr; }
      }
      if (funder) {
        const f = funders.get(funder) ?? { count: 0, totalSol: 0, sampleWallet: w };
        f.count += 1;
        f.totalSol += Math.max(0, funded);
        funders.set(funder, f);
        console.log(`  ${w.slice(0,8)}  funded by  ${funder.slice(0,8)}  (${Math.max(0,funded).toFixed(3)} SOL)`);
      }
    } catch (e) {
      console.log(`  ${w.slice(0,8)}  error`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`\n=== FUNDERS ranked by how many of his wallets they funded ===`);
  const ranked = [...funders.entries()].sort((a, b) => b[1].count - a[1].count || b[1].totalSol - a[1].totalSol);
  for (const [addr, f] of ranked.slice(0, 15)) {
    console.log(`  ${String(f.count).padStart(3)} wallets  ${f.totalSol.toFixed(2).padStart(9)} SOL  ${addr}`);
    console.log(`         https://solscan.io/account/${addr}`);
  }
  console.log(`\nAn address that funded MANY of his wallets is his central master/funding wallet — the top of the pyramid.`);
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); },
);
