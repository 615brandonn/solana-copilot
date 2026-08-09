import "dotenv/config";
import { Connection, Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./env.js";
import { db, type BotConfigRow } from "./db.js";
import { decryptPrivateKey } from "./crypto.js";
import { decodeParsedTransaction } from "./poller.js";
import { fetch } from "undici";
import { parseJupiterPrice } from "./price-parser.js";
import { redactedIdentifier, safeDiagnostic } from "./diagnostics.js";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OFFICIAL_JITO_TIP_ACCOUNTS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);
const rpc = new Connection(env.RPC_URL, { commitment: "confirmed" });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type TransactionMeta = NonNullable<ParsedTransactionWithMeta["meta"]>;
type TokenBalance = NonNullable<TransactionMeta["preTokenBalances"]>[number];
let failureCount = 0;
let warningCount = 0;

function line(label: string, value: unknown) {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function fail(label: string, value: unknown) {
  failureCount += 1;
  console.log(`❌ ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function pass(label: string, value: unknown) {
  console.log(`✅ ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function warn(label: string, value: unknown) {
  warningCount += 1;
  console.log(`⚠️ ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function checkJupiterApi() {
  if (!env.JUPITER_API_KEY) {
    fail("Jupiter API key", "missing — add the paid key to worker/.env");
    return;
  }
  const headers = { "x-api-key": env.JUPITER_API_KEY };
  const priceUrl = new URL(env.PRICE_API_URL);
  priceUrl.searchParams.set("ids", WSOL);
  const priceResponse = await fetch(priceUrl, { headers, signal: AbortSignal.timeout(5_000) });
  const pricePayload = priceResponse.ok ? await priceResponse.json() : null;
  const solUsd = parseJupiterPrice(pricePayload, WSOL);
  if (!priceResponse.ok || solUsd === undefined) {
    fail("Jupiter Price API v3", {
      httpStatus: priceResponse.status,
      parsedSolUsd: solUsd ?? null,
    });
  } else {
    pass("Jupiter Price API v3", { httpStatus: priceResponse.status, solUsd });
  }

  const quoteUrl = new URL("https://api.jup.ag/swap/v2/order");
  quoteUrl.searchParams.set("inputMint", WSOL);
  quoteUrl.searchParams.set("outputMint", USDC);
  quoteUrl.searchParams.set("amount", "1000000");
  const quoteResponse = await fetch(quoteUrl, { headers, signal: AbortSignal.timeout(5_000) });
  const quotePayload = quoteResponse.ok
    ? ((await quoteResponse.json()) as { outAmount?: string })
    : null;
  if (!quoteResponse.ok || !quotePayload?.outAmount) {
    fail("Jupiter Swap V2 quote", { httpStatus: quoteResponse.status, hasQuote: false });
  } else {
    pass("Jupiter Swap V2 quote", { httpStatus: quoteResponse.status, hasQuote: true });
  }
}

function checkJitoTipAccounts() {
  const configured = (env.JITO_TIP_ACCOUNTS ?? "")
    .split(",")
    .map((row) => row.trim())
    .filter(Boolean);
  const invalid = configured.filter((wallet) => !OFFICIAL_JITO_TIP_ACCOUNTS.has(wallet));
  if (configured.length !== 8 || invalid.length > 0) {
    fail("Jito tip accounts", { configured: configured.length, invalid });
  } else {
    pass("Jito tip accounts", "all 8 configured accounts match Jito's official list");
  }
}

async function loadConfig(): Promise<BotConfigRow | null> {
  let lastError = "unknown database error";
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const byUser = await db
        .from("bot_config")
        .select("*")
        .eq("user_id", env.HELIX_USER_ID)
        .maybeSingle();
      if (!byUser.error) {
        if (byUser.data) return byUser.data as BotConfigRow;
        const any = await db
          .from("bot_config")
          .select("*")
          .not("target_wallet", "is", null)
          .neq("target_wallet", "")
          .order("updated_at", { ascending: false })
          .limit(1);
        if (!any.error) {
          const row = any.data?.[0] as BotConfigRow | undefined;
          if (row) {
            throw new Error(
              "HELIX_USER_ID mismatch: worker identity does not match the configured dashboard row",
            );
          }
          return null;
        }
        lastError = safeDiagnostic(any.error.message);
      } else {
        lastError = safeDiagnostic(byUser.error.message);
      }
    } catch (err) {
      const message = safeDiagnostic(err);
      if (message.startsWith("HELIX_USER_ID mismatch")) throw err;
      lastError = message;
    }
    if (attempt < attempts) {
      line("Database retry", `attempt ${attempt}/${attempts} failed; retrying in ${attempt}s`);
      await delay(attempt * 1000);
    }
  }
  throw new Error(`bot_config query failed after ${attempts} attempts: ${lastError}`);
}

async function loadFundingKey(userId: string) {
  const { data, error } = await db
    .from("funding_keys")
    .select("ciphertext")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`funding_keys query failed: ${error.message}`);
  if (!data) return null;
  return decryptPrivateKey(data.ciphertext);
}

function validatePubkey(label: string, value: string | null | undefined): PublicKey | null {
  if (!value) {
    fail(label, "missing");
    return null;
  }
  try {
    const key = new PublicKey(value);
    pass(label, key.toBase58());
    return key;
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function amountFromTokenBalance(balance: TokenBalance) {
  return Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0);
}

function analyzeTargetTx(tx: ParsedTransactionWithMeta, target: string) {
  const meta = tx?.meta;
  const accountKeys = (tx?.transaction?.message?.accountKeys ?? []).map(
    (key) => key?.pubkey?.toBase58?.() ?? String(key?.pubkey ?? key),
  );
  const targetIndex = accountKeys.indexOf(target);
  const preLamports = targetIndex >= 0 ? Number(meta?.preBalances?.[targetIndex] ?? 0) : 0;
  const postLamports = targetIndex >= 0 ? Number(meta?.postBalances?.[targetIndex] ?? 0) : 0;
  const nativeSolDelta = (postLamports - preLamports) / 1e9;
  const logs = (meta?.logMessages ?? []).map((v: unknown) => String(v).toLowerCase());
  const swapSignal = logs.some(
    (v: string) =>
      v.includes("instruction: buy") ||
      v.includes("instruction: sell") ||
      v.includes("instruction: swap") ||
      v.includes("instruction: route") ||
      v.includes("sharedaccountsroute") ||
      v.includes("exactoutroute"),
  );

  const rows = new Map<string, { mint: string; pre: number; post: number; decimals: number }>();
  const ingest = (balances: readonly TokenBalance[], field: "pre" | "post") => {
    for (const b of balances ?? []) {
      if (b?.owner !== target || b?.mint === WSOL) continue;
      const row = rows.get(b.mint) ?? {
        mint: b.mint,
        pre: 0,
        post: 0,
        decimals: Number(b?.uiTokenAmount?.decimals ?? 0),
      };
      row[field] += amountFromTokenBalance(b);
      rows.set(b.mint, row);
    }
  };
  ingest(meta?.preTokenBalances ?? [], "pre");
  ingest(meta?.postTokenBalances ?? [], "post");

  const deltas = Array.from(rows.values())
    .map((row) => ({
      mint: row.mint,
      delta: Number((row.post - row.pre).toFixed(12)),
      decimals: row.decimals,
    }))
    .filter((row) => Math.abs(row.delta) > 1e-12);

  const decodedEvents = decodeParsedTransaction(target, tx);
  const decodedTargetBuys = decodedEvents.filter(
    (event) => event.kind === "swap" && event.wallet === target && event.side === "buy",
  );
  const decodedTargetTransfers = decodedEvents.filter(
    (event) => event.kind === "transfer" && event.from === target,
  );
  const wouldTriggerBuy =
    deltas.some((row) => row.delta > 0) && (nativeSolDelta < -0.0005 || swapSignal);
  const wouldTriggerFallbackTransfer =
    deltas.some((row) => row.delta < 0) && !(Math.abs(nativeSolDelta) > 0.0005 || swapSignal);
  const inferredBuy = inferBuyTransferredOut(meta, target, nativeSolDelta, swapSignal, deltas);

  return {
    signature: tx?.transaction?.signatures?.[0],
    nativeSolDelta,
    swapSignal,
    targetTokenDeltas: deltas,
    liveDecoderEvents: decodedEvents,
    inferredSameTxBuy: inferredBuy,
    wouldTriggerBuy,
    wouldTriggerInferredBuy: !!inferredBuy,
    wouldTriggerFallbackTransfer,
    liveWorkerWouldCopyBuy: decodedTargetBuys.length > 0 || decodedTargetTransfers.length > 0,
  };
}

function inferBuyTransferredOut(
  meta: TransactionMeta | null,
  target: string,
  solDelta: number,
  swapSignal: boolean,
  targetDeltas: Array<{ mint: string; delta: number; decimals: number }>,
) {
  const likelySpentValue = solDelta < -0.0005 || (Math.abs(solDelta) <= 0.0005 && swapSignal);
  if (!likelySpentValue) return null;

  const alreadyPositive = new Set(
    targetDeltas.filter((row) => row.delta > 0).map((row) => row.mint),
  );
  const targetNegative = new Set(
    targetDeltas.filter((row) => row.delta < 0).map((row) => row.mint),
  );
  const preByOwnerMint = new Map<string, number>();
  for (const balance of meta?.preTokenBalances ?? []) {
    if (!balance?.owner || !balance?.mint || balance.owner === target || balance.mint === WSOL)
      continue;
    preByOwnerMint.set(`${balance.owner}::${balance.mint}`, amountFromTokenBalance(balance));
  }

  const byMint = new Map<
    string,
    {
      mint: string;
      amountTokens: number;
      decimals: number;
      recipients: Array<{ wallet: string; amountTokens: number }>;
    }
  >();
  for (const balance of meta?.postTokenBalances ?? []) {
    if (!balance?.owner || !balance?.mint || balance.owner === target || balance.mint === WSOL)
      continue;
    if (alreadyPositive.has(balance.mint) || targetNegative.has(balance.mint)) continue;
    const pre = preByOwnerMint.get(`${balance.owner}::${balance.mint}`) ?? 0;
    const post = amountFromTokenBalance(balance);
    const delta = post - pre;
    if (delta <= 1e-12) continue;
    const cur: {
      mint: string;
      amountTokens: number;
      decimals: number;
      recipients: Array<{ wallet: string; amountTokens: number }>;
    } = byMint.get(balance.mint) ?? {
      mint: balance.mint,
      amountTokens: 0,
      decimals: Number(balance?.uiTokenAmount?.decimals ?? 0),
      recipients: [],
    };
    cur.amountTokens += delta;
    cur.decimals = Number(balance?.uiTokenAmount?.decimals ?? cur.decimals);
    cur.recipients.push({ wallet: balance.owner, amountTokens: delta });
    byMint.set(balance.mint, cur);
  }

  return Array.from(byMint.values()).sort((a, b) => b.amountTokens - a.amountTokens)[0] ?? null;
}

async function main() {
  console.log("\nHelix Doctor — copy-trading pipeline check\n");
  line("HELIX_USER_ID", redactedIdentifier(env.HELIX_USER_ID));
  line("RPC_URL host", new URL(env.RPC_URL).host);
  line("YELLOWSTONE_GRPC_URL host", new URL(env.YELLOWSTONE_GRPC_URL).host);
  line("YELLOWSTONE_TOKEN set", env.YELLOWSTONE_TOKEN ? "yes" : "no");
  line("JUPITER_API_KEY set", env.JUPITER_API_KEY ? "yes" : "no");
  await checkJupiterApi();

  const cfg = await loadConfig();
  if (!cfg) {
    fail("Config", "no bot_config row found in Supabase");
    return;
  }

  const targets = Array.from(
    new Set([cfg.target_wallet ?? "", ...(cfg.additional_target_wallets ?? [])].filter(Boolean)),
  );
  pass("Config row", {
    user_id: redactedIdentifier(cfg.user_id),
    target_wallet_count: targets.length,
    entries_enabled: cfg.enabled,
  });
  if (cfg.execution_route === "jito") checkJitoTipAccounts();
  else line("Jito tip accounts", "not required while execution route is RPC");
  if (!cfg.enabled)
    warn("Entries switch", "OFF — safe for diagnostics; exits remain active, but buys are paused");
  else pass("Entries switch", "ON");

  if (cfg.coordinated_mode_enabled === undefined) {
    fail(
      "Coordinated-mode migration",
      "missing — run supabase/coordinated-mode-migration.sql before deploying this worker",
    );
    return;
  }

  if (
    cfg.follower_seller_exit_enabled === undefined ||
    cfg.follower_seller_exit_count === undefined ||
    cfg.follower_seller_exit_pct === undefined ||
    cfg.target_inactivity_exit_enabled === undefined ||
    cfg.target_inactivity_hours === undefined
  ) {
    fail(
      "Main-mode exit migration",
      "missing — run supabase/main-mode-exits-migration.sql before deploying this worker",
    );
    return;
  }

  const schemaChecks = await Promise.all([
    db
      .from("positions")
      .select("entry_mode,coordinated_exit_triggered,follower_seller_exit_triggered")
      .limit(1),
    db.from("follower_wallets").select("first_sell_at,last_seen_signature,last_seen_slot").limit(1),
  ]);
  if (schemaChecks[0].error || schemaChecks[1].error) {
    fail(
      "Coordinated-mode schema",
      schemaChecks[0].error?.message ?? schemaChecks[1].error?.message,
    );
    return;
  }
  pass("Coordinated-mode schema", "required config, position, and follower columns are present");

  line("Buy/filter settings", {
    fixed_buy_usd: cfg.fixed_buy_usd,
    min_target_buy_usd: cfg.min_target_buy_usd,
    mc_min_usd: cfg.mc_min_usd,
    mc_max_usd: cfg.mc_max_usd,
    liq_min_usd: cfg.liq_min_usd,
    liq_max_usd: cfg.liq_max_usd,
    token_age_filter_enabled: cfg.token_age_filter_enabled,
    token_age_min_minutes: cfg.token_age_min_minutes,
    token_age_max_minutes: cfg.token_age_max_minutes,
    pump_fun_only: cfg.pump_fun_only,
    require_socials: cfg.require_socials,
    only_first_buy_ever: cfg.only_first_buy_ever,
    only_once_per_token: cfg.only_once_per_token,
    execution_route: cfg.execution_route,
    follower_seller_exit_enabled: cfg.follower_seller_exit_enabled,
    follower_seller_exit_count: cfg.follower_seller_exit_count,
    follower_seller_exit_pct: cfg.follower_seller_exit_pct,
    target_inactivity_exit_enabled: cfg.target_inactivity_exit_enabled,
    target_inactivity_hours: cfg.target_inactivity_hours,
  });

  line("Coordinated-wallet settings", {
    coordinated_mode_enabled: cfg.coordinated_mode_enabled,
    coordinated_fixed_buy_usd: cfg.coordinated_fixed_buy_usd,
    coordinated_target_wallet_count: cfg.coordinated_target_wallet_count,
    coordinated_window_seconds: cfg.coordinated_window_seconds,
    coordinated_mc_range_usd: [cfg.coordinated_mc_min_usd, cfg.coordinated_mc_max_usd],
    coordinated_coin_age_range_minutes: [
      cfg.coordinated_coin_age_min_minutes,
      cfg.coordinated_coin_age_max_minutes,
    ],
    coordinated_target_buy_range_usd: [
      cfg.coordinated_target_buy_min_usd,
      cfg.coordinated_target_buy_max_usd,
    ],
    coordinated_first_buy_only: cfg.coordinated_first_buy_only,
    coordinated_once_per_token: cfg.coordinated_once_per_token,
    coordinated_follower_sell_count: cfg.coordinated_follower_sell_count,
    coordinated_follower_sell_pct: cfg.coordinated_follower_sell_pct,
    coordinated_inactivity_hours: cfg.coordinated_inactivity_hours,
  });

  if (
    cfg.coordinated_mode_enabled &&
    targets.length < Number(cfg.coordinated_target_wallet_count)
  ) {
    fail(
      "Coordinated target count",
      `needs ${cfg.coordinated_target_wallet_count}; only ${targets.length} configured`,
    );
    return;
  }
  for (const [index, wallet] of targets.entries()) {
    if (!validatePubkey(`Target wallet ${index + 1}`, wallet)) return;
  }

  const target = validatePubkey("Target wallet", cfg.target_wallet);
  if (!target) return;

  let secret: string | null = null;
  let fundingKeyErrored = false;
  try {
    secret = await loadFundingKey(cfg.user_id);
  } catch (err) {
    fundingKeyErrored = true;
    fail("Funding key", err instanceof Error ? err.message : String(err));
    fail(
      "Next step",
      "On the VPS run: npm --prefix worker run save-key — paste the Phantom private key there, then rerun doctor",
    );
  }
  if (!secret) {
    if (!fundingKeyErrored) {
      fail("Funding key", `missing for config user_id ${cfg.user_id}`);
      fail(
        "Next step",
        "On the VPS run: npm --prefix worker run save-key — paste the Phantom private key there, then rerun doctor",
      );
    }
  } else {
    try {
      const decoded = bs58.decode(secret.trim());
      if (decoded.length !== 64)
        fail("Funding key", `decoded to ${decoded.length} bytes, expected 64`);
      else {
        const signer = Keypair.fromSecretKey(decoded);
        const sol = (await rpc.getBalance(signer.publicKey, "confirmed")) / 1e9;
        pass("Funding key", { wallet: signer.publicKey.toBase58(), solBalance: sol });
        if (sol < 0.02) fail("Funding wallet balance", "very low SOL balance; buys may fail");
      }
    } catch (err) {
      fail("Funding key decrypt/parse", err instanceof Error ? err.message : String(err));
    }
  }

  const { data: heartbeat, error: heartbeatError } = await db
    .from("worker_heartbeat")
    .select(
      "updated_at,geyser_connected,decoded_event_count,funding_key_ready,funding_key_checked_at,last_error,wallet_holdings,observed_follower_holdings",
    )
    .eq("user_id", cfg.user_id)
    .maybeSingle();
  if (heartbeatError) {
    fail("Worker heartbeat table", heartbeatError.message);
  } else if (!heartbeat) {
    fail("Worker heartbeat", `missing for config user_id ${cfg.user_id}`);
  } else {
    const ageSeconds = Math.max(
      0,
      Math.round((Date.now() - Date.parse(heartbeat.updated_at)) / 1000),
    );
    const heartbeatDetails = {
      ageSeconds,
      geyserConnected: heartbeat.geyser_connected,
      decodedEventCount: Number(heartbeat.decoded_event_count),
      fundingKeyReady: heartbeat.funding_key_ready,
      fundingKeyCheckedAt: heartbeat.funding_key_checked_at,
      lastError: heartbeat.last_error,
      walletHoldingCount: Array.isArray(heartbeat.wallet_holdings)
        ? heartbeat.wallet_holdings.length
        : 0,
      observedFollowerHoldingCount: Array.isArray(heartbeat.observed_follower_holdings)
        ? heartbeat.observed_follower_holdings.length
        : 0,
    };
    if (ageSeconds <= 45) pass("Worker heartbeat", heartbeatDetails);
    else fail("Worker heartbeat", heartbeatDetails);
  }

  try {
    const version = await rpc.getVersion();
    pass("RPC connection", version);
  } catch (err) {
    fail("RPC connection", err instanceof Error ? err.message : String(err));
    return;
  }

  const targetSol = (await rpc.getBalance(target, "confirmed")) / 1e9;
  pass("Target wallet RPC lookup", { solBalance: targetSol });

  const signatures = await rpc.getSignaturesForAddress(target, { limit: 10 }, "confirmed");
  if (signatures.length === 0) {
    warn("Recent target activity", "RPC sees no recent transactions for this target wallet");
    return;
  }

  pass(
    "Recent target activity",
    signatures.map((sig) => ({
      signature: sig.signature,
      time: sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : null,
      err: sig.err,
    })),
  );

  const txs = await rpc.getParsedTransactions(
    signatures.slice(0, 5).map((sig) => sig.signature),
    {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    },
  );
  const analyses = txs
    .filter((tx): tx is ParsedTransactionWithMeta => tx !== null)
    .map((tx) => analyzeTargetTx(tx, target.toBase58()));
  line("Last 5 tx decoder check", analyses);

  const trigger = analyses.find(
    (row) =>
      row.liveWorkerWouldCopyBuy ||
      row.wouldTriggerBuy ||
      row.wouldTriggerInferredBuy ||
      row.wouldTriggerFallbackTransfer,
  );
  if (trigger)
    pass(
      "Decoder verdict",
      "At least one recent tx should trigger the live worker path. If PM2 logs did not show feed event, Laserstream/RPC polling is the likely break.",
    );
  else
    warn(
      "Decoder verdict",
      "Recent target txs do not look like target buys/transfers to this decoder. The target may be buying from another wallet/signing account, or the tx format needs a new parser.",
    );

  console.log(
    '\nNext command if this passes but bot is silent:\npm2 logs helix-worker-v3 --lines 200 --nostream | grep -E "stream heartbeat|database heartbeat|feed event|target buy candidate|filtered|submitting copy buy|copy buy|Pump.fun|funding wallet"\n',
  );
}

main()
  .then(() => {
    if (failureCount > 0) {
      console.log(`\n❌ Doctor summary: ${failureCount} failure(s), ${warningCount} warning(s)\n`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ Doctor summary: PASS (${warningCount} warning(s))\n`);
    }
  })
  .catch((err) => {
    fail("Doctor crashed", err instanceof Error ? (err.stack ?? err.message) : String(err));
    console.log(`\n❌ Doctor summary: ${failureCount} failure(s), ${warningCount} warning(s)\n`);
    process.exit(1);
  });
