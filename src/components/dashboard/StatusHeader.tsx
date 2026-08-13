import { Activity, Power, Zap, CheckCircle2, AlertCircle } from "lucide-react";
import { Switch } from "@/components/ui/switch";

type Props = {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  ready: boolean;
  readinessPending?: boolean;
  readinessMessage: string;
  workerConnected?: boolean;
  workerDegraded?: boolean;
  workerStatusMessage?: string;
  activePositions: number;
  monitoredWallets: number;
  syncing?: boolean;
  coordinatedModeEnabled?: boolean;
  convictionModeEnabled?: boolean;
  convictionTradingMode?: "shadow" | "live";
};

export function StatusHeader({
  enabled,
  onToggle,
  ready,
  readinessPending,
  readinessMessage,
  workerConnected,
  workerDegraded,
  workerStatusMessage,
  activePositions,
  monitoredWallets,
  syncing,
  coordinatedModeEnabled,
  convictionModeEnabled,
  convictionTradingMode,
}: Props) {
  const convictionShadow = convictionModeEnabled && convictionTradingMode !== "live";
  return (
    <header className="glass-card rounded-2xl px-6 py-5 flex flex-wrap items-center justify-between gap-6">
      <div className="flex items-center gap-4">
        <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Zap className="h-6 w-6" strokeWidth={2.4} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Helix</h1>
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              v0.2 · solana
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Sub-second copy trading · follower propagation exits
          </p>
          <p
            className={`mt-1 max-w-xl text-[11px] ${ready ? "text-success" : "text-muted-foreground"}`}
          >
            {readinessMessage}
          </p>
        </div>
        <div
          className={`ml-2 flex items-center gap-2 rounded-lg border px-3 py-1.5 ${
            ready
              ? "border-success/40 bg-success/10 text-success"
              : "border-border bg-muted/40 text-muted-foreground"
          }`}
          title={readinessMessage}
        >
          {ready ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          <span className="text-[11px] font-semibold uppercase tracking-wider">
            {readinessPending ? "Checking" : ready ? "Ready" : "Setup needed"}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <div title={workerStatusMessage}>
          <Stat
            label="Worker"
            value={
              workerConnected === undefined
                ? "Checking"
                : workerConnected && workerDegraded
                  ? "Degraded"
                  : workerConnected
                    ? "Online"
                    : "Offline"
            }
            accent={workerConnected && !workerDegraded ? "success" : "muted"}
            pulse={workerConnected && !workerDegraded}
          />
        </div>
        <Stat label="Open positions" value={String(activePositions)} />
        <Stat label="Monitored" value={String(monitoredWallets)} />

        <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-2">
          <Power className={`h-4 w-4 ${enabled ? "text-primary" : "text-muted-foreground"}`} />
          <span
            className="text-xs font-medium uppercase tracking-wider"
            title={
              enabled
                ? convictionShadow
                  ? "Conviction Mode is recording hypothetical entries. SHADOW mode cannot submit buys."
                  : "New entries and open-position exits are active."
                : "New entries are off. Follower-network exits for existing positions remain active while the VPS worker is online."
            }
          >
            {enabled
              ? convictionShadow
                ? "Conviction shadow · no buys"
                : convictionModeEnabled
                  ? "Entries on · conviction"
                  : coordinatedModeEnabled
                    ? "Entries on · coordinated"
                    : "Entries on · regular"
              : "Entries off · exits active"}
          </span>
          {syncing && <span className="text-[10px] text-muted-foreground">syncing…</span>}
          <Switch checked={enabled} onCheckedChange={onToggle} />
        </div>
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
  accent,
  pulse,
}: {
  label: string;
  value: string;
  accent?: "success" | "muted";
  pulse?: boolean;
}) {
  const color =
    accent === "success"
      ? "text-success"
      : accent === "muted"
        ? "text-muted-foreground"
        : "text-foreground";
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className={`mono text-sm font-semibold ${color} flex items-center gap-2`}>
        {pulse && (
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success">
            <span className="pulse-dot absolute inset-0 rounded-full text-success" />
          </span>
        )}
        {value}
      </span>
    </div>
  );
}
