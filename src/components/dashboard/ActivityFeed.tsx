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
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function tokenAmount(value: number) {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function latency(value: number | null) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return milliseconds < 1_000
    ? `${Math.round(milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(1)}s`;
}

export function ActivityFeed() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["trades"],
    queryFn: () => getTrades(),
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });

  const trades = (data ?? []) as TradeRow[];

  return (
    <SectionCard
      title="Activity"
      description="Confirmed buys and sells from your worker"
      icon={<Radio className="h-4 w-4" />}
    >
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
        {trades.map((trade) => {
          const pnl = trade.pnl_pct != null ? Number(trade.pnl_pct) : undefined;
          const usd = trade.amount_usd != null ? Number(trade.amount_usd) : undefined;
          const tokens = Number(trade.amount_tokens);
          const tradeLatency = latency(trade.latency_ms);
          const hasUsd = usd !== undefined && Number.isFinite(usd);

          return (
            <li key={trade.id} className="flex items-center gap-4 py-3">
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                  trade.side === "buy"
                    ? "bg-primary/10 text-primary"
                    : pnl !== undefined && pnl < 0
                      ? "bg-destructive/10 text-destructive"
                      : "bg-success/10 text-success"
                }`}
              >
                {trade.side === "buy" ? (
                  <ArrowDownRight className="h-4 w-4" />
                ) : (
                  <ArrowUpRight className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="mono text-sm font-semibold">{short(trade.token_mint)}</span>
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    {trade.side}
                  </span>
                  {pnl !== undefined && Number.isFinite(pnl) && (
                    <span
                      className={`mono text-xs ${pnl >= 0 ? "text-success" : "text-destructive"}`}
                    >
                      {pnl >= 0 ? "+" : ""}
                      {pnl.toFixed(1)}%
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {trade.reason ?? "—"}
                </div>
              </div>
              <div className="text-right">
                <div className="mono text-sm">{tokenAmount(tokens)} tokens</div>
                <div
                  className="mono max-w-48 truncate text-[10px] text-muted-foreground"
                  title={`${tokenAmount(tokens)} tokens`}
                >
                  {hasUsd ? `$${usd.toFixed(2)} · ` : ""}
                  {tradeLatency ? `${tradeLatency} · ` : ""}
                  {relTime(trade.created_at)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
