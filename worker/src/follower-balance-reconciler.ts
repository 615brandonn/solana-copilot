import { PublicKey, type Connection } from "@solana/web3.js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { safeDiagnostic } from "./diagnostics.js";

export type ActiveFollowerBalance = {
  wallet: string;
  tokenMint: string;
  expectedAmount: number;
  activePositionCount: number;
  decimals: number;
};

export type FollowerBalanceAlertObservation = ActiveFollowerBalance & {
  observedAmount: number;
  shortfallAmount: number;
  comparisonTolerance: number;
  checkedAt: string;
};

export type FollowerBalanceReconciliationHealth = {
  hasCompleted: boolean;
  lastCheckedAt: number | null;
  lastSuccessfulAt: number | null;
  checkedBalanceCount: number;
  candidateMismatchCount: number;
  mismatchCount: number;
  degraded: boolean;
  lastError: string | null;
};

export interface FollowerBalanceStore {
  loadActiveBalances(userId: string): Promise<ActiveFollowerBalance[]>;
  loadOpenAlertKeys(userId: string): Promise<ReadonlySet<string>>;
  recordMismatch(userId: string, observation: FollowerBalanceAlertObservation): Promise<void>;
  resolveMatch(
    userId: string,
    balance: ActiveFollowerBalance,
    observedAmount: number,
    checkedAt: string,
  ): Promise<void>;
  resolveInactive(
    userId: string,
    activeKeys: ReadonlySet<string>,
    checkedAt: string,
  ): Promise<void>;
  countConfirmed(userId: string): Promise<number>;
  countCandidates(userId: string): Promise<number>;
}

export interface FollowerTokenBalanceReader {
  read(wallet: string, tokenMint: string): Promise<{ amount: number; decimals: number }>;
}

export function followerBalanceKey(wallet: string, tokenMint: string): string {
  return `${wallet}\u0000${tokenMint}`;
}

export function groupActiveFollowerBalances(
  rows: Array<{
    wallet: string;
    tokenMint: string;
    currentAmount: number;
    positionId: string;
    decimals?: number;
  }>,
): ActiveFollowerBalance[] {
  const groups = new Map<string, ActiveFollowerBalance & { positionIds: Set<string> }>();
  for (const row of rows) {
    const currentAmount = Math.max(0, Number(row.currentAmount));
    if (!row.wallet || !row.tokenMint || !Number.isFinite(currentAmount) || currentAmount <= 0)
      continue;
    const key = followerBalanceKey(row.wallet, row.tokenMint);
    const existing = groups.get(key);
    if (existing) {
      existing.expectedAmount += currentAmount;
      existing.positionIds.add(row.positionId);
      existing.activePositionCount = existing.positionIds.size;
      existing.decimals = Math.max(existing.decimals, Math.max(0, Number(row.decimals ?? 0)));
      continue;
    }
    groups.set(key, {
      wallet: row.wallet,
      tokenMint: row.tokenMint,
      expectedAmount: currentAmount,
      activePositionCount: 1,
      decimals: Math.max(0, Number(row.decimals ?? 0)),
      positionIds: new Set([row.positionId]),
    });
  }
  return Array.from(groups.values()).map(({ positionIds: _positionIds, ...group }) => group);
}

export function followerBalanceShortfall(
  expectedAmount: number,
  observedAmount: number,
  decimals: number,
): number {
  const expected = Math.max(0, Number(expectedAmount));
  const observed = Math.max(0, Number(observedAmount));
  if (!Number.isFinite(expected) || !Number.isFinite(observed)) return 0;
  const tolerance = followerBalanceTolerance(expected, decimals);
  const shortfall = expected - observed;
  return shortfall > tolerance ? shortfall : 0;
}

export function followerBalanceTolerance(expectedAmount: number, decimals: number): number {
  const expected = Math.max(0, Number(expectedAmount));
  const rawUnitTolerance = Math.pow(10, -Math.max(0, Math.min(18, Number(decimals) || 0))) * 2;
  return Math.max(1e-9, rawUnitTolerance, expected * 1e-8);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await operation(values[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, () => worker()),
  );
  return results;
}

