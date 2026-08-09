import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { db, type BotConfigRow } from "./db.js";
import { env } from "./env.js";
import { encryptPrivateKey } from "./crypto.js";

function write(message: string) {
  process.stdout.write(message);
}

async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    write(prompt);
    let value = "";
    for await (const chunk of stdin) value += chunk.toString("utf8");
    return value.trim();
  }

  return await new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        const code = char.charCodeAt(0);
        if (code === 3) {
          cleanup();
          stdout.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (code === 8 || code === 127) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdout.write(prompt);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

async function loadConfig(): Promise<BotConfigRow | null> {
  const byUser = await db.from("bot_config").select("*").eq("user_id", env.HELIX_USER_ID).maybeSingle();
  if (byUser.error) throw new Error(`bot_config query failed: ${byUser.error.message}`);
  if (byUser.data) return byUser.data as BotConfigRow;

  const any = await db.from("bot_config").select("*")
    .not("target_wallet", "is", null).neq("target_wallet", "")
    .order("updated_at", { ascending: false }).limit(1);
  if (any.error) throw new Error(`bot_config fallback query failed: ${any.error.message}`);
  const row = any.data?.[0] as BotConfigRow | undefined;
  if (row) {
    throw new Error(
      "HELIX_USER_ID mismatch: worker identity does not match the configured dashboard row",
    );
  }
  return null;
}

async function main() {
  console.log("\nHelix funding wallet saver\n");
  console.log("For security, your private key will NOT show on screen while you paste it.");
  console.log("Paste it once, then press Enter. If nothing appears, that is normal.\n");

  const cfg = await loadConfig();
  if (!cfg) throw new Error("No bot_config row found. Save the target wallet in the dashboard first.");

  console.log(`Saving key for config user_id: ${cfg.user_id}`);
  console.log(`Target wallet: ${cfg.target_wallet ?? "not set"}`);

  const privateKey = await readHidden("Paste Phantom private key, then press Enter: ");
  if (!privateKey) throw new Error("No private key pasted");

  console.log("Private key received. Validating and saving...");

  const decoded = bs58.decode(privateKey.trim());
  if (decoded.length !== 64) {
    throw new Error(`Private key decoded to ${decoded.length} bytes; Phantom/Solana secret keys must decode to 64 bytes.`);
  }

  const signer = Keypair.fromSecretKey(decoded);
  const ciphertext = encryptPrivateKey(privateKey.trim());
  const { error } = await db.from("funding_keys").upsert({
    user_id: cfg.user_id,
    wallet_pubkey: signer.publicKey.toBase58(),
    ciphertext,
  }, { onConflict: "user_id" });

  if (error) throw new Error(`funding_keys save failed: ${error.message}`);

  console.log(`✅ Funding key saved for wallet: ${signer.publicKey.toBase58()}`);
  console.log("Next: run bun run doctor");
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
