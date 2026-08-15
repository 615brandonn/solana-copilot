import { Connection, PublicKey } from "@solana/web3.js";
import { env } from "./env.js";

// Hubs to trace up: the cross-confirmed hub (funds wallets AND collects proceeds),
// a secondary funder, and the 3 known target/front wallets.
const HUBS: Record<string, string> = {
  "C3FzbX9n1YD2dow2dCmEv5uNyyf22Gb3TLAEqGBhw5fY": "cross-confirmed hub (funds + collects)",
  "CRo8DBwrmd97DJfAnvCv96tZPL5Mktf2NZy2ZnhDer1A": "secondary funder",
  "Em8J3gBWapfVBGVhVipwQnLrqCvnWBnLajw6XFsFECPF": "target wallet 1",
  "7iVCXQn4u6tiTEfNVqbWSEsRdEi69E9oYsSMiepuECwi": "target wallet 2",
  "7JCe3GHwkEr3feHgtLXnmuJ1yB3A7coSeyynxTBgdG8k": "target wallet 3",
};

const IGNORE = new Set<string>([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "Vote111111111111111111111111111111111111111",
]);

async function oldestSignatures(conn: Connection, wallet: PublicKey, maxPages: number): Promise<string[]> {
  let before: string | undefined = undefined;
  let lastPage: string[] = [];
  for (let page = 0; page < maxPages; page++) {
    const sigs = await conn.getSignaturesForAddress(wallet, { limit: 1000, before });
    if (sigs.length === 0) break;
    lastPage = sigs.map((s) => s.signature);
    if (sigs.length < 1000) break;
    before = lastPage[lastPage.length - 1];
    await new Promise((r) => setTimeout(r, 120));
  }
  // Return the oldest ~10 signatures, oldest first.
  return lastPage.slice(-10).reverse();
}

async function findFunder(conn: Connection, wallet: string): Promise<{ funder: string; sol: number; sig: string } | null> {
  const pk = new PublicKey(wallet);
  const oldest = await oldestSignatures(conn, pk, 40);
  for (const sig of oldest) {
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    await new Promise((r) => setTimeout(r, 120));
    if (!tx || !tx.meta) continue;
    const keys = tx.transaction.message.accountKeys as Array<{ pubkey: PublicKey }>;
    const pre = tx.meta.preBalances ?? [];
    const post = tx.meta.postBalances ?? [];
    const idx = keys.findIndex((k) => k.pubkey.toBase58() === wallet);
    if (idx < 0) continue;
    const gained = ((post[idx] ?? 0) - (pre[idx] ?? 0)) / 1e9;
    if (gained <= 0.001) continue; // not a funding tx
    let funder: string | null = null;
    let biggestOut = 0;
    for (let i = 0; i < keys.length; i++) {
      const addr = keys[i]!.pubkey.toBase58();
      if (addr === wallet || IGNORE.has(addr)) continue;
      const out = ((pre[i] ?? 0) - (post[i] ?? 0)) / 1e9;
      if (out > biggestOut) { biggestOut = out; funder = addr; }
    }
    if (funder) return { funder, sol: gained, sig };
  }
  return null;
}

async function main() {
  const conn = new Connection(env.RPC_URL, "confirmed");
  const funderTally = new Map<string, number>();

  for (const [wallet, label] of Object.entries(HUBS)) {
    try {
      const res = await findFunder(conn, wallet);
      if (res) {
        funderTally.set(res.funder, (funderTally.get(res.funder) ?? 0) + 1);
        console.log(`  ${label}`);
        console.log(`    ${wallet.slice(0,12)}…  first funded by  ${res.funder}  (${res.sol.toFixed(3)} SOL)`);
        console.log(`    https://solscan.io/account/${res.funder}\n`);
      } else {
        console.log(`  ${label}: could not reach a funding tx (wallet too active / genesis beyond page cap)\n`);
      }
    } catch (e) {
      console.log(`  ${label}: error ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  console.log(`=== CONVERGENCE CHECK ===`);
  const ranked = [...funderTally.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) { console.log("No funding txs reached."); }
  for (const [addr, n] of ranked) {
    console.log(`  ${n} hub(s) funded by  ${addr}`);
  }
  console.log(`\nIf ONE address funded multiple hubs, that is the master wallet — top of the pyramid.`);
}

main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
