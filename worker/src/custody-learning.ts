import type { SupabaseClient } from "@supabase/supabase-js";
import { safeDiagnostic } from "./diagnostics.js";
import type { CustodyWalletType } from "./custody-types.js";

export type CustodyWalletBehavior = {
  wallet: string;
  journeyCount: number;
  transferOutCount: number;
  verifiedSellCount: number;
  activeHoldingCount: number;
  firstSeenAtMs: number;
};

export type CustodyLearnedProfile = {
  inferredType: Extract<
    CustodyWalletType,
    "routing_wallet" | "hot_wallet_candidate" | "cold_storage_candidate"
  >;
  inferredLabel: string;
  confidence: number;
  evidence: string;
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

/**
 * Conservative behavioral suggestions. These are always rendered as
 * candidates, never as confirmed identity or a named exchange.
 */
export function learnCustodyWalletProfile(
  behavior: CustodyWalletBehavior,
  nowMs = Date.now(),
): CustodyLearnedProfile | null {
  if (behavior.journeyCount >= 2 && behavior.verifiedSellCount >= 3) {
    return {
      inferredType: "hot_wallet_candidate",
      inferredLabel: "Active seller pattern",
      confidence: 0.65,
      evidence: `${behavior.verifiedSellCount} verified custody sells across ${behavior.journeyCount} journeys`,
    };
  }
  if (behavior.journeyCount >= 2 && behavior.transferOutCount >= 3) {
    return {
      inferredType: "routing_wallet",
      inferredLabel: "Repeated routing pattern",
      confidence: 0.65,
      evidence: `${behavior.transferOutCount} outgoing custody transfers across ${behavior.journeyCount} journeys`,
    };
  }
  if (
    behavior.journeyCount >= 3 &&
    behavior.activeHoldingCount > 0 &&
    behavior.transferOutCount === 0 &&
    behavior.verifiedSellCount === 0 &&
    Number.isFinite(behavior.firstSeenAtMs) &&
    nowMs - behavior.firstSeenAtMs >= SEVEN_DAYS_MS
  ) {
    return {
      inferredType: "cold_storage_candidate",
      inferredLabel: "Long-hold custody pattern",
      confidence: 0.5,
      evidence: `No observed outflow across ${behavior.journeyCount} journeys for at least 7 days`,
    };
  }
  return null;
}

type WalletRow = {
  journey_id: string;
  wallet: string;
  current_attributed_tokens: number | string;
  total_transferred_tokens: number | string;
  total_verified_sold_tokens: number | string;
  first_seen_at: string;
};

type ProfileRow = {
  wallet: string;
  inferred_type: string | null;
  inference_confidence: number | string | null;
  manual_type: string | null;
};

async function loadAllRows<T extends Record<string, unknown>>(
  buildQuery: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: T[] | null;
    error: unknown;
  }>,
  label: string,
): Promise<T[]> {
  const pageSize = 1_000;
  const maxRows = 100_000;
  const rows: T[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const result = await buildQuery(offset, offset + pageSize - 1);
    if (result.error) {
      throw new Error(`${label} failed: ${safeDiagnostic(result.error)}`);
    }
    if (!Array.isArray(result.data)) throw new Error(`${label} returned invalid data`);
    rows.push(...result.data);
    if (result.data.length < pageSize) return rows;
  }
  throw new Error(`${label} exceeded its complete-read safety limit`);
}

export async function refreshCustodyWalletLearning(
  client: SupabaseClient,
  userId: string,
  nowMs = Date.now(),
): Promise<number> {
  const [walletRows, profileRows] = await Promise.all([
    loadAllRows<WalletRow & Record<string, unknown>>(
      (from, to) =>
        client
          .from("custody_journey_wallets")
          .select(
            "journey_id,wallet,current_attributed_tokens,total_transferred_tokens,total_verified_sold_tokens,first_seen_at",
          )
          .eq("user_id", userId)
          .order("journey_id", { ascending: true })
          .order("wallet", { ascending: true })
          .range(from, to),
      "custody learning wallet read",
    ),
    loadAllRows<ProfileRow & Record<string, unknown>>(
      (from, to) =>
        client
          .from("custody_wallet_profiles")
          .select("wallet,inferred_type,inference_confidence,manual_type")
          .eq("user_id", userId)
          .order("wallet", { ascending: true })
          .range(from, to),
      "custody learning profile read",
    ),
  ]);

  const profiles = new Map(profileRows.map((row) => [row.wallet, row]));
  const grouped = new Map<
    string,
    {
      journeys: Set<string>;
      transferOutCount: number;
      verifiedSellCount: number;
      activeHoldingCount: number;
      firstSeenAtMs: number;
    }
  >();
  for (const row of walletRows) {
    const current = grouped.get(row.wallet) ?? {
      journeys: new Set<string>(),
      transferOutCount: 0,
      verifiedSellCount: 0,
      activeHoldingCount: 0,
      firstSeenAtMs: Number.POSITIVE_INFINITY,
    };
    current.journeys.add(row.journey_id);
    if (Number(row.total_transferred_tokens) > 0) current.transferOutCount += 1;
    if (Number(row.total_verified_sold_tokens) > 0) current.verifiedSellCount += 1;
    if (Number(row.current_attributed_tokens) > 0) current.activeHoldingCount += 1;
    const firstSeen = new Date(row.first_seen_at).getTime();
    if (Number.isFinite(firstSeen))
      current.firstSeenAtMs = Math.min(current.firstSeenAtMs, firstSeen);
    grouped.set(row.wallet, current);
  }

  let updated = 0;
  for (const [wallet, aggregate] of grouped) {
    const current = profiles.get(wallet);
    if (current?.manual_type) continue;
    if (
      current &&
      !["unknown", "routing_wallet", "hot_wallet_candidate", "cold_storage_candidate"].includes(
        current.inferred_type ?? "unknown",
      )
    ) {
      continue;
    }
    const learned = learnCustodyWalletProfile(
      {
        wallet,
        journeyCount: aggregate.journeys.size,
        transferOutCount: aggregate.transferOutCount,
        verifiedSellCount: aggregate.verifiedSellCount,
        activeHoldingCount: aggregate.activeHoldingCount,
        firstSeenAtMs: aggregate.firstSeenAtMs,
      },
      nowMs,
    );
    if (!learned || Number(current?.inference_confidence ?? 0) >= learned.confidence) continue;
    const { data, error } = await client
      .from("custody_wallet_profiles")
      .update({
        inferred_type: learned.inferredType,
        inferred_label: learned.inferredLabel,
        inference_confidence: learned.confidence,
        inference_source: `behavioral:${learned.evidence}`,
        updated_at: new Date(nowMs).toISOString(),
      })
      .eq("user_id", userId)
      .eq("wallet", wallet)
      .is("manual_type", null)
      .in("inferred_type", [
        "unknown",
        "routing_wallet",
        "hot_wallet_candidate",
        "cold_storage_candidate",
      ])
      .lt("inference_confidence", learned.confidence)
      .select("wallet")
      .maybeSingle();
    if (error) throw new Error(`custody learning update failed: ${safeDiagnostic(error)}`);
    if (data) updated += 1;
  }
  return updated;
}
