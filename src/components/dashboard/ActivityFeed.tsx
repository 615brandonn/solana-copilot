import { ArrowDownRight, ArrowUpRight, Radio } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SectionCard } from "./SettingRow";
import { getTrades } from "@/lib/bot.functions";
import type { TradeRow } from "@/lib/supabase-types";

function short(mint: string) {
  if (!mint) return "";
  return mint.length > 8 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;
}

function relTime(iso: string) {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function ActivityFeed() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["trades"],
    queryFn: () => getTrades(),
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });

  const trades = data ?? [];

  return (
    <SectionCard title="Activity" description="Live trade feed from your worker" icon={<Radio className="h-4 w-4" />}>
      {isError && (
        <p className="py-3 text-center text-xs text-destructive">
          {(error as Error)?.message ?? "Failed to load trades"}
        </p>
      )}
      <ul className="divide-y divide-border/50">
        {trades.length === 0 && (
          <li className="py-8 text-center text-xs text-muted-foreground">
            {isLoading ? "Loading…" : "No trades yet. Arm the bot and add a target wallet."}
          </li>
        )}
        {trades.map((t) => {
          const pnl = t.pnl_pct != null ? Number(t.pnl_pct) : undefined;
          const usd = t.amount_usd != null ? Number(t.amount_usd) : 0;
          return (
            <li key={t.id} className="flex items-center gap-4 py-3">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                  t.side === "buy"
                    ? "bg-primary/10 text-primary"
                    : pnl !== undefined && pnl < 0
                    ? "bg-destructive/10 text-destructive"
                    : "bg-success/10 text-success"
                }`}
              >
                {t.side === "buy" ? <ArrowDownRight className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="mono text-sm font-semibold">{short(t.token_mint)}</span>
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{t.side}</span>
                  {pnl !== undefined && (
                    <span className={`mono text-xs ${pnl >= 0 ? "text-success" : "text-destructive"}`}>
                      {pnl >= 0 ? "+" : ""}
                      {pnl.toFixed(1)}%
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">{t.reason ?? "—"}</div>
              </div>
              <div className="text-right">
                <div className="mono text-sm">${usd.toFixed(2)}</div>
                <div className="mono text-[10px] text-muted-foreground">{relTime(t.created_at)}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