export type FollowerBalanceInspection = {
  checkedBalanceCount: number;
  failedReadCount: number;
  observations: Array<{
    balance: ActiveFollowerBalance;
    observedAmount: number;
    shortfallAmount: number;
    comparisonTolerance: number;
  }>;
};

export async function inspectFollowerBalances(
  balances: readonly ActiveFollowerBalance[],
  reader: FollowerTokenBalanceReader,
  concurrency = 6,
): Promise<FollowerBalanceInspection> {
  const snapshots = await mapWithConcurrency(balances, concurrency, async (balance) => ({
    balance,
    snapshot: await reader.read(balance.wallet, balance.tokenMint),
  }));
  const observations: FollowerBalanceInspection["observations"] = [];
  let failedReadCount = 0;
  for (const result of snapshots) {
    if (result.status === "rejected") {
      failedReadCount += 1;
      continue;
    }
    observations.push({
      balance: result.value.balance,
      observedAmount: result.value.snapshot.amount,
      shortfallAmount: followerBalanceShortfall(
        result.value.balance.expectedAmount,
        result.value.snapshot.amount,
        result.value.snapshot.decimals || result.value.balance.decimals,
      ),
      comparisonTolerance: followerBalanceTolerance(
        result.value.balance.expectedAmount,
        result.value.snapshot.decimals || result.value.balance.decimals,
      ),
    });
  }
  return {
    checkedBalanceCount: observations.length,
    failedReadCount,
    observations,
  };
}

export class FollowerBalanceReconciler {
  private running = false;
  private state: FollowerBalanceReconciliationHealth = {
    hasCompleted: false,
    lastCheckedAt: null,
    lastSuccessfulAt: null,
    checkedBalanceCount: 0,
    candidateMismatchCount: 0,
    mismatchCount: 0,
    degraded: true,
    lastError: null,
  };

  constructor(
    private readonly userId: string,
    private readonly store: FollowerBalanceStore,
    private readonly reader: FollowerTokenBalanceReader,
    private readonly concurrency = 6,
  ) {}

  health(): FollowerBalanceReconciliationHealth {
    return { ...this.state };
  }

  async run(): Promise<FollowerBalanceReconciliationHealth> {
    if (this.running) return this.health();
    this.running = true;
    const checkedAtMs = Date.now();
    const checkedAt = new Date(checkedAtMs).toISOString();
    try {
      const [balances, openAlertKeys] = await Promise.all([
        this.store.loadActiveBalances(this.userId),
        this.store.loadOpenAlertKeys(this.userId),
      ]);
      const activeKeys = new Set(
        balances.map((balance) => followerBalanceKey(balance.wallet, balance.tokenMint)),
      );
      const inspection = await inspectFollowerBalances(balances, this.reader, this.concurrency);
      for (const observation of inspection.observations) {
        const { balance, observedAmount, shortfallAmount, comparisonTolerance } = observation;
        if (shortfallAmount > 0) {
          await this.store.recordMismatch(this.userId, {
            ...balance,
            observedAmount,
            shortfallAmount,
            comparisonTolerance,
            checkedAt,
          });
        } else if (openAlertKeys.has(followerBalanceKey(balance.wallet, balance.tokenMint))) {
          // Healthy wallets with no open alert need no database write. This is
          // important when hundreds of follower wallets are checked every run.
          await this.store.resolveMatch(this.userId, balance, observedAmount, checkedAt);
        }
      }
      await this.store.resolveInactive(this.userId, activeKeys, checkedAt);
      const [mismatchCount, candidateMismatchCount] = await Promise.all([
        this.store.countConfirmed(this.userId),
        this.store.countCandidates(this.userId),
      ]);
      const degraded = inspection.failedReadCount > 0;
      this.state = {
        hasCompleted: true,
        lastCheckedAt: checkedAtMs,
        lastSuccessfulAt: degraded ? this.state.lastSuccessfulAt : checkedAtMs,
        checkedBalanceCount: inspection.checkedBalanceCount,
        candidateMismatchCount,
        mismatchCount,
        degraded,
        lastError:
          inspection.failedReadCount > 0
            ? `${inspection.failedReadCount} follower balance RPC lookup(s) failed; no failed lookup was treated as a sale`
            : null,
      };
      return this.health();
    } catch (error) {
      // Do not place arbitrary provider/database error text in the heartbeat;
      // endpoint URLs can contain credentials. The worker log already records
      // sanitized operational context elsewhere.
      this.state = {
        ...this.state,
        hasCompleted: true,
        lastCheckedAt: checkedAtMs,
        degraded: true,
        lastError: `follower balance reconciliation request failed (${safeDiagnostic(error).length > 0 ? "diagnostic available in local worker logs" : "unknown error"})`,
      };
      return this.health();
    } finally {
      this.running = false;
    }
  }
}

