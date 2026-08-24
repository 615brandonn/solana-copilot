import type { SupabaseClient } from "@supabase/supabase-js";
import { revivalConfigHash, revivalEventFingerprint } from "./revival-engine.js";
import {
  revivalCampaignDbRow,
  revivalEventDbRow,
  revivalEventFromDbRow,
  revivalMarketSnapshotDbRow,
  revivalShadowActionDbRow,
  revivalStrategyVersionRow,
  revivalTransitionDbRow,
} from "./revival-persistence.js";
import type {
  RevivalCampaignSnapshot,
  RevivalEvent,
  RevivalReplayResult,
  RevivalRuntimeHealth,
  RevivalTrackerConfig,
} from "./revival-types.js";
import { REVIVAL_ENGINE_VERSION } from "./revival-types.js";
import { safeDiagnostic } from "./diagnostics.js";

export type RevivalEventWriteResult = "inserted" | "duplicate" | "enriched";

export type RevivalProjectionChanges = {
  events: RevivalEvent[];
  transitions: RevivalReplayResult["transitions"];
  actions: RevivalReplayResult["actions"];
  campaignKeys: string[];
};

export interface RevivalStore {
  ensureStrategyVersion(config: RevivalTrackerConfig): Promise<string>;
  insertEvent(event: RevivalEvent): Promise<RevivalEventWriteResult>;
  loadEvents(tokenMint?: string): Promise<RevivalEvent[]>;
  /** Mints whose durable event has no projection-complete campaign link. */
  loadProjectionRepairMints(): Promise<string[]>;
  saveProjection(result: RevivalReplayResult, changes: RevivalProjectionChanges): Promise<void>;
  loadActiveCampaignMints(): Promise<string[]>;
  loadActiveTargetWallets(): Promise<string[]>;
  recordHeartbeat(input: {
    startedAt: string;
    enabled: boolean;
    targetWalletCount: number;
    health: RevivalRuntimeHealth;
    rpcHealth: Record<string, unknown>;
    lastError: string | null;
  }): Promise<void>;
}

type LooseClient = SupabaseClient;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function revivalEventFallsWithinCampaign(
  eventAvailableAtMs: number,
  seedAvailableAtMs: number,
  closedAtMs?: number,
): boolean {
  return (
    Number.isFinite(eventAvailableAtMs) &&
    Number.isFinite(seedAvailableAtMs) &&
    eventAvailableAtMs >= seedAvailableAtMs &&
    eventAvailableAtMs <= (closedAtMs ?? Number.POSITIVE_INFINITY)
  );
}

export function revivalMarketSamplingIsStale(
  health: Pick<RevivalRuntimeHealth, "activeCampaignCount" | "lastMarketSnapshotAt">,
  nowMs: number,
): boolean {
  return (
    health.activeCampaignCount > 0 &&
    (health.lastMarketSnapshotAt === null || nowMs - health.lastMarketSnapshotAt > 90_000)
  );
}

function activeCampaignForEvent(
  campaigns: RevivalCampaignSnapshot[],
  event: RevivalEvent,
): RevivalCampaignSnapshot | undefined {
  return (
    campaigns.find((campaign) => campaign.seedEventKey === event.eventKey) ??
    [...campaigns]
      .reverse()
      .find(
        (campaign) =>
          event.availableAtMs >= campaign.seedAvailableAtMs &&
          event.availableAtMs <= (campaign.closedAtMs ?? Number.POSITIVE_INFINITY),
      )
  );
}

