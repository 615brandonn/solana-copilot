import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "./db.js";
import { env } from "./env.js";

const WSOL = "So11111111111111111111111111111111111111112";
const IGNORE = new Set<string>([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "Vote111111111111111111111111111111111111111",
]);

type Recip = { count: number; totalSol: number; sample: string };

async function main() {
  // Biggest hidden-dump burner txs (hop-2, hidden outflow).
  const { data, error } = await (db as any)
    .from("custody_journey_wallets")
    .select("wallet,last_tx_sig,total_unresolved_outflow_tokens")
    .eq("hop_depth", 2)
    .gt("total_unresolved_outflow_tokens", 0)
    .not("last_tx_sig", "is", null)
    .order("total_unresolved_outflow_tokens", { ascending: false })
    .limit(40);
  if (error) throw new Error(`query failed: ${error.message}`);

  const rows = (Array.isArray(data) ? data : []).filter(
    (r: { last_tx_sig?: string }) => String(r.last_tx_sig ?? "").length > 40,
  );
  console.log(`Tracing SOL proceeds across ${rows.length} burner dumps...\n`);

  const conn = new Connection(env.RPC_URL, "confirmed");
  const recipients = new Map<string, Recip>();
  let fetched = 0;

  for (const row of rows) {
    const seller = String(row.wallet);
    const sig = String(row.last_tx_sig);
    try {
      const tx = await conn.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx || !tx.meta) continue;
      fetched += 1;

      const keys = tx.transaction.message.accountKeys as Array<{ pubkey: PublicKey }>;
      const pre = tx.meta.preBalances ?? [];
      const post = tx.meta.postBalances ?? [];

      // Native SOL gainers (post-pre > threshold), excluding seller, fee payer (index 0), infra.
      for (let i = 1; i < keys.length; i++) {
        const addr = keys[i]!.pubkey.toBase58();
        if (addr === seller || IGNORE.has(addr)) continue;
        const delta = ((post[i] ?? 0) - (pre[i] ?? 0)) / 1e9;
        if (delta > 0.02) {
          const r = recipients.get(addr) ?? { count: 0, totalSol: 0, sample: sig };
          r.count += 1;
          r.totalSol += delta;
          recipients.set(addr, r);
        }
      }

      // WSOL token-account owners that gained WSOL (proceeds parked as wrapped SOL).
      const preT = (tx.meta.preTokenBalances ?? []) as Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number } }>;
      const postT = (tx.meta.postTokenBalances ?? []) as Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number } }>;
      const ownerDelta = new Map<string, number>();
      for (const b of postT) if (b.mint === WSOL && b.owner) ownerDelta.set(b.owner, (ownerDelta.get(b.owner) ?? 0) + (b.uiTokenAmount?.uiAmount ?? 0));
      for (const b of preT) if (b.mint === WSOL && b.owner) ownerDelta.set(b.owner, (ownerDelta.get(b.owner) ?? 0) - (b.uiTokenAmount?.uiAmount ?? 0));
      for (const [owner, d] of ownerDelta) {
        if (owner === seller || IGNORE.has(owner)) continue;
        if (d > 0.02) {
          const r = recipients.get(owner) ?? { count: 0, totalSol: 0, sample: sig };
          r.count += 1;
          r.totalSol += d;
          recipients.set(owner, r);
        }
      }
    } catch {
      /* skip */
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`Fetched ${fetched} dumps. Proceeds recipients ranked by how many dumps they appear in:\n`);
  const ranked = [...recipients.entries()].sort((a, b) => b[1].count - a[1].count || b[1].totalSol - a[1].totalSol);
  for (const [addr, r] of ranked.slice(0, 20)) {
    console.log(`  ${String(r.count).padStart(3)} dumps  ${r.totalSol.toFixed(2).padStart(10)} SOL  ${addr}`);
    console.log(`         sample: https://solscan.io/tx/${r.sample}`);
  }
  console.log(`\nAn address appearing across MANY different dumps is a central treasury / collection wallet.`);
  console.log(`One-off recipients are just per-swap pools/routers. Look for the recurring ones.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
