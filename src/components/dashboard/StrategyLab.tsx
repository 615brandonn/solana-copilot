import { useQuery } from "@tanstack/react-query";
import { BrainCircuit, RefreshCw, Route, ScanSearch } from "lucide-react";

import { getStrategyInsights } from "@/lib/bot.functions";
import type { StrategyInsights, StrategyRecentObservation } from "@/lib/supabase-types";
import { SectionCard } from "./SettingRow";

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usd(value: number | null) {
  if (value === null || !Number.isFinite(Number(value))) return "Learning";
  const amount = Number(value);
  return amount >= 1_000_000
    ? `$${(amount / 1_000_000).toFixed(2)}M`
    : amount >= 1_000
      ? `$${(amount / 1_000).toFixed(1)}K`
      : `$${amount.toFixed(2)}`;
}

function short(value: string) {
  return value.length > 10 ? `${value.slice(0, 5)}…${value.slice(-4)}` : value;
}

function duration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return "Learning";
  const amount = Number(value);
  return amount < 1_000 ? `${Math.round(amount)} ms` : `${(amount / 1_000).toFixed(2)} s`;
}

function observationLabel(row: StrategyRecentObservation) {
  if (row.event_kind === "transfer") {
    return row.relationship === "target" ? "Target transfer" : "Wallet transfer";
  }
  if (row.relationship === "follower" && row.side === "sell") return "Follower sell";
  return `${row.relationship === "target" ? "Target" : "Observed"} ${row.side ?? "swap"}`;
}

function StrategyMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-4">
      <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mono mt-1 text-xl font-semibold text-foreground">{value}</div>
      {detail && <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

export function StrategyLab() {
  const query = useQuery({
    queryKey: ["strategy-insights"],
    queryFn: () => getStrategyInsights(),
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 1_500,
    retry: false,
  });
  const insights = query.data as StrategyInsights | undefined;
  const recent = insights?.recent?.slice(0, 8) ?? [];
  const topFilterReasons = insights?.top_filter_reasons ?? [];
  const lastUpdated =
    query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt).toLocaleTimeString() : "connecting";

  return (
    <div className="mt-6">
      <SectionCard
        title="Strategy Lab"
        description="Read-only observations from the target and retained sell-wallet chain · last 24 hours"
        icon={<BrainCircuit className="h-4 w-4" />}
      >
        {query.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            Strategy Lab is waiting for its Supabase v11 update. Trading continues normally.
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-success/25 bg-success/5 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-50" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
                </span>
                <span className="mono text-[10px] font-semibold uppercase tracking-[0.18em] text-success">
                  Live learning
                </span>
                <span className="text-[11px] text-muted-foreground">
                  updates automatically every 3 seconds
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <RefreshCw className={`h-3 w-3 ${query.isFetching ? "animate-spin" : ""}`} />
                Last update: {lastUpdated}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StrategyMetric
                label="Target buys"
                value={number(insights?.target_buys)}
                detail={`${number(insights?.copied_buys)} copied · ${number(insights?.filtered_buys)} filtered`}
              />
              <StrategyMetric
                label="Sell signals"
                value={number(insights?.follower_sells)}
                detail={`${number(insights?.target_sells)} direct target sells observed`}
              />
              <StrategyMetric
                label="Transfer behavior"
                value={number(insights?.target_transfers)}
                detail={`${number(insights?.average_transfer_recipients).toFixed(1)} wallets per split`}
              />
              <StrategyMetric
                label="Tokens studied"
                value={number(insights?.unique_mints)}
                detail={`${number(insights?.total_observations)} total observations`}
              />
              <StrategyMetric
                label="Median buy size"
                value={usd(insights?.median_target_buy_usd ?? null)}
              />
              <StrategyMetric
                label="Median market cap"
                value={usd(insights?.median_entry_market_cap_usd ?? null)}
              />
              <StrategyMetric
                label="Median liquidity"
                value={usd(insights?.median_entry_liquidity_usd ?? null)}
              />
              <StrategyMetric
                label="Most active hour"
                value={
                  insights?.most_active_hour_utc == null
                    ? "Learning"
                    : `${String(insights.most_active_hour_utc).padStart(2, "0")}:00 UTC`
                }
              />
              <StrategyMetric
                label="Buy response"
                value={duration(insights?.median_buy_reaction_ms)}
                detail={`${duration(insights?.median_buy_execution_ms)} median execution`}
              />
              <StrategyMetric
                label="Follower-sell response"
                value={duration(insights?.median_sell_reaction_ms)}
                detail={`${duration(insights?.median_sell_execution_ms)} median execution`}
              />
              <StrategyMetric
                label="Learning confidence"
                value={`${number(insights?.learning_confidence_pct).toFixed(0)}%`}
                detail="reaches 100% after 50 observed target buys"
              />
              <StrategyMetric
                label="Failed actions"
                value={number(insights?.failed_actions)}
                detail="recorded execution or persistence failures"
              />
            </div>

            <div className="mt-5 rounded-xl border border-border/60 bg-background/25 p-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Most common reasons a target buy was not copied
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {topFilterReasons.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    Learning as more target buys arrive.
                  </span>
                ) : (
                  topFilterReasons.map((item) => (
                    <span
                      key={item.reason}
                      className="rounded-full border border-border/70 bg-background/50 px-3 py-1.5 text-[11px]"
                    >
                      {item.reason}{" "}
                      <span className="mono text-muted-foreground">x{item.count}</span>
                    </span>
                  ))
                )}
              </div>
            </div>

            <div className="mt-5 overflow-hidden rounded-xl border border-border/60">
              <div className="flex items-center justify-between border-b border-border/60 bg-background/30 px-4 py-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <ScanSearch className="h-4 w-4 text-primary" />
                  Recent observations
                </div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Route className="h-3 w-3" />
                  recorder only — no extra trades
                </div>
              </div>
              <div className="divide-y divide-border/50">
                {recent.length === 0 && (
                  <div className="p-6 text-center text-xs text-muted-foreground">
                    {query.isLoading
                      ? "Loading observations…"
                      : "Learning begins as the target and retained wallets transact."}
                  </div>
                )}
                {recent.map((row) => (
                  <div
                    key={row.event_key}
                    className="grid gap-2 px-4 py-3 text-xs sm:grid-cols-[150px_1fr_auto]"
                  >
                    <div>
                      <div className="font-medium capitalize">{observationLabel(row)}</div>
                      <div className="mono text-[10px] text-muted-foreground">
                        {new Date(row.event_at).toLocaleTimeString()}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="mono truncate">{short(row.token_mint)}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {row.bot_reason ?? `${number(row.amount_tokens).toLocaleString()} tokens`}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="mono">{usd(row.amount_usd)}</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {row.bot_decision ?? row.source}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}