export function createSupabaseRevivalStore(client: LooseClient, userId: string): RevivalStore {
  const versionIds = new Map<string, string>();

  const ensureStrategyVersion = async (config: RevivalTrackerConfig): Promise<string> => {
    const configHash = revivalConfigHash(config);
    const cached = versionIds.get(configHash);
    if (cached) return cached;
    const existing = await client
      .from("revival_strategy_versions")
      .select("id")
      .eq("user_id", userId)
      .eq("config_hash", configHash)
      .maybeSingle();
    if (existing.error) {
      throw new Error(`Revival strategy lookup failed: ${safeDiagnostic(existing.error)}`);
    }
    if (existing.data?.id) {
      versionIds.set(configHash, existing.data.id);
      return existing.data.id;
    }
    const latest = await client
      .from("revival_strategy_versions")
      .select("version_number")
      .eq("user_id", userId)
      .order("version_number", { ascending: false })
      .limit(1);
    if (latest.error) {
      throw new Error(`Revival strategy version query failed: ${safeDiagnostic(latest.error)}`);
    }
    const versionNumber = Math.max(1, Number(latest.data?.[0]?.version_number ?? 0) + 1);
    const inserted = await client
      .from("revival_strategy_versions")
      .insert(revivalStrategyVersionRow(userId, configHash, config, versionNumber))
      .select("id")
      .maybeSingle();
    if (inserted.error?.code === "23505") {
      const recovered = await client
        .from("revival_strategy_versions")
        .select("id")
        .eq("user_id", userId)
        .eq("config_hash", configHash)
        .maybeSingle();
      if (recovered.error || !recovered.data?.id) {
        throw new Error(
          `Revival strategy recovery failed: ${safeDiagnostic(recovered.error ?? "missing row")}`,
        );
      }
      versionIds.set(configHash, recovered.data.id);
      return recovered.data.id;
    }
    if (inserted.error || !inserted.data?.id) {
      throw new Error(
        `Revival strategy registration failed: ${safeDiagnostic(inserted.error ?? "missing row")}`,
      );
    }
    versionIds.set(configHash, inserted.data.id);
    return inserted.data.id;
  };

  return {
    ensureStrategyVersion,

    async insertEvent(event): Promise<RevivalEventWriteResult> {
      const strategyVersionId = await ensureStrategyVersion(event.seedConfig!);
      const row = revivalEventDbRow(userId, strategyVersionId, event);
      const inserted = await client.from("revival_events").insert(row);
      if (!inserted.error) return "inserted";
      if (inserted.error.code !== "23505") {
        throw new Error(`Revival event persistence failed: ${safeDiagnostic(inserted.error)}`);
      }
      const existing = await client
        .from("revival_events")
        .select("id,request_fingerprint,amount_usd,conflict_count")
        .eq("user_id", userId)
        .eq("event_key", event.eventKey)
        .maybeSingle();
      if (existing.error || !existing.data) {
        throw new Error(
          `Revival duplicate recovery failed: ${safeDiagnostic(existing.error ?? "missing row")}`,
        );
      }
      if (existing.data.request_fingerprint !== revivalEventFingerprint(event)) {
        const conflict = await client
          .from("revival_events")
          .update({
            conflict_count: Math.max(0, Number(existing.data.conflict_count ?? 0)) + 1,
            last_conflict_at: new Date().toISOString(),
          })
          .eq("id", existing.data.id)
          .eq("user_id", userId);
        if (conflict.error) {
          throw new Error(`Revival conflict audit failed: ${safeDiagnostic(conflict.error)}`);
        }
        throw new Error("Revival event payload mismatch was quarantined");
      }
      if (
        existing.data.amount_usd === null &&
        Number.isFinite(event.amountUsd) &&
        Number(event.amountUsd) > 0
      ) {
        const enriched = await client
          .from("revival_events")
          .update({ amount_usd: Number(event.amountUsd) })
          .eq("id", existing.data.id)
          .eq("user_id", userId)
          .is("amount_usd", null);
        if (enriched.error) {
          throw new Error(`Revival valuation enrichment failed: ${safeDiagnostic(enriched.error)}`);
        }
        return "enriched";
      }
      return "duplicate";
    },

    async loadEvents(tokenMint?: string): Promise<RevivalEvent[]> {
      const output: RevivalEvent[] = [];
      const pageSize = 1_000;
      for (let offset = 0; ; offset += pageSize) {
        let query = client
          .from("revival_events")
          .select("*,strategy_version:revival_strategy_versions!inner(algorithm_version)")
          .eq("user_id", userId)
          .eq("strategy_version.algorithm_version", REVIVAL_ENGINE_VERSION)
          .order("available_at", { ascending: true })
          .order("event_at", { ascending: true })
          .order("event_key", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (tokenMint) query = query.eq("token_mint", tokenMint);
        const result = await query;
        if (result.error) {
          throw new Error(`Revival event hydration failed: ${safeDiagnostic(result.error)}`);
        }
        for (const row of result.data ?? []) {
          const parsed = revivalEventFromDbRow(row as Record<string, unknown>);
          if (parsed) output.push(parsed);
        }
        if ((result.data?.length ?? 0) < pageSize) return output;
      }
    },

    async loadProjectionRepairMints(): Promise<string[]> {
      const output = new Set<string>();
      const requiresCampaignAt = new Map<string, number[]>();
      const pageSize = 1_000;
      for (let offset = 0; ; offset += pageSize) {
        const result = await client
          .from("revival_events")
          .select(
            "token_mint,event_type,classification_reliable,available_at,strategy_version:revival_strategy_versions!inner(algorithm_version)",
          )
          .eq("user_id", userId)
          .eq("strategy_version.algorithm_version", REVIVAL_ENGINE_VERSION)
          .is("campaign_id", null)
          .order("available_at", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (result.error) {
          throw new Error(`Revival repair scan failed: ${safeDiagnostic(result.error)}`);
        }
        for (const row of result.data ?? []) {
          const mint = text(row.token_mint).trim();
          if (!mint) continue;
          // A reliable target buy can create a campaign, so it is repairable
          // even if the process crashed before the campaign insert. Every
          // other event needs an already-existing campaign; this excludes
          // orphan pre-campaign market/clock observations from perpetual
          // startup repair.
          if (row.classification_reliable === true && row.event_type === "TARGET_BUY") {
            output.add(mint);
          } else if (
            row.classification_reliable === true ||
            row.event_type === "MARKET_SNAPSHOT" ||
            row.event_type === "CLOCK_TICK"
          ) {
            const availableAt = Date.parse(String(row.available_at ?? ""));
            if (Number.isFinite(availableAt)) {
              const times = requiresCampaignAt.get(mint) ?? [];
              times.push(availableAt);
              requiresCampaignAt.set(mint, times);
            }
          }
        }
        if ((result.data?.length ?? 0) < pageSize) break;
      }
      const candidates = Array.from(requiresCampaignAt.keys());
      for (let offset = 0; offset < candidates.length; offset += 250) {
        const result = await client
          .from("revival_campaigns")
          .select("token_mint,seed_available_at,closed_at")
          .eq("user_id", userId)
          .eq("engine_version", REVIVAL_ENGINE_VERSION)
          .in("token_mint", candidates.slice(offset, offset + 250));
        if (result.error) {
          throw new Error(`Revival repair scope query failed: ${safeDiagnostic(result.error)}`);
        }
        for (const row of result.data ?? []) {
          const mint = text(row.token_mint).trim();
          if (!mint) continue;
          const seededAt = Date.parse(String(row.seed_available_at ?? ""));
          const closedAt = row.closed_at
            ? Date.parse(String(row.closed_at))
            : Number.POSITIVE_INFINITY;
          if (
            (requiresCampaignAt.get(mint) ?? []).some((availableAt) =>
              revivalEventFallsWithinCampaign(availableAt, seededAt, closedAt),
            )
          ) {
            output.add(mint);
          }
        }
      }
      return Array.from(output).sort();
    },

    async saveProjection(result, changes): Promise<void> {
      const campaignIds = new Map<string, { id: string; strategyVersionId: string }>();
      const changedCampaignKeys = new Set(changes.campaignKeys);
      const changedCampaigns = result.campaigns.filter((campaign) =>
        changedCampaignKeys.has(campaign.campaignKey),
      );
      for (const campaign of changedCampaigns) {
        const strategyVersionId = await ensureStrategyVersion(campaign.config);
        const upserted = await client
          .from("revival_campaigns")
          .upsert(revivalCampaignDbRow(userId, strategyVersionId, campaign), {
            onConflict: "user_id,campaign_key",
          })
          .select("id,campaign_key")
          .maybeSingle();
        if (upserted.error || !upserted.data?.id) {
          throw new Error(
            `Revival campaign projection failed: ${safeDiagnostic(upserted.error ?? "missing row")}`,
          );
        }
        campaignIds.set(campaign.campaignKey, { id: upserted.data.id, strategyVersionId });
      }

      for (const transition of changes.transitions) {
        const campaign = campaignIds.get(transition.campaignKey);
        if (!campaign) continue;
        const saved = await client
          .from("revival_transitions")
          .upsert(
            revivalTransitionDbRow(userId, campaign.strategyVersionId, campaign.id, transition),
            { onConflict: "user_id,transition_key", ignoreDuplicates: true },
          );
        if (saved.error) {
          throw new Error(`Revival transition save failed: ${safeDiagnostic(saved.error)}`);
        }
      }

      for (const shadowAction of changes.actions) {
        const campaign = campaignIds.get(shadowAction.campaignKey);
        if (!campaign) continue;
        const saved = await client
          .from("revival_shadow_actions")
          .upsert(
            revivalShadowActionDbRow(userId, campaign.strategyVersionId, campaign.id, shadowAction),
            { onConflict: "user_id,action_key", ignoreDuplicates: true },
          );
        if (saved.error) {
          throw new Error(`Revival shadow action save failed: ${safeDiagnostic(saved.error)}`);
        }
      }

      const eventLinks: Array<{
        event: RevivalEvent;
        campaign: { id: string; strategyVersionId: string };
      }> = [];
      for (const event of changes.events) {
        const projected = activeCampaignForEvent(result.campaigns, event);
        const campaign = projected ? campaignIds.get(projected.campaignKey) : undefined;
        if (!campaign) continue;
        eventLinks.push({ event, campaign });
        if (event.eventType !== "MARKET_SNAPSHOT") continue;
        const linked = await client
          .from("revival_market_snapshots")
          .upsert(
            revivalMarketSnapshotDbRow(userId, campaign.strategyVersionId, campaign.id, event),
            { onConflict: "user_id,snapshot_key" },
          );
        if (linked.error) {
          throw new Error(`Revival market snapshot link failed: ${safeDiagnostic(linked.error)}`);
        }
      }

      for (const campaign of changedCampaigns) {
        if (!campaign.closedAtMs) continue;
        const linked = campaignIds.get(campaign.campaignKey);
        if (!linked) continue;
        const entryAction = result.actions.find(
          (item) =>
            item.campaignKey === campaign.campaignKey && item.actionType === "STARTER_ELIGIBLE",
        );
        const entryPrice = Number(entryAction?.metadata.latestPriceUsd ?? 0);
        const closePrice = Number(campaign.latestPriceUsd ?? 0);
        const scorable = entryPrice > 0 && closePrice > 0;
        const pnlPct = scorable ? (closePrice / entryPrice - 1) * 100 : null;
        const variantKey = REVIVAL_ENGINE_VERSION;
        const outcome = await client.from("revival_outcomes").upsert(
          {
            user_id: userId,
            campaign_id: linked.id,
            strategy_version_id: linked.strategyVersionId,
            variant_key: variantKey,
            outcome_key: `${campaign.campaignKey}:${variantKey}`,
            status:
              campaign.state === "INVALIDATED"
                ? "invalidated"
                : scorable
                  ? "resolved"
                  : "unscorable",
            resolution_reason: campaign.closeReason ?? "campaign_closed",
            entry_at: entryAction ? new Date(entryAction.decisionAtMs).toISOString() : null,
            ignition_at: campaign.ignitedAtMs ? new Date(campaign.ignitedAtMs).toISOString() : null,
            distribution_at: campaign.distributionRiskAtMs
              ? new Date(campaign.distributionRiskAtMs).toISOString()
              : null,
            closed_at: new Date(campaign.closedAtMs).toISOString(),
            entry_price_usd: entryPrice > 0 ? entryPrice : null,
            close_price_usd: closePrice > 0 ? closePrice : null,
            pnl_pct: pnlPct,
            mfe_pct:
              campaign.seedPriceUsd && campaign.peakPriceUsd
                ? (campaign.peakPriceUsd / campaign.seedPriceUsd - 1) * 100
                : null,
            mae_pct:
              campaign.seedPriceUsd && campaign.troughPriceUsd
                ? (campaign.troughPriceUsd / campaign.seedPriceUsd - 1) * 100
                : null,
            holding_seconds: Math.max(
              0,
              Math.round((campaign.closedAtMs - campaign.seedAvailableAtMs) / 1_000),
            ),
            winner: pnlPct === null ? null : pnlPct > 0,
            coverage_status: campaign.coverageStatus,
            market_data_reliable: campaign.marketDataReliable,
            target_attribution_reliable: campaign.targetAttributionReliable,
            metadata: {
              priceProxyOnly: true,
              executableQuoteUnavailable: true,
              note: "Not promotion-quality P&L; no executable fill path was stored.",
            },
          },
          { onConflict: "user_id,outcome_key" },
        );
        if (outcome.error) {
          throw new Error(`Revival outcome save failed: ${safeDiagnostic(outcome.error)}`);
        }
      }

      // campaign_id is the durable projection-complete marker. It is written
      // only after the campaign, transitions, actions, snapshots, and outcome
      // (when terminal) have all succeeded. A crash before this point is found
      // by loadProjectionRepairMints() on restart.
      for (const { event, campaign } of eventLinks) {
        const eventLink = await client
          .from("revival_events")
          .update({ campaign_id: campaign.id })
          .eq("user_id", userId)
          .eq("event_key", event.eventKey)
          .is("campaign_id", null);
        if (eventLink.error) {
          throw new Error(`Revival event link failed: ${safeDiagnostic(eventLink.error)}`);
        }
      }
    },

    async loadActiveCampaignMints(): Promise<string[]> {
      const result = await client
        .from("revival_campaigns")
        .select("token_mint")
        .eq("user_id", userId)
        .eq("engine_version", REVIVAL_ENGINE_VERSION)
        .is("closed_at", null)
        .not("state", "in", "(INVALIDATED,CLOSED)")
        .order("last_available_at", { ascending: false })
        .limit(500);
      if (result.error) {
        throw new Error(`Revival active campaign query failed: ${safeDiagnostic(result.error)}`);
      }
      return Array.from(
        new Set((result.data ?? []).map((row) => text(row.token_mint)).filter(Boolean)),
      );
    },

    async loadActiveTargetWallets(): Promise<string[]> {
      const result = await client
        .from("revival_campaigns")
        .select("target_wallets")
        .eq("user_id", userId)
        .eq("engine_version", REVIVAL_ENGINE_VERSION)
        .is("closed_at", null)
        .order("last_available_at", { ascending: false })
        .limit(500);
      if (result.error) {
        throw new Error(`Revival active target query failed: ${safeDiagnostic(result.error)}`);
      }
      const wallets = new Set<string>();
      for (const row of result.data ?? []) {
        if (!Array.isArray(row.target_wallets)) continue;
        for (const value of row.target_wallets) {
          const wallet = text(value).trim();
          if (wallet) wallets.add(wallet);
        }
      }
      return Array.from(wallets).sort();
    },

    async recordHeartbeat(input): Promise<void> {
      const nowMs = Date.now();
      const marketSamplingStale = revivalMarketSamplingIsStale(input.health, nowMs);
      const result = await client.from("revival_worker_heartbeat").upsert(
        {
          user_id: userId,
          started_at: input.startedAt,
          updated_at: new Date().toISOString(),
          enabled: input.enabled,
          target_wallet_count: input.targetWalletCount,
          initialized: input.health.initialized,
          event_count: input.health.eventCount,
          active_campaign_count: input.health.activeCampaignCount,
          pending_market_data_count: input.health.pendingMarketDataCount,
          last_event_at: input.health.lastObservationAt
            ? new Date(input.health.lastObservationAt).toISOString()
            : null,
          last_market_snapshot_at: input.health.lastMarketSnapshotAt
            ? new Date(input.health.lastMarketSnapshotAt).toISOString()
            : null,
          rpc_last_poll_at:
            typeof input.rpcHealth.lastPollAt === "number" && input.rpcHealth.lastPollAt > 0
              ? new Date(input.rpcHealth.lastPollAt).toISOString()
              : null,
          rpc_last_success_at:
            typeof input.rpcHealth.lastSuccessAt === "number" && input.rpcHealth.lastSuccessAt > 0
              ? new Date(input.rpcHealth.lastSuccessAt).toISOString()
              : null,
          rpc_backlog_wallet_count: Number(input.rpcHealth.backlogWalletCount ?? 0),
          degraded:
            Number(input.rpcHealth.backlogWalletCount ?? 0) > 0 ||
            Boolean(input.lastError) ||
            input.health.marketProviderReliable === false ||
            marketSamplingStale,
          last_error_code:
            input.lastError ??
            (input.health.marketProviderReliable === false
              ? `market_provider_unreliable_${input.health.consecutiveMarketProviderFailures}`
              : marketSamplingStale
                ? "market_sampling_stale"
                : null),
        },
        { onConflict: "user_id" },
      );
      if (result.error) {
        throw new Error(`Revival heartbeat save failed: ${safeDiagnostic(result.error)}`);
      }
    },
  };
}
