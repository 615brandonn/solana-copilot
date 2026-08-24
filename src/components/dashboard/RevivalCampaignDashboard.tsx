import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, ExternalLink, Radar, ShieldCheck } from "lucide-react";
import { getRevivalCampaignDetail, getRevivalDashboard } from "@/lib/bot.functions";
import type {
  RevivalCampaignDetail,
  RevivalCampaignState,
  RevivalCampaignSummary,
  RevivalDashboardData,
  RevivalDetailRow,
} from "@/lib/revival";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SectionCard } from "./SettingRow";
import { solscanTokenUrl } from "./revival-solscan";

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1)}K`;
  return `${sign}$${absolute.toFixed(absolute >= 100 ? 0 : 2)}`;
}

function short(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-5)}` : value;
}

function relativeTime(value: string | null | undefined) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function stateClass(state: RevivalCampaignState) {
  if (state === "ENTRY_READY") return "border-emerald-400/35 bg-emerald-400/10 text-emerald-300";
  if (state === "RETAIL_IGNITION") return "border-amber-400/35 bg-amber-400/10 text-amber-300";
  if (state === "DISTRIBUTION_RISK")
    return "border-destructive/35 bg-destructive/10 text-destructive";
  if (state === "COVERAGE_GAP") return "border-orange-400/35 bg-orange-400/10 text-orange-300";
  if (state === "INVALIDATED" || state === "CLOSED")
    return "border-border/70 bg-muted/30 text-muted-foreground";
  return "border-cyan-400/35 bg-cyan-400/10 text-cyan-300";
}

function TokenMintLink({ tokenMint }: { tokenMint: string }) {
  const href = solscanTokenUrl(tokenMint);
  const label = short(tokenMint);

  if (!href) {
    return (
      <span className="font-mono text-[10px] text-muted-foreground" title={tokenMint}>
        {label}
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-mono text-[10px] text-cyan-300 hover:underline"
      title={`Open ${tokenMint} on Solscan`}
      aria-label={`Open token contract ${tokenMint} on Solscan`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {label}
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
    </a>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/15 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm">{value}</div>
    </div>
  );
}

function detailRecord(value: unknown): RevivalDetailRow | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RevivalDetailRow)
    : null;
}

function pairAgeAtSeed(detail: RevivalCampaignDetail | undefined): string {
  const snapshot = detail?.marketSnapshots.find((row) => row.reliable === true);
  const metadata = detailRecord(snapshot?.metadata);
  const pairCreatedAtMs = Number(metadata?.pairCreatedAtMs ?? Number.NaN);
  const seededAtMs = Date.parse(detail?.campaign.seededAt ?? "");
  if (!Number.isFinite(pairCreatedAtMs) || !Number.isFinite(seededAtMs)) return "Unknown";
  const days = Math.max(0, (seededAtMs - pairCreatedAtMs) / 86_400_000);
  return days >= 365 ? `${(days / 365).toFixed(1)}y` : `${days.toFixed(days >= 10 ? 0 : 1)}d`;
}

