import { useQuery } from "@tanstack/react-query";
import { Coins, ExternalLink, Users } from "lucide-react";
import { getFollowers, getPositions, getWalletHoldings } from "@/lib/bot.functions";
import type { PositionRow } from "@/lib/supabase-types";
import { SectionCard } from "./SettingRow";

type Follower = {
  wallet: string;
  position_id: string | null;
  token_mint: string;
  current_amount: number;
  held_pct: number | null;
  hop_depth: number;
  last_updated: string;
  observed_only: boolean;
  source_target_count: number | null;
};

type WalletHolding = {
  token_mint: string;
  amount: number;
  decimals: number;
};

const FUNDING_ASSET_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCo24RDUuUuJZq8bn6T",
]);

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
  const holdingsQ = useQuery({
    queryKey: ["wallet-holdings"],
    queryFn: () => getWalletHoldings(),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const positions = (positionsQ.data ?? []) as PositionRow[];
  const followers = (followersQ.data ?? []) as Follower[];
  const holdings = ((holdingsQ.data ?? []) as WalletHolding[]).filter(
    (holding) => !FUNDING_ASSET_MINTS.has(holding.token_mint),
  );
  const positionByMint = new Map(positions.map((position) => [position.token_mint, position]));
  const holdingMints = new Set(holdings.map((holding) => holding.token_mint));
  const rows = [
    ...holdings.map((holding) => ({ holding, position: positionByMint.get(holding.token_mint) })),
    ...positions
      .filter((position) => !holdingMints.has(position.token_mint))
      .map((position) => ({
        holding: { token_mint: position.token_mint, amount: 0, decimals: 0 },
        position,
      })),
  ].sort((a, b) => Number(Boolean(b.position)) - Number(Boolean(a.position)));
  const error = positionsQ.error ?? followersQ.error ?? holdingsQ.error;

  return (
    <SectionCard
      title="Wallet holdings & followers"
      description="See each coin you hold, your current balance, and the live balances of follower wallets connected to that coin."
      icon={<Coins className="h-4 w-4" />}
    >
      <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
          <span className="font-medium text-primary">Helix managed:</span> opened by this bot;
          configured exit rules can act on its tracked followers.
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
          <span className="font-medium text-foreground">Wallet only:</span> held in your wallet and
          displayed for awareness; follower activity cannot trigger a trade.
        </div>
      </div>
      {error && (
        <p className="py-3 text-center text-xs text-destructive">
          {error instanceof Error ? error.message : "Failed to load positions"}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {positionsQ.isLoading || holdingsQ.isLoading ? "Loading…" : "No token holdings found."}
        </p>
      ) : (
        <div className="space-y-3 pt-3">
          {rows.map(({ holding, position }) => {
            const attached = position
              ? followers.filter(
                  (follower) => follower.position_id === position.id && !follower.observed_only,
                )
              : followers.filter(
                  (follower) =>
                    follower.token_mint === holding.token_mint && follower.observed_only,
                );
            const cost = position ? usd(Number(position.bot_cost_basis_usd)) : null;
            const managed = Boolean(position);
            return (
              <article
                key={holding.token_mint}
                className="rounded-xl border border-border/70 bg-card/40 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-sm font-semibold" title={holding.token_mint}>
                        {short(holding.token_mint)}
                      </span>
                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${managed ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                      >
                        {managed
                          ? `Helix managed · ${position?.entry_mode ?? "regular"}`
                          : "Wallet only"}
                      </span>
                      <a
                        href={`https://solscan.io/token/${holding.token_mint}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-primary"
                      >
                        View coin <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    <p className="mt-2 break-all text-[10px] text-muted-foreground">
                      Coin mint: <span className="mono text-foreground">{holding.token_mint}</span>
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Your wallet holds{" "}
                      <span className="mono font-medium text-foreground">
                        {amount(holding.amount)} tokens
                      </span>
                      {position ? (
                        <span>
                          {" "}
                          · Helix remaining:{" "}
                          <span className="mono text-foreground">
                            {amount(Number(position.amount_remaining))}
                          </span>
                        </span>
                      ) : null}
                      {cost ? (
                        <span>
                          {" "}
                          · Cost basis: <span className="mono text-foreground">{cost}</span>
                        </span>
                      ) : null}
                    </p>
                  </div>
                  {attached.length > 0 ? (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Users className="h-3.5 w-3.5" />
                      <span>
                        {attached.length} follower{attached.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  ) : null}
                </div>

                {!managed && attached.length === 0 ? (
                  <p className="mt-3 rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                    Wallet-only holding. No observed target recipients yet; Helix exits are not
                    active for this coin.
                  </p>
                ) : attached.length === 0 ? (
                  <p className="mt-3 rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                    No follower wallets have received this coin yet.
                  </p>
                ) : (
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {attached.map((follower, followerIndex) => (
                      <li
                        key={`${position?.id}-${follower.wallet}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/30 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            Follower wallet {followerIndex + 1} of {attached.length}
                          </div>
                          <a
                            href={"https://solscan.io/account/" + follower.wallet}
                            target="_blank"
                            rel="noreferrer"
                            className="mono break-all text-[11px] text-foreground transition-colors hover:text-primary"
                            title="Open this wallet on Solscan"
                          >
                            {follower.wallet}
                          </a>
                          <div className="text-[10px] text-muted-foreground">
                            {follower.observed_only
                              ? "Observed from target-wallet transfers"
                              : `hop ${follower.hop_depth}`}{" "}
                          </div>
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            This wallet's live balance:{" "}
                            <span className="mono font-medium text-foreground">
                              {amount(Number(follower.current_amount))} tokens
                            </span>
                          </div>
                        </div>
                        {follower.held_pct === null ? (
                          <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                            view only
                          </span>
                        ) : (
                          <span
                            className={`mono shrink-0 text-xs ${follower.held_pct > 0 ? "text-success" : "text-muted-foreground"}`}
                          >
                            {follower.held_pct.toFixed(0)}%
                          </span>
                        )}
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
