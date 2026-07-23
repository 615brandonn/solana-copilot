import { Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SectionCard } from "./SettingRow";
import { getFollowers } from "@/lib/bot.functions";

type Follower = { wallet: string; token_mint: string; held_pct: number; last_updated: string };

function short(s: string) {
  if (!s) return "";
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

export function MonitoredWallets() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["followers"],
    queryFn: () => getFollowers(),
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });

  const items = (data ?? []) as Follower[];

  return (
    <SectionCard
      title="Monitored followers"
      description="Wallets your target sent tokens to after buying. Auto-removed once you're flat."
      icon={<Users className="h-4 w-4" />}
    >
      {isError && (
        <p className="py-3 text-center text-xs text-destructive">
          {(error as Error)?.message ?? "Failed to load followers"}
        </p>
      )}
      {items.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {isLoading ? "Loading…" : "No active follower monitoring."}
        </p>
      ) : (
        <ul className="space-y-2 pt-2">
          {items.map((f) => (
            <li
              key={f.wallet + f.token_mint}
              className="flex items-center justify-between rounded-lg border border-border/60 bg-card/40 px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <span className="mono text-xs text-foreground">{short(f.wallet)}</span>
                <span className="mono text-[10px] text-muted-foreground">tracking {short(f.token_mint)}</span>
              </div>
              <span className="mono text-xs text-muted-foreground">
                holds <span className="text-foreground">{f.held_pct.toFixed(0)}%</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
