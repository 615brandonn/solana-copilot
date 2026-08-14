import { Connection } from "@solana/web3.js";
import { db } from "./db.js";
import { env } from "./env.js";

const KNOWN: Record<string, string> = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "Raydium CPMM",
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj": "Raydium LaunchLab",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpool",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora DLMM",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": "Meteora Pools",
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG": "Meteora DAMM v2",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter v6",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap",
};

const INFRA = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
]);

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[1\]$/;

async function main() {
  const { data, error } = await (db as any)
    .from("custody_journey_wallets")
    .select("last_tx_sig")
    .gt("total_unresolved_outflow_tokens", 0)
    .not("last_tx_sig", "is", null)
    .limit(300);
  if (error) throw new Error(`query failed: ${error.message}`);

  const sigs = Array.from(
    new Set(
      (Array.isArray(data) ? data : [])
        .map((row: { last_tx_sig?: string }) => String(row.last_tx_sig ?? "").trim())
        .filter((sig: string) => sig.length > 40),
    ),
  );
  console.log(`Fetching ${sigs.length} unresolved-outflow transactions...`);

  const conn = new Connection(env.RPC_URL, "confirmed");
  const tally = new Map<string, { count: number; sample: string }>();
  let fetched = 0;
  let failed = 0;

  for (const sig of sigs) {
    try {
      const tx = await conn.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      const logs = tx?.meta?.logMessages ?? [];
      const seen = new Set<string>();
      for (const line of logs) {
        const match = typeof line === "string" ? line.match(INVOKE_RE) : null;
        if (!match) continue;
        const program = match[1]!;
        if (INFRA.has(program) || seen.has(program)) continue;
        seen.add(program);
        const entry = tally.get(program) ?? { count: 0, sample: sig };
        entry.count += 1;
        tally.set(program, entry);
      }
      fetched += 1;
    } catch {
      failed += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(`\nFetched ${fetched}, failed ${failed}. Top-level programs in hidden-exit transactions:\n`);
  const rows = [...tally.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [program, info] of rows) {
    const name = KNOWN[program] ?? "UNKNOWN — investigate";
    const pct = fetched > 0 ? ((info.count / fetched) * 100).toFixed(1) : "0";
    console.log(`${String(info.count).padStart(4)}  ${pct.padStart(5)}%  ${name.padEnd(24)} ${program}`);
    console.log(`       sample: https://solscan.io/tx/${info.sample}`);
  }
  console.log("\nDone. Programs marked UNKNOWN are candidate venues to add to the sell verifier.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
