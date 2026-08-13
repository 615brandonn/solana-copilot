import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BrainCircuit, FlaskConical, Play, RefreshCw, Route, ScanSearch } from "lucide-react";

import { getStrategyInsights, runConvictionBacktest } from "@/lib/bot.functions";
import {
  DEFAULT_CONVICTION_BACKTEST_SETTINGS,
  type ConvictionBacktestResult,
  type ConvictionBacktestSettings,
} from "@/lib/conviction-lab";
import type { StrategyInsights, StrategyRecentObservation } from "@/lib/supabase-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

function BacktestNumberInput({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
          className="h-9 font-mono text-xs"
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[10px] text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function BacktestToggle({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/50 bg-background/30 px-3 py-2">
      <Label className="text-xs">{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function resultPct(value: number | null) {
  return value === null ? "No label data" : `${value.toFixed(1)}%`;
}

function ConvictionBacktestLab() {
  const [settings, setSettings] = useState<ConvictionBacktestSettings>(() => ({
    ...DEFAULT_CONVICTION_BACKTEST_SETTINGS,
  }));
  const mutation = useMutation({
    mutationFn: (next: ConvictionBacktestSettings) => runConvictionBacktest({ data: next }),
  });
  const result = mutation.data as ConvictionBacktestResult | undefined;
  const settingsChangedSinceRun =
    Boolean(result) &&
    (Object.keys(settings) as Array<keyof ConvictionBacktestSettings>).some(
      (key) => settings[key] !== result?.settings[key],
    );
  const setNumber = (key: keyof ConvictionBacktestSettings) => (value: number) =>
    setSettings((current) => ({ ...current, [key]: value }));

  return (
    <div>
      <div className="mb-4 rounded-xl border border-primary/25 bg-primary/5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <FlaskConical className="h-4 w-4 text-primary" /> Conviction threshold lab
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Replays only verified, historically valued target-wallet swaps through the same pure
              engine used by the worker, oldest to newest. Future commitment labels are calculated
              only after replay, so they cannot influence an earlier signal.
            </p>
          </div>
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
            Local test settings only
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <BacktestNumberInput
          label="History"
          value={settings.sinceDays}
          onChange={setNumber("sinceDays")}
          min={1}
          max={365}
          suffix="days"
        />
        <div className="space-y-1.5">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Leaderboard
          </Label>
          <select
            value={settings.leaderboardWindowMinutes}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                leaderboardWindowMinutes: Number(event.target.value) as 5 | 30 | 60,
              }))
            }
            className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs"
          >
            <option value={5}>5 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>60 minutes</option>
          </select>
        </div>
        <BacktestNumberInput
          label="Score threshold"
          value={settings.scoreThreshold}
          onChange={setNumber("scoreThreshold")}
          max={100}
        />
        <BacktestNumberInput
          label="Top N required"
          value={settings.topN}
          onChange={setNumber("topN")}
          min={1}
          max={10}
        />
        <BacktestNumberInput
          label="Minimum net"
          value={settings.minNetCommitmentUsd}
          onChange={setNumber("minNetCommitmentUsd")}
          suffix="$"
        />
        <BacktestNumberInput
          label="Recent net inflow"
          value={settings.minRecentNetInflowUsd}
          onChange={setNumber("minRecentNetInflowUsd")}
          step={0.01}
          suffix="$"
        />
        <BacktestNumberInput
          label="Capital velocity"
          value={settings.minCapitalVelocityUsdPerMinute}
          onChange={setNumber("minCapitalVelocityUsdPerMinute")}
          suffix="$/m"
        />
        <BacktestNumberInput
          label="Acceleration"
          value={settings.minCapitalAccelerationRatio}
          onChange={setNumber("minCapitalAccelerationRatio")}
          min={0}
          step={0.05}
          suffix="×"
        />
        <BacktestNumberInput
          label="Converged wallets"
          value={settings.minConvergedWallets}
          onChange={setNumber("minConvergedWallets")}
          min={1}
          max={3}
        />
        <BacktestNumberInput
          label="Minimum single buy"
          value={settings.minIndividualBuyUsd}
          onChange={setNumber("minIndividualBuyUsd")}
          suffix="$"
        />
        <BacktestNumberInput
          label="Max user exposure"
          value={settings.maxPositionPerTokenUsd}
          onChange={setNumber("maxPositionPerTokenUsd")}
          min={0.01}
          step={0.01}
          suffix="$"
        />
      </div>

      <details className="mt-4 rounded-xl border border-border/60 bg-background/20">
        <summary className="cursor-pointer px-4 py-3 text-xs font-medium">
          Advanced filters, weights, distribution, and scale-in tiers
        </summary>
        <div className="space-y-5 border-t border-border/50 p-4">
          <BacktestToggle
            label="Rapid Follow scale-ins"
            checked={settings.rapidFollowEnabled}
            onCheckedChange={(checked) =>
              setSettings((current) => ({ ...current, rapidFollowEnabled: checked }))
            }
          />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <BacktestNumberInput
              label="2-wallet window"
              value={settings.twoWalletWindowSeconds}
              onChange={setNumber("twoWalletWindowSeconds")}
              min={1}
              suffix="sec"
            />
            <BacktestNumberInput
              label="3-wallet window"
              value={settings.threeWalletWindowSeconds}
              onChange={setNumber("threeWalletWindowSeconds")}
              min={1}
              suffix="sec"
            />
            <BacktestNumberInput
              label="Data freshness"
              value={settings.dataFreshnessSeconds}
              onChange={setNumber("dataFreshnessSeconds")}
              min={1}
              suffix="sec"
            />
            <BacktestNumberInput
              label="Rank-loss grace"
              value={settings.rankLossGraceSeconds}
              onChange={setNumber("rankLossGraceSeconds")}
              min={0}
              suffix="sec"
            />
            <BacktestNumberInput
              label="New-token window"
              value={settings.lifecycleNewMinutes}
              onChange={setNumber("lifecycleNewMinutes")}
              min={1}
              suffix="min"
            />
            <BacktestNumberInput
              label="Revival inactivity"
              value={settings.lifecycleRevivalInactivityMinutes}
              onChange={setNumber("lifecycleRevivalInactivityMinutes")}
              min={1}
              suffix="min"
            />
            <BacktestNumberInput
              label="Distribution ratio"
              value={settings.distributionSellRatio}
              onChange={setNumber("distributionSellRatio")}
              min={0}
              max={1}
              step={0.01}
            />
            <BacktestNumberInput
              label="Distribution sells"
              value={settings.distributionMinSellsUsd}
              onChange={setNumber("distributionMinSellsUsd")}
              suffix="$"
            />
            <BacktestNumberInput
              label="Selling wallets"
              value={settings.distributionWalletCount}
              onChange={setNumber("distributionWalletCount")}
              min={1}
              max={3}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="space-y-3 rounded-xl border border-border/50 p-3">
              <BacktestToggle
                label="Market-cap filter"
                checked={settings.marketCapFilterEnabled}
                onCheckedChange={(checked) =>
                  setSettings((current) => ({ ...current, marketCapFilterEnabled: checked }))
                }
              />
              <div className="grid grid-cols-2 gap-2">
                <BacktestNumberInput
                  label="Minimum"
                  value={settings.marketCapMinUsd}
                  onChange={setNumber("marketCapMinUsd")}
                  suffix="$"
                />
                <BacktestNumberInput
                  label="Maximum"
                  value={settings.marketCapMaxUsd}
                  onChange={setNumber("marketCapMaxUsd")}
                  suffix="$"
                />
              </div>
            </div>
            <div className="space-y-3 rounded-xl border border-border/50 p-3">
              <BacktestToggle
                label="Liquidity filter"
                checked={settings.liquidityFilterEnabled}
                onCheckedChange={(checked) =>
                  setSettings((current) => ({ ...current, liquidityFilterEnabled: checked }))
                }
              />
              <div className="grid grid-cols-2 gap-2">
                <BacktestNumberInput
                  label="Minimum"
                  value={settings.liquidityMinUsd}
                  onChange={setNumber("liquidityMinUsd")}
                  suffix="$"
                />
                <BacktestNumberInput
                  label="Maximum"
                  value={settings.liquidityMaxUsd}
                  onChange={setNumber("liquidityMaxUsd")}
                  suffix="$"
                />
              </div>
            </div>
            <div className="space-y-3 rounded-xl border border-border/50 p-3">
              <BacktestToggle
                label="Token-age filter"
                checked={settings.tokenAgeFilterEnabled}
                onCheckedChange={(checked) =>
                  setSettings((current) => ({ ...current, tokenAgeFilterEnabled: checked }))
                }
              />
              <div className="grid grid-cols-2 gap-2">
                <BacktestNumberInput
                  label="Minimum"
                  value={settings.tokenAgeMinMinutes}
                  onChange={setNumber("tokenAgeMinMinutes")}
                  suffix="min"
                />
                <BacktestNumberInput
                  label="Maximum"
                  value={settings.tokenAgeMaxMinutes}
                  onChange={setNumber("tokenAgeMaxMinutes")}
                  suffix="min"
                />
              </div>
            </div>
          </div>

          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Score weights
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <BacktestNumberInput
                label="Net commitment"
                value={settings.weightNetCommitment}
                onChange={setNumber("weightNetCommitment")}
                max={100}
              />
              <BacktestNumberInput
                label="Velocity"
                value={settings.weightVelocity}
                onChange={setNumber("weightVelocity")}
                max={100}
              />
              <BacktestNumberInput
                label="Acceleration"
                value={settings.weightAcceleration}
                onChange={setNumber("weightAcceleration")}
                max={100}
              />
              <BacktestNumberInput
                label="Convergence"
                value={settings.weightConvergence}
                onChange={setNumber("weightConvergence")}
                max={100}
              />
              <BacktestNumberInput
                label="Rank persistence"
                value={settings.weightPersistence}
                onChange={setNumber("weightPersistence")}
                max={100}
              />
            </div>
          </div>

          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Rapid Follow scale-in tiers
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {([1, 2, 3, 4] as const).map((tier) => {
                const buyKey = `tier${tier}BuyUsd` as keyof ConvictionBacktestSettings;
                const commitmentKey =
                  `tier${tier}MinCommitmentUsd` as keyof ConvictionBacktestSettings;
                return (
                  <div
                    key={tier}
                    className="grid grid-cols-2 gap-2 rounded-xl border border-border/50 p-3"
                  >
                    <BacktestNumberInput
                      label={`Tier ${tier} buy`}
                      value={settings[buyKey] as number}
                      onChange={setNumber(buyKey)}
                      min={0.01}
                      step={0.01}
                      suffix="$"
                    />
                    <BacktestNumberInput
                      label="MM net"
                      value={settings[commitmentKey] as number}
                      onChange={setNumber(commitmentKey)}
                      min={1}
                      suffix="$"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </details>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button disabled={mutation.isPending} onClick={() => mutation.mutate(settings)}>
          {mutation.isPending ? (
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          {mutation.isPending ? "Replaying history…" : "Run historical backtest"}
        </Button>
        <Button
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => setSettings({ ...DEFAULT_CONVICTION_BACKTEST_SETTINGS })}
        >
          Reset test settings
        </Button>
        <span className="text-[10px] text-muted-foreground">
          Does not save settings, enable Entries, or submit transactions.
        </span>
      </div>

      {settingsChangedSinceRun ? (
        <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
          Test settings changed after this result was generated. Run the backtest again before
          comparing the numbers.
        </div>
      ) : null}

      {mutation.isError ? (
        <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : "The historical backtest could not be completed."}
        </div>
      ) : null}

      {result && result.observationsReplayed === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed border-border/70 px-5 py-8 text-center">
          <div className="text-sm font-medium">
            No production-equivalent target swaps were available to replay
          </div>
          <p className="mx-auto mt-1 max-w-2xl text-xs text-muted-foreground">
            Try a longer history window. The lab deliberately excludes observations whose USD value
            or worker verification evidence is missing instead of guessing.
          </p>
          <div className="mt-3 text-[10px] text-muted-foreground">
            {result.observationsLoaded.toLocaleString()} target swaps were loaded;{" "}
            {result.observationsProductionEquivalent.toLocaleString()} passed the conservative
            replay evidence gate.
          </div>
        </div>
      ) : result ? (
        <div className="mt-5 space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StrategyMetric
              label="$25K+ detected"
              value={resultPct(result.eventual25kDetectedPct)}
              detail="ever signaled during the replay"
            />
            <StrategyMetric
              label="$50K+ caught early"
              value={resultPct(result.eventual50kDetectedBefore5kPct)}
              detail="signal before MM net reached $5K"
            />
            <StrategyMetric
              label="$100K+ caught early"
              value={resultPct(result.eventual100kDetectedBefore5kPct)}
              detail="signal before MM net reached $5K"
            />
            <StrategyMetric
              label="Median first signal"
              value={usd(result.medianCommitmentAtFirstSignalUsd)}
              detail="cluster net at first signal"
            />
            <StrategyMetric
              label="False-positive rate"
              value={resultPct(result.falsePositiveRatePct)}
              detail="signals whose peak stayed below $5K"
            />
            <StrategyMetric
              label="Probe rejection rate"
              value={resultPct(result.probeRejectionRatePct)}
              detail="sub-$5K probes correctly rejected"
            />
            <StrategyMetric
              label="Tokens replayed"
              value={result.uniqueTokens}
              detail={`${result.observationsReplayed.toLocaleString()} verified, valued swaps`}
            />
            <StrategyMetric
              label="Tokens signaled"
              value={result.signaledTokenCount}
              detail={`${result.signalCount.toLocaleString()} qualifying timestamps`}
            />
            <StrategyMetric
              label="Hypothetical tiers"
              value={result.hypotheticalTierCount}
              detail={`${usd(result.hypotheticalExposureUsd)} shadow exposure`}
            />
          </div>

          <div className="overflow-hidden rounded-xl border border-border/60">
            <div className="border-b border-border/60 bg-background/30 px-4 py-3 text-xs font-medium">
              Detection by eventual peak MM commitment
            </div>
            <div className="grid grid-cols-[1fr_1fr_1fr_1fr] gap-2 border-b border-border/50 px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>Label</span>
              <span>Tokens</span>
              <span>Detected</span>
              <span>Rate</span>
            </div>
            {result.thresholds.map((metric) => (
              <div
                key={metric.thresholdUsd}
                className="grid grid-cols-[1fr_1fr_1fr_1fr] gap-2 border-b border-border/40 px-4 py-2.5 text-xs last:border-0"
              >
                <span className="font-mono">≥ {usd(metric.thresholdUsd)}</span>
                <span className="font-mono">{metric.eventualTokenCount}</span>
                <span className="font-mono">{metric.detectedTokenCount}</span>
                <span className="font-mono">{resultPct(metric.detectionRatePct)}</span>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-xl border border-border/60">
            <div className="border-b border-border/60 bg-background/30 px-4 py-3 text-xs font-medium">
              Event-time lifecycle segments
            </div>
            <div className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-2 border-b border-border/50 px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>Segment</span>
              <span>Swaps</span>
              <span>Tokens</span>
              <span>First signals</span>
              <span>Rate</span>
            </div>
            {result.lifecycleSegments.map((metric) => (
              <div
                key={metric.segment}
                className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr] gap-2 border-b border-border/40 px-4 py-2.5 text-xs last:border-0"
              >
                <span className="font-medium">{metric.segment.replaceAll("_", " ")}</span>
                <span className="font-mono">{metric.observationCount}</span>
                <span className="font-mono">{metric.uniqueTokenCount}</span>
                <span className="font-mono">{metric.firstSignalTokenCount}</span>
                <span className="font-mono">{resultPct(metric.firstSignalRatePct)}</span>
              </div>
            ))}
            <div className="border-t border-border/40 px-4 py-2 text-[10px] text-muted-foreground">
              Lifecycle is labeled at each historical timestamp without future data. A token can
              appear in more than one segment over time; this table does not affect entry rules.
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-background/25 p-4 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">Data quality and interpretation</div>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              <span>{result.observationsLoaded.toLocaleString()} target swaps loaded</span>
              <span>{result.observationsWithUsd.toLocaleString()} had historical USD values</span>
              <span>
                {result.observationsProductionEquivalent.toLocaleString()} had production-equivalent
                verification evidence
              </span>
              <span>
                {result.observationsExcludedUnverified.toLocaleString()} valued swaps excluded for
                missing verification or replay-identity evidence
              </span>
              <span>
                {result.observationsExcludedUnvalued.toLocaleString()} swaps excluded for missing
                USD values
              </span>
              <span>
                {result.observationsExcludedDelayedValuation.toLocaleString()} valued swaps excluded
                because a time-sensitive value lacked its own timely observation timestamp
              </span>
              <span>
                {result.observationsWithMarketCap.toLocaleString()} replayed swaps had market-cap
                snapshots
              </span>
              <span>
                {result.observationsWithLiquidity.toLocaleString()} replayed swaps had liquidity
                snapshots
              </span>
              <span>
                {result.marketCapSnapshotsExcludedForTiming.toLocaleString()} market-cap snapshots
                cleared because their observation time was missing or too late
              </span>
              <span>
                {result.liquiditySnapshotsExcludedForTiming.toLocaleString()} liquidity snapshots
                cleared because their observation time was missing or too late
              </span>
            </div>
            <ul className="mt-3 list-disc space-y-1 pl-4">
              {result.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
            <div className="mt-3 text-[10px]">
              Replay range:{" "}
              {result.observedFrom
                ? new Date(result.observedFrom).toLocaleString()
                : "no valued observations"}{" "}
              → {result.observedThrough ? new Date(result.observedThrough).toLocaleString() : "—"}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function StrategyLab() {
  const [strategy, setStrategy] = useState<"baseline" | "conviction">("baseline");
  const query = useQuery({
    queryKey: ["strategy-insights"],
    queryFn: () => getStrategyInsights(),
    enabled: strategy === "baseline",
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
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
        description="Compare the current strategy with Conviction Mode using real recorded target-wallet activity"
        icon={<BrainCircuit className="h-4 w-4" />}
      >
        <Tabs
          value={strategy}
          onValueChange={(value) => setStrategy(value as "baseline" | "conviction")}
        >
          <TabsList className="mb-5">
            <TabsTrigger value="baseline">Baseline / current strategy</TabsTrigger>
            <TabsTrigger value="conviction">Conviction Mode backtest</TabsTrigger>
          </TabsList>
        </Tabs>
        {strategy === "baseline" ? (
          query.isError ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              Strategy Lab data is temporarily unavailable. Trading continues normally.
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
                    {number(insights?.total_observations) > 0
                      ? "Live observations"
                      : "Waiting for observations"}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    updates automatically every 15 seconds
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
          )
        ) : (
          <ConvictionBacktestLab />
        )}
      </SectionCard>
    </div>
  );
}
