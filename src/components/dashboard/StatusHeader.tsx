import { Activity, Power, Zap } from "lucide-react";
import { Switch } from "@/components/ui/switch";

type Props = {
  enabled: boolean;
  onToggle: (v: boolean) => void;
  workerConnected: boolean;
  activePositions: number;
  monitoredWallets: number;
  syncing?: boolean;
};

export function StatusHeader({ enabled, onToggle, workerConnected, activePositions, monitoredWallets, syncing }: Props) {
  return (
    <header className="glass-card rounded-2xl px-6 py-5 flex flex-wrap items-center justify-between gap-6">
      <div className="flex items-center gap-4">
        <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Zap className="h-6 w-6" strokeWidth={2.4} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Helix</h1>
            <span className="mono text-[10px] uppercase tracking-widest text-muted-foreground">v0.1 · solana</span>
          </div>
          <p className="text-xs text-muted-foreground">Sub-second copy trading · follower propagation exits</p>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <Stat label="Worker" value={workerConnected ? "Online" : "Offline"} accent={workerConnected ? "success" : "muted"} pulse={workerConnected} />
        <Stat label="Open positions" value={String(activePositions)} />
        <Stat label="Monitored" value={String(monitoredWallets)} />

        <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-2">
          <Power className={`h-4 w-4 ${enabled ? "text-primary" : "text-muted-foreground"}`} />
          <span className="text-xs font-medium uppercase tracking-wider">
            {enabled ? "Bot armed" : "Bot idle"}
          </span>
          {syncing && <span className="text-[10px] text-muted-foreground">syncing…</span>}
          <Switch checked={enabled} onCheckedChange={onToggle} />
        </div>
      </div>
    </header>
  );
}

function Stat({ label, value, accent, pulse }: { label: string; value: string; accent?: "success" | "muted"; pulse?: boolean }) {
  const color = accent === "success" ? "text-success" : accent === "muted" ? "text-muted-foreground" : "text-foreground";
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className={`mono text-sm font-semibold ${color} flex items-center gap-2`}>
        {pulse && <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success"><span className="pulse-dot absolute inset-0 rounded-full text-success" /></span>}
        {value}
      </span>
    </div>
  );
}
