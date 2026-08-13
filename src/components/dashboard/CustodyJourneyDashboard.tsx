import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Eye,
  ExternalLink,
  Network,
  Radio,
  RefreshCw,
  Route,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useState } from "react";

import {
  getCustodyDashboard,
  getCustodyJourney,
  saveCustodyWalletLabel,
} from "@/lib/bot.functions";
import {
  custodyObserverEffectiveStatus,
  identityName,
  identityType,
  type CustodyAccountingCoverage,
  type CustodyDashboardData,
  type CustodyEventCategory,
  type CustodyEvidence,
  type CustodyIdentityConfidence,
  type CustodyJourneyDetailData,
  type CustodyJourneyEventView,
  type CustodyJourneySummary,
  type CustodyObserverHealth,
  type CustodyObserverStatus,
  type CustodyWalletIdentity,
  type CustodyWindow,
} from "@/lib/custody";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

type CustodyTab = "journeys" | "destinations" | "transfers";
type ManualWalletType =
  | "unknown"
  | "exchange"
  | "cold_storage_candidate"
  | "hot_wallet_candidate"
  | "routing_wallet"
  | "custody"
  | "bridge"
  | "vault"
  | "other";

function manualTypeForIdentity(identity: CustodyWalletIdentity): ManualWalletType {
  const type = identity.type?.toLowerCase() ?? "";
  if (type === "cex") return "exchange";
  if (type.includes("cold storage")) return "cold_storage_candidate";
  if (type.includes("hot wallet")) return "hot_wallet_candidate";
  if (type === "routing wallet") return "routing_wallet";
  if (type === "custody wallet") return "custody";
  if (type === "bridge") return "bridge";
  if (type === "vault") return "vault";
  if (type && type !== "entity unknown") return "other";
  return "unknown";
}

function short(value: string, head = 6, tail = 5) {
  return value.length > head + tail + 2 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function amount(value: number) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function percent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "Share unavailable";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}% of verified buy`;
}

function time(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : "—";
}

function relativeTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function confidenceClass(confidence: CustodyIdentityConfidence) {
  if (confidence === "confirmed") return "border-success/35 bg-success/10 text-success";
  if (confidence === "manual") return "border-primary/35 bg-primary/10 text-primary";
  if (confidence === "candidate") return "border-amber-400/35 bg-amber-400/10 text-amber-300";
  return "border-border/70 bg-muted/30 text-muted-foreground";
}

function ConfidenceBadge({ confidence }: { confidence: CustodyIdentityConfidence }) {
  const label =
    confidence === "manual"
      ? "manual label"
      : confidence === "confirmed"
        ? "confirmed identity"
        : confidence === "candidate"
          ? "candidate identity"
          : "identity unknown";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${confidenceClass(confidence)}`}
    >
      {label}
    </span>
  );
}

function EvidenceBadge({
  evidence,
  category,
}: {
  evidence: CustodyEvidence;
  category?: CustodyEventCategory;
}) {
  const label =
    evidence === "confirmed"
      ? category === "sell"
        ? "verified sale"
        : "confirmed movement"
      : evidence === "candidate"
        ? "candidate evidence"
        : "evidence unknown";
  const className =
    evidence === "confirmed"
      ? "border-success/35 bg-success/10 text-success"
      : evidence === "candidate"
        ? "border-amber-400/35 bg-amber-400/10 text-amber-300"
        : "border-border/70 bg-muted/30 text-muted-foreground";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${className}`}
    >
      {label}
    </span>
  );
}

function CoverageBadge({ coverage }: { coverage: CustodyAccountingCoverage }) {
  const className =
    coverage === "complete"
      ? "border-success/35 bg-success/10 text-success"
      : coverage === "partial"
        ? "border-amber-400/35 bg-amber-400/10 text-amber-300"
        : "border-border/70 bg-muted/30 text-muted-foreground";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-wider ${className}`}
    >
      {coverage === "complete"
        ? "cohort accounted"
        : coverage === "partial"
          ? "partial custody coverage"
          : "coverage unknown"}
    </span>
  );
}

