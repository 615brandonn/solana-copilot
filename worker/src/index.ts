// Helix worker entrypoint. Long-running Node process. Deploy on a
// low-latency VPS geographically close to Jito block engine + your RPC.

import pino from "pino";
import { randomUUID } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "./env.js";
import { db, type BotConfigRow } from "./db.js";
import { GeyserFeed, type FeedEvent, type SwapEvent, type TransferEvent } from "./geyser.js";
import { FollowerMonitor, type ChainedTransferBatchState } from "./monitor.js";
import { executeSwap, type ExecuteResult } from "./executor.js";
import { SubmissionUncertainError, isPostSubmissionError } from "./execution-safety.js";
import {
  canReclaimEntryClaim,
  entryClaimFailureDisposition,
  entryClaimMatchesPersistedPosition,
  isUnresolvedEntryClaim,
  type EntryClaimStatus,
} from "./entry-claim-policy.js";
import { decryptPrivateKey } from "./crypto.js";
import { checkEntry, loadTokenMeta } from "./filters.js";
import { RpcBackfillPoller } from "./poller.js";
import { createSupabaseRpcCursorStore } from "./rpc-cursor.js";
import { PendingTransferBuffer } from "./pending-transfer-buffer.js";
import { computeTargetSellAmount } from "./target-sell-policy.js";
import { isMissingReadinessColumnError, toIsoTimestamp } from "./health.js";
import {
  createRpcFollowerTokenBalanceReader,
  createSupabaseFollowerBalanceStore,
  FollowerBalanceReconciler,
} from "./follower-balance-reconciler.js";
import { evaluateEntryMonitoringGate } from "./entry-monitoring-gate.js";
import { priceUsd } from "./prices.js";
import {
  checkCoordinatedEntry,
  CoordinatedBuyTracker,
  inactivityDeadlineMs,
  shouldTriggerDistinctSellerExit,
  type TargetBuyObservation,
} from "./coordinated-mode.js";
import { isFlatPosition, proportionalMirrorSell } from "./follower-math.js";
import { safeDiagnostic } from "./diagnostics.js";
import {
  KeyedExecutionQueue,
  RecentAsyncResultCache,
  RecentEventDeduper,
} from "./event-deduper.js";
import { resolveTargetBuyValue } from "./target-buy-valuation.js";
import { automaticEntryStrategy } from "./entry-strategy-router.js";
import { evaluateConvictionLiveExecutionGate } from "./conviction-execution-policy.js";
import {
  ConvictionRuntime,
  type ConvictionRuntimeAction,
  type ConvictionTierLifecycleUpdate,
  type StoredConvictionTier,
} from "./conviction-runtime.js";
import { createSupabaseConvictionStore } from "./conviction-supabase-store.js";
import { convictionConfigFromBotConfig } from "./conviction-config.js";
import { effectiveConvictionExposureUsd } from "./conviction-exposure.js";
import { classifyConvictionSwap, classifyConvictionTransfers } from "./conviction-classifier.js";
import type { ConvictionEvent } from "./conviction-engine.js";
import {
  transferEventForRecipient,
  transferRecipients,
  type ClassifiedTransferRecipient,
} from "./transfer-batch.js";
import {
  canReclaimSellClaim,
  periodicSellIdentity,
  sellClaimFailureDisposition,
  type SellTriggerKind,
} from "./sell-claim-policy.js";
import { authoritativeCoordinatedTargetLinks } from "./target-link-backfill.js";
import { targetTerminalOutflowExitPct } from "./target-outflow-policy.js";
import { quoteTokenSpendUsd } from "./token-spend-quote.js";
import {
  groupObservedFollowerTransfers,
  isEligibleFollowerWallet,
  ReducedBalanceConfirmationTracker,
  walletTokenHoldings,
  type WalletTokenHolding,
  ZeroBalanceConfirmationTracker,
} from "./position-reconciliation.js";
import {
  observationFromEvent,
  StrategyRecorder,
  strategyEventsFromFeedEvent,
  strategyReactionMs,
  type StrategyDecision,
  type StrategyObservationPatch,
} from "./strategy-recorder.js";

const log = pino({ level: env.LOG_LEVEL });
const WSOL = "So11111111111111111111111111111111111111112";
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCo24RDUuUuJZq8bn6T", // USDT
]);
const rpc = new Connection(env.RPC_URL, { commitment: "processed" });
type RecipientClassification = "eligible" | "program_or_off_curve" | "unknown";
const followerRecipientEligibility = new Map<string, RecipientClassification>();

type CopyBuyOptions = {
  entryMode: "regular" | "coordinated";
  firstBuy: boolean;
  targetBuyUsd: number | undefined;
  coordinatedWallets?: string[];
};

type EntryClaimRow = {
  id: string;
  user_id: string;
  source_tx_sig: string;
  source_wallet: string;
  token_mint: string;
  planned_position_id: string;
  entry_mode: "regular" | "coordinated";
  amount_lamports: number | string;
  status: EntryClaimStatus;
  bot_tx_sig: string | null;
};

async function classifyFollowerRecipient(address: string): Promise<RecipientClassification> {
  const cached = followerRecipientEligibility.get(address);
  if (cached !== undefined) return cached;
  try {
    const publicKey = new PublicKey(address);
    const account = await rpc.getAccountInfo(publicKey, "confirmed");
    const eligible = isEligibleFollowerWallet(address, account?.owner.toBase58() ?? null);
    const classification: RecipientClassification = eligible ? "eligible" : "program_or_off_curve";
    if (followerRecipientEligibility.size >= 10_000) {
      followerRecipientEligibility.delete(followerRecipientEligibility.keys().next().value ?? "");
    }
    followerRecipientEligibility.set(address, classification);
    return classification;
  } catch (err) {
    log.warn(
      { address, err: safeDiagnostic(err) },
      "follower recipient classification failed — excluding unknown recipient",
    );
    return "unknown";
  }
}

async function isEligibleFollowerRecipient(address: string): Promise<boolean> {
  return (await classifyFollowerRecipient(address)) === "eligible";
}

function configuredTargetWallets(config: BotConfigRow): string[] {
  return Array.from(
    new Set(
      [config.target_wallet ?? "", ...(config.additional_target_wallets ?? [])]
        .map((wallet) => wallet.trim())
        .filter(Boolean),
    ),
  );
}

async function loadConfig(userId: string): Promise<BotConfigRow | null> {
  const byUser = await db.from("bot_config").select("*").eq("user_id", userId).maybeSingle();
  if (byUser.error)
    throw new Error(`bot_config query failed: ${safeDiagnostic(byUser.error.message)}`);
  if (byUser.data) return byUser.data as BotConfigRow;
  const any = await db
    .from("bot_config")
    .select("*")
    .not("target_wallet", "is", null)
    .neq("target_wallet", "")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (any.error)
    throw new Error(`bot_config identity check failed: ${safeDiagnostic(any.error.message)}`);
  const row = any.data?.[0];
  if (row) {
    throw new Error(
      "HELIX_USER_ID mismatch: worker identity does not match the configured dashboard row",
    );
  }
  return null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadSigner(userId: string): Promise<string | null> {
  const { data, error } = await db
    .from("funding_keys")
    .select("ciphertext")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`funding_keys query failed: ${safeDiagnostic(error.message)}`);
  if (!data) return null;
  return decryptPrivateKey(data.ciphertext);
}

type FundingWalletReadiness = {
  ready: boolean;
  walletPubkey: string | null;
  error: string | null;
  checkedAt: string;
};

async function checkFundingWalletReadiness(
  userId: string,
  fixedBuyUsd: number,
): Promise<FundingWalletReadiness> {
  const checkedAt = new Date().toISOString();
  try {
    const secret = await loadSigner(userId);
    if (!secret) {
      log.error({}, "readiness failed — no funding private key saved for this config user");
      return {
        ready: false,
        walletPubkey: null,
        error: "Funding key missing for worker user",
        checkedAt,
      };
    }

    const decoded = bs58.decode(secret.trim());
    if (decoded.length !== 64) {
      log.error(
        { decodedBytes: decoded.length },
        "readiness failed — funding private key is not a 64-byte Phantom/Solana secret key",
      );
      return {
        ready: false,
        walletPubkey: null,
        error: `Funding key decoded to ${decoded.length} bytes instead of 64`,
        checkedAt,
      };
    }

    const signer = Keypair.fromSecretKey(decoded);
    const walletPubkey = signer.publicKey.toBase58();
    try {
      const balanceLamports = await rpc.getBalance(signer.publicKey, "processed");
      const solBalance = balanceLamports / 1e9;
      log.info(
        {
          fundingWallet: walletPubkey,
          solBalance,
          fixedBuyUsd,
        },
        "funding wallet ready",
      );

      if (solBalance < 0.02) {
        log.warn(
          { fundingWallet: walletPubkey, solBalance },
          "funding wallet SOL balance is very low",
        );
      }
    } catch (err) {
      log.warn(
        { err: safeDiagnostic(err), fundingWallet: walletPubkey },
        "funding key is valid but wallet balance check failed",
      );
    }
    return { ready: true, walletPubkey, error: null, checkedAt };
  } catch (err) {
    log.error(
      { err: safeDiagnostic(err) },
      "readiness failed — could not decrypt/check funding wallet",
    );
    return {
      ready: false,
      walletPubkey: null,
      error: safeDiagnostic(err),
      checkedAt,
    };
  }
}

async function waitForConfig(userId: string): Promise<BotConfigRow> {
  let logged = false;
  while (true) {
    try {
      const cfg = await loadConfig(userId);
      if (cfg?.target_wallet) {
        log.info({ targetCount: configuredTargetWallets(cfg).length }, "config loaded");
        return cfg;
      }
      if (!logged) {
        log.warn("no target wallet configured yet — polling every 5s");
        logged = true;
      }
    } catch (err) {
      log.error(
        { err: safeDiagnostic(err) },
        "config unavailable — preserving worker and retrying in 5s",
      );
    }
    await delay(5000);
  }
}

