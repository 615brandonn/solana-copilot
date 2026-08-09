import { useQuery } from "@tanstack/react-query";
import { Coins, ExternalLink, Users } from "lucide-react";
import { getFollowers, getPositions } from "@/lib/bot.functions";
import type { PositionRow } from "@/lib/supabase-types";
import { SectionCard } from "./SettingRow";

type Follower = {
  wallet: string;
  position_id: string;
  token_mint: string;
  current_amount: number;
  held_pct: number;
  hop_depth: number;
  last_updated: string;
};

function short(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

function amount(value: number) {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function usd(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PositionFollowers() {
  const positionsQ = useQuery({
    queryKey: ["positions"],
    queryFn: () => getPositions(),
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });
  const followersQ = useQuery({
    queryKey: ["followers"],
    queryFn: () => getFollowers(),
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
  });

  const positions = (positionsQ.data ?? []) as PositionRow[];
  const followers = (followersQ.data ?? []) as Follower[];
  const error = positionsQ.error ?? followersQ.error;

  return (
    <SectionCard
      title="My positions & followers"
      description="Coins managed by Helix, with the follower wallets attached to each position."
      icon={<Coins className="h-4 w-4" />}
    >
      {error && (
        <p className="py-3 text-center text-xs text-destructive">
          {error instanceof Error ? error.message : "Failed to load positions"}
        </p>
      )}
      {positions.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {positionsQ.isLoading ? "Loading…" : "No active Helix positions."}
        </p>
      ) : (
        <div className="space-y-3 pt-3">
          {positions.map((position) => {
            const attached = followers.filter((follower) => follower.position_id === position.id);
            const cost = usd(Number(position.bot_cost_basis_usd));
            return (
              <article
                key={position.id}
                className="rounded-xl border border-border/70 bg-card/40 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-sm font-semibold" title={position.token_mint}>
                        {short(position.token_mint)}
                      </span>
                      <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                        {position.entry_mode ?? "regular"}
                      </span>
                      <a
                        href={`https://solscan.io/token/${position.token_mint}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-primary"
                      >
                        View coin <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Remaining:{" "}
                      <span className="mono text-foreground">
                        {amount(Number(position.amount_remaining))}
                      </span>
                      {cost ? (
                        <span>
                          {" "}
                          · Cost basis: <span className="mono text-foreground">{cost}</span>
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    <span>
                      {attached.length} follower{attached.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>

                {attached.length === 0 ? (
                  <p className="mt-3 rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                    No follower wallets have received this coin yet.
                  </p>
                ) : (
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {attached.map((follower) => (
                      <li
                        key={`${position.id}-${follower.wallet}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/30 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="mono truncate text-xs" title={follower.wallet}>
                            {short(follower.wallet)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            hop {follower.hop_depth} · {amount(Number(follower.current_amount))}{" "}
                            tokens
                          </div>
                        </div>
                        <span
                          className={`mono shrink-0 text-xs ${follower.held_pct > 0 ? "text-success" : "text-muted-foreground"}`}
                        >
                          {follower.held_pct.toFixed(0)}%
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
