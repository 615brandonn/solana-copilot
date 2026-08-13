import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BrainCircuit,
  CircleGauge,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
  Zap,
} from "lucide-react";

import { getConvictionDashboard, getConvictionTokenDetail } from "@/lib/bot.functions";
import type {
  ConvictionDashboardData,
  ConvictionTokenDetailData,
  ConvictionTokenStateRow,
  ConvictionWindowMinutes,
  SerializableJson,
} from "@/lib/conviction-lab";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SectionCard } from "./SettingRow";

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usd(value: unknown, unavailable = "—") {
  if (value === null || value === undefined || value === "") return unavailable;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return unavailable;
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1)}K`;
  return `${sign}$${absolute.toFixed(absolute >= 100 ? 0 : 2)}`;
}

function ratio(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${amount.toFixed(2)}×` : "—";
}

function short(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

function time(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleTimeString() : "—";
}

function stateClass(state: string) {
  if (state === "HIGH_CONVICTION") return "border-success/35 bg-success/10 text-success";
  if (state === "BETTING") return "border-primary/35 bg-primary/10 text-primary";
  if (state === "ACCUMULATING") return "border-cyan-400/35 bg-cyan-400/10 text-cyan-300";
  if (state === "DISTRIBUTING") return "border-destructive/35 bg-destructive/10 text-destructive";
  return "border-border/70 bg-muted/30 text-muted-foreground";
}

function directionIcon(direction: string) {
  if (direction === "up") return <ArrowUp className="h-3.5 w-3.5 text-success" />;
  if (direction === "down") return <ArrowDown className="h-3.5 w-3.5 text-destructive" />;
  return <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />;
}

function jsonRecord(value: SerializableJson | undefined): Record<string, SerializableJson> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function optionalNumber(value: SerializableJson | undefined): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringArray(value: SerializableJson | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function rankForWindow(row: ConvictionTokenStateRow, windowMinutes: ConvictionWindowMinutes) {
  const ranks = jsonRecord(row.rolling_metrics.ranks);
  const persisted = jsonRecord(ranks?.[String(windowMinutes)]);
  if (persisted) {
    const current = optionalNumber(persisted.currentRank);
    const previous = optionalNumber(persisted.previousRank);
    const rawDirection = persisted.direction;
    return {
      // A persisted rank object with no currentRank is authoritative: the token
      // has left this leaderboard. Do not revive it from old rank-history rows.
      rank: current !== null && current > 0 ? current : null,
      previousRank: previous !== null && previous > 0 ? previous : null,
      direction: typeof rawDirection === "string" ? rawDirection : "new",
    };
  }

  // Compatibility for state rows written before all-window rank snapshots were
  // embedded in rolling_metrics. The scalar columns represent the 30m rank.
  if (windowMinutes !== 30) return { rank: null, previousRank: null, direction: "out" };
  return {
    rank: row.current_rank,
    previousRank: row.previous_rank,
    direction: row.rank_direction,
  };
}

function metricsForWindow(row: ConvictionTokenStateRow, windowMinutes: ConvictionWindowMinutes) {
  const windows = jsonRecord(row.rolling_metrics.windows);
  const persisted = jsonRecord(windows?.[String(windowMinutes * 60)]);
  const windowScores = jsonRecord(row.rolling_metrics.windowScores);
  const persistedScore = jsonRecord(windowScores?.[String(windowMinutes)]);
  const score = optionalNumber(persistedScore?.score);
  const state = persistedScore?.state;
  const reasons = stringArray(persistedScore?.reasons);
  return {
    velocity:
      optionalNumber(persisted?.capitalVelocityUsdPerMinute) ?? row.capital_velocity_usd_per_min,
    acceleration: optionalNumber(persisted?.accelerationSignal) ?? row.capital_acceleration_ratio,
    buySizeAcceleration:
      optionalNumber(persisted?.buySizeAcceleration) ?? row.buy_size_acceleration_ratio,
    score: score ?? row.conviction_score,
    state:
      typeof state === "string" &&
      [
        "TESTING",
        "WATCHING",
        "ACCUMULATING",
        "BETTING",
        "HIGH_CONVICTION",
        "DISTRIBUTING",
      ].includes(state)
        ? state
        : row.conviction_state,
    reasons: reasons.length > 0 ? reasons : row.score_reasons,
  };
}

function ConvictionTokenDetail({
  tokenMint,
  windowMinutes,
  onClose,
}: {
  tokenMint: string;
  windowMinutes: ConvictionWindowMinutes;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["conviction-token-detail", tokenMint],
    queryFn: () => getConvictionTokenDetail({ data: { tokenMint } }),
    enabled: Boolean(tokenMint),
    staleTime: 10_000,
    retry: false,
  });
  const detail = query.data as ConvictionTokenDetailData | undefined;
  const state = detail?.state;
  const windowMetrics = state ? metricsForWindow(state, windowMinutes) : null;
  // Only current score components belong in the current score explanation.
  // Historical transition reasons are shown with their own timestamp below.
  const reasons = Array.from(new Set(windowMetrics?.reasons ?? [])).slice(0, 12);

  return (
    <Dialog open={Boolean(tokenMint)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {state?.symbol || short(tokenMint)}
            {state ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] ${stateClass(windowMetrics?.state ?? state.conviction_state)}`}
              >
                {(windowMetrics?.state ?? state.conviction_state).replaceAll("_", " ")}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription className="break-all font-mono text-[11px]">
            {tokenMint}
          </DialogDescription>
        </DialogHeader>

        {query.isLoading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Loading token history…
          </div>
        ) : query.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {query.error instanceof Error
              ? query.error.message
              : "Conviction token detail is temporarily unavailable."}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <DetailMetric
                label={`${windowMinutes}m score`}
                value={windowMetrics ? `${number(windowMetrics.score).toFixed(0)}/100` : "—"}
              />
              <DetailMetric label="Cluster net" value={usd(state?.net_cluster_investment_usd)} />
              <DetailMetric label="Largest buy" value={usd(state?.largest_buy_usd)} />
              <DetailMetric
                label="Wallet convergence"
                value={state ? `${state.wallet_convergence_count}/3` : "—"}
              />
            </div>

            <div className="rounded-xl border border-border/60 bg-background/25 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-medium">MM buy sequence</div>
                <div className="text-[10px] text-muted-foreground">
                  oldest → newest · up to 150 events
                </div>
              </div>
              {detail?.buys.length ? (
                <>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                    {detail.buys.slice(-16).map((event, index, rows) => (
                      <span key={event.event_key} className="flex items-center gap-1.5">
                        <span className="rounded-md border border-primary/20 bg-primary/5 px-2 py-1 font-mono">
                          {usd(event.amount_usd, "unvalued")}
                        </span>
                        {index < rows.length - 1 ? (
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        ) : null}
                      </span>
                    ))}
                  </div>
                  <div className="mt-4 max-h-56 overflow-auto rounded-lg border border-border/50">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Time</TableHead>
                          <TableHead>Wallet</TableHead>
                          <TableHead>Buy</TableHead>
                          <TableHead>Market cap</TableHead>
                          <TableHead>Quality</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.buys.map((event) => (
                          <TableRow key={event.event_key}>
                            <TableCell className="whitespace-nowrap font-mono text-[11px]">
                              {time(event.event_at)}
                            </TableCell>
                            <TableCell className="font-mono text-[11px]" title={event.actor_wallet}>
                              {short(event.actor_wallet)}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {usd(event.amount_usd, "unvalued")}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {usd(event.market_cap_usd)}
                            </TableCell>
                            <TableCell className="text-[10px]">
                              {event.data_reliable ? (
                                <span className="text-success">reliable</span>
                              ) : (
                                <span className="text-amber-400">partial</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              ) : (
                <div className="mt-3 text-xs text-muted-foreground">
                  No classified cluster buys have been persisted for this token.
                </div>
              )}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-background/25 p-4">
                <div className="text-xs font-medium">
                  Why {windowMinutes}m conviction score ={" "}
                  {windowMetrics ? number(windowMetrics.score).toFixed(0) : "—"}
                </div>
                <ul className="mt-3 space-y-2 text-xs">
                  {reasons.length ? (
                    reasons.map((reason) => (
                      <li key={reason} className="flex gap-2 text-muted-foreground">
                        <span
                          className={
                            reason.trim().startsWith("-") ? "text-destructive" : "text-success"
                          }
                        >
                          {reason.trim().startsWith("-") ? "−" : "+"}
                        </span>
                        <span>{reason.replace(/^[+-]\s*/, "")}</span>
                      </li>
                    ))
                  ) : (
                    <li className="text-muted-foreground">
                      The engine has not persisted score reasons yet.
                    </li>
                  )}
                </ul>
              </div>
              <div className="rounded-xl border border-border/60 bg-background/25 p-4">
                <div className="text-xs font-medium">Entry / Rapid Follow tiers</div>
                <div className="mt-3 space-y-2">
                  {detail?.tiers.length ? (
                    detail.tiers.map((tier) => (
                      <div
                        key={`${tier.trading_mode}:${tier.tier_number}:${tier.source_event_key ?? ""}`}
                        className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2 text-xs"
                      >
                        <span>Tier {tier.tier_number}</span>
                        <span className="text-right font-mono text-muted-foreground">
                          {usd(tier.amount_usd)} · {tier.trading_mode.toUpperCase()} ·{" "}
                          {tier.status || "recorded"}
                          {tier.executed_at ? (
                            <span className="block text-[9px]">{time(tier.executed_at)}</span>
                          ) : null}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      No entry or scale-in tier has fired.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-border/60 bg-background/25 p-4">
                <div className="text-xs font-medium">Recent rank history</div>
                <div className="mt-3 max-h-52 space-y-1.5 overflow-auto">
                  {detail?.ranks.length ? (
                    detail.ranks.slice(0, 16).map((rank, index) => (
                      <div
                        key={`${rank.window_minutes}:${rank.recorded_at}:${index}`}
                        className="grid grid-cols-[72px_1fr_auto] items-center gap-2 rounded-lg border border-border/40 px-3 py-2 text-[11px]"
                      >
                        <span className="font-mono">
                          {rank.window_minutes}m · #{rank.rank}
                        </span>
                        <span className="text-muted-foreground">
                          score {number(rank.conviction_score).toFixed(0)} · flow{" "}
                          {usd(rank.net_flow_usd)}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {time(rank.recorded_at)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      No rank snapshots have been persisted yet.
                    </div>
                  )}
                </div>
              </div>
              <div className="rounded-xl border border-border/60 bg-background/25 p-4">
                <div className="text-xs font-medium">State and safety events</div>
                <div className="mt-3 max-h-52 space-y-1.5 overflow-auto">
                  {detail?.transitions.length ? (
                    detail.transitions.slice(0, 16).map((transition, index) => (
                      <div
                        key={`${transition.event_type}:${transition.occurred_at}:${index}`}
                        className="rounded-lg border border-border/40 px-3 py-2 text-[11px]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">
                            {transition.event_type.replaceAll("_", " ")}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {time(transition.occurred_at)}
                          </span>
                        </div>
                        {transition.previous_state || transition.new_state ? (
                          <div className="mt-1 text-muted-foreground">
                            {transition.previous_state ?? "—"} → {transition.new_state ?? "—"}
                            {transition.new_score != null
                              ? ` · score ${number(transition.new_score).toFixed(0)}`
                              : ""}
                          </div>
                        ) : null}
                        {transition.reasons.length ? (
                          <div className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">
                            {transition.reasons.slice(0, 2).join(" · ")}
                          </div>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      No state transitions or safety events have been persisted yet.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <a
              href={`https://solscan.io/token/${tokenMint}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              View token on Solscan <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/25 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-base font-semibold">{value}</div>
    </div>
  );
}

export function ConvictionDashboard({
  enabled,
  tradingMode,
}: {
  enabled: boolean;
  tradingMode: "shadow" | "live";
}) {
  const [windowMinutes, setWindowMinutes] = useState<ConvictionWindowMinutes>(30);
  const [selectedMint, setSelectedMint] = useState("");
  const query = useQuery({
    queryKey: ["conviction-dashboard", windowMinutes],
    queryFn: () => getConvictionDashboard({ data: { windowMinutes } }),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
    retry: false,
  });
  const dashboard = query.data as ConvictionDashboardData | undefined;
  const states = [...(dashboard?.states ?? [])]
    .filter((row) => {
      const rank = rankForWindow(row, windowMinutes).rank;
      // `rolling_metrics.ranks` is the engine's authoritative current view.
      // A token with no current rank has already dropped out; adding a second
      // browser-side activity rule would incorrectly hide valid ranked tokens.
      return rank != null && rank <= 10;
    })
    .sort((left, right) => {
      const leftRank = rankForWindow(left, windowMinutes).rank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rankForWindow(right, windowMinutes).rank ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || right.conviction_score - left.conviction_score;
    })
    .slice(0, 10);

  return (
    <div className="mt-6">
      <SectionCard
        title="Conviction Leaderboard"
        description="Which token is currently winning the competition for the market-maker cluster’s money? Top 10 is watch-only; Top 3 still requires absolute entry thresholds."
        icon={<CircleGauge className="h-4 w-4" />}
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              value={String(windowMinutes)}
              onValueChange={(value) => setWindowMinutes(Number(value) as ConvictionWindowMinutes)}
            >
              <TabsList>
                <TabsTrigger value="5">5 minutes</TabsTrigger>
                <TabsTrigger value="30">30 minutes</TabsTrigger>
                <TabsTrigger value="60">60 minutes</TabsTrigger>
              </TabsList>
            </Tabs>
            <span
              className={`rounded-full border px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wider ${
                !enabled
                  ? "border-border/70 text-muted-foreground"
                  : tradingMode === "shadow"
                    ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
                    : "border-success/30 bg-success/10 text-success"
              }`}
            >
              {!enabled ? "Conviction off" : tradingMode === "shadow" ? "Shadow only" : "Live mode"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <RefreshCw className={`h-3 w-3 ${query.isFetching ? "animate-spin" : ""}`} />
            {dashboard
              ? `${states.length}/10 ranked · refreshed ${time(dashboard.generatedAt)}`
              : "Connecting"}
          </div>
        </div>

        <div className="mb-3 text-[10px] text-muted-foreground">
          The selected window controls rank, score, velocity, and acceleration. The 1m, 5m, and 30m
          flow columns stay visible together for context.
        </div>

        {query.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {query.error instanceof Error
              ? query.error.message
              : "Conviction leaderboard is temporarily unavailable."}
          </div>
        ) : states.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/70 px-5 py-10 text-center">
            <BrainCircuit className="mx-auto h-6 w-6 text-muted-foreground" />
            <div className="mt-3 text-sm font-medium">
              {query.isLoading
                ? "Loading Conviction state…"
                : dashboard?.states.length
                  ? "No token has a current rank in this window"
                  : "Waiting for classified cluster activity"}
            </div>
            <p className="mx-auto mt-1 max-w-xl text-xs text-muted-foreground">
              The leaderboard fills from persisted events across all configured MM wallets. Empty
              data never implies a qualifying signal.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/60">
            <Table className="min-w-[1400px]">
              <TableHeader>
                <TableRow className="bg-background/40 text-[10px] uppercase tracking-wider">
                  <TableHead className="w-14">Rank</TableHead>
                  <TableHead>Token / state</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Cluster net</TableHead>
                  <TableHead>1m flow</TableHead>
                  <TableHead>5m flow</TableHead>
                  <TableHead>30m flow</TableHead>
                  <TableHead>Velocity</TableHead>
                  <TableHead>Acceleration</TableHead>
                  <TableHead>Largest buy</TableHead>
                  <TableHead>Wallets</TableHead>
                  <TableHead>MC / liquidity</TableHead>
                  <TableHead title="Live exposure in LIVE mode; real base plus hypothetical tiers in SHADOW mode">
                    Strategy exposure
                  </TableHead>
                  <TableHead>Rapid Follow</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {states.map((row) => {
                  const rankSnapshot = rankForWindow(row, windowMinutes);
                  const rank = rankSnapshot.rank;
                  const direction = rankSnapshot.direction;
                  const windowMetrics = metricsForWindow(row, windowMinutes);
                  return (
                    <TableRow
                      key={row.token_mint}
                      tabIndex={0}
                      role="button"
                      aria-label={`Open Conviction detail for ${row.symbol || row.token_mint}`}
                      onClick={() => setSelectedMint(row.token_mint)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ")
                          setSelectedMint(row.token_mint);
                      }}
                      className="cursor-pointer text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    >
                      <TableCell>
                        <div className="flex items-center gap-1 font-mono font-semibold">
                          {directionIcon(direction)} #{rank ?? "—"}
                        </div>
                        <div className="mt-0.5 text-[9px] uppercase text-muted-foreground">
                          {rank != null && rank <= 3
                            ? "top 3"
                            : rank != null && rank <= 10
                              ? "watch"
                              : "active"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 font-medium">
                          <span title={row.token_mint}>{row.symbol || short(row.token_mint)}</span>
                          {!row.data_reliable ? (
                            <ShieldAlert
                              className="h-3.5 w-3.5 text-amber-400"
                              aria-label="Partial data"
                            />
                          ) : null}
                        </div>
                        <span
                          className={`mt-1 inline-flex rounded-full border px-1.5 py-0.5 text-[9px] ${stateClass(windowMetrics.state)}`}
                        >
                          {windowMetrics.state.replaceAll("_", " ")}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-sm font-semibold">
                        {number(windowMetrics.score).toFixed(0)}
                      </TableCell>
                      <TableCell className="font-mono">
                        {usd(row.net_cluster_investment_usd)}
                      </TableCell>
                      <TableCell
                        className={`font-mono ${row.net_flow_1m_usd < 0 ? "text-destructive" : ""}`}
                      >
                        {usd(row.net_flow_1m_usd)}
                      </TableCell>
                      <TableCell
                        className={`font-mono ${row.net_flow_5m_usd < 0 ? "text-destructive" : ""}`}
                      >
                        {usd(row.net_flow_5m_usd)}
                      </TableCell>
                      <TableCell
                        className={`font-mono ${row.net_flow_30m_usd < 0 ? "text-destructive" : ""}`}
                      >
                        {usd(row.net_flow_30m_usd)}
                      </TableCell>
                      <TableCell className="font-mono">
                        {usd(windowMetrics.velocity)}
                        /m
                      </TableCell>
                      <TableCell>
                        <div className="font-mono">flow {ratio(windowMetrics.acceleration)}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          size {ratio(windowMetrics.buySizeAcceleration)}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono">{usd(row.largest_buy_usd)}</TableCell>
                      <TableCell>
                        <div className="font-mono">{row.wallet_convergence_count}/3</div>
                        <div className="text-[10px] text-muted-foreground">
                          {row.wallets_currently_accumulating.length} active
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-mono">{usd(row.market_cap_usd)}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          liq {usd(row.liquidity_usd)}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono">
                        {usd(row.our_current_position_usd)}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[9px] uppercase ${row.rapid_follow_status.toLowerCase().includes("active") ? "border-success/30 bg-success/10 text-success" : "border-border/60 text-muted-foreground"}`}
                        >
                          <Zap className="h-3 w-3" /> {row.rapid_follow_status || "inactive"}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span>
            Click a token for its MM buy sequence, score explanation, rank history, and scale-in
            tiers.
          </span>
          <span>
            {!enabled
              ? "Conviction entries are off; persisted history stays visible."
              : tradingMode === "shadow"
                ? "Shadow mode ranks and records hypothetical tiers but cannot submit a transaction."
                : "Live mode still requires Entries and every safety gate before submission."}
          </span>
          <span className="w-full">
            Unknown or unreliable classifications remain visible for diagnosis but cannot authorize
            an entry.
          </span>
        </div>
      </SectionCard>
      {selectedMint ? (
        <ConvictionTokenDetail
          tokenMint={selectedMint}
          windowMinutes={windowMinutes}
          onClose={() => setSelectedMint("")}
        />
      ) : null}
    </div>
  );
}
