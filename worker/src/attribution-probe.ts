import { Connection, PublicKey } from "@solana/web3.js";
import { db } from "./db.js";
import { env } from "./env.js";

const HOSTILE: Record<string, string> = {
  "58PMEdUAwvLytNNwCbzrYyhLoh3jpsNV4fW9dT9ibuRc": "private executor",
  "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH": "DFlow",
};

async function main() {
  const { data, error } = await (db as any)
    .from("custody_journey_wallets")
    .select("wallet,last_tx_sig,token_mint")
    .gt("total_unresolved_outflow_tokens", 0)
    .not("last_tx_sig", "is", null)
    .order("total_unresolved_outflow_tokens", { ascending: false })
    .limit(20);
  if (error) throw new Error(`query failed: ${error.message}`);

  const rows = (Array.isArray(data) ? data : []).filter(
    (r: { last_tx_sig?: string }) => String(r.last_tx_sig ?? "").length > 40,
  );
  console.log(`Probing ${rows.length} unresolved-outflow transactions...\n`);

  const conn = new Connection(env.RPC_URL, "confirmed");
  let ownerSigned = 0;
  let notSigned = 0;
  let delegated = 0;
  const programTally = new Map<string, number>();

  for (const row of rows) {
    const wallet: string = String(row.wallet);
    const sig: string = String(row.last_tx_sig);
    const mint: string = String(row.token_mint);
    try {
      const tx = await conn.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!tx) {
        console.log(`  ${sig.slice(0, 8)}  (not found)`);
        continue;
      }

      const keys = tx.transaction.message.accountKeys as Array<{ pubkey: PublicKey; signer: boolean }>;
      const walletSigned = keys.some((k) => k.pubkey.toBase58() === wallet && k.signer);
      const signers = keys.filter((k) => k.signer).map((k) => k.pubkey.toBase58());

      // Which hostile program is present at any level
      const logs = tx.meta?.logMessages ?? [];
      const hostilePresent = Object.keys(HOSTILE).filter((p) =>
        logs.some((l) => typeof l === "string" && l.includes(p)),
      );
      for (const p of hostilePresent) programTally.set(p, (programTally.get(p) ?? 0) + 1);

      // Look for a delegate on the wallet's token account for this mint in pre balances
      const pre = (tx.meta?.preTokenBalances ?? []) as Array<{ owner?: string; mint?: string }>;
      const walletHeldMint = pre.some((b) => b.owner === wallet && b.mint === mint);

      // Inspect instructions for an spl-token transfer/burn whose authority is NOT the wallet
      let authorityNotWallet = false;
      const allIx: any[] = [
        ...(tx.transaction.message.instructions as any[]),
        ...((tx.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions) as any[]),
      ];
      for (const ix of allIx) {
        const parsed = ix?.parsed;
        if (!parsed || typeof parsed !== "object") continue;
        const type = parsed.type;
        const info = parsed.info ?? {};
        if (
          (type === "transfer" || type === "transferChecked" || type === "burn" || type === "burnChecked") &&
          (info.authority || info.multisigAuthority || info.owner)
        ) {
          const auth = info.authority ?? info.owner ?? info.multisigAuthority;
          const source = info.source ?? info.account;
          // Only count when it concerns the wallet's tokens moving out
          if (auth && auth !== wallet && (info.owner === wallet || walletHeldMint)) {
            authorityNotWallet = true;
          }
        }
      }

      if (walletSigned) ownerSigned += 1;
      else {
        notSigned += 1;
        if (authorityNotWallet || !walletHeldMint) delegated += 1;
      }

      const label = hostilePresent.map((p) => HOSTILE[p]).join("+") || "other";
      console.log(
        `  ${sig.slice(0, 8)}  wallet-signed=${walletSigned ? "YES" : "no "}  authority!=wallet=${authorityNotWallet ? "YES" : "no "}  via=${label}  signers=${signers.length}`,
      );
    } catch (err) {
      console.log(`  ${sig.slice(0, 8)}  error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`follower wallet SIGNED its own sell : ${ownerSigned}`);
  console.log(`follower wallet did NOT sign        : ${notSigned}`);
  console.log(`  of those, authority was not wallet: ${delegated}  (delegation / executor-authority)`);
  for (const [p, n] of programTally) console.log(`program ${HOSTILE[p]}: ${n}`);
  console.log(`\nIf most sells are wallet-SIGNED, tonight's venue fix already lets proportional follower sell catch them.`);
  console.log(`If most are NOT signed (executor authority), proportional follower sell needs a delegation-aware attribution patch.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
