import { Radar } from "lucide-react";
import type { BotConfig } from "@/lib/bot-config";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionCard, SettingRow } from "./SettingRow";

type Props = {
  cfg: BotConfig;
  onChange: (patch: Partial<BotConfig>) => void;
};

function MarketCapInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
        $
      </span>
      <Input
        type="number"
        min={0}
        step={100}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value)))}
        className="h-9 w-32 pl-7 text-right font-mono"
      />
    </div>
  );
}

export function RevivalTrackerSettingsCard({ cfg, onChange }: Props) {
  return (
    <SectionCard
      title="Revival Campaign Tracker"
      description="Collects low-cap target revival campaigns from the first seed through ignition and distribution"
      icon={<Radar className="h-4 w-4" />}
    >
      <div className="mb-2 flex items-center justify-between rounded-xl border border-cyan-400/25 bg-cyan-400/5 px-4 py-3">
        <div>
          <div className="text-xs font-semibold text-cyan-300">SHADOW ONLY</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            This observer has no transaction, funding-key, position, or exit capability.
          </div>
        </div>
        <Switch
          checked={cfg.revivalTrackerEnabled}
          onCheckedChange={(value) => onChange({ revivalTrackerEnabled: value })}
          aria-label="Collect observation-only Revival campaigns"
        />
      </div>

      <SettingRow
        label="Seed market-cap range"
        hint="Inclusive admission gate for the first verified target buy. Once admitted, a campaign remains tracked above the ceiling so ignition and distribution are not truncated."
      >
        <div className="flex items-center gap-2">
          <MarketCapInput
            value={cfg.revivalMarketCapMinUsd}
            onChange={(minimum) =>
              onChange({
                revivalMarketCapMinUsd: minimum,
                revivalMarketCapMaxUsd: Math.max(minimum, cfg.revivalMarketCapMaxUsd),
              })
            }
          />
          <span className="text-xs text-muted-foreground">to</span>
          <MarketCapInput
            value={cfg.revivalMarketCapMaxUsd}
            onChange={(maximum) =>
              onChange({
                revivalMarketCapMinUsd: Math.min(cfg.revivalMarketCapMinUsd, maximum),
                revivalMarketCapMaxUsd: maximum,
              })
            }
          />
        </div>
      </SettingRow>

      <div className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        The first target buy only seeds a campaign. It can never authorize a trade. Collection is
        independent of global Entries, Conviction, Coordinated mode, and every exit strategy. Pair
        age and pre-seed activity are stored as dormancy evidence; they are not promoted to a live
        filter until forward results support it.
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        Initial paper baseline: at least 2 verified target buys and $1,000 net target commitment
        within 45 minutes. These are labels for next week&apos;s calibration—not trading rules.
      </div>
      <div className="mt-2 rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-[11px] text-amber-100">
        Separate legacy VPS flag: <span className="font-mono">REVIVAL_ONLY_MODE</span> is an older
        money-moving entry route and is not controlled by this tracker. Keep that environment flag
        OFF during the collection-only week.
      </div>
    </SectionCard>
  );
}