function CampaignDetail({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const query = useQuery({
    queryKey: ["revival-campaign-detail", campaignId],
    queryFn: () => getRevivalCampaignDetail({ data: { campaignId } }),
    enabled: Boolean(campaignId),
    retry: false,
  });
  const detail = query.data as RevivalCampaignDetail | undefined;
  const campaign = detail?.campaign;
  const seedMarket = detail?.marketSnapshots.find((row) => row.reliable === true);
  const outcome = detailRecord(detail?.outcome);
  return (
    <Dialog open={Boolean(campaignId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {campaign?.symbol || (campaign ? short(campaign.tokenMint) : "Revival campaign")}
            {campaign ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] ${stateClass(campaign.state)}`}
              >
                {campaign.state.replaceAll("_", " ")}
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            Shadow evidence only. No row in this panel can submit a transaction.
          </DialogDescription>
        </DialogHeader>

        {query.isLoading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Loading campaign evidence…
          </div>
        ) : query.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {query.error instanceof Error ? query.error.message : "Revival detail unavailable."}
          </div>
        ) : campaign ? (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Seed MC" value={usd(campaign.seedMarketCapUsd)} />
              <Metric label="Latest MC" value={usd(campaign.latestMarketCapUsd)} />
              <Metric label="Target net" value={usd(campaign.targetNetCommitmentUsd)} />
              <Metric
                label="Buy / sell facts"
                value={`${campaign.targetBuyCount} / ${campaign.targetSellCount}`}
              />
              <Metric label="Accumulation" value={`${campaign.accumulationScore.toFixed(0)}/100`} />
              <Metric label="Ignition" value={`${campaign.ignitionScore.toFixed(0)}/100`} />
              <Metric label="Distribution" value={`${campaign.distributionScore.toFixed(0)}/100`} />
              <Metric label="Coverage" value={campaign.coverageStatus} />
              <Metric label="Pair age proxy" value={pairAgeAtSeed(detail)} />
              <Metric
                label="Seed 24h volume"
                value={usd(Number(seedMarket?.volume_h24_usd ?? Number.NaN))}
              />
              <Metric
                label="Seed liquidity"
                value={usd(Number(seedMarket?.liquidity_usd ?? Number.NaN))}
              />
              <Metric label="Historical ATH" value="Not inferred" />
              <Metric label="Observed MFE" value={pct(campaign.mfePct)} />
              <Metric label="Observed MAE" value={pct(campaign.maePct)} />
              <Metric
                label="Price-proxy result"
                value={pct(Number(outcome?.pnl_pct ?? Number.NaN))}
              />
              <Metric label="Outcome status" value={String(outcome?.status ?? "Open")} />
            </div>

            <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/5 px-4 py-3 text-xs text-muted-foreground">
              “Pair age” is a market-pair proxy, not proof of token creation date. Historical ATH is
              deliberately left unknown until a causal history provider is added; the tracker never
              invents old/dead-coin evidence. Closed-campaign P/L is a price-path proxy only—not an
              executable fill, fee, slippage, or audited profit result.
            </div>

            <div className="rounded-xl border border-border/60 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide">State transitions</h3>
              <div className="mt-3 space-y-2">
                {(detail?.transitions ?? []).map((row, index) => (
                  <div
                    key={String(row.transition_key ?? index)}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2 text-xs last:border-0"
                  >
                    <span className="font-mono">
                      {String(row.from_state ?? "START")} → {String(row.to_state ?? "UNKNOWN")}
                    </span>
                    <span className="text-muted-foreground">
                      {relativeTime(String(row.available_at ?? ""))}
                    </span>
                  </div>
                ))}
                {(detail?.transitions.length ?? 0) === 0 ? (
                  <p className="text-xs text-muted-foreground">No persisted transition rows yet.</p>
                ) : null}
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-border/60 p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide">Target evidence</h3>
                <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
                  {(detail?.events ?? [])
                    .filter((row) => String(row.event_type ?? "").startsWith("TARGET_"))
                    .map((row, index) => (
                      <div
                        key={String(row.event_key ?? index)}
                        className="rounded-lg bg-muted/20 px-3 py-2 text-xs"
                      >
                        <div className="flex justify-between gap-3">
                          <span className="font-mono">{String(row.event_type ?? "EVENT")}</span>
                          <span>{usd(Number(row.amount_usd ?? Number.NaN))}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          {String(row.classification_reliable ? "verified" : "unverified")} ·{" "}
                          {relativeTime(String(row.available_at ?? ""))}
                        </div>
                      </div>
                    ))}
                </div>
              </div>

              <div className="rounded-xl border border-border/60 p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide">Shadow decisions</h3>
                <div className="mt-3 space-y-2">
                  {(detail?.shadowActions ?? []).map((row, index) => (
                    <div
                      key={String(row.action_key ?? index)}
                      className="rounded-lg bg-muted/20 px-3 py-2 text-xs"
                    >
                      <div className="font-mono">{String(row.action_type ?? "SKIP")}</div>
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {String(row.reason ?? "No reason recorded")}
                      </div>
                    </div>
                  ))}
                  {(detail?.shadowActions.length ?? 0) === 0 ? (
                    <p className="text-xs text-muted-foreground">No paper action has qualified.</p>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function RevivalCampaignDashboard({
  enabled,
  marketCapMinUsd,
  marketCapMaxUsd,
}: {
  enabled: boolean;
  marketCapMinUsd: number;
  marketCapMaxUsd: number;
}) {
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["revival-dashboard"],
    queryFn: () => getRevivalDashboard(),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const data = query.data as RevivalDashboardData | undefined;
  const health = data?.health;
  const healthText = !enabled
    ? "OFF — collected history remains available"
    : !health?.installed
      ? "NOT STARTED"
      : !health.enabled
        ? "OBSERVER OFF"
        : health.online && !health.degraded
          ? "LIVE"
          : health.degraded
            ? "DEGRADED"
            : "STALE";

  return (
    <div className="mt-6">
      <SectionCard
        title="Revival Campaigns"
        description="From the target's first seed through accumulation, market ignition, and distribution"
        icon={<Radar className="h-4 w-4" />}
      >
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-400/25 bg-cyan-400/5 px-4 py-3">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-cyan-300" />
            <div>
              <div className="text-xs font-semibold text-cyan-300">SHADOW ONLY · {healthText}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Seed admission {usd(marketCapMinUsd)}–{usd(marketCapMaxUsd)} inclusive; admitted
                campaigns remain tracked above the ceiling.
              </div>
            </div>
          </div>
          <div className="text-right text-[10px] text-muted-foreground">
            {health?.updatedAt
              ? `heartbeat ${relativeTime(health.updatedAt)}`
              : "No observer heartbeat"}
          </div>
        </div>

        {query.isLoading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Loading Revival campaigns…
          </div>
        ) : query.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {query.error instanceof Error
              ? query.error.message
              : "Revival data unavailable; trading is unaffected."}
          </div>
        ) : data ? (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
              <Metric label="Active" value={data.summary.active} />
              <Metric label="Entry-ready" value={data.summary.entryReady} />
              <Metric label="Ignition" value={data.summary.ignition} />
              <Metric label="Distribution" value={data.summary.distributionRisk} />
              <Metric label="Closed" value={data.summary.closed} />
              <Metric label="Invalidated" value={data.summary.invalidated} />
              <Metric label="Coverage gaps" value={data.summary.coverageGaps} />
            </div>

            {health?.degraded ? (
              <div className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-xs text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {health.rpcBacklogWalletCount > 0
                  ? "Revival collection is catching up for " +
                    health.rpcBacklogWalletCount +
                    " target wallet(s)."
                  : "Revival collection has a market-provider, configuration, or observer health issue."}{" "}
                Trading and exits are independent.
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-xl border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Token / state</TableHead>
                    <TableHead>Seed → latest MC</TableHead>
                    <TableHead>Target net</TableHead>
                    <TableHead>Buys / sells</TableHead>
                    <TableHead>Accum.</TableHead>
                    <TableHead>Ignition</TableHead>
                    <TableHead>MFE / MAE</TableHead>
                    <TableHead>Coverage</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.campaigns.map((campaign: RevivalCampaignSummary) => (
                    <TableRow
                      key={campaign.id}
                      tabIndex={0}
                      className="cursor-pointer"
                      onClick={() => setSelectedCampaignId(campaign.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedCampaignId(campaign.id);
                        }
                      }}
                    >
                      <TableCell>
                        {campaign.symbol ? (
                          <div className="font-mono text-xs">{campaign.symbol}</div>
                        ) : null}
                        <TokenMintLink tokenMint={campaign.tokenMint} />
                        <span
                          className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[9px] ${stateClass(campaign.state)}`}
                        >
                          {campaign.state.replaceAll("_", " ")}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {usd(campaign.seedMarketCapUsd)} → {usd(campaign.latestMarketCapUsd)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {usd(campaign.targetNetCommitmentUsd)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {campaign.targetBuyCount} / {campaign.targetSellCount}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {campaign.accumulationScore.toFixed(0)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {campaign.ignitionScore.toFixed(0)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {pct(campaign.mfePct)} / {pct(campaign.maePct)}
                      </TableCell>
                      <TableCell className="text-xs">{campaign.coverageStatus}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {relativeTime(campaign.lastActivityAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data.campaigns.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={9}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        <Activity className="mx-auto mb-2 h-5 w-5" />
                        {!enabled
                          ? "The tracker is off. Enable it to begin collecting forward campaigns."
                          : health?.enabled && health.online && !health.degraded
                            ? "Monitoring is live; no qualifying target seed has been observed yet."
                            : "The tracker is enabled in Settings, but the collector is not healthy and live yet."}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
            {data.campaignsTruncated ? (
              <div className="text-right text-[11px] text-muted-foreground">
                Showing the newest {data.campaignsReturned.toLocaleString()} of{" "}
                {data.campaignsTotal.toLocaleString()} campaigns. Summary totals include all stored
                campaigns.
              </div>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      {selectedCampaignId ? (
        <CampaignDetail
          campaignId={selectedCampaignId}
          onClose={() => setSelectedCampaignId(null)}
        />
      ) : null}
    </div>
  );
}
