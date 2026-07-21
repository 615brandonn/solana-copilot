import { Users } from "lucide-react";
import { SectionCard } from "./SettingRow";

type Follower = { addr: string; token: string; heldPct: number };

const demo: Follower[] = [
  { addr: "9ozA…4kFq", token: "$WIF", heldPct: 100 },
  { addr: "B2xK…8mNr", token: "$WIF", heldPct: 100 },
  { addr: "Cp1n…7hVy", token: "$MOTHER", heldPct: 72 },
];

export function MonitoredWallets({ items = demo }: { items?: Follower[] }) {
  return (
    <SectionCard
      title="Monitored followers"
      description="Wallets your target sent tokens to after buying. Auto-removed once you're flat."
      icon={<Users className="h-4 w-4" />}
    >
      {items.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No active follower monitoring.</p>
      ) : (
        <ul className="space-y-2 pt-2">
          {items.map((f, i) => (
            <li
              key={i}
              className="flex items-center justify-between rounded-lg border border-border/60 bg-card/40 px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <span className="mono text-xs text-foreground">{f.addr}</span>
                <span className="mono text-[10px] text-muted-foreground">tracking {f.token}</span>
              </div>
              <span className="mono text-xs text-muted-foreground">
                holds <span className="text-foreground">{f.heldPct}%</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