type SupabaseLike = Pick<SupabaseClient, "from">;

function databaseFailure(label: string, error: { message?: string } | null): never {
  throw new Error(`${label}: ${safeDiagnostic(error?.message ?? "unknown database error")}`);
}

export function createSupabaseFollowerBalanceStore(db: SupabaseLike): FollowerBalanceStore {
  return {
    async loadActiveBalances(userId) {
      const positionRows: Array<{
        id: string;
        token_mint: string;
        decimals: number | null;
      }> = [];
      for (let offset = 0; ; offset += 1_000) {
        const positions = await db
          .from("positions")
          .select("id,token_mint,decimals")
          .eq("user_id", userId)
          .is("closed_at", null)
          .order("id", { ascending: true })
          .range(offset, offset + 999);
        if (positions.error) databaseFailure("load active positions", positions.error);
        const page = (positions.data ?? []) as typeof positionRows;
        positionRows.push(...page);
        if (page.length < 1_000) break;
      }
      if (positionRows.length === 0) return [];
      const mintByPosition = new Map(positionRows.map((row) => [row.id, row.token_mint]));
      const decimalsByPosition = new Map(
        positionRows.map((row) => [row.id, Math.max(0, Number(row.decimals ?? 0))]),
      );
      const followerRows: Array<{
        position_id: string;
        wallet: string;
        current_amount: number;
      }> = [];
      for (let positionOffset = 0; positionOffset < positionRows.length; positionOffset += 100) {
        const positionIds = positionRows
          .slice(positionOffset, positionOffset + 100)
          .map((row) => row.id);
        for (let rowOffset = 0; ; rowOffset += 1_000) {
          const followers = await db
            .from("follower_wallets")
            .select("position_id,wallet,current_amount")
            .in("position_id", positionIds)
            .is("released_at", null)
            .gt("current_amount", 0)
            .order("id", { ascending: true })
            .range(rowOffset, rowOffset + 999);
          if (followers.error) databaseFailure("load active follower balances", followers.error);
          const page = (followers.data ?? []) as typeof followerRows;
          followerRows.push(...page);
          if (page.length < 1_000) break;
        }
      }
      return groupActiveFollowerBalances(
        followerRows.map((row) => ({
          positionId: row.position_id,
          wallet: row.wallet,
          tokenMint: mintByPosition.get(row.position_id) ?? "",
          currentAmount: Number(row.current_amount),
          decimals: decimalsByPosition.get(row.position_id) ?? 0,
        })),
      );
    },

    async loadOpenAlertKeys(userId) {
      const keys = new Set<string>();
      for (let offset = 0; ; offset += 1_000) {
        const result = await db
          .from("follower_balance_alerts")
          .select("wallet,token_mint")
          .eq("user_id", userId)
          .is("resolved_at", null)
          .order("id", { ascending: true })
          .range(offset, offset + 999);
        if (result.error) databaseFailure("load follower balance alerts", result.error);
        const page = (result.data ?? []) as Array<{ wallet: string; token_mint: string }>;
        for (const row of page) keys.add(followerBalanceKey(row.wallet, row.token_mint));
        if (page.length < 1_000) break;
      }
      return keys;
    },

    async recordMismatch(userId, observation) {
      const existing = await db
        .from("follower_balance_alerts")
        .select("id,observed_amount,occurrence_count,confirmed_at")
        .eq("user_id", userId)
        .eq("wallet", observation.wallet)
        .eq("token_mint", observation.tokenMint)
        .is("resolved_at", null)
        .maybeSingle();
      if (existing.error) databaseFailure("load follower balance alert", existing.error);
      const values = {
        expected_amount: observation.expectedAmount,
        observed_amount: observation.observedAmount,
        shortfall_amount: observation.shortfallAmount,
        active_position_count: observation.activePositionCount,
        last_detected_at: observation.checkedAt,
      };
      if (existing.data) {
        const previousObserved = Math.max(0, Number(existing.data.observed_amount ?? 0));
        const sameOrLower =
          observation.observedAmount <= previousObserved + observation.comparisonTolerance;
        const occurrenceCount = sameOrLower
          ? Math.max(1, Number(existing.data.occurrence_count ?? 0)) + 1
          : 1;
        const updated = await db
          .from("follower_balance_alerts")
          .update({
            ...values,
            occurrence_count: occurrenceCount,
            confirmed_at:
              existing.data.confirmed_at ?? (occurrenceCount >= 2 ? observation.checkedAt : null),
          })
          .eq("id", existing.data.id)
          .is("resolved_at", null);
        if (updated.error) databaseFailure("update follower balance alert", updated.error);
        return;
      }
      const inserted = await db.from("follower_balance_alerts").insert({
        user_id: userId,
        wallet: observation.wallet,
        token_mint: observation.tokenMint,
        ...values,
        first_detected_at: observation.checkedAt,
        occurrence_count: 1,
        confirmed_at: null,
      });
      if (inserted.error) databaseFailure("insert follower balance alert", inserted.error);
    },

    async resolveMatch(userId, balance, observedAmount, checkedAt) {
      const result = await db
        .from("follower_balance_alerts")
        .update({
          resolved_at: checkedAt,
          resolution_reason: "balance_recovered",
          resolution_observed_amount: observedAmount,
        })
        .eq("user_id", userId)
        .eq("wallet", balance.wallet)
        .eq("token_mint", balance.tokenMint)
        .is("resolved_at", null);
      if (result.error) databaseFailure("resolve follower balance alert", result.error);
    },

    async resolveInactive(userId, activeKeys, checkedAt) {
      const existing = await db
        .from("follower_balance_alerts")
        .select("id,wallet,token_mint")
        .eq("user_id", userId)
        .is("resolved_at", null)
        .limit(5_000);
      if (existing.error)
        databaseFailure("load unresolved follower balance alerts", existing.error);
      const staleIds = (
        (existing.data ?? []) as Array<{
          id: string;
          wallet: string;
          token_mint: string;
        }>
      )
        .filter((row) => !activeKeys.has(followerBalanceKey(row.wallet, row.token_mint)))
        .map((row) => row.id);
      for (let offset = 0; offset < staleIds.length; offset += 100) {
        const result = await db
          .from("follower_balance_alerts")
          .update({ resolved_at: checkedAt, resolution_reason: "no_longer_active" })
          .in("id", staleIds.slice(offset, offset + 100))
          .is("resolved_at", null);
        if (result.error) databaseFailure("resolve inactive follower balance alerts", result.error);
      }
    },

    async countConfirmed(userId) {
      const result = await db
        .from("follower_balance_alerts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("resolved_at", null)
        .not("confirmed_at", "is", null);
      if (result.error) databaseFailure("count follower balance alerts", result.error);
      return Math.max(0, Number(result.count ?? 0));
    },

    async countCandidates(userId) {
      const result = await db
        .from("follower_balance_alerts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("resolved_at", null)
        .is("confirmed_at", null);
      if (result.error) databaseFailure("count follower balance candidates", result.error);
      return Math.max(0, Number(result.count ?? 0));
    },
  };
}

export function createRpcFollowerTokenBalanceReader(
  connection: Connection,
): FollowerTokenBalanceReader {
  return {
    async read(wallet, tokenMint) {
      const accounts = await connection.getParsedTokenAccountsByOwner(
        new PublicKey(wallet),
        { mint: new PublicKey(tokenMint) },
        "confirmed",
      );
      let amount = 0;
      let decimals = 0;
      for (const account of accounts.value) {
        const info = account.account.data.parsed.info as {
          tokenAmount?: { decimals?: number; uiAmountString?: string };
        };
        amount += Math.max(0, Number(info.tokenAmount?.uiAmountString ?? 0));
        decimals = Math.max(0, Number(info.tokenAmount?.decimals ?? decimals));
      }
      if (!Number.isFinite(amount))
        throw new Error("RPC returned an invalid follower token balance");
      return { amount, decimals };
    },
  };
}
