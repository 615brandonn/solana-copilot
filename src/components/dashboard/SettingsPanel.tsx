import {
  SlidersHorizontal,
  Target,
  TrendingUp,
  ShieldAlert,
  Rocket,
  Users,
  Zap,
  DollarSign,
} from "lucide-react";
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

function NumInput({
  value,
  onChange,
  prefix,
  suffix,
  step = 1,
  min,
}: {
  value: number;
  onChange: (n: number) => void;
  prefix?: string;
  suffix?: string;
  step?: number;
  min?: number;
}) {
  return (
    <div className="relative">
      {prefix && (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 mono text-xs text-muted-foreground">
          {prefix}
        </span>
      )}
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`mono h-9 w-32 ${prefix ? "pl-7" : ""} ${suffix ? "pr-8" : ""} text-right`}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 mono text-xs text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  );
}

export function SettingsPanel({ cfg, onChange }: Props) {
  return (
    <div className="space-y-6">
      {/* Execution */}
      <SectionCard
        title="Execution"
        description="How your buys and sells hit the chain"
        icon={<Zap className="h-4 w-4" />}
      >
        <SettingRow
          label="Routing"
          hint="Jito bundles win priority via tip; RPC is a fallback path."
        >
          <RadioGroup
            value={cfg.executionRoute}
            onValueChange={(v) => onChange({ executionRoute: v as "jito" | "rpc" })}
            className="flex gap-4"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="jito" id="r-jito" />
              <Label htmlFor="r-jito" className="mono text-xs">
                JITO
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="rpc" id="r-rpc" />
              <Label htmlFor="r-rpc" className="mono text-xs">
                RPC
              </Label>
            </div>
          </RadioGroup>
        </SettingRow>
        <SettingRow
          label="Jito tip"
          hint="Applied to every bundle. Higher = better landing under congestion."
        >
          <div className="flex items-center gap-3 w-72">
            <Slider
              min={0.000001}
              max={0.05}
              step={0.000001}
              value={[cfg.jitoTipSol]}
              onValueChange={(v) => onChange({ jitoTipSol: v[0] })}
            />
            <span className="mono text-xs w-20 text-right">{cfg.jitoTipSol.toFixed(4)} SOL</span>
          </div>
        </SettingRow>
      </SectionCard>

      {/* Position sizing */}
      <SectionCard
        title="Position sizing"
        description="Protect starter capital while following stronger market-maker conviction"
        icon={<DollarSign className="h-4 w-4" />}
      >
        <SettingRow
          label="Fixed buy amount"
          hint={
            cfg.networkScalingEnabled
              ? "Used only when campaign scaling is turned off. Scaling mode sizes entries from your live bankroll."
              : "Verified USD value of SOL sent into each swap. Network/Jito fees are additional."
          }
        >
          <NumInput
            value={cfg.fixedBuyUsd}
            onChange={(n) => onChange({ fixedBuyUsd: n })}
            prefix="$"
            min={0.01}
          />
        </SettingRow>
        <SettingRow
          label="Capital-aware campaign scaling"
          hint="Treat all configured market-maker wallets as one campaign. Start small, then add only when their combined spending rises."
        >
          <Switch
            checked={cfg.networkScalingEnabled}
            onCheckedChange={(v) => onChange({ networkScalingEnabled: v })}
          />
        </SettingRow>
        {cfg.networkScalingEnabled && (
          <>
            <SettingRow
              label="Starter per coin"
              hint="The first copied buy uses this percentage of your available cash plus current open-position cost basis."
            >
              <NumInput
                value={cfg.starterPositionPct}
                onChange={(n) => onChange({ starterPositionPct: n })}
                suffix="%"
                step={0.5}
                min={0.1}
              />
            </SettingRow>
            <SettingRow
              label="Maximum per coin"
              hint="Hard ceiling for one campaign. With a $50 bankroll, 15% means no more than about $7.50 in one coin."
            >
              <NumInput
                value={cfg.maxPositionPct}
                onChange={(n) => onChange({ maxPositionPct: n })}
                suffix="%"
                step={0.5}
                min={0.1}
              />
            </SettingRow>
            <SettingRow
              label="Protected scale-in reserve"
              hint="New coins cannot spend this portion of your bankroll. Existing coins may use it after the market maker buys more."
            >
              <NumInput
                value={cfg.newEntryReservePct}
                onChange={(n) => onChange({ newEntryReservePct: n })}
                suffix="%"
                step={1}
                min={0}
              />
            </SettingRow>
            <SettingRow
              label="Copy ratio"
              hint="Your desired position as a percentage of all target-wallet spending on that coin. 1% means their combined $500 becomes your $5 target."
            >
              <NumInput
                value={cfg.targetCopyRatioPct}
                onChange={(n) => onChange({ targetCopyRatioPct: n })}
                suffix="%"
                step={0.1}
                min={0.1}
              />
            </SettingRow>
            <SettingRow
              label="Smallest scale-in"
              hint="Wait until accumulated target buys justify at least this much, avoiding repeated dust swaps and fees."
            >
              <NumInput
                value={cfg.minScaleBuyUsd}
                onChange={(n) => onChange({ minScaleBuyUsd: n })}
                prefix="$"
                step={0.25}
                min={0.01}
              />
            </SettingRow>
          </>
        )}
        <SettingRow
          label="Minimum target buy"
          hint="Only copy if the target spends at least this much USD on the token."
        >
          <NumInput
            value={cfg.minTargetBuyUsd}
            onChange={(n) => onChange({ minTargetBuyUsd: n })}
            prefix="$"
            min={0}
          />
        </SettingRow>
      </SectionCard>

      {/* Filters */}
      <SectionCard
        title="Entry filters"
        description="Skip trades that don't match your rules"
        icon={<Target className="h-4 w-4" />}
      >
        <SettingRow
          label="Market cap range"
          hint="Strict token FDV/MC range at entry. A buy is skipped if market-cap data is unavailable."
        >
          <div className="flex items-center gap-2 mono text-xs">
            <NumInput value={cfg.mcMinUsd} onChange={(n) => onChange({ mcMinUsd: n })} prefix="$" />
            <span className="text-muted-foreground">→</span>
            <NumInput value={cfg.mcMaxUsd} onChange={(n) => onChange({ mcMaxUsd: n })} prefix="$" />
          </div>
        </SettingRow>
        <SettingRow
          label="Liquidity range"
          hint="Strict pool-liquidity range at entry. A buy is skipped if liquidity data is unavailable."
        >
          <div className="flex items-center gap-2">
            <NumInput
              value={cfg.liqMinUsd}
              onChange={(n) => onChange({ liqMinUsd: n })}
              prefix="$"
            />
            <span className="text-muted-foreground">→</span>
            <NumInput
              value={cfg.liqMaxUsd}
              onChange={(n) => onChange({ liqMaxUsd: n })}
              prefix="$"
            />
          </div>
        </SettingRow>
        <SettingRow label="Pump.fun only" hint="Reject non-Pump.fun tokens.">
          <Switch checked={cfg.pumpFunOnly} onCheckedChange={(v) => onChange({ pumpFunOnly: v })} />
        </SettingRow>
        <SettingRow
          label="Require socials"
          hint="Only copy if token has X.com / website / Telegram in metadata."
        >
          <Switch
            checked={cfg.requireSocials}
            onCheckedChange={(v) => onChange({ requireSocials: v })}
          />
        </SettingRow>
        <SettingRow
          label="24h uptrend only"
          hint="Only buy when the available 24-hour price change is above 0%. New tokens use their available history since launch. Missing trend data is rejected."
        >
          <Switch
            checked={cfg.require24hUptrend}
            onCheckedChange={(v) => onChange({ require24hUptrend: v })}
          />
        </SettingRow>
        <SettingRow
          label="Target large-buy scanner"
          hint="Only copy unusually large buys made by your configured target wallet. This never buys from an unrelated wallet."
        >
          <Switch
            checked={cfg.largeBuyScannerEnabled}
            onCheckedChange={(v) => onChange({ largeBuyScannerEnabled: v })}
          />
        </SettingRow>
        {cfg.largeBuyScannerEnabled && (
          <>
            <SettingRow
              label="Scanner market-cap ceiling"
              hint="Scanner mode replaces the normal market-cap range with $0 up to this ceiling. A final live on-chain check also blocks the buy if your order would push the token over the ceiling."
            >
              <NumInput
                value={cfg.largeBuyScannerMaxMcUsd}
                onChange={(n) => onChange({ largeBuyScannerMaxMcUsd: n })}
                prefix="$"
                min={1}
              />
            </SettingRow>
            <SettingRow
              label="Scanner minimum target buy"
              hint="The target must spend at least this much in one confirmed buy."
            >
              <NumInput
                value={cfg.largeBuyScannerMinBuyUsd}
                onChange={(n) => onChange({ largeBuyScannerMinBuyUsd: n })}
                prefix="$"
                min={0.01}
              />
            </SettingRow>
            <SettingRow
              label="Unusual-size multiplier"
              hint="The target buy must also be this many times larger than the median of its recent buys."
            >
              <NumInput
                value={cfg.largeBuyScannerMultiplier}
                onChange={(n) => onChange({ largeBuyScannerMultiplier: n })}
                suffix="x"
                step={0.1}
                min={1}
              />
            </SettingRow>
            <SettingRow
              label="Target-buy history"
              hint="Number of recent target buys used to calculate the median. At least five prior buys are required."
            >
              <NumInput
                value={cfg.largeBuyScannerHistoryWindow}
                onChange={(n) =>
                  onChange({ largeBuyScannerHistoryWindow: Math.max(5, Math.round(n)) })
                }
                suffix="buys"
                min={5}
              />
            </SettingRow>
          </>
        )}
        <SettingRow
          label="First-ever buy only"
          hint="Copy only if this is the target's very first purchase of this token, across all time."
        >
          <Switch
            checked={cfg.onlyFirstBuyEver}
            onCheckedChange={(v) => onChange({ onlyFirstBuyEver: v })}
          />
        </SettingRow>
        <SettingRow
          label="Once per token"
          hint="Never re-enter a token your bot has already traded."
        >
          <Switch
            checked={cfg.onlyOncePerToken}
            onCheckedChange={(v) => onChange({ onlyOncePerToken: v })}
          />
        </SettingRow>
      </SectionCard>

      {/* Exit */}
      <SectionCard
        title="Exit strategy"
        description="Take profit, stop loss, and follower propagation"
        icon={<TrendingUp className="h-4 w-4" />}
      >
        <SettingRow label="Take profit" hint="Auto-sell a portion when a gain threshold hits.">
          <Switch
            checked={cfg.takeProfitEnabled}
            onCheckedChange={(v) => onChange({ takeProfitEnabled: v })}
          />
        </SettingRow>
        {cfg.takeProfitEnabled && (
          <>
            <SettingRow label="TP trigger" hint="Sell when unrealized gain reaches this.">
              <NumInput
                value={cfg.takeProfitPct}
                onChange={(n) => onChange({ takeProfitPct: n })}
                suffix="%"
              />
            </SettingRow>
            <SettingRow label="TP portion" hint="Percent of remaining bag to sell at trigger.">
              <NumInput
                value={cfg.takeProfitSellPct}
                onChange={(n) => onChange({ takeProfitSellPct: n })}
                suffix="%"
              />
            </SettingRow>
          </>
        )}
        <SettingRow label="Stop loss" hint="Cut losers at a fixed drawdown.">
          <Switch
            checked={cfg.stopLossEnabled}
            onCheckedChange={(v) => onChange({ stopLossEnabled: v })}
          />
        </SettingRow>
        {cfg.stopLossEnabled && (
          <SettingRow label="SL trigger" hint="Exit fully when down this much.">
            <NumInput
              value={cfg.stopLossPct}
              onChange={(n) => onChange({ stopLossPct: n })}
              suffix="%"
            />
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
