import { SlidersHorizontal, Target, TrendingUp, ShieldAlert, Rocket, Users, Zap, DollarSign } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import type { BotConfig } from "@/lib/bot-config";
import { SectionCard, SettingRow } from "./SettingRow";

type Props = {
  cfg: BotConfig;
  onChange: (patch: Partial<BotConfig>) => void;
};

const usd = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

function NumInput({ value, onChange, prefix, suffix, step = 1, min }: { value: number; onChange: (n: number) => void; prefix?: string; suffix?: string; step?: number; min?: number }) {
  return (
    <div className="relative">
      {prefix && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 mono text-xs text-muted-foreground">{prefix}</span>}
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`mono h-9 w-32 ${prefix ? "pl-7" : ""} ${suffix ? "pr-8" : ""} text-right`}
      />
      {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 mono text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

export function SettingsPanel({ cfg, onChange }: Props) {
  return (
    <div className="space-y-6">
      {/* Execution */}
      <SectionCard title="Execution" description="How your buys and sells hit the chain" icon={<Zap className="h-4 w-4" />}>
        <SettingRow label="Routing" hint="Jito bundles win priority via tip; RPC is a fallback path.">
          <RadioGroup
            value={cfg.executionRoute}
            onValueChange={(v) => onChange({ executionRoute: v as "jito" | "rpc" })}
            className="flex gap-4"
          >
            <div className="flex items-center gap-2"><RadioGroupItem value="jito" id="r-jito" /><Label htmlFor="r-jito" className="mono text-xs">JITO</Label></div>
            <div className="flex items-center gap-2"><RadioGroupItem value="rpc" id="r-rpc" /><Label htmlFor="r-rpc" className="mono text-xs">RPC</Label></div>
          </RadioGroup>
        </SettingRow>
        <SettingRow label="Jito tip" hint="Applied to every bundle. Higher = better landing under congestion.">
          <div className="flex items-center gap-3 w-72">
            <Slider min={0} max={0.05} step={0.0005} value={[cfg.jitoTipSol]} onValueChange={(v) => onChange({ jitoTipSol: v[0] })} />
            <span className="mono text-xs w-20 text-right">{cfg.jitoTipSol.toFixed(4)} SOL</span>
          </div>
        </SettingRow>
      </SectionCard>

      {/* Position sizing */}
      <SectionCard title="Position sizing" description="How much you commit per copy trade" icon={<DollarSign className="h-4 w-4" />}>
        <SettingRow label="Fixed buy amount" hint="USD you spend on every copied entry, regardless of target size.">
          <NumInput value={cfg.fixedBuyUsd} onChange={(n) => onChange({ fixedBuyUsd: n })} prefix="$" />
        </SettingRow>
        <SettingRow label="Minimum target buy" hint="Only copy if the target spends at least this much USD on the token.">
          <NumInput value={cfg.minTargetBuyUsd} onChange={(n) => onChange({ minTargetBuyUsd: n })} prefix="$" />
        </SettingRow>
      </SectionCard>

      {/* Filters */}
      <SectionCard title="Entry filters" description="Skip trades that don't match your rules" icon={<Target className="h-4 w-4" />}>
        <SettingRow label="Market cap range" hint="Token FDV/MC at time of target's buy.">
          <div className="flex items-center gap-2 mono text-xs">
            <NumInput value={cfg.mcMinUsd} onChange={(n) => onChange({ mcMinUsd: n })} prefix="$" />
            <span className="text-muted-foreground">→</span>
            <NumInput value={cfg.mcMaxUsd} onChange={(n) => onChange({ mcMaxUsd: n })} prefix="$" />
          </div>
        </SettingRow>
        <SettingRow label="Liquidity range" hint="Pool liquidity in USD at entry.">
          <div className="flex items-center gap-2">
            <NumInput value={cfg.liqMinUsd} onChange={(n) => onChange({ liqMinUsd: n })} prefix="$" />
            <span className="text-muted-foreground">→</span>
            <NumInput value={cfg.liqMaxUsd} onChange={(n) => onChange({ liqMaxUsd: n })} prefix="$" />
          </div>
        </SettingRow>
        <SettingRow label="Pump.fun only" hint="Reject non-Pump.fun tokens.">
          <Switch checked={cfg.pumpFunOnly} onCheckedChange={(v) => onChange({ pumpFunOnly: v })} />
        </SettingRow>
        <SettingRow label="Require socials" hint="Only copy if token has X.com / website / Telegram in metadata.">
          <Switch checked={cfg.requireSocials} onCheckedChange={(v) => onChange({ requireSocials: v })} />
        </SettingRow>
        <SettingRow label="First-ever buy only" hint="Copy only if this is the target's very first purchase of this token, across all time.">
          <Switch checked={cfg.onlyFirstBuyEver} onCheckedChange={(v) => onChange({ onlyFirstBuyEver: v })} />
        </SettingRow>
        <SettingRow label="Once per token" hint="Never re-enter a token your bot has already traded.">
          <Switch checked={cfg.onlyOncePerToken} onCheckedChange={(v) => onChange({ onlyOncePerToken: v })} />
        </SettingRow>
      </SectionCard>

      {/* Exit */}
      <SectionCard title="Exit strategy" description="Take profit, stop loss, and follower propagation" icon={<TrendingUp className="h-4 w-4" />}>
        <SettingRow label="Take profit" hint="Auto-sell a portion when a gain threshold hits.">
          <Switch checked={cfg.takeProfitEnabled} onCheckedChange={(v) => onChange({ takeProfitEnabled: v })} />
        </SettingRow>
        {cfg.takeProfitEnabled && (
          <>
            <SettingRow label="TP trigger" hint="Sell when unrealized gain reaches this.">
              <NumInput value={cfg.takeProfitPct} onChange={(n) => onChange({ takeProfitPct: n })} suffix="%" />
            </SettingRow>
            <SettingRow label="TP portion" hint="Percent of remaining bag to sell at trigger.">
              <NumInput value={cfg.takeProfitSellPct} onChange={(n) => onChange({ takeProfitSellPct: n })} suffix="%" />
            </SettingRow>
          </>
        )}
        <SettingRow label="Stop loss" hint="Cut losers at a fixed drawdown.">
          <Switch checked={cfg.stopLossEnabled} onCheckedChange={(v) => onChange({ stopLossEnabled: v })} />
        </SettingRow>
        {cfg.stopLossEnabled && (
          <SettingRow label="SL trigger" hint="Exit fully when down this much.">
            <NumInput value={cfg.stopLossPct} onChange={(n) => onChange({ stopLossPct: n })} suffix="%" />
          </SettingRow>
        )}
        <SettingRow
          label="Proportional follower sells"
          hint="Mirror follower-wallet exits proportionally. If followers dump 30% of their combined supply, your bot sells 30%."
        >
          <Switch
            checked={cfg.proportionalFollowerSells}
            onCheckedChange={(v) => onChange({ proportionalFollowerSells: v })}
          />
        </SettingRow>
      </SectionCard>
    </div>
  );
}

// Explicit re-export usage to silence unused-icon warnings if tree-shaking flags
export const _icons = { SlidersHorizontal, ShieldAlert, Rocket, Users };