async function main() {
  const USER_ID = env.HELIX_USER_ID;
  let cfg = await waitForConfig(USER_ID);
  let entryConfigTransitioning = false;
  let configRefreshRunning = false;
  let fundingReadiness = await checkFundingWalletReadiness(cfg.user_id, cfg.fixed_buy_usd);

  const feed: GeyserFeed = new GeyserFeed(async (event): Promise<void> => {
    await handle(event);
  });
  const rpcCursorStore = createSupabaseRpcCursorStore(db, cfg.user_id);
  const poller: RpcBackfillPoller = new RpcBackfillPoller(
    rpc,
    async (event): Promise<void> => {
      await handle(event);
    },
    rpcCursorStore,
  );
  // Crew-wallet registry: reused downstream wallets identified by the custody
  // observer (view public.crew_wallets). Refreshed on a timer; read-only.
  let crewWallets = new Set<string>();
  async function refreshCrewWallets(minMints: number) {
    const { data, error } = await (db as any)
      .from("crew_wallets")
      .select("wallet,mint_count")
      .gte("mint_count", minMints);
    if (error) {
      log.warn({ err: safeDiagnostic(error.message) }, "crew wallet refresh failed; keeping prior set");
      return;
    }
    crewWallets = new Set(
      (Array.isArray(data) ? data : [])
        .map((row: { wallet?: string }) => String(row.wallet ?? "").trim())
        .filter(Boolean),
    );
    log.info({ count: crewWallets.size, minMints }, "crew wallet registry refreshed");
  }
  const monitor: FollowerMonitor = new FollowerMonitor(feed, poller);
  const followerBalanceReconciler = new FollowerBalanceReconciler(
    cfg.user_id,
    createSupabaseFollowerBalanceStore(db),
    createRpcFollowerTokenBalanceReader(rpc),
    6,
  );
  const currentEntryMonitoringGate = () => {
    const geyser = feed.health();
    const rpcFallback = poller.health();
    return evaluateEntryMonitoringGate({
      geyserConnected: Boolean(geyser.connected),
      rpcLastSuccessAt: rpcFallback.lastSuccessAt ?? null,
      rpcBacklogWalletCount: Number(rpcFallback.backlogWalletCount ?? 0),
      followerBalances: followerBalanceReconciler.health(),
    });
  };
  const coordinatedBuys = new CoordinatedBuyTracker();

  // Cumulative USDC the target has committed to each mint over a rolling window
  // (his real conviction). Used by the USDC-conviction gate/sizing when enabled.
  const CONVICTION_WINDOW_MS = 2 * 60 * 60_000;
  const targetConvictionUsd = new Map<string, Array<{ usd: number; at: number }>>();
  function addTargetConvictionUsd(mint: string, usd: number, atMs: number) {
    if (!(usd > 0)) return;
    const arr = targetConvictionUsd.get(mint) ?? [];
    arr.push({ usd, at: atMs });
    const cutoff = atMs - CONVICTION_WINDOW_MS;
    targetConvictionUsd.set(
      mint,
      arr.filter((e) => e.at >= cutoff),
    );
  }
  function targetConvictionUsdFor(mint: string, nowMs: number): number {
    const arr = targetConvictionUsd.get(mint);
    if (!arr) return 0;
    const cutoff = nowMs - CONVICTION_WINDOW_MS;
    return arr.reduce((s, e) => (e.at >= cutoff ? s + e.usd : s), 0);
  }
  // Every buy and sell for the same mint shares this queue. This prevents a
  // scale-in from racing an exit and attaching newly bought tokens to a
  // position that was closed while the buy was being built.
  const tradeExecutionQueue = new KeyedExecutionQueue();
  const exitExecutionQueue = new KeyedExecutionQueue();
  const exitsInFlight = new Set<string>();
  const pendingTransfers = new PendingTransferBuffer({
    ttlMs: 5 * 60_000,
    maxEntries: 5_000,
    maxEntriesPerMint: 250,
  });
  const targetBuyDeduper = new RecentEventDeduper();
  const targetBuyActivityAccounting = new RecentAsyncResultCache<void>();
  const targetFirstBuyAccounting = new RecentAsyncResultCache<boolean>();
  const uncertainEntryMints = new Set<string>();

  async function retryDb<T>(
    label: string,
    operation: () => PromiseLike<{ data: T; error: { message: string } | null }>,
    attempts = 4,
  ): Promise<T> {
    let lastError = "unknown database error";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await operation();
        if (!result.error) return result.data;
        lastError = safeDiagnostic(result.error.message);
      } catch (err) {
        lastError = safeDiagnostic(err);
      }
      if (attempt < attempts) {
        log.warn({ label, attempt, error: lastError }, "database operation failed — retrying");
        await delay(attempt * 500);
      }
    }
    throw new Error(`${label} failed after ${attempts} attempts: ${lastError}`);
  }

  async function updateEntryClaim(
    claimId: string,
    values: Record<string, unknown>,
    required = true,
  ): Promise<boolean> {
    const { error } = await db
      .from("entry_signal_claims")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("id", claimId)
      .eq("user_id", cfg.user_id);
    if (!error) return true;
    log.error({ err: safeDiagnostic(error), claimId }, "entry claim status update failed");
    if (required) {
      throw new Error(`entry claim status update failed: ${safeDiagnostic(error)}`);
    }
    return false;
  }

  async function claimEntrySubmission(
    event: SwapEvent,
    entryMode: "regular" | "coordinated",
    amountLamports: number,
  ): Promise<EntryClaimRow | null> {
    const sourceTxSig = event.txSig || `slot-${event.slot}`;
    const plannedPositionId = randomUUID();
    const fields =
      "id,user_id,source_tx_sig,source_wallet,token_mint,planned_position_id,entry_mode,amount_lamports,status,bot_tx_sig";
    const { data: inserted, error: insertError } = await db
      .from("entry_signal_claims")
      .insert({
        user_id: cfg.user_id,
        source_tx_sig: sourceTxSig,
        source_wallet: event.wallet,
        token_mint: event.tokenMint,
        planned_position_id: plannedPositionId,
        entry_mode: entryMode,
        amount_lamports: amountLamports,
        status: "claimed",
      })
      .select(fields)
      .maybeSingle();
    if (!insertError && inserted) return inserted as EntryClaimRow;

    if (insertError?.code !== "23505") {
      throw new Error(
        `entry signal claim failed: ${safeDiagnostic(insertError ?? "missing claim")}`,
      );
    }

    // A uniqueness conflict can be either the same durable event or a different
    // unresolved entry for this mint. Only the exact event in an explicit
    // failed_pre_submit state is reclaimable.
    const { data: existing, error: existingError } = await db
      .from("entry_signal_claims")
      .select(fields)
      .eq("user_id", cfg.user_id)
      .eq("source_tx_sig", sourceTxSig)
      .eq("source_wallet", event.wallet)
      .eq("token_mint", event.tokenMint)
      .maybeSingle();
    if (existingError) {
      throw new Error(`entry signal claim recovery failed: ${safeDiagnostic(existingError)}`);
    }
    const existingClaim = existing as EntryClaimRow | null;
    if (!existingClaim || !canReclaimEntryClaim(existingClaim.status)) {
      log.warn(
        { mint: event.tokenMint, hasMatchingEventClaim: Boolean(existingClaim) },
        "entry blocked by an existing durable claim",
      );
      return null;
    }

    const { data: reclaimed, error: reclaimError } = await db
      .from("entry_signal_claims")
      .update({
        status: "claimed",
        amount_lamports: amountLamports,
        error_code: null,
        bot_tx_sig: null,
        submission_started_at: null,
        landed_at: null,
        persisted_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingClaim.id)
      .eq("user_id", cfg.user_id)
      .eq("status", "failed_pre_submit")
      .select(fields)
      .maybeSingle();
    if (reclaimError || !reclaimed) {
      throw new Error(
        `entry signal reclaim failed: ${safeDiagnostic(reclaimError ?? "claim changed")}`,
      );
    }
    return reclaimed as EntryClaimRow;
  }

  let reconcilingEntryClaims = false;
  async function reconcileUnresolvedEntryClaims(): Promise<number> {
    if (reconcilingEntryClaims) return 0;
    reconcilingEntryClaims = true;
    try {
      const claims = await retryDb<EntryClaimRow[] | null>("load unresolved entry claims", () =>
        db
          .from("entry_signal_claims")
          .select(
            "id,user_id,source_tx_sig,source_wallet,token_mint,planned_position_id,entry_mode,amount_lamports,status,bot_tx_sig",
          )
          .eq("user_id", cfg.user_id)
          .in("status", ["claimed", "submitted", "landed", "uncertain"])
          .order("created_at", { ascending: true }),
      );
      let resolved = 0;
      for (const claim of claims ?? []) {
        if (!isUnresolvedEntryClaim(claim.status)) continue;
        uncertainEntryMints.add(claim.token_mint);
        const { data: position, error: positionError } = await db
          .from("positions")
          .select("id,token_mint,entry_tx_sig")
          .eq("user_id", cfg.user_id)
          .eq("id", claim.planned_position_id)
          .maybeSingle();
        if (positionError) {
          throw new Error(
            `entry claim position reconciliation failed: ${safeDiagnostic(positionError)}`,
          );
        }
        if (entryClaimMatchesPersistedPosition(claim, position)) {
          await updateEntryClaim(claim.id, {
            status: "persisted",
            error_code: null,
            persisted_at: new Date().toISOString(),
          });
          uncertainEntryMints.delete(claim.token_mint);
          resolved += 1;
          continue;
        }

        // A confirmed signature without the exact planned position proves only
        // that Helix may hold tokens. It does not authorize adopting that balance
        // or buying again; keep the mint quarantined for manual reconciliation.
        if (claim.bot_tx_sig) {
          try {
            const statuses = await rpc.getSignatureStatuses([claim.bot_tx_sig], {
              searchTransactionHistory: true,
            });
            const status = statuses.value[0];
            if (status && !status.err && claim.status !== "landed") {
              await updateEntryClaim(claim.id, {
                status: "landed",
                landed_at: new Date().toISOString(),
                error_code: "landed-position-not-persisted",
              });
            }
          } catch (err) {
            log.warn(
              { err: safeDiagnostic(err), mint: claim.token_mint },
              "entry signature reconciliation unavailable — quarantine retained",
            );
          }
        }
      }
      if ((claims?.length ?? 0) > 0) {
        log.warn(
          {
            unresolvedEntryClaimCount: (claims?.length ?? 0) - resolved,
            resolvedEntryClaimCount: resolved,
          },
          "durable entry claims reconciled — unresolved mints remain quarantined",
        );
      }
      return resolved;
    } finally {
      reconcilingEntryClaims = false;
    }
  }

  let targetWallets = new Set(configuredTargetWallets(cfg));
  if (targetWallets.size === 0) throw new Error("config loaded without a target wallet");
  monitor.setBaseWatchedWallets(targetWallets);

  const convictionStore = createSupabaseConvictionStore(db, cfg.user_id);
  const convictionRuntime = new ConvictionRuntime(
    convictionConfigFromBotConfig(cfg),
    convictionStore,
  );
  let convictionConfigFingerprint = JSON.stringify(convictionConfigFromBotConfig(cfg));
  if (automaticEntryStrategy(cfg) === "conviction") {
    await convictionRuntime.initialize();
  }

  function convictionExposureIncludingShadow(mint: string, actualPositionUsd: number): number {
    return effectiveConvictionExposureUsd({
      tradingMode: cfg.conviction_trading_mode === "live" ? "live" : "shadow",
      actualPositionUsd,
      executedTiers: convictionRuntime.snapshot(mint)?.executedTiers ?? [],
    });
  }

  async function syncConvictionPositionExposure(): Promise<void> {
    const { data, error } = await db
      .from("positions")
      .select("token_mint,amount_remaining,entry_price_usd")
      .eq("user_id", cfg.user_id)
      .is("closed_at", null);
    if (error) {
      throw new Error(`Conviction position exposure sync failed: ${safeDiagnostic(error)}`);
    }
    for (const position of data ?? []) {
      if (!convictionRuntime.snapshot(position.token_mint)) continue;
      await convictionRuntime.setPositionUsd(
        position.token_mint,
        convictionExposureIncludingShadow(
          position.token_mint,
          Math.max(0, Number(position.amount_remaining)) *
            Math.max(0, Number(position.entry_price_usd ?? 0)),
        ),
      );
    }
  }

  async function reconcileConvictionTierClaims(): Promise<void> {
    // Reconcile unfinished LIVE claims even when Conviction Mode was switched
    // off before this restart. Otherwise the legacy strategy could resume on
    // a mint whose Conviction submission is still unresolved.
    const tiers = await convictionStore.loadTiers();
    const transitionRecoveredTier = (
      tier: StoredConvictionTier,
      update: ConvictionTierLifecycleUpdate,
    ) =>
      automaticEntryStrategy(cfg) === "conviction"
        ? convictionRuntime.transitionAction(tier, update)
        : convictionStore.updateTier(tier.id, update);
    for (const tier of tiers) {
      if (tier.status === "claimed") {
        await transitionRecoveredTier(tier, {
          status: "failed_pre_submit",
          errorCode: "recovered-pre-submit-claim",
        });
        continue;
      }
      if (tier.status === "submitted") {
        await transitionRecoveredTier(tier, {
          status: "uncertain",
          errorCode: "worker-restarted-during-submission",
        });
        uncertainEntryMints.add(tier.tokenMint);
        continue;
      }
      if (tier.status === "uncertain") {
        uncertainEntryMints.add(tier.tokenMint);
        continue;
      }
      if (tier.status !== "landed") continue;
      if (!tier.botTxSig) {
        uncertainEntryMints.add(tier.tokenMint);
        log.error(
          { mint: tier.tokenMint, tier: tier.tierNumber },
          "landed Conviction tier has no transaction signature — coin quarantined",
        );
        continue;
      }

      const [{ data: trade, error: tradeError }, { data: position, error: positionError }] =
        await Promise.all([
          db
            .from("trades")
            .select("position_id")
            .eq("user_id", cfg.user_id)
            .eq("tx_sig", tier.botTxSig)
            .maybeSingle(),
          tier.plannedPositionId
            ? db
                .from("positions")
                .select("id,entry_tx_sig")
                .eq("user_id", cfg.user_id)
                .eq("id", tier.plannedPositionId)
                .maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
      if (tradeError || positionError) {
        throw new Error(
          `Conviction tier reconciliation failed: ${safeDiagnostic(tradeError ?? positionError)}`,
        );
      }
      const recoveredPositionId =
        trade?.position_id ?? (position?.entry_tx_sig === tier.botTxSig ? position.id : null);
      if (recoveredPositionId) {
        await transitionRecoveredTier(tier, {
          status: "persisted",
          botTxSig: tier.botTxSig,
          positionId: recoveredPositionId,
          errorCode: null,
        });
      } else {
        uncertainEntryMints.add(tier.tokenMint);
        log.error(
          { mint: tier.tokenMint, tier: tier.tierNumber },
          "landed Conviction tier lacks exact persistence evidence — coin quarantined",
        );
      }
    }
  }

  let lastStrategyRecorderErrorAt = 0;
  const strategyRecorder = new StrategyRecorder(
    async (rows) => {
      const { error } = await db.rpc("record_strategy_observations", { p_rows: rows });
      if (error)
        throw new Error(`strategy recorder batch failed: ${safeDiagnostic(error.message)}`);
    },
    {
      onError: (err) => {
        const now = Date.now();
        if (now - lastStrategyRecorderErrorAt < 30_000) return;
        lastStrategyRecorderErrorAt = now;
        log.warn(
          { err: safeDiagnostic(err) },
          "strategy recorder unavailable — trading continues and observations remain buffered",
        );
      },
      onDrop: (dropped) => {
        if (dropped === 1 || dropped % 100 === 0) {
          log.warn({ dropped }, "strategy recorder queue full — oldest observation dropped");
        }
      },
    },
  );
  strategyRecorder.start();

  function recordStrategyEvent(event: FeedEvent, patch: StrategyObservationPatch = {}) {
    for (const strategyEvent of strategyEventsFromFeedEvent(event)) {
      const actor = strategyEvent.kind === "swap" ? strategyEvent.wallet : strategyEvent.from;
      const position = monitor.activeForMint(strategyEvent.tokenMint);
      const relationship = targetWallets.has(actor) ? "target" : position ? "follower" : "observed";
      const primaryTarget =
        cfg.target_wallet ?? position?.targetWallet ?? Array.from(targetWallets)[0];
      if (!primaryTarget) continue;
      const additionalTarget = targetWallets.has(actor) && actor !== primaryTarget;
      strategyRecorder.record(
        observationFromEvent(
          strategyEvent,
          {
            userId: cfg.user_id,
            targetWallet: primaryTarget,
            relationship,
            positionId: position?.positionId,
          },
          {
            ...patch,
            metadata: {
              ...(patch.metadata ?? {}),
              ...(additionalTarget ? { additionalTargetWallet: true } : {}),
            },
          },
        ),
      );
    }
  }

  function recordStrategyDecision(
    event: FeedEvent,
    decision: StrategyDecision,
    reason: string,
    patch: StrategyObservationPatch = {},
  ) {
    recordStrategyEvent(event, {
      ...patch,
      bot_decision: decision,
      bot_reason: reason,
    });
  }

  async function releaseMonitoredPosition(positionId: string) {
    await monitor.releasePosition(positionId);
    // A target wallet can also appear in a transfer chain. Reassert target
    // subscriptions after releasing follower-only watches.
    for (const wallet of targetWallets) {
      await feed.watch(wallet);
      poller.watch(wallet);
    }
  }

  const zeroBalanceTracker = new ZeroBalanceConfirmationTracker();
  const reducedBalanceTracker = new ReducedBalanceConfirmationTracker();
  let latestWalletHoldings: WalletTokenHolding[] = [];
  type ObservedFollowerHolding = {
    token_mint: string;
    wallet: string;
    amount: number;
    decimals: number;
    source_target_count: number;
    last_updated: string;
  };
  let latestObservedFollowerHoldings: ObservedFollowerHolding[] = [];

  async function reconcileFlatWalletPositions() {
    if (!fundingReadiness.ready || !fundingReadiness.walletPubkey) return;
    const { data: positions, error } = await db
      .from("positions")
      .select("id,token_mint,amount_remaining,decimals")
      .eq("user_id", cfg.user_id)
      .is("closed_at", null);
    if (error) throw new Error(`position reconciliation query failed: ${safeDiagnostic(error)}`);

    // Only a successful RPC snapshot advances the two-observation guard.
    latestWalletHoldings = await walletTokenHoldings(rpc, fundingReadiness.walletPubkey);
    const positiveMints = new Set(latestWalletHoldings.map((row) => row.token_mint));
    const holdingAmounts = new Map(
      latestWalletHoldings.map((row) => [row.token_mint, Number(row.amount)]),
    );
    const confirmedReductions = reducedBalanceTracker.observe(positions ?? [], holdingAmounts);
    const confirmedFlat = zeroBalanceTracker.observe(positions ?? [], positiveMints);
    if (confirmedFlat.length === 0 && confirmedReductions.length === 0) return;

    const closedAt = new Date().toISOString();
    const flatIds = new Set(confirmedFlat);
    const positionsById = new Map((positions ?? []).map((position) => [position.id, position]));
    for (const reduction of confirmedReductions) {
      const observedPosition = positionsById.get(reduction.id);
      if (!observedPosition) continue;
      const isFlat = flatIds.has(reduction.id) || reduction.amountRemaining <= 1e-9;
      await tradeExecutionQueue.run(observedPosition.token_mint, async () => {
        const { data: updated, error: updateError } = await db
          .from("positions")
          .update({
            amount_remaining: isFlat ? 0 : reduction.amountRemaining,
            closed_at: isFlat ? closedAt : null,
          })
          .eq("id", reduction.id)
          .eq("user_id", cfg.user_id)
          .eq("amount_remaining", Number(observedPosition.amount_remaining))
          .is("closed_at", null)
          .select("id")
          .maybeSingle();
        if (updateError) {
          throw new Error(`position reconciliation update failed: ${safeDiagnostic(updateError)}`);
        }
        // A live buy/exit changed the row after the wallet snapshot. Its newer
        // accounting wins; the next two confirmed snapshots can reconcile it.
        if (!updated) return;
        if (isFlat) await releaseMonitoredPosition(reduction.id);
      });
    }
    for (const positionId of confirmedFlat) {
      if (confirmedReductions.some((row) => row.id === positionId)) continue;
      const observedPosition = positionsById.get(positionId);
      if (!observedPosition) continue;
      await tradeExecutionQueue.run(observedPosition.token_mint, async () => {
        const { data: updated, error: updateError } = await db
          .from("positions")
          .update({ amount_remaining: 0, closed_at: closedAt })
          .eq("id", positionId)
          .eq("user_id", cfg.user_id)
          .eq("amount_remaining", Number(observedPosition.amount_remaining))
          .is("closed_at", null)
          .select("id")
          .maybeSingle();
        if (updateError) {
          throw new Error(`position reconciliation update failed: ${safeDiagnostic(updateError)}`);
        }
        if (updated) await releaseMonitoredPosition(positionId);
      });
    }
    log.info(
      {
        reducedPositionCount: confirmedReductions.length,
        closedPositionCount: confirmedFlat.length,
      },
      "position balances reconciled from consecutive wallet snapshots",
    );
  }

  async function refreshObservedFollowerHoldings() {
    if (latestWalletHoldings.length === 0) {
      latestObservedFollowerHoldings = [];
      return;
    }
    const heldMints = latestWalletHoldings.map((row) => row.token_mint);
    const targets = Array.from(targetWallets);
    const transfers: Array<{
      token_mint: string;
      to_wallet: string | null;
      from_wallet: string | null;
      event_at: string;
    }> = [];
    for (const tokenMint of heldMints) {
      for (const targetWallet of targets) {
        const rows = await retryDb<typeof transfers>(
          "load observed follower transfers",
          async () => {
            const result = await db
              .from("strategy_observations")
              .select("token_mint,to_wallet,from_wallet,event_at")
              .eq("user_id", cfg.user_id)
              .eq("token_mint", tokenMint)
              .eq("from_wallet", targetWallet)
              .eq("relationship", "target")
              .eq("event_kind", "transfer")
              .not("to_wallet", "is", null)
              .order("event_at", { ascending: false })
              .limit(500);
            return {
              data: (result.data ?? []) as typeof transfers,
              error: result.error,
            };
          },
        );
        transfers.push(...rows);
      }
    }

    const grouped = groupObservedFollowerTransfers(transfers, new Set(targets));
    const pending: typeof grouped = [];
    for (let offset = 0; offset < grouped.length; offset += 8) {
      const batch = grouped.slice(offset, offset + 8);
      const eligibility = await Promise.all(
        batch.map((row) => isEligibleFollowerRecipient(row.wallet)),
      );
      for (const [index, row] of batch.entries()) {
        if (eligibility[index]) pending.push(row);
      }
    }
    const refreshed: ObservedFollowerHolding[] = [];
    for (let offset = 0; offset < pending.length; offset += 8) {
      const batch = pending.slice(offset, offset + 8);
      const results = await Promise.allSettled(
        batch.map(async (row) => {
          const accounts = await rpc.getParsedTokenAccountsByOwner(
            new PublicKey(row.wallet),
            { mint: new PublicKey(row.tokenMint) },
            "confirmed",
          );
          let amount = 0;
          let decimals = 0;
          for (const account of accounts.value) {
            const info = account.account.data.parsed.info as {
              tokenAmount: { decimals?: number; uiAmountString?: string };
            };
            amount += Number(info.tokenAmount.uiAmountString ?? 0);
            decimals = Number(info.tokenAmount.decimals ?? decimals);
          }
          return {
            token_mint: row.tokenMint,
            wallet: row.wallet,
            amount: Math.max(0, amount),
            decimals,
            source_target_count: row.sourceTargets.length,
            last_updated: new Date().toISOString(),
          } satisfies ObservedFollowerHolding;
        }),
      );
      for (const result of results) {
        if (result.status === "fulfilled") refreshed.push(result.value);
      }
    }
    latestObservedFollowerHoldings = refreshed;
  }

  // Reconcile durable buy claims before accepting any feed work. Only an exact
  // planned-position/signature match is released; wallet holdings are never
  // auto-adopted as Helix positions.
  await reconcileUnresolvedEntryClaims();
  await reconcileConvictionTierClaims();

  // Rehydrate any positions still open from a previous worker run so we keep
  // monitoring their followers across restarts.
  const openPositions = await retryDb<Array<{
    id: string;
    token_mint: string;
    amount_remaining: number;
    entry_price_usd: number | null;
    last_root_buy_wallet: string | null;
    entry_slot: number | null;
    entry_mode: string | null;
    root_buy_count: number | null;
    opened_at: string | null;
    last_root_buy_at: string | null;
  }> | null>("load open positions for follower recovery", () =>
    db
      .from("positions")
      .select(
        "id,token_mint,amount_remaining,entry_price_usd,last_root_buy_wallet,entry_slot,entry_mode,root_buy_count,opened_at,last_root_buy_at",
      )
      .eq("user_id", cfg.user_id)
      .is("closed_at", null),
  );
  for (const pos of openPositions ?? []) {
    if (Number(pos.amount_remaining) <= 0) continue;
    if (convictionRuntime.snapshot(pos.token_mint)) {
      await convictionRuntime.setPositionUsd(
        pos.token_mint,
        convictionExposureIncludingShadow(
          pos.token_mint,
          Number(pos.amount_remaining) * Math.max(0, Number(pos.entry_price_usd ?? 0)),
        ),
      );
    }
    await monitor.onCopyBuy({
      positionId: pos.id,
      tokenMint: pos.token_mint,
      targetWallet: pos.last_root_buy_wallet ?? cfg.target_wallet ?? Array.from(targetWallets)[0],
      entrySlot: Number(pos.entry_slot ?? 0) || undefined,
    });
    if (pos.last_root_buy_wallet && targetWallets.has(pos.last_root_buy_wallet)) {
      await linkTargetToPosition(pos.id, pos.last_root_buy_wallet, "recovered");
    }
    await backfillCoordinatedTargetLinks(pos);
    await backfillConvictionTargetLinks(pos);
  }
  await monitor.reconcileFollowersFromDatabase();

  // On the first deployment of durable cursors, recover transfers made since
  // the oldest still-open entry instead of silently baselining every target at
  // the current head. Historical buys are action-gated, while transfers can
  // safely repair follower lineage for an existing position.
  const oldestOpenEntrySlot = (openPositions ?? [])
    .map((position) => Number(position.entry_slot ?? 0))
    .filter((slot) => Number.isSafeInteger(slot) && slot > 0)
    .reduce<number | undefined>(
      (oldest, slot) => (oldest === undefined ? slot : Math.min(oldest, slot)),
      undefined,
    );
  if (oldestOpenEntrySlot !== undefined) {
    for (const wallet of targetWallets) {
      poller.watch(wallet, { anchorSlot: oldestOpenEntrySlot });
    }
  }

  // Establish durable RPC recovery first. A Geyser outage must never prevent
  // target/follower catch-up from running; the normal entry gate remains closed
  // until one monitoring path is demonstrably healthy.
  poller.start(Array.from(targetWallets));
  const startGeyserUntilConnected = async () => {
    while (true) {
      try {
        await feed.start(Array.from(targetWallets));
        return;
      } catch (err) {
        log.error({ err: safeDiagnostic(err) }, "geyser start failed — retrying in 2s");
        await delay(2000);
      }
    }
  };
  void startGeyserUntilConnected();

  const runFollowerBalanceReconciliation = () => {
    followerBalanceReconciler
      .run()
      .then((health) => {
        const level = health.degraded || health.mismatchCount > 0 ? "warn" : "info";
        log[level](
          {
            checkedBalanceCount: health.checkedBalanceCount,
            candidateMismatchCount: health.candidateMismatchCount,
            mismatchCount: health.mismatchCount,
            degraded: health.degraded,
            lastCheckedAt: toIsoTimestamp(health.lastCheckedAt),
            diagnostic: health.lastError,
          },
          "follower balance reconciliation completed — observations never trigger sells",
        );
      })
      .catch(() =>
        log.error("follower balance reconciliation crashed safely; provider details suppressed"),
      );
  };
  runFollowerBalanceReconciliation();
  setInterval(runFollowerBalanceReconciliation, 30_000);

  // A transient database/stream failure must not leave a persisted follower
  // wallet unmonitored for the rest of the worker's lifetime. Reconciliation
  // only restores missing watches; the hot sell path remains event-driven.
  setInterval(() => {
    monitor
      .reconcileFollowersFromDatabase()
      .catch((err: unknown) =>
        log.error({ err: safeDiagnostic(err) }, "follower subscription repair failed"),
      );
  }, 10_000);

  setInterval(async () => {
    if (configRefreshRunning) return;
    configRefreshRunning = true;
    try {
      const next = await loadConfig(cfg.user_id);
      if (!next?.target_wallet) return;
      const previousTargets = targetWallets;
      const nextTargets = new Set(configuredTargetWallets(next));
      const previousEntryStrategy = automaticEntryStrategy(cfg);
      const nextEntryStrategy = automaticEntryStrategy(next);
      const nextConvictionConfig = convictionConfigFromBotConfig(next);
      const nextConvictionFingerprint = JSON.stringify(nextConvictionConfig);
      const targetsChanged =
        Array.from(previousTargets).sort().join(",") !== Array.from(nextTargets).sort().join(",");
      const convictionConfigChanged = nextConvictionFingerprint !== convictionConfigFingerprint;
      entryConfigTransitioning =
        previousEntryStrategy !== nextEntryStrategy ||
        (nextEntryStrategy === "conviction" && (targetsChanged || convictionConfigChanged));

      // Hydrate and atomically reconfigure the Conviction runtime before the
      // new strategy/config becomes visible to event handlers. During this
      // transition every automatic entry path fails closed, while exits and
      // monitoring continue normally.
      if (convictionConfigChanged && nextEntryStrategy === "conviction") {
        await convictionRuntime.reconfigure(nextConvictionConfig);
      }

      cfg = next;
      targetWallets = nextTargets;
      monitor.setBaseWatchedWallets(nextTargets);
      for (const wallet of previousTargets) {
        if (nextTargets.has(wallet)) continue;
        if (monitor.isFollowerRetained(wallet)) continue;
        poller.unwatch(wallet);
        await feed.unwatch(wallet);
      }
      for (const wallet of nextTargets) {
        if (previousTargets.has(wallet)) continue;
        poller.watch(wallet);
        await feed.watch(wallet);
      }
      if (convictionConfigChanged) {
        // The optional module performs no database work while it is disabled.
        // Its latest settings are still fingerprinted, and enabling it later
        // hydrates the durable engine once with the complete current config.
        convictionConfigFingerprint = nextConvictionFingerprint;
        if (nextEntryStrategy === "conviction") {
          await syncConvictionPositionExposure();
        }
      }
      if (previousEntryStrategy !== nextEntryStrategy) {
        log.info(
          {
            event:
              nextEntryStrategy === "conviction"
                ? "CONVICTION_MODE_ENABLED"
                : "CONVICTION_MODE_DISABLED",
            previousEntryStrategy,
            nextEntryStrategy,
            tradingMode: cfg.conviction_trading_mode ?? "shadow",
          },
          nextEntryStrategy === "conviction"
            ? "Conviction Mode enabled — it is now the exclusive automatic entry strategy"
            : "Conviction Mode disabled — the saved legacy entry strategy is restored",
        );
      }
      if (targetsChanged)
        log.info({ targets: Array.from(nextTargets) }, "target wallet subscriptions updated");
    } catch (err) {
      log.error({ err: safeDiagnostic(err) }, "config refresh failed");
    } finally {
      entryConfigTransitioning = false;
      configRefreshRunning = false;
    }
  }, 3000);

  let convictionTickRunning = false;
  setInterval(() => {
    if (
      convictionTickRunning ||
      entryConfigTransitioning ||
      automaticEntryStrategy(cfg) !== "conviction"
    ) {
      return;
    }
    convictionTickRunning = true;
    convictionRuntime
      .tick(Date.now())
      .then((result) => {
        if (result.persistedRankCount > 0) {
          log.info(
            {
              refreshedTokenCount: result.refreshedTokenCount,
              persistedRankCount: result.persistedRankCount,
            },
            "Conviction rolling windows refreshed during a quiet feed period",
          );
        }
      })
      .catch((err: unknown) =>
        log.error({ err: safeDiagnostic(err) }, "Conviction periodic refresh failed safely"),
      )
      .finally(() => {
        convictionTickRunning = false;
      });
  }, 30_000);

  setInterval(() => {
    log.info(
      {
        target: cfg.target_wallet,
        geyser: feed.health(),
        rpcFallback: poller.health(),
        followerBalanceReconciliation: followerBalanceReconciler.health(),
        entryMonitoringGate: currentEntryMonitoringGate(),
        strategyRecorder: strategyRecorder.health(),
      },
      "stream heartbeat",
    );
  }, 30000);

  const workerStartedAt = new Date().toISOString();

  async function writeWorkerHeartbeat() {
    const geyser = feed.health();
    const rpcFallback = poller.health();
    const followerBalances = followerBalanceReconciler.health();
    const entryMonitoringGate = currentEntryMonitoringGate();
    const baseHeartbeat = {
      user_id: cfg.user_id,
      target_wallet: cfg.target_wallet ?? null,
      started_at: workerStartedAt,
      updated_at: new Date().toISOString(),
      geyser_connected: Boolean(geyser.connected),
      last_geyser_message_at: toIsoTimestamp(geyser.lastMessageAt),
      decoded_event_count: Number(geyser.decodedEventCount ?? 0),
      rpc_last_poll_at: toIsoTimestamp(rpcFallback.lastPollAt),
    };
    const readinessHeartbeat = {
      ...baseHeartbeat,
      rpc_last_success_at: toIsoTimestamp(rpcFallback.lastSuccessAt),
      rpc_backlog_wallet_count: Number(rpcFallback.backlogWalletCount ?? 0),
      monitoring_degraded: entryMonitoringGate.blocked,
      follower_balance_last_checked_at: toIsoTimestamp(followerBalances.lastCheckedAt),
      follower_balance_candidate_count: followerBalances.candidateMismatchCount,
      follower_balance_mismatch_count: followerBalances.mismatchCount,
      follower_balance_reconciliation_degraded: followerBalances.degraded,
      follower_balance_last_error: followerBalances.lastError,
      funding_key_ready: fundingReadiness.ready,
      funding_key_checked_at: fundingReadiness.checkedAt,
      funding_wallet_pubkey: fundingReadiness.walletPubkey,
      last_error: fundingReadiness.error,
      wallet_holdings: latestWalletHoldings,
      observed_follower_holdings: latestObservedFollowerHoldings,
    };
    let { error } = await db
      .from("worker_heartbeat")
      .upsert(readinessHeartbeat, { onConflict: "user_id" });

    if (error && isMissingReadinessColumnError(error.message)) {
      log.warn(
        { err: safeDiagnostic(error) },
        "heartbeat readiness columns missing — writing compatible base heartbeat",
      );
      ({ error } = await db
        .from("worker_heartbeat")
        .upsert(baseHeartbeat, { onConflict: "user_id" }));
    }

    if (error) throw new Error(`worker_heartbeat upsert failed: ${safeDiagnostic(error.message)}`);
  }

  await reconcileFlatWalletPositions().catch((err) =>
    log.error({ err: safeDiagnostic(err) }, "position reconciliation failed"),
  );
  await writeWorkerHeartbeat().catch((err) =>
    log.error({ err: safeDiagnostic(err) }, "database heartbeat failed"),
  );
  setInterval(() => {
    writeWorkerHeartbeat().catch((err) =>
      log.error({ err: safeDiagnostic(err) }, "database heartbeat failed"),
    );
  }, 20_000);
  setInterval(() => {
    checkFundingWalletReadiness(cfg.user_id, cfg.fixed_buy_usd)
      .then((next) => {
        fundingReadiness = next;
      })
      .catch((err) => log.error({ err: safeDiagnostic(err) }, "funding readiness refresh failed"));
  }, 60_000);
  refreshObservedFollowerHoldings().catch((err) =>
    log.error({ err: safeDiagnostic(err) }, "observed follower holdings refresh failed"),
  );
  setInterval(() => {
    reconcileFlatWalletPositions()
      .then(() => refreshObservedFollowerHoldings())
      .catch((err) => log.error({ err: safeDiagnostic(err) }, "wallet holdings refresh failed"));
  }, 60_000);
  setInterval(() => {
    reconcileUnresolvedEntryClaims().catch((err) =>
      log.error({ err: safeDiagnostic(err) }, "durable entry claim reconciliation failed"),
    );
  }, 60_000);
  await refreshCrewWallets(cfg.crew_exit_min_mints ?? 4).catch(() => {});
  setInterval(() => {
    if (cfg.crew_exit_enabled !== true) return;
    void refreshCrewWallets(cfg.crew_exit_min_mints ?? 4);
  }, 60_000);


  // Take-profit / stop-loss watcher — polls prices every 4s for all open positions.
  setInterval(() => {
    checkTpSl().catch((err) => log.error({ err: safeDiagnostic(err) }, "tp/sl loop failed"));
  }, 4000);

  // A sell claim that ends "uncertain" (Jito submitted, transaction failed
  // on-chain) is terminal for reclaim purposes, so the periodic exit path can
  // never retry it and the position is left with no working stop. Resolve the
  // ambiguity against chain state: if the funding wallet still holds the mint,
  // the sell did not land, so the claim is safe to reopen for retry.
  async function recoverStrandedSellClaims() {
    if (!fundingReadiness.ready || !fundingReadiness.walletPubkey) return;
    const staleBefore = new Date(Date.now() - 120_000).toISOString();
    const { data: stranded, error } = await db
      .from("sell_signal_claims")
      .select("id,position_id,trigger_kind,status")
      .eq("user_id", cfg.user_id)
      .in("status", ["uncertain", "claimed"])
      .lt("updated_at", staleBefore)
      .limit(25);
    if (error) {
      log.warn({ err: safeDiagnostic(error) }, "stranded sell claim scan failed");
      return;
    }
    if (!stranded || stranded.length === 0) return;

    let heldByMint: Map<string, number>;
    try {
      const holdings = await walletTokenHoldings(rpc, fundingReadiness.walletPubkey);
      heldByMint = new Map(holdings.map((row) => [row.token_mint, Number(row.amount) || 0]));
    } catch (err) {
      // Fail closed: without chain truth we must not reopen a claim that may
      // have landed, or the same sell could be submitted twice.
      log.warn(
        { err: safeDiagnostic(err) },
        "stranded sell claim recovery skipped — wallet holdings unavailable",
      );
      return;
    }

    for (const claim of stranded as Array<{
      id: string;
      position_id: string;
      trigger_kind: string;
      status: string;
    }>) {
      const { data: pos, error: posError } = await db
        .from("positions")
        .select("id,token_mint,amount_remaining")
        .eq("id", claim.position_id)
        .is("closed_at", null)
        .maybeSingle();
      if (posError || !pos || Number(pos.amount_remaining) <= 0) continue;
      // Tokens gone => the prior sell landed. Leave the claim terminal.
      if ((heldByMint.get(String(pos.token_mint)) ?? 0) <= 0) continue;
      const { data: reopened, error: reopenError } = await db
        .from("sell_signal_claims")
        .update({
          status: "failed_pre_submit",
          error_code: "reopened by recovery: tokens still held on-chain, prior sell did not land",
          submission_started_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", claim.id)
        .in("status", ["uncertain", "claimed"])
        .select("id")
        .maybeSingle();
      if (reopenError) {
        log.warn(
          { err: safeDiagnostic(reopenError), positionId: claim.position_id },
          "stranded sell claim reopen failed",
        );
      } else if (reopened) {
        log.warn(
          {
            positionId: claim.position_id,
            triggerKind: claim.trigger_kind,
            priorStatus: claim.status,
          },
          "stranded sell claim reopened — tokens still held on-chain, exit will retry",
        );
      }
    }
  }
  setInterval(() => {
    recoverStrandedSellClaims().catch((err) =>
      log.error({ err: safeDiagnostic(err) }, "stranded sell claim recovery loop failed"),
    );
  }, 60_000);
  setInterval(() => {
    checkConfiguredPositionExits().catch((err) =>
      log.error({ err: safeDiagnostic(err) }, "configured position exit loop failed"),
    );
  }, 30_000);

  const positionPeakPrice = new Map<string, number>();

  async function checkTpSl() {
    if (
      !cfg.take_profit_enabled &&
      !cfg.stop_loss_enabled &&
      cfg.trailing_stop_enabled !== true &&
      cfg.mirror_custody_sell_exit_enabled !== true
    )
      return;
    const { data: positions } = await db
      .from("positions")
      .select(
        "id,token_mint,entry_price_usd,amount_tokens,amount_remaining,decimals,tp_taken,mirrored_sold_fraction,entry_mode,opened_at",
      )
      .eq("user_id", cfg.user_id)
      .is("closed_at", null);

    let mirrorSoldAt: Map<string, string> | null = null;
    if (cfg.mirror_custody_sell_exit_enabled === true && (positions?.length ?? 0) > 0) {
      const openMints = Array.from(new Set((positions ?? []).map((p) => p.token_mint)));
      const { data: soldRows } = await db
        .from("custody_sell_watch")
        .select("token_mint,sold_detected_at")
        .eq("status", "sold")
        .in("token_mint", openMints);
      mirrorSoldAt = new Map<string, string>();
      for (const s of soldRows ?? []) {
        const mint = (s as { token_mint: string }).token_mint;
        const at = String((s as { sold_detected_at: string | null }).sold_detected_at ?? "");
        const prev = mirrorSoldAt.get(mint);
        if (!prev || at > prev) mirrorSoldAt.set(mint, at);
      }
    }
    for (const pos of positions ?? []) {
      const remaining = Number(pos.amount_remaining);
      const entry = Number(pos.entry_price_usd);
      if (remaining <= 0 || entry <= 0) continue;

      if (cfg.mirror_custody_sell_exit_enabled === true && mirrorSoldAt) {
        const soldAt = mirrorSoldAt.get(pos.token_mint);
        if (soldAt && (!pos.opened_at || soldAt > String(pos.opened_at))) {
          log.warn(
            { positionId: pos.id, tokenMint: pos.token_mint },
            "target hidden custody sell detected — mirroring exit",
          );
          await executeClaimedPercentageExit(
            pos.id,
            pos.token_mint,
            remaining,
            Number(pos.decimals ?? 0),
            Math.abs(Number(cfg.mirror_custody_sell_exit_pct ?? 100)) || 100,
            "mirror_custody_sell",
            undefined,
            "mirrored target hidden custody sell (detector)",
            periodicSellIdentity(pos.id, "mirror_custody_sell"),
          );
          continue;
        }
      }
      const price = await priceUsd(pos.token_mint);
      if (!price || price <= 0) continue;
      const gainPct = ((price - entry) / entry) * 100;

      const prevPeak = positionPeakPrice.get(pos.id) ?? price;
      const peak = price > prevPeak ? price : prevPeak;
      positionPeakPrice.set(pos.id, peak);
      if (cfg.trailing_stop_enabled === true) {
        const peakGainPct = ((peak - entry) / entry) * 100;
        const dropFromPeakPct = peak > 0 ? ((peak - price) / peak) * 100 : 0;
        if (
          peakGainPct >= Math.abs(Number(cfg.trailing_activation_pct ?? 50)) &&
          dropFromPeakPct >= Math.abs(Number(cfg.trailing_stop_pct ?? 35))
        ) {
          log.info(
            {
              positionId: pos.id,
              peakGainPct: peakGainPct.toFixed(1),
              dropFromPeakPct: dropFromPeakPct.toFixed(1),
            },
            "trailing-stop triggered — winner pulled back from peak",
          );
          await executeClaimedPercentageExit(
            pos.id,
            pos.token_mint,
            remaining,
            Number(pos.decimals ?? 0),
            100,
            "trailing_stop",
            undefined,
            `trailing-stop ${dropFromPeakPct.toFixed(1)}% off peak (peak +${peakGainPct.toFixed(0)}%)`,
            periodicSellIdentity(pos.id, "trailing_stop"),
          );
          positionPeakPrice.delete(pos.id);
          continue;
        }
      }

      if (cfg.stop_loss_enabled && gainPct <= -Math.abs(cfg.stop_loss_pct)) {
        const decimals = Number(pos.decimals ?? 0);
        log.warn(
          { positionId: pos.id, gainPct: gainPct.toFixed(2) },
          "stop-loss triggered — selling all",
        );
        await executeClaimedPercentageExit(
          pos.id,
          pos.token_mint,
          remaining,
          decimals,
          100,
          "stop_loss",
          undefined,
          `stop-loss ${gainPct.toFixed(1)}%`,
          periodicSellIdentity(pos.id, "stop_loss"),
        );
        continue;
      }

      if (cfg.take_profit_enabled && !pos.tp_taken && gainPct >= Math.abs(cfg.take_profit_pct)) {
        const decimals = Number(pos.decimals ?? 0);
        log.info(
          {
            positionId: pos.id,
            gainPct: gainPct.toFixed(2),
            sellPct: cfg.take_profit_sell_pct,
          },
          "take-profit triggered",
        );
        await executeClaimedPercentageExit(
          pos.id,
          pos.token_mint,
          remaining,
          decimals,
          Number(cfg.take_profit_sell_pct),
          "take_profit",
          undefined,
          `take-profit ${gainPct.toFixed(1)}%`,
          {
            ...periodicSellIdentity(pos.id, "take_profit"),
            markTpTaken: true,
          },
        );
      }
    }

    const openIds = new Set((positions ?? []).map((p) => p.id));
    for (const id of positionPeakPrice.keys()) {
      if (!openIds.has(id)) positionPeakPrice.delete(id);
    }
  }


  async function checkConfiguredPositionExits() {
    const { data: positions, error } = await db
      .from("positions")
      .select(
        "id,token_mint,amount_remaining,decimals,last_root_buy_at,opened_at,entry_mode,coordinated_exit_triggered,follower_seller_exit_triggered",
      )
      .eq("user_id", cfg.user_id)
      .is("closed_at", null);
    if (error)
      throw new Error(`configured position exit query failed: ${safeDiagnostic(error.message)}`);
    const nowMs = Date.now();
    for (const pos of positions ?? []) {
      if (exitsInFlight.has(pos.id) || Number(pos.amount_remaining) <= 0) continue;
      const coordinated = (pos.entry_mode ?? "regular") === "coordinated";
      const sellerExitEnabled = coordinated || Boolean(cfg.follower_seller_exit_enabled);
      const sellerExitTriggered = coordinated
        ? Boolean(pos.coordinated_exit_triggered)
        : Boolean(pos.follower_seller_exit_triggered);
      const requiredSellers = coordinated
        ? Number(cfg.coordinated_follower_sell_count)
        : Number(cfg.follower_seller_exit_count);
      const sellerExitPct = coordinated
        ? Number(cfg.coordinated_follower_sell_pct)
        : Number(cfg.follower_seller_exit_pct);
      if (sellerExitEnabled && !sellerExitTriggered) {
        const { count, error: sellerCountError } = await db
          .from("follower_wallets")
          .select("id", { count: "exact", head: true })
          .eq("position_id", pos.id)
          .eq("trigger_eligible", true)
          .is("released_at", null)
          .not("first_fresh_sell_at", "is", null);
        if (sellerCountError) {
          throw new Error(`seller-count query failed: ${safeDiagnostic(sellerCountError.message)}`);
        }
        if (shouldTriggerDistinctSellerExit(Number(count ?? 0), requiredSellers, false)) {
          await executeClaimedPercentageExit(
            pos.id,
            pos.token_mint,
            Number(pos.amount_remaining),
            Number(pos.decimals ?? 0),
            sellerExitPct,
            "distinct_follower",
            undefined,
            `${coordinated ? "coordinated" : "main"} ${count ?? 0} distinct follower seller(s) (retry check)`,
            {
              ...periodicSellIdentity(
                pos.id,
                "distinct_follower",
                coordinated ? "coordinated" : "regular",
              ),
              markCoordinatedExit: coordinated,
              markFollowerSellerExit: !coordinated,
            },
          );
          continue;
        }
      }
      const inactivityEnabled = coordinated || Boolean(cfg.target_inactivity_exit_enabled);
      if (!inactivityEnabled) continue;
      const inactivityHours = coordinated
        ? Number(cfg.coordinated_inactivity_hours)
        : Number(cfg.target_inactivity_hours);
      const deadline = inactivityDeadlineMs(pos.last_root_buy_at ?? pos.opened_at, inactivityHours);
      if (deadline === undefined || nowMs < deadline) continue;
      await executeClaimedPercentageExit(
        pos.id,
        pos.token_mint,
        Number(pos.amount_remaining),
        Number(pos.decimals ?? 0),
        100,
        "target_inactivity",
        undefined,
        `${coordinated ? "coordinated" : "main"} target inactivity ${inactivityHours}h`,
        {
          ...periodicSellIdentity(
            pos.id,
            "target_inactivity",
            coordinated ? "coordinated" : "regular",
          ),
          markCoordinatedExit: coordinated,
        },
      );
    }
  }

  async function executeExitSell(
    positionId: string,
    mint: string,
    sellRaw: number,
    sellUi: number,
    reason: string,
    markTpTaken = false,
    markCoordinatedExit = false,
    markFollowerSellerExit = false,
    strategyEvent?: FeedEvent,
    mirroredSoldFraction?: number,
  ): Promise<ExecuteResult | null> {
    if (exitsInFlight.has(positionId)) return null;
    exitsInFlight.add(positionId);
    let landedResult: ExecuteResult | undefined;
    try {
      const secret = await loadSigner(cfg.user_id);
      if (!secret) {
        log.error("no funding key for tp/sl sell");
        if (strategyEvent) {
          recordStrategyDecision(strategyEvent, "failed", "funding key is not available for sell", {
            position_id: positionId,
          });
        }
        return null;
      }
      if (strategyEvent) {
        recordStrategyDecision(strategyEvent, "mirror_submitted", reason, {
          position_id: positionId,
        });
      }
      const result = await executeSwap({
        signerSecret: secret,
        inputMint: mint,
        outputMint: WSOL,
        amountLamports: sellRaw,
        // Exits prioritize certainty of getting out over price: a stop-loss that
        // reverts on Alien's fast dumps (Jupiter 6001) leaves the position
        // unprotected. 15% slippage makes exits actually land during a crash.
        slippageBps: 1500,
        route: cfg.execution_route,
        jitoTipSol: cfg.jito_tip_sol,
      });
      landedResult = result;
      if (strategyEvent) {
        recordStrategyDecision(strategyEvent, "mirrored", "event-triggered exit landed", {
          position_id: positionId,
          bot_tx_sig: result.txSig,
          reaction_ms: strategyReactionMs(strategyEvent, Date.now(), result.latencyMs),
          execution_ms: result.latencyMs,
          metadata: { persistencePending: true },
        });
      }
      const cur = await retryDb<{
        amount_remaining: number;
        entry_price_usd: number | null;
      } | null>("load position after exit", () =>
        db
          .from("positions")
          .select("amount_remaining,entry_price_usd")
          .eq("id", positionId)
          .maybeSingle(),
      );
      if (!cur) throw new Error(`position ${positionId} disappeared after exit transaction landed`);
      const newRemaining = Math.max(0, Number(cur.amount_remaining) - sellUi);
      const closed = isFlatPosition(newRemaining);
      const update: {
        amount_remaining: number;
        closed_at: string | null;
        tp_taken?: boolean;
        coordinated_exit_triggered?: boolean;
        follower_seller_exit_triggered?: boolean;
        mirrored_sold_fraction?: number;
      } = {
        amount_remaining: newRemaining,
        closed_at: closed ? new Date().toISOString() : null,
      };
      if (markTpTaken) update.tp_taken = true;
      if (markCoordinatedExit) update.coordinated_exit_triggered = true;
      if (markFollowerSellerExit) update.follower_seller_exit_triggered = true;
      if (mirroredSoldFraction !== undefined) {
        update.mirrored_sold_fraction = Math.min(1, Math.max(0, Number(mirroredSoldFraction) || 0));
      }
      await retryDb("save position after exit", () =>
        db.from("positions").update(update).eq("id", positionId),
      );
      if (convictionRuntime.snapshot(mint)) {
        await convictionRuntime.setPositionUsd(
          mint,
          convictionExposureIncludingShadow(
            mint,
            newRemaining * Math.max(0, Number(cur.entry_price_usd ?? 0)),
          ),
        );
      }
      // Analytics: capture exit price, proceeds, and PnL so the trade log is
      // measurable. Best-effort and non-blocking to execution — the swap has
      // already landed above; a price-feed miss simply records nulls (prior
      // behaviour) and never throws.
      let exitPriceUsd: number | null = null;
      try {
        const p = await priceUsd(mint);
        exitPriceUsd = typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
      } catch {
        exitPriceUsd = null;
      }
      const entryPriceUsd = Number(cur.entry_price_usd ?? 0);
      const exitAmountUsd = exitPriceUsd !== null ? sellUi * exitPriceUsd : null;
      const exitPnlPct =
        exitPriceUsd !== null && entryPriceUsd > 0
          ? ((exitPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
          : null;
      await retryDb("save exit trade", () =>
        db.from("trades").insert({
          user_id: cfg.user_id,
          position_id: positionId,
          side: "sell",
          token_mint: mint,
          amount_tokens: sellUi,
          amount_usd: exitAmountUsd,
          price_usd: exitPriceUsd,
          pnl_pct: exitPnlPct,
          tx_sig: result.txSig,
          reason,
          latency_ms: result.latencyMs,
          route: result.route,
        }),
      );
      log.info({ sig: result.txSig, reason, closed }, "exit sell landed");
      if (closed) await releaseMonitoredPosition(positionId);
      if (strategyEvent) {
        recordStrategyDecision(strategyEvent, "mirrored", "event-triggered exit landed and saved", {
          position_id: positionId,
          bot_tx_sig: result.txSig,
          reaction_ms: strategyReactionMs(strategyEvent, Date.now(), result.latencyMs),
          execution_ms: result.latencyMs,
          metadata: { persistencePending: false, closed },
        });
      }
      return result;
    } catch (err) {
      // Once executeSwap returns, the chain action is already landed. Any
      // later persistence failure must remain non-retryable until reconciled;
      // otherwise a periodic pass could submit the same sell again.
      if (landedResult && !isPostSubmissionError(err)) {
        throw new SubmissionUncertainError({
          route: landedResult.route,
          txSig: landedResult.txSig,
          detail: err,
        });
      }
      throw err;
    } finally {
      exitsInFlight.delete(positionId);
    }
  }

  async function executeClaimedPercentageExit(
    positionId: string,
    mint: string,
    _remaining: number,
    decimals: number,
    sellPct: number,
    triggerKind: SellTriggerKind,
    event: FeedEvent | undefined,
    reason: string,
    options: {
      sourceTxSig?: string;
      sourceWallet?: string;
      exactSellUi?: number;
      markTpTaken?: boolean;
      markCoordinatedExit?: boolean;
      markFollowerSellerExit?: boolean;
      mirroredSoldFraction?: number;
    } = {},
    tradeLockHeld = false,
  ): Promise<ExecuteResult | null> {
    const runClaimedExit = async () => {
      const normalizedPct = Math.min(100, Math.max(0, Number(sellPct)));
      if (normalizedPct <= 0 || exitsInFlight.has(positionId)) return null;
      const sourceWallet =
        options.sourceWallet ??
        (event ? (event.kind === "swap" ? event.wallet : event.from) : "helix-worker");
      const sourceTxSig =
        options.sourceTxSig ??
        (event ? event.txSig || `slot-${event.slot}` : `periodic:${positionId}:${triggerKind}`);
      const requestedSellAmount =
        options.exactSellUi !== undefined ? Math.max(0, Number(options.exactSellUi) || 0) : null;
      const { data: insertedClaim, error: claimError } = await db
        .from("sell_signal_claims")
        .insert({
          user_id: cfg.user_id,
          position_id: positionId,
          source_tx_sig: sourceTxSig,
          source_wallet: sourceWallet,
          trigger_kind: triggerKind,
          status: "claimed",
          requested_sell_pct: normalizedPct,
          requested_sell_amount: requestedSellAmount,
        })
        .select("id")
        .maybeSingle();
      let claim = insertedClaim as { id: string } | null;
      if (claimError?.code === "23505") {
        const { data: existingClaim, error: existingClaimError } = await db
          .from("sell_signal_claims")
          .select("id,status")
          .eq("position_id", positionId)
          .eq("source_tx_sig", sourceTxSig)
          .eq("source_wallet", sourceWallet)
          .eq("trigger_kind", triggerKind)
          .maybeSingle();
        if (existingClaimError) {
          throw new Error(
            `sell signal claim recovery failed: ${safeDiagnostic(existingClaimError)}`,
          );
        }
        if (!existingClaim || !canReclaimSellClaim(existingClaim.status)) {
          if (event) {
            recordStrategyDecision(event, "tracked", "duplicate durable sell signal ignored", {
              position_id: positionId,
            });
          }
          return null;
        }
        const { data: reclaimed, error: reclaimError } = await db
          .from("sell_signal_claims")
          .update({
            status: "claimed",
            error_code: null,
            requested_sell_pct: normalizedPct,
            requested_sell_amount: requestedSellAmount,
            submission_started_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingClaim.id)
          .eq("status", "failed_pre_submit")
          .select("id")
          .maybeSingle();
        if (reclaimError || !reclaimed) {
          throw new Error(
            `sell signal reclaim failed: ${safeDiagnostic(reclaimError ?? "claim changed")}`,
          );
        }
        claim = reclaimed;
      }
      if ((claimError && claimError.code !== "23505") || !claim) {
        throw new Error(
          `sell signal claim failed: ${safeDiagnostic(claimError ?? "missing claim")}`,
        );
      }

      const updateClaim = async (values: Record<string, unknown>, required = false) => {
        const { error } = await db
          .from("sell_signal_claims")
          .update({ ...values, updated_at: new Date().toISOString() })
          .eq("id", claim.id);
        if (error) {
          log.error(
            { err: safeDiagnostic(error), triggerKind, positionId },
            "sell signal status update failed",
          );
          if (required) {
            throw new Error(`sell signal status update failed: ${safeDiagnostic(error)}`);
          }
        }
      };

      const { data: currentPosition, error: currentPositionError } = await db
        .from("positions")
        .select("amount_remaining,decimals")
        .eq("id", positionId)
        .is("closed_at", null)
        .maybeSingle();
      if (currentPositionError || !currentPosition) {
        await updateClaim({
          status: "failed_pre_submit",
          error_code: currentPositionError ? "position-load-failed" : "position-not-open",
        });
        if (currentPositionError) {
          throw new Error(`sell position refresh failed: ${safeDiagnostic(currentPositionError)}`);
        }
        return null;
      }

      const currentRemaining = Math.max(0, Number(currentPosition.amount_remaining) || 0);
      const sellUi = Math.min(
        currentRemaining,
        requestedSellAmount !== null
          ? requestedSellAmount
          : currentRemaining * (normalizedPct / 100),
      );
      const currentDecimals = Number(currentPosition.decimals ?? decimals);
      const sellRaw = Math.floor(sellUi * Math.pow(10, currentDecimals));
      if (sellRaw <= 0 || sellUi <= 0) {
        await updateClaim({ status: "failed_pre_submit", error_code: "no-executable-amount" });
        return null;
      }

      await updateClaim(
        { status: "submitted", submission_started_at: new Date().toISOString() },
        true,
      );
      try {
        log.warn({ positionId, mint, sellPct: normalizedPct, reason }, "claimed exit triggered");
        const result = await executeExitSell(
          positionId,
          mint,
          sellRaw,
          sellUi,
          reason,
          Boolean(options.markTpTaken),
          Boolean(options.markCoordinatedExit),
          Boolean(options.markFollowerSellerExit),
          event,
          options.mirroredSoldFraction,
        );
        if (!result) {
          await updateClaim({ status: "failed_pre_submit", error_code: "no-executable-amount" });
          return null;
        }
        await updateClaim({
          status: "landed",
          bot_tx_sig: result.txSig,
          error_code: null,
          landed_at: new Date().toISOString(),
        });
        return result;
      } catch (err) {
        const disposition = sellClaimFailureDisposition(err);
        await updateClaim({
          status: disposition.status,
          bot_tx_sig: disposition.botTxSig,
          error_code: safeDiagnostic(err),
        });
        throw err;
      }
    };
    // Global lock order is always mint first, then position. A landed buy may
    // inspect a buffered terminal outflow while already holding the mint lock;
    // it acquires only the inner position lock. Normal exits can therefore
    // never hold the position lock while waiting for that buy, avoiding AB/BA
    // deadlocks while retaining cross-process protection in the DB claim.
    return tradeLockHeld
      ? exitExecutionQueue.run(positionId, runClaimedExit)
      : tradeExecutionQueue.run(mint, () => exitExecutionQueue.run(positionId, runClaimedExit));
  }

  async function handle(event: FeedEvent): Promise<void> {
    // This is bounded in-memory work. Supabase persistence happens on the
    // recorder timer and cannot delay the serial Geyser hot path.
    recordStrategyEvent(event);
    try {
      if (event.kind === "transfer") {
        await handleTransfer(event);
        await observeConvictionTransfers(event);
        return;
      }
      if (event.kind === "swap") {
        if (targetWallets.has(event.wallet) && event.side === "buy") {
          await handleTargetBuy(event);
          return;
        }
        if (event.side === "sell") {
          // Conviction distribution state must see a linked target sell before
          // a potentially slow existing exit runs. Observation failure never
          // suppresses the independently configured sell/risk path.
          let convictionObservationError: unknown;
          if (targetWallets.has(event.wallet)) {
            try {
              await observeConvictionSell(event);
            } catch (err) {
              convictionObservationError = err;
              log.warn(
                { err: safeDiagnostic(err), mint: event.tokenMint },
                "Conviction target-sell observation failed; exit handling will run before replay",
              );
            }
          }
          await handleFollowerSell(event);
          // Keep the RPC cursor on this signature so a transient Conviction
          // persistence/valuation failure can replay after the independent
          // exit path has had its chance to act. Durable dedupe makes replay
          // safe for both systems.
          if (convictionObservationError) throw convictionObservationError;
          return;
        }
        log.info(
          {
            eventWallet: event.wallet,
            targets: Array.from(targetWallets),
            side: event.side,
            mint: event.tokenMint,
            txSig: event.txSig,
          },
          "swap event ignored — not target buy or follower sell",
        );
        recordStrategyDecision(event, "tracked", "observed wallet buy outside target entry flow");
      }
    } catch (err) {
      recordStrategyDecision(event, "failed", safeDiagnostic(err));
      log.error({ err: safeDiagnostic(err) }, "handler failed");
      // The RPC fallback advances its durable cursor only after this promise
      // resolves. Re-throw so transient database/quote/handler failures remain
      // replayable instead of being silently skipped forever. Geyser contains
      // the rejection per message and continues draining the live stream.
      throw err;
    }
  }

  async function observeTargetFirstBuy(targetWallet: string, tokenMint: string): Promise<boolean> {
    const { data: prior, error } = await db
      .from("target_traded_tokens")
      .select("token_mint")
      .eq("target_wallet", targetWallet)
      .eq("token_mint", tokenMint)
      .maybeSingle();
    if (error) throw new Error(`target first-buy lookup failed: ${safeDiagnostic(error.message)}`);
    if (prior) return false;
    const { error: insertError } = await db
      .from("target_traded_tokens")
      .upsert({ target_wallet: targetWallet, token_mint: tokenMint });
    if (insertError)
      throw new Error(`target first-buy record failed: ${safeDiagnostic(insertError.message)}`);
    return true;
  }

  async function linkTargetToPosition(
    positionId: string,
    wallet: string,
    linkReason: "entry" | "coordinated" | "additional_buy" | "recovered",
    observedAt = new Date().toISOString(),
  ) {
    if (!targetWallets.has(wallet)) return;
    const { error } = await db.from("position_target_wallets").upsert(
      {
        user_id: cfg.user_id,
        position_id: positionId,
        wallet,
        link_reason: linkReason,
        last_buy_at: observedAt,
      },
      { onConflict: "position_id,wallet" },
    );
    if (error) throw new Error(`position target link failed: ${safeDiagnostic(error.message)}`);
  }

  async function backfillCoordinatedTargetLinks(position: {
    id: string;
    token_mint: string;
    entry_mode: string | null;
    root_buy_count: number | null;
    opened_at: string | null;
    last_root_buy_at: string | null;
    last_root_buy_wallet: string | null;
  }) {
    const anchorAt = position.last_root_buy_at ?? position.opened_at;
    if (
      position.entry_mode !== "coordinated" ||
      Number(position.root_buy_count ?? 0) < 2 ||
      !anchorAt
    ) {
      return;
    }
    const anchorMs = Date.parse(anchorAt);
    if (!Number.isFinite(anchorMs)) return;
    const windowMs = Math.max(1, Number(cfg.coordinated_window_seconds) || 0) * 1_000;
    const { data, error } = await db
      .from("strategy_observations")
      .select("actor_wallet,event_at,metadata")
      .eq("user_id", cfg.user_id)
      .eq("token_mint", position.token_mint)
      .eq("relationship", "target")
      .eq("event_kind", "swap")
      .eq("side", "buy")
      .gte("event_at", new Date(anchorMs - windowMs).toISOString())
      .lte("event_at", new Date(anchorMs + 5_000).toISOString())
      .contains("metadata", { entryMode: "coordinated" })
      .limit(100);
    if (error) {
      log.warn(
        { positionId: position.id, err: safeDiagnostic(error) },
        "coordinated target-link evidence unavailable — no links guessed",
      );
      return;
    }
    const wallets = authoritativeCoordinatedTargetLinks({
      position: {
        positionId: position.id,
        tokenMint: position.token_mint,
        entryMode: position.entry_mode,
        rootBuyCount: Number(position.root_buy_count ?? 0),
        anchorAt,
        lastRootBuyWallet: position.last_root_buy_wallet,
      },
      observations: (data ?? []) as Array<{
        actor_wallet: string;
        event_at: string;
        metadata?: Record<string, unknown> | null;
      }>,
      configuredTargets: targetWallets,
      windowSeconds: Number(cfg.coordinated_window_seconds),
    });
    if (wallets.length === 0) {
      log.warn(
        { positionId: position.id, required: Number(position.root_buy_count ?? 0) },
        "coordinated target-link evidence incomplete — no links guessed",
      );
      return;
    }
    for (const wallet of wallets) {
      await linkTargetToPosition(position.id, wallet, "coordinated", anchorAt);
    }
    log.info(
      { positionId: position.id, linkedTargetCount: wallets.length },
      "coordinated target links restored from authoritative Strategy Lab evidence",
    );
  }

  async function backfillConvictionTargetLinks(position: {
    id: string;
    token_mint: string;
  }): Promise<void> {
    const { data: tier, error: tierError } = await db
      .from("conviction_tiers")
      .select("source_event_key")
      .eq("user_id", cfg.user_id)
      .eq("position_id", position.id)
      .eq("trading_mode", "live")
      .in("status", ["landed", "persisted"])
      .order("tier_number", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (tierError) {
      throw new Error(`Conviction target-link tier lookup failed: ${safeDiagnostic(tierError)}`);
    }
    if (!tier?.source_event_key) return;

    const { data: sourceEvent, error: sourceError } = await db
      .from("conviction_events")
      .select("event_at")
      .eq("user_id", cfg.user_id)
      .eq("event_key", tier.source_event_key)
      .maybeSingle();
    if (sourceError) {
      throw new Error(
        `Conviction target-link source lookup failed: ${safeDiagnostic(sourceError)}`,
      );
    }
    if (!sourceEvent?.event_at) return;

    const { data: buys, error: buyError } = await db
      .from("conviction_events")
      .select("wallet,event_at")
      .eq("user_id", cfg.user_id)
      .eq("token_mint", position.token_mint)
      .eq("classification", "DEX_BUY")
      .eq("classification_reliable", true)
      .lte("event_at", sourceEvent.event_at)
      .order("event_at", { ascending: false })
      .limit(1_000);
    if (buyError) {
      throw new Error(`Conviction target-link evidence lookup failed: ${safeDiagnostic(buyError)}`);
    }
    const evidence = new Map<string, string>();
    for (const buy of buys ?? []) {
      if (!targetWallets.has(buy.wallet) || evidence.has(buy.wallet)) continue;
      evidence.set(buy.wallet, buy.event_at);
    }
    for (const [wallet, eventAt] of evidence) {
      await linkTargetToPosition(position.id, wallet, "recovered", eventAt);
    }
    if (evidence.size > 0) {
      log.info(
        { positionId: position.id, recoveredTargetCount: evidence.size },
        "Conviction target links restored from durable verified-buy evidence",
      );
    }
  }

  async function recordOpenPositionTargetBuy(event: SwapEvent) {
    const { data: pos, error } = await db
      .from("positions")
      .select("id,root_buy_count,last_root_buy_at,last_root_buy_wallet")
      .eq("user_id", cfg.user_id)
      .eq("token_mint", event.tokenMint)
      .is("closed_at", null)
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error)
      throw new Error(`open-position target-buy lookup failed: ${safeDiagnostic(error.message)}`);
    if (!pos) return;
    const observedAt = new Date(event.timestampMs);
    const priorAt = pos.last_root_buy_at ? new Date(pos.last_root_buy_at) : null;
    const preservesNewerObservation =
      priorAt && Number.isFinite(priorAt.getTime()) && priorAt > observedAt;
    const lastRootBuyAt = preservesNewerObservation ? priorAt : observedAt;
    const { error: updateError } = await db
      .from("positions")
      .update({
        root_buy_count: Number(pos.root_buy_count ?? 0) + 1,
        last_root_buy_at: lastRootBuyAt.toISOString(),
        last_root_buy_wallet: preservesNewerObservation ? pos.last_root_buy_wallet : event.wallet,
      })
      .eq("id", pos.id);
    if (updateError)
      throw new Error(`target-buy activity update failed: ${safeDiagnostic(updateError.message)}`);
    await linkTargetToPosition(pos.id, event.wallet, "additional_buy", observedAt.toISOString());
  }

  function isFreshAutomaticAction(event: FeedEvent, maxAgeMs: number): boolean {
    const authoritativeEventMs =
      event.delivery === "catchup" ? event.blockTimeMs : (event.blockTimeMs ?? event.timestampMs);
    if (!authoritativeEventMs || !Number.isFinite(authoritativeEventMs)) return false;
    const ageMs = Date.now() - authoritativeEventMs;
    return ageMs >= -5_000 && ageMs <= maxAgeMs;
  }

  async function classifyTransferRecipients(
    event: TransferEvent,
  ): Promise<ClassifiedTransferRecipient[]> {
    return Promise.all(
      transferRecipients(event).map(async (recipient) => {
        const classification = await classifyFollowerRecipient(recipient.wallet);
        const eligible = classification === "eligible";
        return {
          ...recipient,
          track: eligible,
          triggerEligible:
            eligible && Math.max(0, Number(recipient.recipientPreAmount ?? 0)) <= 1e-9,
          destinationClass: eligible ? "follower" : classification,
        };
      }),
    );
  }

  function convictionEventIdentity(event: FeedEvent, suffix: string): string {
    const transaction = event.txSig || `slot-${event.slot}`;
    return `${event.kind}:${transaction}:${suffix}:${event.tokenMint}`;
  }

  function convictionEventMetadata(event: FeedEvent): Record<string, unknown> {
    return {
      txSig: event.txSig,
      slot: event.slot,
      source: event.source ?? "unknown",
      delivery: event.delivery ?? "live",
      blockTimeMs: event.blockTimeMs,
      observedAtMs: event.observedAtMs ?? event.timestampMs,
    };
  }

  async function convictionSellValueUsd(event: SwapEvent): Promise<number | undefined> {
    const attribution = event.sellAttribution;
    if (!attribution?.verified) return undefined;
    const proceedsAmount = Number(attribution.proceedsAmount ?? 0);
    if (proceedsAmount > 0 && attribution.proceedsMint) {
      if (STABLECOIN_MINTS.has(attribution.proceedsMint)) return proceedsAmount;
      const proceedsPrice = await priceUsd(attribution.proceedsMint);
      if (proceedsPrice !== undefined) return proceedsAmount * proceedsPrice;
    }
    const soldPrice = await priceUsd(event.tokenMint);
    if (soldPrice === undefined) return undefined;
    const soldTokens = Math.max(0, Number(event.amountTokens));
    return soldTokens > 0 ? soldTokens * soldPrice : undefined;
  }

  async function observeConvictionEvent(
    event: ConvictionEvent,
    feedEvent: FeedEvent,
    actionable: boolean,
  ): Promise<void> {
    if (automaticEntryStrategy(cfg) !== "conviction") return;
    let currentPositionUsd: number | undefined;
    if (event.type === "DEX_BUY") {
      const { data: openPosition, error } = await db
        .from("positions")
        .select("amount_remaining,entry_price_usd")
        .eq("user_id", cfg.user_id)
        .eq("token_mint", event.tokenMint)
        .is("closed_at", null)
        .limit(1)
        .maybeSingle();
      if (error) {
        throw new Error(`Conviction exposure lookup failed: ${safeDiagnostic(error)}`);
      }
      const actualPositionUsd = openPosition
        ? Math.max(0, Number(openPosition.amount_remaining)) *
          Math.max(0, Number(openPosition.entry_price_usd ?? 0))
        : 0;
      currentPositionUsd = convictionExposureIncludingShadow(event.tokenMint, actualPositionUsd);
    }
    // A settings transition can complete while the authoritative exposure
    // read is in flight. Never feed an event into a strategy that is no
    // longer selected, and never let a transition-time event submit a tier.
    if (automaticEntryStrategy(cfg) !== "conviction") return;
    const result = await convictionRuntime.observe(event, {
      globalEntriesEnabled: cfg.enabled === true,
      actionable: actionable && !entryConfigTransitioning,
      currentPositionUsd,
    });
    if (result.duplicate) return;

    for (const transition of result.update.transitions) {
      log.info(
        {
          event: "CONVICTION_STATE_CHANGE",
          mint: transition.mint,
          previousState: transition.previousState,
          newState: transition.newState,
          previousScore: transition.previousScore,
          newScore: transition.newScore,
          reasons: transition.reasons,
        },
        "Conviction token state changed",
      );
    }
    for (const breakout of result.update.breakouts) {
      log.info(
        {
          event: "CONVICTION_BREAKOUT",
          mint: breakout.mint,
          score: breakout.newScore,
          netClusterInvestmentUsd: breakout.netClusterInvestmentUsd,
          capitalVelocityUsdPerMinute: breakout.capitalVelocityUsdPerMinute,
          walletConvergence: breakout.walletConvergence,
          reasons: breakout.reasons,
        },
        "Conviction breakout detected",
      );
    }
    if (result.action) {
      await executeConvictionAction(result.action, feedEvent);
    }
  }

  async function observeConvictionBuy(
    event: SwapEvent,
    meta: Awaited<ReturnType<typeof loadTokenMeta>>,
    targetBuyUsd: number | undefined,
    actionable: boolean,
  ): Promise<void> {
    const classification = classifyConvictionSwap(event, targetWallets);
    const reliable = classification.reliable && targetBuyUsd !== undefined;
    await observeConvictionEvent(
      {
        eventId: convictionEventIdentity(event, `${event.wallet}:buy`),
        timestampMs: event.blockTimeMs ?? event.timestampMs,
        wallet: event.wallet,
        tokenMint: event.tokenMint,
        type: reliable ? classification.classification : "UNKNOWN",
        amountUsd: targetBuyUsd ?? 0,
        amountTokens: Math.max(0, Number(event.amountTokens)),
        symbol: meta.symbol,
        marketCapUsd: meta.marketCapUsd,
        liquidityUsd: meta.liquidityUsd,
        tokenCreatedAtMs: meta.pairCreatedAtMs,
        classificationReliable: reliable,
        metadata: {
          ...convictionEventMetadata(event),
          side: "buy",
          inferredRecipientCount: event.inferredRecipients?.length ?? 0,
        },
      },
      event,
      actionable,
    );
  }

  async function observeConvictionSell(event: SwapEvent): Promise<void> {
    if (automaticEntryStrategy(cfg) !== "conviction" || !targetWallets.has(event.wallet)) return;
    const classification = classifyConvictionSwap(event, targetWallets);
    const amountUsd = await convictionSellValueUsd(event);
    const valuationObservedAtMs = Date.now();
    const reliable = classification.reliable && amountUsd !== undefined;
    if (amountUsd !== undefined) {
      event.amountUsd = amountUsd;
      recordStrategyEvent(event, {
        amount_usd: amountUsd,
        metadata: {
          side: "sell",
          verifiedSwap: event.verifiedSwap === true,
          sellAttributionVerified: event.sellAttribution?.verified === true,
          valuationSource: event.sellAttribution?.proceedsMint
            ? "verified-proceeds"
            : "sold-token-price",
          proceedsMint: event.sellAttribution?.proceedsMint,
          valuationObservedAtMs,
        },
      });
    }
    const meta = await loadTokenMeta(event.tokenMint);
    const marketDataObservedAtMs = Date.now();
    recordStrategyEvent(event, {
      market_cap_usd: meta.marketCapUsd,
      liquidity_usd: meta.liquidityUsd,
      metadata: { marketDataObservedAtMs },
    });
    await observeConvictionEvent(
      {
        eventId: convictionEventIdentity(event, `${event.wallet}:sell`),
        timestampMs: event.blockTimeMs ?? event.timestampMs,
        wallet: event.wallet,
        tokenMint: event.tokenMint,
        type: reliable ? classification.classification : "UNKNOWN",
        amountUsd: amountUsd ?? 0,
        amountTokens: Math.max(0, Number(event.amountTokens)),
        symbol: meta.symbol,
        marketCapUsd: meta.marketCapUsd,
        liquidityUsd: meta.liquidityUsd,
        tokenCreatedAtMs: meta.pairCreatedAtMs,
        classificationReliable: reliable,
        metadata: {
          ...convictionEventMetadata(event),
          side: "sell",
          proceedsMint: event.sellAttribution?.proceedsMint,
          valuationObservedAtMs,
          marketDataObservedAtMs,
        },
      },
      event,
      isFreshAutomaticAction(event, 15_000),
    );
  }

  async function observeConvictionTransfers(event: TransferEvent): Promise<void> {
    if (automaticEntryStrategy(cfg) !== "conviction") return;
    const rows = classifyConvictionTransfers(event, targetWallets);
    for (const row of rows) {
      if (row.classification === "UNKNOWN") continue;
      await observeConvictionEvent(
        {
          eventId: convictionEventIdentity(
            event,
            `${row.fromWallet}:${row.toWallet}:${row.classification}`,
          ),
          timestampMs: event.blockTimeMs ?? event.timestampMs,
          wallet: targetWallets.has(row.fromWallet) ? row.fromWallet : row.toWallet,
          tokenMint: event.tokenMint,
          type: row.classification,
          amountUsd: 0,
          amountTokens: Math.max(0, Number(row.amountTokens)),
          fromWallet: row.fromWallet,
          toWallet: row.toWallet,
          classificationReliable: row.reliable,
          metadata: convictionEventMetadata(event),
        },
        event,
        false,
      );
    }
  }

  async function executeConvictionAction(
    action: ConvictionRuntimeAction,
    sourceEvent: FeedEvent,
  ): Promise<void> {
    const event = sourceEvent.kind === "swap" ? sourceEvent : null;
    if (!event || event.side !== "buy") {
      await convictionRuntime.transitionAction(action.claim, {
        status: "failed_pre_submit",
        errorCode: "non-buy-conviction-action",
      });
      return;
    }

    await tradeExecutionQueue.run(event.tokenMint, async () => {
      const monitoringGate = currentEntryMonitoringGate();
      const initialGate = evaluateConvictionLiveExecutionGate({
        strategy: automaticEntryStrategy(cfg),
        tradingMode: cfg.conviction_trading_mode === "live" ? "live" : "shadow",
        entriesEnabled: cfg.enabled === true,
        monitoringBlocked: monitoringGate.blocked,
        fresh: isFreshAutomaticAction(event, 15_000),
        uncertainEntry: uncertainEntryMints.has(event.tokenMint),
        existingExposureUsd: 0,
        requestedBuyUsd: action.claim.amountUsd,
        maxExposureUsd: Math.max(0, Number(cfg.conviction_max_position_per_token_usd)),
      });
      if (!initialGate.allowed) {
        const reason = initialGate.reason;
        await convictionRuntime.transitionAction(action.claim, {
          status: "failed_pre_submit",
          errorCode: reason,
        });
        log.warn(
          { event: "CONVICTION_TRADE_SKIPPED", mint: event.tokenMint, reason },
          "Conviction live tier cancelled at a final safety gate",
        );
        return;
      }

      const { data: openPosition, error: openPositionError } = await db
        .from("positions")
        .select(
          "id,amount_tokens,amount_remaining,entry_price_usd,root_buy_count,entry_tx_sig,entry_slot,entry_mode",
        )
        .eq("user_id", cfg.user_id)
        .eq("token_mint", event.tokenMint)
        .is("closed_at", null)
        .limit(1)
        .maybeSingle();
      if (openPositionError) {
        await convictionRuntime.transitionAction(action.claim, {
          status: "failed_pre_submit",
          errorCode: safeDiagnostic(openPositionError),
        });
        throw new Error(
          `Conviction open-position check failed: ${safeDiagnostic(openPositionError)}`,
        );
      }

      const existingExposureUsd = openPosition
        ? Math.max(
            0,
            Number(openPosition.amount_remaining) * Number(openPosition.entry_price_usd ?? 0),
          )
        : 0;
      if (openPosition) {
        const { data: activeSellClaim, error: activeSellClaimError } = await db
          .from("sell_signal_claims")
          .select("id")
          .eq("position_id", openPosition.id)
          .in("status", ["claimed", "submitted", "uncertain"])
          .limit(1)
          .maybeSingle();
        if (activeSellClaimError) {
          await convictionRuntime.transitionAction(action.claim, {
            status: "failed_pre_submit",
            errorCode: "sell-claim-safety-check-failed",
          });
          throw new Error(
            `Conviction sell-claim safety check failed: ${safeDiagnostic(activeSellClaimError)}`,
          );
        }
        if (activeSellClaim || exitsInFlight.has(openPosition.id)) {
          await convictionRuntime.transitionAction(action.claim, {
            status: "failed_pre_submit",
            errorCode: "position-exit-in-progress",
          });
          await convictionRuntime.setPositionUsd(event.tokenMint, existingExposureUsd);
          return;
        }
      }
      const maxExposureUsd = Math.max(0, Number(cfg.conviction_max_position_per_token_usd));
      const exposureGate = evaluateConvictionLiveExecutionGate({
        strategy: automaticEntryStrategy(cfg),
        tradingMode: cfg.conviction_trading_mode === "live" ? "live" : "shadow",
        entriesEnabled: cfg.enabled === true,
        monitoringBlocked: currentEntryMonitoringGate().blocked,
        fresh: isFreshAutomaticAction(event, 15_000),
        uncertainEntry: uncertainEntryMints.has(event.tokenMint),
        existingExposureUsd,
        requestedBuyUsd: action.claim.amountUsd,
        maxExposureUsd,
      });
      if (!exposureGate.allowed) {
        await convictionRuntime.transitionAction(action.claim, {
          status: "failed_pre_submit",
          errorCode: exposureGate.reason,
        });
        await convictionRuntime.setPositionUsd(event.tokenMint, existingExposureUsd);
        return;
      }

      let secret: string | null;
      try {
        secret = await loadSigner(cfg.user_id);
      } catch (err) {
        await convictionRuntime.transitionAction(action.claim, {
          status: "failed_pre_submit",
          errorCode: safeDiagnostic(err),
        });
        throw err;
      }
      if (!secret) {
        await convictionRuntime.transitionAction(action.claim, {
          status: "failed_pre_submit",
          errorCode: "funding-key-unavailable",
        });
        return;
      }
      const solPrice = await priceUsd(WSOL);
      if (solPrice === undefined) {
        await convictionRuntime.transitionAction(action.claim, {
          status: "failed_pre_submit",
          errorCode: "sol-price-unavailable",
        });
        return;
      }
      const amountLamports = Math.floor((action.claim.amountUsd / solPrice) * 1e9);
      if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0) {
        await convictionRuntime.transitionAction(action.claim, {
          status: "failed_pre_submit",
          errorCode: "invalid-buy-size",
        });
        return;
      }

      // Keep the tier in `claimed` while the executor performs local quote and
      // transaction construction. The executor's last callback atomically
      // revalidates the live score/rank/distribution state and advances the
      // durable row to `submitted` immediately before its first network send.
      if (
        automaticEntryStrategy(cfg) !== "conviction" ||
        entryConfigTransitioning ||
        cfg.conviction_trading_mode !== "live" ||
        !cfg.enabled ||
        currentEntryMonitoringGate().blocked
      ) {
        await convictionRuntime.transitionAction(action.claim, {
          status: "failed_pre_submit",
          errorCode: "final-safety-gate",
        });
        return;
      }

      uncertainEntryMints.add(event.tokenMint);
      log.info(
        {
          event: "CONVICTION_TRADE_EXECUTED",
          phase: "pre-submit",
          mint: event.tokenMint,
          tier: action.claim.tierNumber,
          amountUsd: action.claim.amountUsd,
          score: action.snapshot.convictionScore,
          route: cfg.execution_route,
        },
        "preparing live Conviction tier buy; final runtime authorization is still required",
      );

      let result: ExecuteResult;
      try {
        result = await executeSwap({
          signerSecret: secret,
          inputMint: WSOL,
          outputMint: event.tokenMint,
          amountLamports,
          // Memecoins move fast; 3% slippage caused ~40% of coordinated buys to
          // revert with Jupiter 6001 (slippage exceeded). 8% cuts those reverts.
          slippageBps: 800,
          route: cfg.execution_route,
          jitoTipSol: cfg.jito_tip_sol,
          outputDecimals: event.decimals,
          beforeSubmit: async () => {
            if (
              cfg.enabled !== true ||
              entryConfigTransitioning ||
              automaticEntryStrategy(cfg) !== "conviction" ||
              cfg.conviction_trading_mode !== "live" ||
              currentEntryMonitoringGate().blocked
            ) {
              return false;
            }
            const authorization = await convictionRuntime.authorizeLiveClaimForSubmission(
              action.claim,
              {
                nowMs: Date.now(),
                globalEntriesEnabled: cfg.enabled === true,
                currentPositionUsd: existingExposureUsd,
                maxSourceEventAgeMs: 15_000,
              },
            );
            if (!authorization.allowed) {
              log.warn(
                {
                  event: "CONVICTION_TRADE_SKIPPED",
                  mint: event.tokenMint,
                  tier: action.claim.tierNumber,
                  reasons: authorization.reasons,
                },
                "Conviction tier no longer qualifies at the network submission boundary",
              );
            }
            // The durable claimed -> submitted update above is asynchronous.
            // Re-read process-local gates after it completes so Entries OFF,
            // a mode change, stale source data, or monitoring degradation that
            // happened during the database round trip still cancels before the
            // executor begins its network request.
            return (
              authorization.allowed &&
              cfg.enabled === true &&
              !entryConfigTransitioning &&
              automaticEntryStrategy(cfg) === "conviction" &&
              cfg.conviction_trading_mode === "live" &&
              isFreshAutomaticAction(event, 15_000) &&
              !currentEntryMonitoringGate().blocked
            );
          },
        });
      } catch (err) {
        const disposition = entryClaimFailureDisposition(err);
        await convictionRuntime.transitionAction(action.claim, {
          status: disposition.status,
          botTxSig: disposition.botTxSig,
          errorCode: safeDiagnostic(err),
        });
        if (disposition.status !== "uncertain") uncertainEntryMints.delete(event.tokenMint);
        throw err;
      }

      await convictionRuntime.transitionAction(action.claim, {
        status: "landed",
        botTxSig: result.txSig,
        receivedTokens: result.outUiAmount,
      });
      const receivedUi = Math.max(0, Number(result.outUiAmount ?? 0));
      const entryPrice =
        receivedUi > 0
          ? action.claim.amountUsd / receivedUi
          : ((await priceUsd(event.tokenMint)) ?? 0);
      const positionId = openPosition?.id ?? action.claim.plannedPositionId;
      if (!positionId) {
        throw new SubmissionUncertainError({
          route: result.route,
          txSig: result.txSig,
          detail: "Conviction buy landed without a planned position identity",
        });
      }
      const newAmount = Number(openPosition?.amount_remaining ?? 0) + receivedUi;
      const newTotalAmount = Number(openPosition?.amount_tokens ?? 0) + receivedUi;
      const newCostBasis = existingExposureUsd + action.claim.amountUsd;
      const blendedEntryPrice = newAmount > 0 ? newCostBasis / newAmount : entryPrice;
      const targetBuyAt = new Date(event.timestampMs).toISOString();
      const { data: savedPosition, error: positionError } = await db
        .from("positions")
        .upsert(
          {
            id: positionId,
            user_id: cfg.user_id,
            token_mint: event.tokenMint,
            entry_price_usd: blendedEntryPrice,
            amount_tokens: newTotalAmount,
            amount_remaining: newAmount,
            decimals: event.decimals,
            entry_tx_sig: openPosition?.entry_tx_sig ?? result.txSig,
            entry_slot: openPosition?.entry_slot ?? event.slot,
            // Conviction is an entry selector, not an exit-mode rewrite. Keep
            // the original exit semantics when scaling an existing position.
            entry_mode: openPosition?.entry_mode ?? "regular",
            last_root_buy_at: targetBuyAt,
            last_root_buy_wallet: event.wallet,
            root_buy_count: Math.max(
              1,
              Number(openPosition?.root_buy_count ?? 0),
              action.snapshot.walletsThatBought.length,
            ),
          },
          { onConflict: "id" },
        )
        .select("id")
        .maybeSingle();
      if (positionError || !savedPosition) {
        throw new SubmissionUncertainError({
          route: result.route,
          txSig: result.txSig,
          detail: `Conviction buy landed but position persistence failed: ${safeDiagnostic(positionError ?? "missing position")}`,
        });
      }

      // The trade row is the exact crash-recovery evidence for scale-ins,
      // whose transaction signature is intentionally not the position's
      // original entry signature. Save it before fallible monitoring/linkage
      // side effects and before marking the tier persisted.
      const { data: priorTrade, error: priorTradeError } = await db
        .from("trades")
        .select("position_id")
        .eq("user_id", cfg.user_id)
        .eq("tx_sig", result.txSig)
        .eq("side", "buy")
        .maybeSingle();
      if (priorTradeError) {
        throw new SubmissionUncertainError({
          route: result.route,
          txSig: result.txSig,
          detail: `Conviction buy landed but trade recovery lookup failed: ${safeDiagnostic(priorTradeError)}`,
        });
      }
      if (priorTrade && priorTrade.position_id !== savedPosition.id) {
        throw new SubmissionUncertainError({
          route: result.route,
          txSig: result.txSig,
          detail: "Conviction buy transaction is already linked to a different position",
        });
      }
      if (!priorTrade) {
        const { error: tradeError } = await db.from("trades").insert({
          user_id: cfg.user_id,
          position_id: savedPosition.id,
          side: "buy",
          token_mint: event.tokenMint,
          amount_tokens: receivedUi,
          amount_usd: action.claim.amountUsd,
          tx_sig: result.txSig,
          reason: `Conviction Mode tier ${action.claim.tierNumber ?? action.claim.tierId}`,
          latency_ms: result.latencyMs,
          route: result.route,
        });
        if (tradeError) {
          const { data: recoveredTrade, error: recoveryError } = await db
            .from("trades")
            .select("position_id")
            .eq("user_id", cfg.user_id)
            .eq("tx_sig", result.txSig)
            .eq("side", "buy")
            .maybeSingle();
          if (recoveryError || recoveredTrade?.position_id !== savedPosition.id) {
            throw new SubmissionUncertainError({
              route: result.route,
              txSig: result.txSig,
              detail: `Conviction buy landed but its trade record could not be confirmed: ${safeDiagnostic(recoveryError ?? tradeError)}`,
            });
          }
        }
      }

      await convictionRuntime.transitionAction(action.claim, {
        status: "landed",
        botTxSig: result.txSig,
        positionId: savedPosition.id,
        receivedTokens: receivedUi,
      });

      // Make the landed buy's exposure authoritative before replaying any
      // buffered terminal outflow. A nested exit updates exposure again; it
      // must be the last writer instead of being overwritten below with this
      // pre-exit cost basis.
      await convictionRuntime.setPositionUsd(event.tokenMint, newCostBasis);

      await monitor.onCopyBuy({
        positionId: savedPosition.id,
        tokenMint: event.tokenMint,
        targetWallet: event.wallet,
        entrySlot: event.slot > 0 ? event.slot : undefined,
      });
      for (const wallet of action.snapshot.walletsThatBought) {
        if (targetWallets.has(wallet)) {
          // Conviction selects the entry; the target-position relationship is
          // still an ordinary source-entry link used by the existing exits.
          await linkTargetToPosition(savedPosition.id, wallet, "entry", targetBuyAt);
        }
      }
      if (!openPosition) {
        for (const transfer of pendingTransfers.drainForLandedBuy(event.tokenMint, event.slot)) {
          const classifiedPending = await classifyTransferRecipients(transfer);
          for (const recipient of classifiedPending) {
            if (!recipient.track) continue;
            await monitor.recordTransfer(
              savedPosition.id,
              recipient.wallet,
              recipient.amountTokens,
              {
                hopDepth: 1,
                parentWallet: transfer.from,
                txSig: transfer.txSig,
                slot: transfer.slot,
                triggerEligible: Boolean(recipient.triggerEligible),
              },
            );
          }
          await handleTargetTerminalOutflows(
            transfer,
            {
              positionId: savedPosition.id,
              tokenMint: event.tokenMint,
              targetWallet: event.wallet,
              entrySlot: event.slot > 0 ? event.slot : undefined,
            },
            classifiedPending,
            true,
          );
        }
      }
      await convictionRuntime.transitionAction(action.claim, {
        status: "persisted",
        botTxSig: result.txSig,
        positionId: savedPosition.id,
        receivedTokens: receivedUi,
      });
      uncertainEntryMints.delete(event.tokenMint);

      const { error: tradedError } = await db
        .from("traded_tokens")
        .upsert({ user_id: cfg.user_id, token_mint: event.tokenMint });
      if (tradedError) {
        log.error(
          { err: safeDiagnostic(tradedError), mint: event.tokenMint },
          "Conviction buy landed but traded-token history save failed",
        );
      }
      recordStrategyDecision(
        event,
        "copied",
        `live Conviction tier ${action.claim.tierNumber ?? action.claim.tierId} landed`,
        {
          position_id: savedPosition.id,
          bot_tx_sig: result.txSig,
          execution_ms: result.latencyMs,
          reaction_ms: strategyReactionMs(event, Date.now(), result.latencyMs),
          metadata: {
            entryMode: "conviction",
            tier: action.claim.tierNumber,
            score: action.snapshot.convictionScore,
            configuredBuyUsd: action.claim.amountUsd,
          },
        },
      );
    });
  }

  async function handleTargetBuy(event: SwapEvent) {
    if (event.tokenMint === WSOL || STABLECOIN_MINTS.has(event.tokenMint)) {
      recordStrategyDecision(event, "skipped", "output is SOL or a stablecoin");
      return;
    }
    const transactionId = event.txSig || `slot-${event.slot}`;
    const dedupeKey = `${event.wallet}:${transactionId}:${event.tokenMint}`;

    // Recovered buys must still reset target inactivity and repair target
    // linkage/history. Only the entry action is freshness-gated.
    await targetBuyActivityAccounting.getOrCreate(dedupeKey, () =>
      recordOpenPositionTargetBuy(event),
    );
    const firstBuy = await targetFirstBuyAccounting.getOrCreate(dedupeKey, () =>
      observeTargetFirstBuy(event.wallet, event.tokenMint),
    );
    const freshForAutomaticEntry = isFreshAutomaticAction(event, 15_000);
    if (!freshForAutomaticEntry && automaticEntryStrategy(cfg) !== "conviction") {
      recordStrategyDecision(event, "tracked", "historical target buy recovered without entry", {
        metadata: {
          delivery: event.delivery ?? "live",
          stale: true,
          firstBuy,
        },
      });
      return;
    }

    if (event.inferredRecipients?.length) {
      const recipientChecks = await Promise.all(
        event.inferredRecipients.map((recipient) => isEligibleFollowerRecipient(recipient)),
      );
      if (recipientChecks.some((eligible) => !eligible)) {
        log.info(
          {
            wallet: event.wallet,
            mint: event.tokenMint,
            txSig: event.txSig,
            recipientCount: event.inferredRecipients.length,
          },
          "inferred target buy rejected — output recipient is not an eligible external wallet",
        );
        recordStrategyDecision(
          event,
          "skipped",
          "inferred output recipient is program controlled, off-curve, or unavailable",
        );
        if (automaticEntryStrategy(cfg) === "conviction") {
          const meta = await loadTokenMeta(event.tokenMint);
          await observeConvictionBuy(event, meta, undefined, false);
        }
        return;
      }
    }

    const valuation = await resolveTargetBuyValue(event, {
      quoteTokenSpendUsd,
      solPriceUsd: () => priceUsd(WSOL),
    });
    const valuationObservedAtMs = Date.now();
    const targetBuyUsd = valuation.amountUsd;
    event.amountUsd = targetBuyUsd;
    recordStrategyEvent(event, {
      amount_usd: targetBuyUsd,
      metadata: {
        valuationSource: valuation.source,
        inputMint: event.spentToken?.mint,
        valuationObservedAtMs,
      },
    });
    log.info(
      {
        wallet: event.wallet,
        mint: event.tokenMint,
        txSig: event.txSig,
        valuationSource: valuation.source,
        targetBuyUsd: targetBuyUsd === undefined ? "unknown" : Number(targetBuyUsd.toFixed(2)),
        inputMint: event.spentToken?.mint,
      },
      "target buy value resolved",
    );

    const entryStrategy = automaticEntryStrategy(cfg);
    if (entryStrategy === "conviction") {
      const meta = await loadTokenMeta(event.tokenMint);
      const marketDataObservedAtMs = Date.now();
      const actionable = freshForAutomaticEntry;
      await observeConvictionBuy(event, meta, targetBuyUsd, actionable);
      recordStrategyDecision(
        event,
        "tracked",
        targetBuyUsd === undefined
          ? "Conviction observed an unvalued target buy; no automatic tier is eligible"
          : cfg.conviction_trading_mode === "live"
            ? "Conviction Mode evaluated this target buy in live mode"
            : "Conviction Mode evaluated this target buy in shadow mode; no transaction sent",
        {
          market_cap_usd: meta.marketCapUsd,
          liquidity_usd: meta.liquidityUsd,
          amount_usd: targetBuyUsd,
          metadata: {
            entryMode: "conviction",
            tradingMode: cfg.conviction_trading_mode,
            actionable,
            valuationObservedAtMs,
            marketDataObservedAtMs,
          },
        },
      );
      return;
    }

    const requiresKnownValue =
      entryStrategy === "coordinated" ? true : Number(cfg.min_target_buy_usd) > 0;
    if (requiresKnownValue && targetBuyUsd === undefined) {
      log.info(
        { wallet: event.wallet, mint: event.tokenMint, txSig: event.txSig },
        "target buy value unavailable — waiting for a richer duplicate observation",
      );
      recordStrategyDecision(event, "filtered", "target buy size unavailable", {
        metadata: { valuationSource: valuation.source },
      });
      return;
    }

    if (!targetBuyDeduper.claim(dedupeKey, event.timestampMs)) {
      log.info(
        { wallet: event.wallet, mint: event.tokenMint, txSig: event.txSig },
        "duplicate target buy observation ignored",
      );
      return;
    }

    // A proven pre-submission failure may be retried by the other feed. Once a
    // submission is possible or uncertain, retain the claim to prevent a
    // duplicate purchase.
    try {
      await processTargetBuy(event, targetBuyUsd, firstBuy);
    } catch (err) {
      if (!uncertainEntryMints.has(event.tokenMint)) {
        targetBuyDeduper.release(dedupeKey);
      }
      throw err;
    }
  }

  async function processTargetBuy(
    event: SwapEvent,
    targetBuyUsd: number | undefined,
    firstBuy: boolean,
  ) {
    const entryStrategy = automaticEntryStrategy(cfg);
    if (entryStrategy === "conviction") {
      log.warn(
        { mint: event.tokenMint },
        "legacy target-buy path blocked by the exclusive Conviction strategy router",
      );
      return;
    }
    if (!cfg.enabled) {
      log.info(
        { wallet: event.wallet, mint: event.tokenMint },
        "entries off — target buy observed but not copied",
      );
      recordStrategyDecision(event, "skipped", "new entries disabled");
      return;
    }

    // Accumulate the target's USDC commitment for this mint (conviction signal).
    if (targetBuyUsd !== undefined) {
      addTargetConvictionUsd(event.tokenMint, targetBuyUsd, event.timestampMs);
    }

    if (entryStrategy === "regular") {
      await tryCopyBuy(event, "target copy buy", {
        entryMode: "regular",
        firstBuy,
        targetBuyUsd,
      });
      return;
    }

    const observation: TargetBuyObservation = {
      wallet: event.wallet,
      tokenMint: event.tokenMint,
      amountUsd: targetBuyUsd,
      firstBuy,
      timestampMs: event.timestampMs,
      txSig: event.txSig,
      slot: event.slot,
      decimals: event.decimals,
    };
    const coordination = coordinatedBuys.record(cfg, observation);
    if (!coordination.ready) {
      log.info(
        {
          wallet: event.wallet,
          mint: event.tokenMint,
          reason: coordination.reason,
          qualifyingWallets: coordination.qualifyingWallets,
          requiredWallets: cfg.coordinated_target_wallet_count,
        },
        "coordinated buy waiting / filtered",
      );
      recordStrategyDecision(
        event,
        coordination.reason.startsWith("waiting for") ? "tracked" : "filtered",
        coordination.reason,
        {
          metadata: {
            entryMode: "coordinated",
            qualifyingWallets: coordination.qualifyingWallets,
            requiredWallets: cfg.coordinated_target_wallet_count,
          },
        },
      );
      return;
    }

    await tryCopyBuy(event, `coordinated ${coordination.observations.length}-wallet copy buy`, {
      entryMode: "coordinated",
      firstBuy,
      targetBuyUsd,
      coordinatedWallets: coordination.observations.map((row) => row.wallet),
    });
  }

  async function handleTransfer(ev: TransferEvent) {
    const ctx = monitor.activeForMint(ev.tokenMint);
    const recipients = transferRecipients(ev);
    if (ctx?.entrySlot && ev.slot > 0 && ev.slot < ctx.entrySlot) {
      for (const recipient of recipients) {
        recordStrategyDecision(
          transferEventForRecipient(ev, recipient),
          "tracked",
          "historical transfer predates the copied position",
          { position_id: ctx.positionId, metadata: { stale: true } },
        );
      }
      return;
    }
    const classified = await classifyTransferRecipients(ev);
    if (classified.length === 0) return;

    if (ctx && cfg.crew_exit_enabled === true) {
      await maybeExecuteCrewWalletExit(
        ev,
        ctx,
        classified.map((recipient) => recipient.wallet),
      ).catch((err) =>
        log.error({ err: safeDiagnostic(err) }, "crew-wallet exit attempt failed safely"),
      );
    }


    if (!targetWallets.has(ev.from)) {
      if (ctx) {
        const state = await monitor.recordChainedTransferBatch(ev.tokenMint, ev.from, classified, {
          txSig: ev.txSig,
          slot: ev.slot,
        });
        const trackedWallets = new Set(state.trackedWallets);
        const terminalWallets = new Set(state.terminalWallets);
        for (const recipient of classified) {
          const child = transferEventForRecipient(ev, recipient);
          if (trackedWallets.has(recipient.wallet)) {
            recordStrategyDecision(
              child,
              state.duplicate ? "skipped" : "tracked",
              state.duplicate
                ? "duplicate follower transfer batch ignored"
                : "follower transfer retained atomically",
              { position_id: ctx.positionId, metadata: { hopDepth: state.hopDepth } },
            );
          } else if (terminalWallets.has(recipient.wallet)) {
            recordStrategyDecision(child, "tracked", "untrackable follower outflow retained", {
              position_id: ctx.positionId,
              metadata: {
                hopDepth: state.hopDepth,
                destinationClass:
                  (state.hopDepth ?? 0) > 5 ? "hop_limit" : recipient.destinationClass,
              },
            });
          } else {
            recordStrategyDecision(
              child,
              "skipped",
              state.reason ?? "follower transfer batch was not attributable",
              { position_id: ctx.positionId },
            );
          }
        }
        if ((state.applied || state.duplicate) && state.terminalAmount > 0) {
          await maybeExecuteTerminalBatchExit(ev, ctx, state);
        }
      } else {
        for (const recipient of classified) {
          recordStrategyDecision(
            transferEventForRecipient(ev, recipient),
            "skipped",
            "no active copied position for transfer",
          );
        }
      }
      return;
    }

    if (ctx) {
      for (const recipient of classified) {
        const child = transferEventForRecipient(ev, recipient);
        if (!recipient.track) {
          log.info(
            { from: ev.from, to: recipient.wallet, mint: ev.tokenMint, txSig: ev.txSig },
            "program-controlled or off-curve target recipient excluded from follower monitoring",
          );
          recordStrategyDecision(child, "tracked", "terminal target transfer observed", {
            position_id: ctx.positionId,
          });
          continue;
        }
        const tracked = await monitor.recordTransfer(
          ctx.positionId,
          recipient.wallet,
          recipient.amountTokens,
          {
            hopDepth: 1,
            parentWallet: ev.from,
            txSig: ev.txSig,
            slot: ev.slot,
            triggerEligible: recipient.triggerEligible,
          },
        );
        recordStrategyDecision(
          child,
          tracked ? "tracked" : "skipped",
          tracked ? "target transfer wallet retained" : "duplicate target transfer ignored",
          { position_id: ctx.positionId },
        );
      }
      await handleTargetTerminalOutflows(ev, ctx, classified);
      return;
    }

    // Preserve the complete target batch, including terminal-only recipients.
    // If the matching copied entry lands, every custody observation is written;
    // any optional action is still independently linked/fresh/health gated.
    const buffered = pendingTransfers.add(ev);
    log.info(
      { from: ev.from, recipientCount: classified.length, mint: ev.tokenMint, buffered },
      "target transfer held pending a possible landed copy entry",
    );
    for (const recipient of classified) {
      recordStrategyDecision(
        transferEventForRecipient(ev, recipient),
        "tracked",
        !recipient.track
          ? buffered
            ? "terminal target transfer buffered pending an entry"
            : "duplicate pending terminal target transfer ignored"
          : buffered
            ? "target transfer buffered pending an entry"
            : "duplicate pending target transfer ignored",
      );
    }
  }

  async function handleTargetTerminalOutflows(
    ev: TransferEvent,
    ctx: { positionId: string; tokenMint: string; targetWallet: string; entrySlot?: number },
    recipients: ClassifiedTransferRecipient[],
    tradeLockHeld = false,
  ) {
    const terminalRecipients = recipients.filter((recipient) => !recipient.track);
    if (terminalRecipients.length === 0) return;

    const { data: linked, error: linkError } = await db
      .from("position_target_wallets")
      .select("wallet")
      .eq("position_id", ctx.positionId)
      .eq("wallet", ev.from)
      .maybeSingle();
    if (linkError) {
      throw new Error(`target custody link lookup failed: ${safeDiagnostic(linkError)}`);
    }
    const sourceLinked = Boolean(linked);
    for (const recipient of terminalRecipients) {
      const { error } = await db.from("target_outflow_observations").upsert(
        {
          user_id: cfg.user_id,
          position_id: ctx.positionId,
          source_wallet: ev.from,
          destination_wallet: recipient.wallet,
          token_mint: ev.tokenMint,
          amount_tokens: recipient.amountTokens,
          destination_class: recipient.destinationClass,
          source_linked: sourceLinked,
          tx_sig: ev.txSig || `slot-${ev.slot}`,
          slot: ev.slot,
        },
        { onConflict: "position_id,tx_sig,source_wallet,destination_wallet,token_mint" },
      );
      if (error) {
        throw new Error(`target custody observation failed: ${safeDiagnostic(error)}`);
      }
    }

    const confirmedTerminalAmount = terminalRecipients
      .filter((recipient) => recipient.destinationClass === "program_or_off_curve")
      .reduce((sum, recipient) => sum + recipient.amountTokens, 0);
    const exitPct = targetTerminalOutflowExitPct({
      enabled: Boolean(cfg.target_terminal_outflow_exit_enabled),
      configuredPct: Number(cfg.target_terminal_outflow_exit_pct),
      sourceLinked,
      fresh: isFreshAutomaticAction(ev, 120_000),
      classificationSucceeded: confirmedTerminalAmount > 0,
      terminalAmount: confirmedTerminalAmount,
    });
    log.warn(
      {
        positionId: ctx.positionId,
        sourceLinked,
        terminalRecipientCount: terminalRecipients.length,
        confirmedTerminalAmount,
        automaticExitEnabled: cfg.target_terminal_outflow_exit_enabled,
      },
      "linked target custody transfer observed — deposit is not proof of a sale",
    );
    if (exitPct <= 0) return;
    const monitoringGate = currentEntryMonitoringGate();
    if (monitoringGate.blocked) {
      log.warn(
        { positionId: ctx.positionId, reasons: monitoringGate.reasons },
        "target custody auto-exit blocked by monitoring safety gate",
      );
      recordStrategyDecision(
        ev,
        "tracked",
        `target custody auto-exit blocked: ${monitoringGate.reasons.join("; ")}`,
        { position_id: ctx.positionId },
      );
      return;
    }

    const { data: pos, error: positionError } = await db
      .from("positions")
      .select("id,token_mint,amount_remaining,decimals,entry_slot")
      .eq("id", ctx.positionId)
      .is("closed_at", null)
      .maybeSingle();
    if (positionError) {
      throw new Error(`target custody position lookup failed: ${safeDiagnostic(positionError)}`);
    }
    if (
      !pos ||
      (Number(pos.entry_slot ?? 0) > 0 && ev.slot > 0 && ev.slot < Number(pos.entry_slot))
    ) {
      return;
    }
    await executeClaimedPercentageExit(
      pos.id,
      pos.token_mint,
      Number(pos.amount_remaining),
      Number(pos.decimals ?? 0),
      exitPct,
      "target_terminal_outflow",
      ev,
      "high-risk linked target custody-transfer response (deposit is not proof of sale)",
      {},
      tradeLockHeld,
    );
  }

  async function maybeExecuteCrewWalletExit(
    ev: TransferEvent,
    ctx: { positionId: string; tokenMint: string; targetWallet: string },
    recipientWallets: string[],
  ) {
    if (cfg.crew_exit_enabled !== true || crewWallets.size === 0) return;
    if (!isFreshAutomaticAction(ev, 120_000)) return;
    const crewHit = recipientWallets.find((wallet) => crewWallets.has(wallet));
    if (!crewHit) return;
    const monitoringGate = currentEntryMonitoringGate();
    if (monitoringGate.blocked) {
      log.warn(
        { positionId: ctx.positionId, reasons: monitoringGate.reasons },
        "crew-wallet auto-exit blocked by monitoring safety gate",
      );
      recordStrategyDecision(
        ev,
        "tracked",
        `crew-wallet auto-exit blocked: ${monitoringGate.reasons.join("; ")}`,
        { position_id: ctx.positionId },
      );
      return;
    }
    const { data: pos, error } = await db
      .from("positions")
      .select("id,token_mint,amount_remaining,decimals,entry_slot")
      .eq("id", ctx.positionId)
      .is("closed_at", null)
      .maybeSingle();
    if (error) throw new Error(`crew exit position lookup failed: ${safeDiagnostic(error)}`);
    if (
      !pos ||
      (Number(pos.entry_slot ?? 0) > 0 && ev.slot > 0 && ev.slot < Number(pos.entry_slot))
    ) {
      return;
    }
    log.info(
      { positionId: ctx.positionId, mint: ctx.tokenMint, crewWallet: crewHit, txSig: ev.txSig },
      "held token transferred to reused exit-desk wallet — firing crew exit",
    );
    await executeClaimedPercentageExit(
      pos.id,
      pos.token_mint,
      Number(pos.amount_remaining),
      Number(pos.decimals ?? 0),
      Number(cfg.crew_exit_pct ?? 100),
      "crew_wallet",
      ev,
      `supply moved to reused exit-desk wallet ${crewHit.slice(0, 8)}…`,
    );
  }

  async function maybeExecuteTerminalBatchExit(
    ev: TransferEvent,
    ctx: { positionId: string; tokenMint: string; targetWallet: string },
    state: ChainedTransferBatchState,
  ) {
    if (
      !cfg.terminal_outflow_exit_enabled ||
      !state.sourceTriggerEligible ||
      !isFreshAutomaticAction(ev, 120_000)
    ) {
      return;
    }
    const monitoringGate = currentEntryMonitoringGate();
    if (monitoringGate.blocked) {
      log.warn(
        { positionId: ctx.positionId, reasons: monitoringGate.reasons },
        "follower custody auto-exit blocked by monitoring safety gate",
      );
      recordStrategyDecision(
        ev,
        "tracked",
        `follower custody auto-exit blocked: ${monitoringGate.reasons.join("; ")}`,
        { position_id: ctx.positionId },
      );
      return;
    }

    const { data: pos, error } = await db
      .from("positions")
      .select("id,token_mint,amount_remaining,decimals,entry_slot")
      .eq("id", ctx.positionId)
      .is("closed_at", null)
      .maybeSingle();
    if (error) throw new Error(`terminal outflow position lookup failed: ${safeDiagnostic(error)}`);
    if (
      !pos ||
      (Number(pos.entry_slot ?? 0) > 0 && ev.slot > 0 && ev.slot < Number(pos.entry_slot))
    ) {
      return;
    }
    await executeClaimedPercentageExit(
      pos.id,
      pos.token_mint,
      Number(pos.amount_remaining),
      Number(pos.decimals ?? 0),
      Number(cfg.terminal_outflow_exit_pct),
      "terminal_outflow",
      ev,
      `defensive custody outflow from tracked follower`,
    );
  }

  async function handleDirectTargetSell(
    ev: SwapEvent,
    ctx: { positionId: string; tokenMint: string; targetWallet: string },
  ) {
    if (cfg.direct_target_sell_exit_mode === "off") {
      recordStrategyDecision(ev, "tracked", "direct target sell observed; response is off", {
        position_id: ctx.positionId,
      });
      return;
    }
    if (!ev.verifiedSwap || !ev.sellAttribution?.verified) {
      recordStrategyDecision(
        ev,
        "tracked",
        "ambiguous target outflow observed without verified sale",
        {
          position_id: ctx.positionId,
        },
      );
      return;
    }
    if (!isFreshAutomaticAction(ev, 120_000)) {
      recordStrategyDecision(ev, "tracked", "historical target sale recovered without execution", {
        position_id: ctx.positionId,
        metadata: { stale: true },
      });
      return;
    }

    const [{ data: linked, error: linkError }, { data: pos, error: positionError }] =
      await Promise.all([
        db
          .from("position_target_wallets")
          .select("wallet")
          .eq("position_id", ctx.positionId)
          .eq("wallet", ev.wallet)
          .maybeSingle(),
        db
          .from("positions")
          .select("id,token_mint,amount_remaining,decimals,entry_slot")
          .eq("id", ctx.positionId)
          .is("closed_at", null)
          .maybeSingle(),
      ]);
    if (linkError)
      throw new Error(`target-position link lookup failed: ${safeDiagnostic(linkError)}`);
    if (positionError) {
      throw new Error(
        `direct target sell position lookup failed: ${safeDiagnostic(positionError)}`,
      );
    }
    if (
      !pos ||
      (Number(pos.entry_slot ?? 0) > 0 && ev.slot > 0 && ev.slot < Number(pos.entry_slot))
    ) {
      recordStrategyDecision(ev, "skipped", "target sell predates or has no open linked position");
      return;
    }

    const sellAmount = computeTargetSellAmount({
      mode: cfg.direct_target_sell_exit_mode,
      verifiedSell: true,
      linkedToPosition: Boolean(linked),
      amountRemaining: Number(pos.amount_remaining),
      targetPreAmount: Number(ev.sellAttribution.tokenBalanceBefore),
      targetPostAmount: Number(ev.sellAttribution.tokenBalanceAfter),
      configuredPct: Number(cfg.direct_target_sell_exit_pct),
    });
    if (sellAmount <= 0) {
      recordStrategyDecision(
        ev,
        "tracked",
        linked
          ? "verified target sale required no exit"
          : "selling target is not linked to position",
        { position_id: pos.id },
      );
      return;
    }
    const sellPct = Math.min(100, (sellAmount / Number(pos.amount_remaining)) * 100);
    await executeClaimedPercentageExit(
      pos.id,
      pos.token_mint,
      Number(pos.amount_remaining),
      Number(pos.decimals ?? 0),
      sellPct,
      "direct_target_sell",
      ev,
      `verified linked target sell (${cfg.direct_target_sell_exit_mode})`,
    );
  }

  async function handleFollowerSell(ev: SwapEvent): Promise<void> {
    const ctx = monitor.activeForMint(ev.tokenMint);
    if (!ctx) {
      recordStrategyDecision(ev, "skipped", "no active copied position for this token");
      return;
    }
    if (targetWallets.has(ev.wallet)) {
      return handleDirectTargetSell(ev, ctx);
    }

    if (!ev.verifiedSwap || !ev.sellAttribution?.verified) {
      recordStrategyDecision(
        ev,
        "tracked",
        "ambiguous follower outflow observed without verified sale",
        {
          position_id: ctx.positionId,
        },
      );
      return;
    }

    const { data: positionTiming, error: positionTimingError } = await db
      .from("positions")
      .select("entry_slot")
      .eq("id", ctx.positionId)
      .is("closed_at", null)
      .maybeSingle();
    if (positionTimingError) {
      throw new Error(
        `follower sell entry-slot lookup failed: ${safeDiagnostic(positionTimingError)}`,
      );
    }
    if (
      !positionTiming ||
      (Number(positionTiming.entry_slot ?? 0) > 0 &&
        ev.slot > 0 &&
        ev.slot < Number(positionTiming.entry_slot))
    ) {
      recordStrategyDecision(ev, "skipped", "follower sale predates the copied position", {
        position_id: ctx.positionId,
      });
      return;
    }

    const freshForAutomaticExit = isFreshAutomaticAction(ev, 120_000);
    const sellState = await monitor.recordFollowerSell(ctx.positionId, ev.wallet, ev.amountTokens, {
      txSig: ev.txSig,
      slot: ev.slot,
      countAsDistinctSeller: freshForAutomaticExit,
    });
    if (sellState === null) {
      recordStrategyDecision(ev, "skipped", "sell wallet is not retained or event is duplicate", {
        position_id: ctx.positionId,
      });
      return;
    }
    if (!sellState.triggerEligible) {
      recordStrategyDecision(ev, "tracked", "observation-only follower sold beyond exit depth", {
        position_id: ctx.positionId,
      });
      return;
    }

    const { data: pos, error: posError } = await db
      .from("positions")
      .select(
        "id,token_mint,amount_tokens,amount_remaining,decimals,mirrored_sold_fraction,entry_mode,entry_slot,coordinated_exit_triggered,follower_seller_exit_triggered",
      )
      .eq("id", ctx.positionId)
      .maybeSingle();
    if (posError) {
      // Accounting is already durably committed. Throw so RPC catch-up does not
      // advance its cursor; the replay returns the stored sell snapshot and can
      // safely resume the downstream exit claim without debiting twice.
      throw new Error(`post-accounting position lookup failed: ${safeDiagnostic(posError)}`);
    }
    if (!pos) {
      recordStrategyDecision(ev, "failed", "active position could not be loaded", {
        position_id: ctx.positionId,
      });
      return;
    }
    if (Number(pos.entry_slot ?? 0) > 0 && ev.slot > 0 && ev.slot < Number(pos.entry_slot)) {
      recordStrategyDecision(ev, "skipped", "follower sale predates the copied position", {
        position_id: pos.id,
      });
      return;
    }
    // On a duplicate Geyser/RPC replay, use the freshness decision stored by
    // the atomic accounting event. Never upgrade a historical catch-up sell to
    // a live automatic exit merely because its duplicate arrived later.
    if (!sellState.freshForAction) {
      recordStrategyDecision(
        ev,
        "tracked",
        "historical follower sale recovered without execution",
        {
          position_id: pos.id,
          metadata: { stale: true, soldFraction: sellState.soldFraction },
        },
      );
      return;
    }

    if ((pos.entry_mode ?? "regular") === "coordinated") {
      if (pos.coordinated_exit_triggered) {
        recordStrategyDecision(ev, "tracked", "coordinated follower exit already triggered", {
          position_id: pos.id,
        });
        return;
      }
      if (
        !shouldTriggerDistinctSellerExit(
          sellState.distinctSellerCount,
          Number(cfg.coordinated_follower_sell_count),
          false,
        )
      ) {
        log.info(
          {
            positionId: pos.id,
            distinctSellerCount: sellState.distinctSellerCount,
            required: cfg.coordinated_follower_sell_count,
          },
          "coordinated follower exit waiting",
        );
        recordStrategyDecision(ev, "tracked", "waiting for coordinated follower-seller threshold", {
          position_id: pos.id,
          metadata: { distinctSellerCount: sellState.distinctSellerCount },
        });
        return;
      }
      const exitReason = `coordinated ${sellState.distinctSellerCount} distinct follower seller(s)`;
      await executeClaimedPercentageExit(
        pos.id,
        pos.token_mint,
        Number(pos.amount_remaining),
        Number(pos.decimals ?? 0),
        Number(cfg.coordinated_follower_sell_pct),
        "distinct_follower",
        ev,
        exitReason,
        {
          ...periodicSellIdentity(pos.id, "distinct_follower", "coordinated"),
          markCoordinatedExit: true,
        },
      );
      return;
    }

    if (cfg.follower_seller_exit_enabled && !pos.follower_seller_exit_triggered) {
      const thresholdReached = shouldTriggerDistinctSellerExit(
        sellState.distinctSellerCount,
        Number(cfg.follower_seller_exit_count),
        false,
      );
      if (!thresholdReached) {
        log.info(
          {
            positionId: pos.id,
            distinctSellerCount: sellState.distinctSellerCount,
            required: cfg.follower_seller_exit_count,
          },
          "main follower exit waiting",
        );
        recordStrategyDecision(ev, "tracked", "waiting for follower-seller threshold", {
          position_id: pos.id,
          metadata: { distinctSellerCount: sellState.distinctSellerCount },
        });
      } else {
        const exitReason = `main ${sellState.distinctSellerCount} distinct follower seller(s)`;
        await executeClaimedPercentageExit(
          pos.id,
          pos.token_mint,
          Number(pos.amount_remaining),
          Number(pos.decimals ?? 0),
          Number(cfg.follower_seller_exit_pct),
          "distinct_follower",
          ev,
          exitReason,
          {
            ...periodicSellIdentity(pos.id, "distinct_follower", "regular"),
            markFollowerSellerExit: true,
          },
        );
        return;
      }
    }

    if (!cfg.proportional_follower_sells) {
      recordStrategyDecision(
        ev,
        "tracked",
        "follower sell recorded; proportional mirroring is off",
        {
          position_id: pos.id,
        },
      );
      return;
    }

    const sellUi = proportionalMirrorSell(
      Number(pos.amount_tokens),
      Number(pos.amount_remaining),
      sellState.soldFraction,
    );
    if (sellUi <= 0) {
      recordStrategyDecision(ev, "tracked", "follower sell required no additional mirror amount", {
        position_id: pos.id,
      });
      return;
    }

    const decimals = Number(pos.decimals ?? 0);
    const sellRaw = Math.floor(sellUi * Math.pow(10, decimals));
    if (sellRaw <= 0) {
      recordStrategyDecision(ev, "tracked", "calculated mirror amount rounded to zero", {
        position_id: pos.id,
      });
      return;
    }

    log.info(
      { positionId: pos.id, soldFraction: sellState.soldFraction, sellUi, sellRaw },
      "mirroring follower sell",
    );
    await executeClaimedPercentageExit(
      pos.id,
      pos.token_mint,
      Number(pos.amount_remaining),
      decimals,
      Math.min(100, (sellUi / Math.max(Number(pos.amount_remaining), 1e-12)) * 100),
      "proportional_follower",
      ev,
      `mirror ${Math.round(sellState.soldFraction * 100)}% followers`,
      {
        exactSellUi: sellUi,
        mirroredSoldFraction: sellState.soldFraction,
      },
    );
  }

  async function tryCopyBuy(
    event: SwapEvent,
    reason = "target copy buy",
    options: CopyBuyOptions,
  ): Promise<string | null> {
    if (entryConfigTransitioning || automaticEntryStrategy(cfg) !== options.entryMode) {
      recordStrategyDecision(
        event,
        "skipped",
        "automatic entry strategy changed before this buy could be evaluated",
      );
      return null;
    }
    if (!cfg.enabled) {
      recordStrategyDecision(event, "skipped", "new entries disabled");
      return null;
    }
    const monitoringGate = currentEntryMonitoringGate();
    if (monitoringGate.blocked) {
      log.warn(
        { reasons: monitoringGate.reasons, mint: event.tokenMint },
        "new entry blocked by monitoring circuit breaker — exits remain active",
      );
      recordStrategyDecision(
        event,
        "skipped",
        `entry monitoring circuit breaker: ${monitoringGate.reasons.join("; ")}`,
      );
      return null;
    }
    return tradeExecutionQueue.run(event.tokenMint, () => tryCopyBuyLocked(event, reason, options));
  }

  async function tryCopyBuyLocked(
    event: SwapEvent,
    reason: string,
    options: CopyBuyOptions,
  ): Promise<string | null> {
    if (entryConfigTransitioning || automaticEntryStrategy(cfg) !== options.entryMode) {
      log.info(
        { mint: event.tokenMint, expectedStrategy: options.entryMode },
        "entry cancelled after queue wait — automatic strategy changed",
      );
      recordStrategyDecision(event, "skipped", "automatic entry strategy changed while queued");
      return null;
    }
    if (!cfg.enabled) {
      log.info(
        { mint: event.tokenMint, txSig: event.txSig },
        "entry cancelled after queue wait — Entries is OFF",
      );
      recordStrategyDecision(event, "skipped", "Entries turned off while entry was queued");
      return null;
    }
    const queuedMonitoringGate = currentEntryMonitoringGate();
    if (queuedMonitoringGate.blocked) {
      log.warn(
        { reasons: queuedMonitoringGate.reasons, mint: event.tokenMint },
        "entry cancelled after queue wait by monitoring circuit breaker — exits remain active",
      );
      recordStrategyDecision(
        event,
        "skipped",
        `entry monitoring circuit breaker after queue wait: ${queuedMonitoringGate.reasons.join("; ")}`,
      );
      return null;
    }
    if (uncertainEntryMints.has(event.tokenMint)) {
      log.error(
        { mint: event.tokenMint, txSig: event.txSig },
        "entry blocked — an earlier submission for this coin needs reconciliation",
      );
      recordStrategyDecision(event, "skipped", "coin quarantined after an uncertain submission");
      return null;
    }
    if (event.tokenMint === WSOL || STABLECOIN_MINTS.has(event.tokenMint)) {
      log.info(
        { mint: event.tokenMint, txSig: event.txSig },
        "target buy skipped — output is SOL/stablecoin, not a token entry",
      );
      recordStrategyDecision(event, "skipped", "output is SOL or a stablecoin");
      return null;
    }

    log.info(
      {
        target: event.wallet,
        coordinatedWallets: options.coordinatedWallets,
        entryMode: options.entryMode,
        mint: event.tokenMint,
        tokenAmount: event.amountTokens,
        solDelta: event.solDelta,
        txSig: event.txSig,
        reason,
      },
      "target buy candidate",
    );

    const { data: openPosition, error: openPositionError } = await db
      .from("positions")
      .select("id")
      .eq("user_id", cfg.user_id)
      .eq("token_mint", event.tokenMint)
      .is("closed_at", null)
      .limit(1)
      .maybeSingle();
    if (openPositionError)
      throw new Error(
        `open-position entry check failed: ${safeDiagnostic(openPositionError.message)}`,
      );
    if (openPosition) {
      log.info(
        { mint: event.tokenMint, positionId: openPosition.id },
        "entry skipped — position already open for coin",
      );
      recordStrategyDecision(event, "skipped", "a copied position for this token is already open", {
        position_id: openPosition.id,
      });
      return null;
    }

    const meta = await loadTokenMeta(event.tokenMint);
    const marketDataObservedAtMs = Date.now();
    const metaPatch: StrategyObservationPatch = {
      market_cap_usd: meta.marketCapUsd,
      liquidity_usd: meta.liquidityUsd,
      has_socials: Boolean(meta.socials.website || meta.socials.twitter || meta.socials.telegram),
      metadata: {
        entryMode: options.entryMode,
        pairCreatedAtMs: meta.pairCreatedAtMs,
        isPumpFun: meta.isPumpFun,
        firstBuy: options.firstBuy,
        marketDataObservedAtMs,
      },
    };
    recordStrategyEvent(event, metaPatch);
    const { data: prior, error: priorError } = await db
      .from("traded_tokens")
      .select("token_mint")
      .eq("user_id", cfg.user_id)
      .eq("token_mint", event.tokenMint)
      .maybeSingle();
    if (priorError)
      throw new Error(`traded-token lookup failed: ${safeDiagnostic(priorError.message)}`);

    const decision =
      options.entryMode === "coordinated"
        ? checkCoordinatedEntry(cfg, meta, Boolean(prior), event.timestampMs)
        : checkEntry(cfg, event, meta, { first: options.firstBuy, already: Boolean(prior) });
    if (!decision.pass) {
      log.info(
        {
          reason: decision.reason,
          entryMode: options.entryMode,
          mint: event.tokenMint,
          targetBuyUsd:
            options.targetBuyUsd === undefined ? "unknown" : options.targetBuyUsd.toFixed(2),
          meta,
        },
        "filtered",
      );
      recordStrategyDecision(event, "filtered", decision.reason, {
        ...metaPatch,
        amount_usd: options.targetBuyUsd,
        metadata: {
          ...metaPatch.metadata,
          alreadyTraded: Boolean(prior),
        },
      });
      return null;
    }

    {
      let secret: string | null = null;
      try {
        secret = await loadSigner(cfg.user_id);
      } catch (err) {
        log.error({ err: safeDiagnostic(err) }, "funding key decrypt failed for copy buy");
        recordStrategyDecision(event, "failed", "funding key could not be loaded", metaPatch);
        return null;
      }
      if (!secret) {
        log.error("no funding key saved for this config user");
        recordStrategyDecision(event, "failed", "funding key is not available", metaPatch);
        return null;
      }

      const solPrice = await priceUsd(WSOL);
      if (solPrice === undefined) {
        log.error({ mint: event.tokenMint }, "copy buy blocked — live SOL/USD price unavailable");
        recordStrategyDecision(event, "failed", "live SOL/USD price is unavailable", metaPatch);
        return null;
      }
      // Tiered coordinated sizing: when 3+ target wallets converge (his highest-
      // conviction tier), use the larger three-wallet buy size if configured.
      const coordinatedWalletCount = options.coordinatedWallets?.length ?? 0;
      const threeWalletBuyUsd = Number(cfg.coordinated_three_wallet_buy_usd ?? 0);
      const coordinatedBuyUsd =
        coordinatedWalletCount >= 3 && threeWalletBuyUsd > 0
          ? threeWalletBuyUsd
          : Number(cfg.coordinated_fixed_buy_usd);
      let buyUsd =
        options.entryMode === "coordinated" ? coordinatedBuyUsd : Number(cfg.fixed_buy_usd);
      // USDC-conviction gate + sizing (env-flagged, coordinated entries only):
      // skip coins the target has barely committed to, and size up as his
      // committed USDC rises. Leaves behaviour unchanged when the flag is off.
      if (env.USDC_CONVICTION_ENABLED && options.entryMode === "coordinated") {
        const hisUsd = targetConvictionUsdFor(event.tokenMint, Date.now());
        const minUsd = Number(env.USDC_CONVICTION_MIN_USD);
        if (hisUsd < minUsd) {
          log.info(
            { mint: event.tokenMint, targetUsdc: Math.round(hisUsd), minUsd },
            "conviction gate: skipped low-conviction coin",
          );
          recordStrategyDecision(
            event,
            "filtered",
            `conviction gate: target committed $${Math.round(hisUsd)} < $${minUsd}`,
            { ...metaPatch, amount_usd: options.targetBuyUsd },
          );
          return null;
        }
        const maxUsd = Number(env.USDC_CONVICTION_MAX_BUY_USD);
        const refUsd = Number(env.USDC_CONVICTION_REF_USD);
        if (maxUsd > buyUsd && refUsd > minUsd) {
          const t = Math.min(1, Math.max(0, (hisUsd - minUsd) / (refUsd - minUsd)));
          buyUsd = buyUsd + (maxUsd - buyUsd) * t;
        }
        log.info(
          { mint: event.tokenMint, targetUsdc: Math.round(hisUsd), sizedBuyUsd: Number(buyUsd.toFixed(2)) },
          "conviction gate: passed",
        );
      }
      const amountLamports = Math.floor((buyUsd / solPrice) * 1e9);
      if (!cfg.enabled) {
        log.info(
          { mint: event.tokenMint, txSig: event.txSig },
          "entry cancelled immediately before submission — Entries is OFF",
        );
        recordStrategyDecision(
          event,
          "skipped",
          "Entries turned off immediately before submission",
          metaPatch,
        );
        return null;
      }
      const submissionMonitoringGate = currentEntryMonitoringGate();
      if (submissionMonitoringGate.blocked) {
        log.warn(
          { reasons: submissionMonitoringGate.reasons, mint: event.tokenMint },
          "entry cancelled before submission by monitoring circuit breaker — exits remain active",
        );
        recordStrategyDecision(
          event,
          "skipped",
          `entry monitoring circuit breaker before submission: ${submissionMonitoringGate.reasons.join("; ")}`,
          metaPatch,
        );
        return null;
      }
      if (entryConfigTransitioning || automaticEntryStrategy(cfg) !== options.entryMode) {
        recordStrategyDecision(
          event,
          "skipped",
          "automatic entry strategy changed before the durable claim",
          metaPatch,
        );
        return null;
      }

      const entryClaim = await claimEntrySubmission(event, options.entryMode, amountLamports);
      if (!entryClaim) {
        recordStrategyDecision(
          event,
          "skipped",
          "an existing durable entry claim blocks another buy for this token",
          metaPatch,
        );
        return null;
      }
      uncertainEntryMints.add(event.tokenMint);
      await updateEntryClaim(entryClaim.id, {
        status: "submitted",
        submission_started_at: new Date().toISOString(),
        error_code: null,
      });

      // The durable claim/update calls above yield to the event loop. Config or
      // monitoring health may have changed during those awaits, so re-check at
      // the final boundary with no intervening await before executeSwap starts.
      const finalSubmissionGate = currentEntryMonitoringGate();
      const strategyChangedAfterClaim =
        entryConfigTransitioning || automaticEntryStrategy(cfg) !== options.entryMode;
      if (!cfg.enabled || finalSubmissionGate.blocked || strategyChangedAfterClaim) {
        const gateReason = strategyChangedAfterClaim
          ? "automatic entry strategy changed after the durable claim"
          : !cfg.enabled
            ? "Entries turned off after the durable claim"
            : `monitoring became unsafe after the durable claim: ${finalSubmissionGate.reasons.join("; ")}`;
        await updateEntryClaim(entryClaim.id, {
          status: "failed_pre_submit",
          error_code: strategyChangedAfterClaim
            ? "strategy-changed-after-claim"
            : !cfg.enabled
              ? "entries-disabled-after-claim"
              : "monitoring-degraded-after-claim",
        });
        uncertainEntryMints.delete(event.tokenMint);
        recordStrategyDecision(event, "skipped", gateReason, metaPatch);
        log.warn(
          { mint: event.tokenMint, reasons: finalSubmissionGate.reasons },
          "copy buy cancelled at the final submission safety gate",
        );
        return null;
      }
      log.info(
        {
          mint: event.tokenMint,
          buyUsd,
          entryMode: options.entryMode,
          solPrice,
          amountLamports,
          route: cfg.execution_route,
        },
        "submitting copy buy",
      );
      recordStrategyDecision(event, "copy_submitted", reason, {
        ...metaPatch,
        amount_usd: options.targetBuyUsd,
        metadata: {
          ...metaPatch.metadata,
          configuredBuyUsd: buyUsd,
          route: cfg.execution_route,
        },
      });

      let result: ExecuteResult;
      try {
        result = await executeSwap({
          signerSecret: secret,
          inputMint: WSOL,
          outputMint: event.tokenMint,
          amountLamports,
          // Memecoins move fast; 3% slippage caused ~40% of coordinated buys to
          // revert with Jupiter 6001 (slippage exceeded). 8% cuts those reverts.
          slippageBps: 800,
          route: cfg.execution_route,
          jitoTipSol: cfg.jito_tip_sol,
          outputDecimals: event.decimals,
          beforeSubmit: () =>
            cfg.enabled === true &&
            !entryConfigTransitioning &&
            automaticEntryStrategy(cfg) === options.entryMode &&
            !currentEntryMonitoringGate().blocked,
        });
      } catch (err) {
        const disposition = entryClaimFailureDisposition(err);
        await updateEntryClaim(entryClaim.id, {
          status: disposition.status,
          bot_tx_sig: disposition.botTxSig,
          error_code: safeDiagnostic(err),
        });
        const quarantined = disposition.status === "uncertain";
        if (!quarantined) uncertainEntryMints.delete(event.tokenMint);
        recordStrategyDecision(
          event,
          "failed",
          quarantined
            ? "copy landing is uncertain; coin quarantined"
            : "copy failed before submission; durable claim is retryable",
          {
            ...metaPatch,
            amount_usd: options.targetBuyUsd,
            reaction_ms: strategyReactionMs(event),
            metadata: {
              ...metaPatch.metadata,
              diagnostic: safeDiagnostic(err),
              quarantined,
            },
          },
        );
        log.error(
          {
            err: safeDiagnostic(err),
            mint: event.tokenMint,
            amountLamports,
            route: cfg.execution_route,
          },
          quarantined
            ? "copy buy landing is uncertain — coin quarantined"
            : "copy buy failed before submission — durable claim released for retry",
        );
        throw err;
      }
      await updateEntryClaim(entryClaim.id, {
        status: "landed",
        bot_tx_sig: result.txSig,
        error_code: null,
        landed_at: new Date().toISOString(),
      });
      recordStrategyDecision(event, "copied", "copy buy landed; saving position", {
        ...metaPatch,
        amount_usd: options.targetBuyUsd,
        bot_tx_sig: result.txSig,
        reaction_ms: strategyReactionMs(event, Date.now(), result.latencyMs),
        execution_ms: result.latencyMs,
        metadata: {
          ...metaPatch.metadata,
          configuredBuyUsd: buyUsd,
          receivedTokens: result.outUiAmount,
          route: result.route,
          persistencePending: true,
        },
      });

      const receivedUi = result.outUiAmount ?? 0;
      const entryPrice =
        receivedUi > 0 ? buyUsd / receivedUi : ((await priceUsd(event.tokenMint)) ?? 0);
      const targetBuyAt = new Date(event.timestampMs).toISOString();

      const positionId = entryClaim.planned_position_id;
      const pos = await retryDb<{ id: string } | null>("save landed copy-buy position", () =>
        db
          .from("positions")
          .upsert(
            {
              id: positionId,
              user_id: cfg.user_id,
              token_mint: event.tokenMint,
              entry_price_usd: entryPrice,
              amount_tokens: receivedUi,
              amount_remaining: receivedUi,
              decimals: event.decimals,
              mirrored_sold_fraction: 0,
              tp_taken: false,
              entry_tx_sig: result.txSig,
              entry_slot: event.slot,
              entry_mode: options.entryMode,
              coordinated_exit_triggered: false,
              follower_seller_exit_triggered: false,
              root_buy_count: options.coordinatedWallets?.length ?? 1,
              last_root_buy_at: targetBuyAt,
              last_root_buy_wallet: event.wallet,
            },
            { onConflict: "id" },
          )
          .select("id")
          .maybeSingle(),
      );
      if (!pos) {
        throw new Error(
          `copy buy ${result.txSig} landed but position ${positionId} could not be read back`,
        );
      }
      await monitor.onCopyBuy({
        positionId: pos.id,
        tokenMint: event.tokenMint,
        targetWallet: event.wallet,
        entrySlot: event.slot > 0 ? event.slot : undefined,
      });
      const linkedTargets = new Set([event.wallet, ...(options.coordinatedWallets ?? [])]);
      for (const wallet of linkedTargets) {
        await linkTargetToPosition(
          pos.id,
          wallet,
          options.entryMode === "coordinated" ? "coordinated" : "entry",
          targetBuyAt,
        );
      }
      await updateEntryClaim(entryClaim.id, {
        status: "persisted",
        error_code: null,
        persisted_at: new Date().toISOString(),
      });
      uncertainEntryMints.delete(event.tokenMint);

      const { error: tradeError } = await db.from("trades").insert({
        user_id: cfg.user_id,
        position_id: pos.id,
        side: "buy",
        token_mint: event.tokenMint,
        amount_tokens: receivedUi,
        amount_usd: buyUsd,
        tx_sig: result.txSig,
        reason,
        latency_ms: result.latencyMs,
        route: result.route,
      });
      if (tradeError)
        log.error(
          { err: safeDiagnostic(tradeError), positionId: pos.id },
          "copy buy landed but trade log save failed",
        );
      const { error: tradedTokenError } = await db
        .from("traded_tokens")
        .upsert({ user_id: cfg.user_id, token_mint: event.tokenMint });
      if (tradedTokenError)
        log.error(
          { err: safeDiagnostic(tradedTokenError), mint: event.tokenMint },
          "could not save traded-token history",
        );

      for (const transfer of pendingTransfers.drainForLandedBuy(event.tokenMint, event.slot)) {
        const classifiedPending = await classifyTransferRecipients(transfer);
        for (const recipient of classifiedPending) {
          if (!recipient.track) continue;
          await monitor.recordTransfer(pos.id, recipient.wallet, recipient.amountTokens, {
            hopDepth: 1,
            parentWallet: transfer.from,
            txSig: transfer.txSig,
            slot: transfer.slot,
            triggerEligible: Math.max(0, Number(recipient.recipientPreAmount ?? 0)) <= 1e-9,
          });
        }
        await handleTargetTerminalOutflows(
          transfer,
          {
            positionId: pos.id,
            tokenMint: event.tokenMint,
            targetWallet: event.wallet,
            entrySlot: event.slot > 0 ? event.slot : undefined,
          },
          classifiedPending,
          true,
        );
      }
      log.info(
        {
          sig: result.txSig,
          ms: result.latencyMs,
          entryMode: options.entryMode,
          targetBuyUsd:
            options.targetBuyUsd === undefined ? "unknown" : options.targetBuyUsd.toFixed(2),
        },
        "copy buy landed — follower monitor armed",
      );
      recordStrategyDecision(event, "copied", "copy buy landed and follower monitoring was armed", {
        ...metaPatch,
        position_id: pos.id,
        amount_usd: options.targetBuyUsd,
        bot_tx_sig: result.txSig,
        reaction_ms: strategyReactionMs(event, Date.now(), result.latencyMs),
        execution_ms: result.latencyMs,
        metadata: {
          ...metaPatch.metadata,
          configuredBuyUsd: buyUsd,
          receivedTokens: receivedUi,
          entryPriceUsd: entryPrice,
          route: result.route,
          persistencePending: false,
        },
      });
      return pos.id;
    }
  }
}

process.on("unhandledRejection", (err) =>
  log.error({ err: safeDiagnostic(err) }, "unhandled rejection"),
);
process.on("uncaughtException", (err) =>
  log.error({ err: safeDiagnostic(err) }, "uncaught exception"),
);

main().catch((e) => {
  log.error({ err: safeDiagnostic(e) }, "worker crashed before startup completed");
  process.exit(1);
});
