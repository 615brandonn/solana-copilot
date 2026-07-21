import { ArrowDownRight, ArrowUpRight, Radio } from "lucide-react";
import { SectionCard } from "./SettingRow";

type Trade = {
  id: string;
  side: "buy" | "sell";
  token: string;
  amountUsd: number;
  pnlPct?: number;
  timestamp: string;
  reason: string;
};

const demo: Trade[] = [
  { id: "1", side: "buy", token: "$WIF", amountUsd: 25, timestamp: "just now", reason: "Target buy · pump.fun · MC 320k" },
  { id: "2", side: "sell", token: "$MOTHER", amountUsd: 42.3, pnlPct: 68, timestamp: "3m", reason: "Follower propagation · 4 wallets sold 30%" },
  { id: "3", side: "sell", token: "$GOAT", amountUsd: 17.1, pnlPct: -22, timestamp: "12m", reason: "Stop loss triggered @ -22%" },
  { id: "4", side: "buy", token: "$PEPE2", amountUsd: 25, timestamp: "48m", reason: "Target first buy · MC 89k" },
];

export function ActivityFeed({ trades = demo }: { trades?: Trade[] }) {
  return (
    <SectionCard title="Activity" description="Live trade feed from your worker" icon={<Radio className="h-4 w-4" />}>
      <ul className="divide-y divide-border/50">
        {trades.length === 0 && (
          <li className="py-8 text-center text-xs text-muted-foreground">
            No trades yet. Arm the bot and add a target wallet.
          </li>
        )}
        {trades.map((t) => (
          <li key={t.id} className="flex items-center gap-4 py-3">
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${t.side === "buy" ? "bg-primary/10 text-primary" : t.pnlPct !== undefined && t.pnlPct < 0 ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"}`}>
              {t.side === "buy" ? <ArrowDownRight className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="mono text-sm font-semibold">{t.token}</span>
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{t.side}</span>
                {t.pnlPct !== undefined && (
                  <span className={`mono text-xs ${t.pnlPct >= 0 ? "text-success" : "text-destructive"}`}>
                    {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct}%
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-muted-foreground">{t.reason}</div>
            </div>
            <div className="text-right">
              <div className="mono text-sm">${t.amountUsd.toFixed(2)}</div>
              <div className="mono text-[10px] text-muted-foreground">{t.timestamp}</div>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