function WalletIdentity({
  identity,
  compact = false,
  onLabel,
}: {
  identity: CustodyWalletIdentity;
  compact?: boolean;
  onLabel?: () => void;
}) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="truncate text-xs font-medium" title={identity.label ?? identity.wallet}>
          {identityName(identity)}
        </span>
        {!compact ? <ConfidenceBadge confidence={identity.confidence} /> : null}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <span>{identityType(identity)}</span>
        <span>·</span>
        <a
          href={`https://solscan.io/account/${identity.wallet}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono hover:text-primary"
          title={identity.wallet}
        >
          {short(identity.wallet)}
        </a>
        {onLabel ? (
          <button
            type="button"
            onClick={onLabel}
            className="rounded border border-border/60 px-1.5 py-0.5 text-[9px] hover:border-primary/50 hover:text-primary"
          >
            Label wallet
          </button>
        ) : null}
      </div>
    </div>
  );
}

function WalletLabelDialog({
  identity,
  journeyId,
  onClose,
}: {
  identity: CustodyWalletIdentity;
  journeyId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState(
    identity.confidence === "manual" && identity.label ? identity.label : "",
  );
  const [type, setType] = useState<ManualWalletType>(() => manualTypeForIdentity(identity));
  const mutation = useMutation({
    mutationFn: () =>
      saveCustodyWalletLabel({
        data: { wallet: identity.wallet, label: label.trim(), type },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["custody-dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["custody-journey", journeyId] }),
      ]);
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Label custody wallet</DialogTitle>
          <DialogDescription>
            This is your own display label. It does not prove ownership, classify an on-chain
            action, or change monitoring or trading.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 font-mono text-[10px] break-all">
            {identity.wallet}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custody-wallet-label">Wallet name</Label>
            <Input
              id="custody-wallet-label"
              value={label}
              maxLength={80}
              placeholder="e.g. My known exchange deposit"
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custody-wallet-type">Wallet type</Label>
            <select
              id="custody-wallet-type"
              value={type}
              onChange={(event) => setType(event.target.value as ManualWalletType)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="unknown">Unknown</option>
              <option value="exchange">Known exchange</option>
              <option value="cold_storage_candidate">Possible cold storage</option>
              <option value="hot_wallet_candidate">Possible hot wallet</option>
              <option value="routing_wallet">Routing wallet</option>
              <option value="custody">Custody wallet</option>
              <option value="bridge">Bridge</option>
              <option value="vault">Vault</option>
              <option value="other">Other</option>
            </select>
          </div>
          {mutation.isError ? (
            <p className="text-xs text-destructive">
              {mutation.error instanceof Error ? mutation.error.message : "Wallet label failed."}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => mutation.mutate()}
              disabled={!label.trim() || mutation.isPending}
            >
              {mutation.isPending ? "Saving…" : "Save user label"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Metric({
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
      {detail ? <div className="mt-1 text-[10px] text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function statusClass(status: string) {
  return status.toLowerCase() === "active"
    ? "border-cyan-400/35 bg-cyan-400/10 text-cyan-300"
    : "border-border/70 bg-muted/30 text-muted-foreground";
}

function observerStatusLabel(status: CustodyObserverStatus) {
  if (status === "live") return "Live";
  if (status === "degraded") return "Catching up / degraded";
  if (status === "stale") return "Stale heartbeat";
  if (status === "off") return "OFF";
  return "Not started";
}

function observerStatusColor(status: CustodyObserverStatus) {
  if (status === "live") return "bg-cyan-300";
  if (status === "degraded") return "bg-amber-300";
  if (status === "stale") return "bg-destructive";
  return "bg-muted-foreground";
}

function observerStatusMessage(health: CustodyObserverHealth, status: CustodyObserverStatus) {
  if (status === "live") {
    return "The observer heartbeat is fresh and its confirmed RPC timeline is current.";
  }
  if (status === "degraded") {
    if (health.hasObservationGap) {
      const boundaryCount = health.expiredEventCount + health.terminalEventCount;
      return `${boundaryCount.toLocaleString()} durable inbox event${boundaryCount === 1 ? " has" : "s have"} reached an observation boundary, so the recorded chain may contain gaps.`;
    }
    if (health.pendingEventCount > 0) {
      return `The observer is recovering ${health.pendingEventCount.toLocaleString()} out-of-order event${health.pendingEventCount === 1 ? "" : "s"} from its durable inbox.`;
    }
    if (health.rpcBacklogWalletCount > 0) {
      return `The observer is catching up ${health.rpcBacklogWalletCount.toLocaleString()} wallet${health.rpcBacklogWalletCount === 1 ? "" : "s"} through durable RPC recovery.`;
    }
    return health.hasLastError
      ? "The observer reported an operational problem. Error details are hidden from this dashboard."
      : "The observer reports degraded coverage while its recovery path catches up.";
  }
  if (status === "stale") {
    return "No recent observer heartbeat was received, so current monitoring coverage is unknown.";
  }
  if (status === "off") {
    return "The worker heartbeat confirms that Custody Journey observation is off. Existing history remains available.";
  }
  return "No Custody Journey worker heartbeat exists yet. Start the separate observer after installing its migration.";
}

function observerIntentMismatch(
  health: CustodyObserverHealth,
  status: CustodyObserverStatus,
  intendedEnabled: boolean | undefined,
): string | null {
  if (intendedEnabled === true && status === "not_started") {
    return "The dashboard setting is ON, but the separate observer has not started.";
  }
  if (intendedEnabled === true && status === "off") {
    return "The dashboard setting is ON, but the latest worker heartbeat reports OFF.";
  }
  if (intendedEnabled === true && status === "stale") {
    return "The dashboard setting is ON, but the observer heartbeat is stale.";
  }
  if (intendedEnabled === false && health.enabled === true && status !== "stale") {
    return "The dashboard setting is OFF, but the worker still reports enabled; it may be applying the change.";
  }
  return null;
}

function ObserverHealthPanel({
  health,
  intendedEnabled,
}: {
  health: CustodyObserverHealth;
  intendedEnabled?: boolean;
}) {
  const status = custodyObserverEffectiveStatus(health);
  const mismatch = observerIntentMismatch(health, status, intendedEnabled);
  return (
    <div className="mb-5 rounded-xl border border-border/60 bg-background/25 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium">Observer health</div>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
            {observerStatusMessage(health, status)} This observer is isolated from execution;
            trading is unaffected.
          </p>
          {mismatch ? <p className="mt-1 text-[11px] text-amber-300">{mismatch}</p> : null}
          {health.hasObservationGap ? (
            <p className="mt-1 text-[10px] text-amber-300">
              {health.expiredEventCount} expired · {health.terminalEventCount} terminal. These are
              custody coverage gaps, not sales or trading signals.
            </p>
          ) : null}
          {health.hasLastError ? (
            <p className="mt-1 text-[10px] text-amber-300">
              An observer error is present; raw diagnostics are intentionally not displayed.
            </p>
          ) : null}
        </div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Started {time(health.startedAt)}
        </span>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Heartbeat</div>
          <div className="mt-1 text-xs">{relativeTime(health.updatedAt)}</div>
          <div className="mt-0.5 text-[9px] text-muted-foreground">
            {status === "stale" ? "stale" : health.freshness}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Confirmed RPC
          </div>
          <div className="mt-1 text-xs">
            {health.rpcBacklogWalletCount > 0 ? "Recovering" : "Current"}
          </div>
          <div className="mt-0.5 text-[9px] text-muted-foreground">
            Success {relativeTime(health.rpcLastSuccessAt)}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Recovery backlog
          </div>
          <div className="mt-1 text-xs">
            {health.rpcBacklogWalletCount.toLocaleString()} wallet backlog
          </div>
          <div className="mt-0.5 text-[9px] text-muted-foreground">
            Poll {relativeTime(health.rpcLastPollAt)}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Watched</div>
          <div className="mt-1 font-mono text-xs">{health.watchedWalletCount}</div>
          <div className="mt-0.5 text-[9px] text-muted-foreground">custody wallets</div>
        </div>
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Active journeys
          </div>
          <div className="mt-1 font-mono text-xs">{health.activeJourneyCount}</div>
          <div className="mt-0.5 text-[9px] text-muted-foreground">
            {health.decodedEventCount.toLocaleString()} decoded events
          </div>
        </div>
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Recovery inbox
          </div>
          <div className="mt-1 font-mono text-xs">{health.pendingEventCount} pending</div>
          <div className="mt-0.5 text-[9px] text-muted-foreground">
            {health.expiredEventCount} expired · {health.terminalEventCount} terminal
          </div>
        </div>
      </div>
    </div>
  );
}

function JourneyCard({ journey, onOpen }: { journey: CustodyJourneySummary; onOpen: () => void }) {
  return (
    <article className="rounded-xl border border-border/65 bg-background/25 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`https://solscan.io/token/${journey.tokenMint}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-sm font-semibold hover:text-primary"
              title={journey.tokenMint}
            >
              {short(journey.tokenMint, 8, 6)}
            </a>
            <span
              className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${statusClass(journey.status)}`}
            >
              {journey.status}
            </span>
            <CoverageBadge coverage={journey.accountingCoverage} />
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            Started {time(journey.startedAt)} · last activity {relativeTime(journey.lastActivityAt)}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={onOpen}>
          Open custody chain
        </Button>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Verified bought
          </div>
          <div className="mt-1 font-mono text-xs">
            {amount(journey.totalVerifiedTargetBuyTokens)}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Still attributed
          </div>
          <div className="mt-1 font-mono text-xs">{amount(journey.currentAttributedTokens)}</div>
        </div>
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Verified sold
          </div>
          <div className="mt-1 font-mono text-xs">
            {amount(journey.totalVerifiedCustodySellTokens)}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 px-3 py-2">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Custody activity
          </div>
          <div className="mt-1 font-mono text-xs">
            {journey.walletCount} wallets · {journey.transferCount} transfers
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground">Source target:</span>
        {journey.sourceTargetWallets.length ? (
          journey.sourceTargetWallets.map((wallet) => (
            <a
              key={wallet}
              href={`https://solscan.io/account/${wallet}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-border/60 px-2 py-1 font-mono hover:text-primary"
              title={wallet}
            >
              {short(wallet)}
            </a>
          ))
        ) : (
          <span>Not recorded</span>
        )}
      </div>

      {journey.transferCount === 0 && journey.verifiedSellCount === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
          Target buy recorded; no downstream transfer or verified custody sell has been recorded
          yet.
        </p>
      ) : journey.destinationPreview.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Recent destinations
          </span>
          {journey.destinationPreview.map((identity) => (
            <span
              key={identity.wallet}
              className="rounded-md border border-border/60 bg-background/40 px-2 py-1 text-[10px]"
              title={identity.wallet}
            >
              {identityName(identity)} · {short(identity.wallet, 4, 4)}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function eventTitle(event: CustodyJourneyEventView) {
  if (event.category === "buy") {
    return event.evidence === "confirmed" ? "Verified target buy" : "Target buy candidate";
  }
  if (event.category === "sell") {
    return event.evidence === "confirmed" ? "Verified custody sell" : "Unverified sell-like event";
  }
  if (event.category === "transfer") return "Custody transfer";
  if (event.category === "boundary") return "Tracking boundary";
  return event.eventType.replace(/_/g, " ").toLowerCase();
}

function JourneyDetailDialog({
  journeyId,
  onClose,
}: {
  journeyId: string | null;
  onClose: () => void;
}) {
  const [labelTarget, setLabelTarget] = useState<CustodyWalletIdentity | null>(null);
  const query = useQuery({
    queryKey: ["custody-journey", journeyId],
    queryFn: () => getCustodyJourney({ data: { journeyId: journeyId! } }),
    enabled: Boolean(journeyId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
    retry: false,
  });
  const detail = query.data as CustodyJourneyDetailData | undefined;

  return (
    <>
      <Dialog open={Boolean(journeyId)} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              Custody chain {detail?.journey ? short(detail.journey.tokenMint, 8, 6) : ""}
              <Badge variant="outline" className="border-cyan-400/35 text-cyan-300">
                Observation only
              </Badge>
            </DialogTitle>
            <DialogDescription>
              Confirmed on-chain movement from the target buy through watched wallets. A transfer is
              not proof of a sale.
            </DialogDescription>
          </DialogHeader>

          {query.isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Loading custody chain…
            </div>
          ) : query.isError ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {query.error instanceof Error
                ? query.error.message
                : "Custody chain is temporarily unavailable. Trading is unaffected."}
            </div>
          ) : detail ? (
            <div className="space-y-5">
              {!detail.coverage.complete ? (
                <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-xs text-amber-200">
                  This journey has more events than the detail view can load at once. The visible
                  chain is partial.
                </div>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                  label="Verified bought"
                  value={amount(detail.journey.totalVerifiedTargetBuyTokens)}
                />
                <Metric
                  label="Still attributed"
                  value={amount(detail.journey.currentAttributedTokens)}
                />
                <Metric
                  label="Verified sold"
                  value={amount(detail.journey.totalVerifiedCustodySellTokens)}
                />
                <Metric
                  label="Coverage"
                  value={detail.journey.accountingCoverage}
                  detail={`${detail.wallets.length} custody wallets`}
                />
              </div>

              <div className="rounded-xl border border-border/60 bg-background/25 p-4">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <WalletCards className="h-4 w-4 text-primary" /> Wallets in this journey
                </div>
                {detail.wallets.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    No downstream custody wallet has been recorded yet.
                  </p>
                ) : (
                  <div className="mt-3 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Wallet / identity</TableHead>
                          <TableHead>Hop</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Attributed now</TableHead>
                          <TableHead>Verified sold</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.wallets.map((wallet) => (
                          <TableRow key={wallet.id}>
                            <TableCell>
                              <WalletIdentity
                                identity={wallet.identity}
                                onLabel={() => setLabelTarget(wallet.identity)}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-xs">{wallet.hopDepth}</TableCell>
                            <TableCell>
                              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                {wallet.watchStatus}
                              </span>
                              {wallet.releaseReason ? (
                                <div className="max-w-56 text-[10px] text-amber-300">
                                  {wallet.releaseReason}
                                </div>
                              ) : null}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {amount(wallet.currentAttributedTokens)}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {amount(wallet.totalVerifiedSoldTokens)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-border/60 bg-background/25 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    <Route className="h-4 w-4 text-primary" /> Buy-to-sell timeline
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {detail.events.length} recorded event{detail.events.length === 1 ? "" : "s"}
                  </span>
                </div>
                {detail.events.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    The journey exists, but no event rows were returned.
                  </p>
                ) : (
                  <ol className="mt-4 space-y-3 border-l border-border/70 pl-4">
                    {detail.events.map((event) => (
                      <li
                        key={event.id}
                        className="relative rounded-xl border border-border/60 bg-background/35 p-3"
                      >
                        <span className="absolute -left-[21px] top-4 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" />
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium capitalize">
                                {eventTitle(event)}
                              </span>
                              <EvidenceBadge evidence={event.evidence} category={event.category} />
                            </div>
                            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                              {time(event.eventAt)}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-mono text-xs">
                              {amount(event.appliedAmountTokens)} tokens
                            </div>
                            {event.txSig ? (
                              <a
                                href={`https://solscan.io/tx/${event.txSig}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary"
                              >
                                transaction <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : null}
                          </div>
                        </div>

                        {event.source || event.destination ? (
                          <div className="mt-3 grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
                            {event.source ? (
                              <WalletIdentity identity={event.source} />
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Source unavailable
                              </span>
                            )}
                            <ArrowRight className="hidden h-4 w-4 text-muted-foreground sm:block" />
                            {event.destination ? (
                              <WalletIdentity identity={event.destination} />
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {event.category === "sell"
                                  ? "DEX proceeds destination not attributed here"
                                  : "No destination recorded"}
                              </span>
                            )}
                          </div>
                        ) : null}

                        {event.resultReason ? (
                          <div className="mt-3 rounded-lg border border-border/50 px-3 py-2 text-[10px] text-muted-foreground">
                            {event.resultReason}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      {labelTarget && journeyId ? (
        <WalletLabelDialog
          key={labelTarget.wallet}
          identity={labelTarget}
          journeyId={journeyId}
          onClose={() => setLabelTarget(null)}
        />
      ) : null}
    </>
  );
}

export function CustodyJourneyDashboard({ enabled }: { enabled?: boolean }) {
  const [window, setWindow] = useState<CustodyWindow>("7d");
  const [tab, setTab] = useState<CustodyTab>("journeys");
  const [selectedJourneyId, setSelectedJourneyId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["custody-dashboard", window],
    queryFn: () => getCustodyDashboard({ data: { window, limit: 30 } }),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
    retry: false,
  });
  const data = query.data as CustodyDashboardData | undefined;
  const errorMessage = query.error instanceof Error ? query.error.message : "";
  const migrationMissing = /not installed|migration/i.test(errorMessage);
  const observerStatus = data ? custodyObserverEffectiveStatus(data.observer) : null;
  const statusLabel = observerStatus
    ? observerStatusLabel(observerStatus)
    : query.isLoading
      ? "Checking observer"
      : migrationMissing
        ? "Not started"
        : "Health unavailable";
  const statusDot = observerStatus
    ? observerStatusColor(observerStatus)
    : query.isError
      ? "bg-destructive"
      : "bg-muted-foreground";

  return (
    <div className="mt-6">
      <SectionCard
        title="Custody Journey"
        description="Follow verified target buys through live wallet transfers and verified custody sells"
        icon={<Network className="h-4 w-4" />}
      >
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-cyan-400/25 bg-cyan-400/5 p-4">
          <div className="flex gap-3">
            <Eye className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-cyan-200">
                Observation only
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
                This panel records and ranks custody movement. It never submits a transaction,
                changes an exit, or treats a transfer as proof of a sale. Unknown wallets stay
                unknown until evidence or a manual label identifies them. Coverage is conservative:
                delegated token-account activity that omits the owner address and unsupported DEX
                protocols may remain unobserved, so a chain is never proof of complete off-chain
                custody.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              {observerStatus === "live" ? (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-300 opacity-40" />
              ) : null}
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${statusDot}`} />
            </span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {statusLabel}
            </span>
            {onToggleEnabled ? (
              <Switch
                className="ml-2"
                checked={enabled === true}
                onCheckedChange={onToggleEnabled}
                aria-label="Toggle custody observation on or off"
              />
            ) : null}
          </div>
        </div>

        {data ? <ObserverHealthPanel health={data.observer} intendedEnabled={enabled} /> : null}

        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Tabs value={tab} onValueChange={(value) => setTab(value as CustodyTab)}>
            <TabsList>
              <TabsTrigger value="journeys">Live journeys</TabsTrigger>
              <TabsTrigger value="destinations">Destinations</TabsTrigger>
              <TabsTrigger value="transfers">Top transfers</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            <label
              htmlFor="custody-window"
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              Window
            </label>
            <select
              id="custody-window"
              value={window}
              onChange={(event) => setWindow(event.target.value as CustodyWindow)}
              className="h-9 rounded-md border border-input bg-background px-3 font-mono text-xs"
            >
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
              <option value="all">All history</option>
            </select>
            <RefreshCw
              className={`h-3.5 w-3.5 text-muted-foreground ${query.isFetching ? "animate-spin" : ""}`}
            />
          </div>
        </div>

        {query.isError && !data ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
            <div className="text-sm font-medium text-destructive">Custody data unavailable</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {query.error instanceof Error
                ? query.error.message
                : "The observation panel could not be loaded. Trading is unaffected."}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              This observer is isolated from execution; trading is unaffected.
            </p>
          </div>
        ) : query.isLoading && !data ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Loading custody observations…
          </div>
        ) : data ? (
          <>
            {query.isError ? (
              <div className="mb-4 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-200">
                Refresh failed; showing the last successful snapshot. Trading is unaffected.
              </div>
            ) : null}
            {!data.coverage.complete ? (
              <div className="mb-4 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-200">
                This window exceeded the safe dashboard row cap. Rankings and chains shown here are
                partial; no missing rows are treated as zero.
              </div>
            ) : null}

            <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Metric
                label="Journeys"
                value={data.summary.journeyCount}
                detail={`${data.summary.activeJourneyCount} active in loaded rows`}
              />
              <Metric label="Wallets observed" value={data.summary.observedWalletCount} />
              <Metric
                label="Transfers"
                value={data.summary.transferEventCount}
                detail="confirmed and candidate movement"
              />
              <Metric
                label="Verified sells"
                value={data.summary.verifiedSellEventCount}
                detail="sell attribution required"
              />
              <Metric
                label="Latest event"
                value={relativeTime(data.coverage.lastEventAt)}
                detail="refreshes every 10 seconds"
              />
            </div>

            {tab === "journeys" ? (
              data.journeys.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/70 py-12 text-center">
                  <Radio className="mx-auto h-5 w-5 text-muted-foreground" />
                  <p className="mt-3 text-sm">No target-buy custody journeys in this window</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {enabled === false
                      ? "Custody Journey observation is off. Existing history remains visible and no new custody events are being requested by this feature."
                      : "A journey appears after the observer records a verified target buy. Entries and Conviction trading do not need to be on."}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {data.journeys.map((journey) => (
                    <JourneyCard
                      key={journey.id}
                      journey={journey}
                      onOpen={() => setSelectedJourneyId(journey.id)}
                    />
                  ))}
                </div>
              )
            ) : tab === "destinations" ? (
              <div className="overflow-hidden rounded-xl border border-border/60">
                <div className="border-b border-border/60 bg-background/30 px-4 py-3">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    <WalletCards className="h-4 w-4 text-primary" /> Top custody destinations
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Ranked by distinct journeys, then transfer-event count. Raw token balances from
                    different coins are never added together.
                  </p>
                </div>
                {data.destinationLeaderboard.length === 0 ? (
                  <div className="p-8 text-center text-xs text-muted-foreground">
                    No downstream custody destinations have been recorded in this window.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Rank</TableHead>
                          <TableHead>Wallet / identity</TableHead>
                          <TableHead>Journeys</TableHead>
                          <TableHead>Transfers</TableHead>
                          <TableHead>Coins</TableHead>
                          <TableHead>Last seen</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.destinationLeaderboard.map((row) => (
                          <TableRow key={row.identity.wallet}>
                            <TableCell className="font-mono text-xs">#{row.rank}</TableCell>
                            <TableCell>
                              <WalletIdentity identity={row.identity} />
                            </TableCell>
                            <TableCell className="font-mono text-xs">{row.journeyCount}</TableCell>
                            <TableCell>
                              <div className="font-mono text-xs">{row.transferCount}</div>
                              <div className="text-[9px] text-muted-foreground">
                                {row.confirmedTransferCount} confirmed
                              </div>
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {row.uniqueTokenCount}
                            </TableCell>
                            <TableCell className="text-[10px] text-muted-foreground">
                              {relativeTime(row.lastSeenAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border/60">
                <div className="border-b border-border/60 bg-background/30 px-4 py-3">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    <ShieldCheck className="h-4 w-4 text-primary" /> Top custody transfers
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Ranked by share of that journey's verified target buy. This dimensionless share
                    avoids comparing raw units across different coins.
                  </p>
                </div>
                {data.transferLeaderboard.length === 0 ? (
                  <div className="p-8 text-center text-xs text-muted-foreground">
                    No custody transfers have been recorded in this window.
                  </div>
                ) : (
                  <div className="divide-y divide-border/50">
                    {data.transferLeaderboard.map((row) => (
                      <div
                        key={`${row.journeyId}:${row.eventKey}`}
                        className="grid gap-3 px-4 py-3 sm:grid-cols-[40px_1fr_auto] sm:items-center"
                      >
                        <div className="font-mono text-xs text-muted-foreground">#{row.rank}</div>
                        <div className="min-w-0">
                          <WalletIdentity identity={row.destination} />
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                            <span className="font-mono">coin {short(row.tokenMint)}</span>
                            <span>·</span>
                            <span>{relativeTime(row.eventAt)}</span>
                            <EvidenceBadge evidence={row.evidence} category="transfer" />
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-mono text-xs">{amount(row.amountTokens)} tokens</div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {percent(row.shareOfJourneyBuyPct)}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="mt-1 h-7 text-[10px]"
                            onClick={() => setSelectedJourneyId(row.journeyId)}
                          >
                            View chain
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        ) : null}
      </SectionCard>

      <JourneyDetailDialog
        journeyId={selectedJourneyId}
        onClose={() => setSelectedJourneyId(null)}
      />
    </div>
  );
}
