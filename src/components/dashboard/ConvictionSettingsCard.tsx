import { AlertTriangle, BrainCircuit } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import type { BotConfig } from "@/lib/bot-config";
import { SectionCard, SettingRow } from "./SettingRow";

type Props = { cfg: BotConfig; onChange: (patch: Partial<BotConfig>) => void };

function NumberInput({
  value,
  onChange,
  prefix,
  suffix,
  min = 0,
  max,
  step = 1,
}: {
  value: number;
  onChange: (value: number) => void;
  prefix?: string;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {prefix && <span className="mono text-xs text-muted-foreground">{prefix}</span>}
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mono h-9 w-28 text-right"
      />
      {suffix && <span className="mono text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function Range({
  min,
  max,
  onMin,
  onMax,
  suffix,
}: {
  min: number;
  max: number;
  onMin: (value: number) => void;
  onMax: (value: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <NumberInput value={min} onChange={onMin} prefix={suffix ? undefined : "$"} suffix={suffix} />
      <span className="text-xs text-muted-foreground">→</span>
      <NumberInput value={max} onChange={onMax} prefix={suffix ? undefined : "$"} suffix={suffix} />
    </div>
  );
}

export function ConvictionSettingsCard({ cfg, onChange }: Props) {
  const targetCount = new Set(
    [cfg.targetWallet, ...cfg.additionalTargetWallets]
      .map((wallet) => wallet.trim())
      .filter(Boolean),
  ).size;
  const weights = [
    ["Net", "convictionWeightNetCommitment", cfg.convictionWeightNetCommitment],
    ["Velocity", "convictionWeightVelocity", cfg.convictionWeightVelocity],
    ["Acceleration", "convictionWeightAcceleration", cfg.convictionWeightAcceleration],
    ["Convergence", "convictionWeightConvergence", cfg.convictionWeightConvergence],
    ["Persistence", "convictionWeightPersistence", cfg.convictionWeightPersistence],
  ] as const;
  const weightTotal = weights.reduce((total, row) => total + row[2], 0);
  const tierTotal = cfg.convictionTierBuyAmountsUsd.reduce((total, amount) => total + amount, 0);

  const setTierValue = (
    field: "convictionTierCommitmentThresholdsUsd" | "convictionTierBuyAmountsUsd",
    index: number,
    value: number,
  ) => {
    const next = [...cfg[field]];
    next[index] = value;
    onChange({ [field]: next } as Partial<BotConfig>);
  };

  return (
    <SectionCard
      title="Conviction Mode"
      description="Detect where the market-maker wallet cluster stops testing and starts betting."
      icon={<BrainCircuit className="h-4 w-4" />}
    >
      <SettingRow
        label="CONVICTION MODE"
        hint="When enabled, Conviction Mode becomes the exclusive automatic entry strategy and other automatic buy strategies are temporarily disabled. Existing settings are preserved."
      >
        <div className="flex items-center gap-2">
          <span className="mono text-xs text-muted-foreground">
            {cfg.convictionModeEnabled ? "ON" : "OFF"}
          </span>
          <Switch
            aria-label="Enable Conviction Mode"
            checked={cfg.convictionModeEnabled}
            disabled={!cfg.convictionModeEnabled && targetCount !== 3}
            onCheckedChange={(value) =>
              onChange(
                value
                  ? { convictionModeEnabled: true, convictionTradingMode: "shadow" }
                  : { convictionModeEnabled: false },
              )
            }
          />
        </div>
      </SettingRow>
      {targetCount !== 3 && (
        <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-500">
          Conviction Mode requires exactly 3 unique market-maker wallets ({targetCount}/3
          configured).
        </div>
      )}
      {cfg.convictionModeEnabled && (
        <div className="mb-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-xs text-muted-foreground">
          Conviction is the only automatic entry strategy. Wallet monitoring and existing sell,
          risk, routing, and global Entries controls remain active.
        </div>
      )}

      <SettingRow
        label="Trading mode"
        hint="SHADOW records hypothetical entries without sending a buy. LIVE requires an explicit selection."
      >
        <RadioGroup
          value={cfg.convictionTradingMode}
          onValueChange={(value) =>
            onChange({ convictionTradingMode: value as BotConfig["convictionTradingMode"] })
          }
          className="flex gap-4"
        >
          {(["shadow", "live"] as const).map((mode) => (
            <div key={mode} className="flex items-center gap-2">
              <RadioGroupItem
                value={mode}
                id={`conviction-${mode}`}
                disabled={mode === "live" && !cfg.convictionModeEnabled}
              />
              <Label htmlFor={`conviction-${mode}`} className="mono text-xs uppercase">
                {mode}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </SettingRow>
      {cfg.convictionTradingMode === "live" && (
        <div className="mb-3 flex gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          LIVE may spend real funds only while Conviction Mode and the global Entries switch are
          both on. Start in SHADOW and review the leaderboard first.
        </div>
      )}
      {!cfg.convictionModeEnabled && (
        <div className="mb-3 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          Enabling Conviction always starts in SHADOW. Select LIVE only after reviewing shadow
          results; live buys still require the global Entries switch.
        </div>
      )}

      <SettingRow
        label="Rapid Follow"
        hint="Allows one controlled scale-in per tier as commitment rises; inactive unless Conviction Mode is on."
      >
        <Switch
          checked={cfg.convictionRapidFollowEnabled}
          disabled={!cfg.convictionModeEnabled}
          onCheckedChange={(value) => onChange({ convictionRapidFollowEnabled: value })}
        />
      </SettingRow>
      <SettingRow label="Primary leaderboard" hint="Default competitive ranking window.">
        <RadioGroup
          value={String(cfg.convictionPrimaryWindowMinutes)}
          onValueChange={(value) =>
            onChange({ convictionPrimaryWindowMinutes: Number(value) as 5 | 30 | 60 })
          }
          className="flex gap-3"
        >
          {[5, 30, 60].map((minutes) => (
            <div key={minutes} className="flex items-center gap-1.5">
              <RadioGroupItem value={String(minutes)} id={`conviction-window-${minutes}`} />
              <Label htmlFor={`conviction-window-${minutes}`} className="mono text-xs">
                {minutes}M
              </Label>
            </div>
          ))}
        </RadioGroup>
      </SettingRow>
      <SettingRow
        label="Entry quality"
        hint="Requires both relative leaderboard rank and absolute score."
      >
        <div className="flex flex-wrap justify-end gap-2">
          <NumberInput
            value={cfg.convictionTopN}
            onChange={(value) => onChange({ convictionTopN: Math.round(value) })}
            prefix="Top"
            min={1}
            max={10}
          />
          <NumberInput
            value={cfg.convictionScoreThreshold}
            onChange={(value) => onChange({ convictionScoreThreshold: value })}
            prefix="Score"
            min={0}
            max={100}
          />
        </div>
      </SettingRow>
      <SettingRow
        label="Capital requirements"
        hint="Minimum total commitment, recent positive net inflow, velocity, and acceleration before entry."
      >
        <div className="flex flex-wrap justify-end gap-2">
          <NumberInput
            value={cfg.convictionMinCommitmentUsd}
            onChange={(value) => onChange({ convictionMinCommitmentUsd: value })}
            prefix="$"
            suffix="net"
          />
          <NumberInput
            value={cfg.convictionMinRecentNetInflowUsd}
            onChange={(value) => onChange({ convictionMinRecentNetInflowUsd: value })}
            prefix="$"
            suffix="recent inflow"
            min={0}
            step={0.01}
          />
          <NumberInput
            value={cfg.convictionMinVelocityUsdPerMinute}
            onChange={(value) => onChange({ convictionMinVelocityUsdPerMinute: value })}
            prefix="$"
            suffix="/min"
          />
          <NumberInput
            value={cfg.convictionMinAccelerationRatio}
            onChange={(value) => onChange({ convictionMinAccelerationRatio: value })}
            suffix="x accel"
            step={0.05}
          />
        </div>
      </SettingRow>
      <SettingRow
        label="Wallet convergence"
        hint="Convergence strengthens conviction but never buys by itself."
      >
        <div className="flex flex-wrap justify-end gap-2">
          <NumberInput
            value={cfg.convictionMinConvergedWallets}
            onChange={(value) => onChange({ convictionMinConvergedWallets: Math.round(value) })}
            suffix="wallets"
            min={1}
            max={3}
          />
          <NumberInput
            value={cfg.convictionTwoWalletWindowSeconds}
            onChange={(value) => onChange({ convictionTwoWalletWindowSeconds: Math.round(value) })}
            prefix="2/3"
            suffix="sec"
            min={1}
          />
          <NumberInput
            value={cfg.convictionThreeWalletWindowSeconds}
            onChange={(value) =>
              onChange({ convictionThreeWalletWindowSeconds: Math.round(value) })
            }
            prefix="3/3"
            suffix="sec"
            min={1}
          />
        </div>
      </SettingRow>
      <SettingRow label="Minimum individual MM buy" hint="Optional buy-size floor; 0 disables it.">
        <NumberInput
          value={cfg.convictionMinIndividualBuyUsd}
          onChange={(value) => onChange({ convictionMinIndividualBuyUsd: value })}
          prefix="$"
        />
      </SettingRow>

      <SettingRow label="Market-cap filter" hint="Optional; no fixed $20K ceiling is imposed.">
        <Switch
          checked={cfg.convictionMarketCapFilterEnabled}
          onCheckedChange={(value) => onChange({ convictionMarketCapFilterEnabled: value })}
        />
      </SettingRow>
      {cfg.convictionMarketCapFilterEnabled && (
        <SettingRow label="Market-cap range">
          <Range
            min={cfg.convictionMarketCapMinUsd}
            max={cfg.convictionMarketCapMaxUsd}
            onMin={(value) => onChange({ convictionMarketCapMinUsd: value })}
            onMax={(value) => onChange({ convictionMarketCapMaxUsd: value })}
          />
        </SettingRow>
      )}
      <SettingRow label="Liquidity filter" hint="Optional minimum and maximum live liquidity.">
        <Switch
          checked={cfg.convictionLiquidityFilterEnabled}
          onCheckedChange={(value) => onChange({ convictionLiquidityFilterEnabled: value })}
        />
      </SettingRow>
      {cfg.convictionLiquidityFilterEnabled && (
        <SettingRow label="Liquidity range">
          <Range
            min={cfg.convictionLiquidityMinUsd}
            max={cfg.convictionLiquidityMaxUsd}
            onMin={(value) => onChange({ convictionLiquidityMinUsd: value })}
            onMax={(value) => onChange({ convictionLiquidityMaxUsd: value })}
          />
        </SettingRow>
      )}
      <SettingRow
        label="Token-age filter"
        hint="Optional; revival tokens remain eligible when off."
      >
        <Switch
          checked={cfg.convictionTokenAgeFilterEnabled}
          onCheckedChange={(value) => onChange({ convictionTokenAgeFilterEnabled: value })}
        />
      </SettingRow>
      {cfg.convictionTokenAgeFilterEnabled && (
        <SettingRow label="Token-age range">
          <Range
            min={cfg.convictionTokenAgeMinMinutes}
            max={cfg.convictionTokenAgeMaxMinutes}
            onMin={(value) => onChange({ convictionTokenAgeMinMinutes: value })}
            onMax={(value) => onChange({ convictionTokenAgeMaxMinutes: value })}
            suffix="min"
          />
        </SettingRow>
      )}

      <SettingRow
        label="Maximum exposure"
        hint="Hard per-token cap across the first qualifying entry and every later Rapid Follow tier."
      >
        <NumberInput
          value={cfg.convictionMaxPositionPerTokenUsd}
          onChange={(value) => onChange({ convictionMaxPositionPerTokenUsd: value })}
          prefix="$"
          suffix="max"
          min={0.01}
          step={0.25}
        />
      </SettingRow>
      <SettingRow
        label="Stop-adding controls"
        hint="Distribution requires the recent sell floor plus a high sell ratio, multiple sellers, or negative net flow. These controls stop scale-ins; existing exit logic remains responsible for sells."
      >
        <div className="flex flex-wrap justify-end gap-2">
          <NumberInput
            value={cfg.convictionDistributionSellRatio}
            onChange={(value) => onChange({ convictionDistributionSellRatio: value })}
            suffix="sell ratio"
            min={0}
            max={1}
            step={0.05}
          />
          <NumberInput
            value={cfg.convictionDistributionMinSellsUsd}
            onChange={(value) => onChange({ convictionDistributionMinSellsUsd: value })}
            prefix="$"
            suffix="sold"
            min={0}
          />
          <NumberInput
            value={cfg.convictionDistributionWalletCount}
            onChange={(value) => onChange({ convictionDistributionWalletCount: Math.round(value) })}
            suffix="sell wallets"
            min={1}
            max={3}
          />
          <NumberInput
            value={cfg.convictionInactivityMinutes}
            onChange={(value) => onChange({ convictionInactivityMinutes: value })}
            suffix="min idle"
            min={0.01}
          />
          <NumberInput
            value={cfg.convictionRankLossGraceSeconds}
            onChange={(value) => onChange({ convictionRankLossGraceSeconds: Math.round(value) })}
            suffix="sec grace"
          />
        </div>
      </SettingRow>

      <div className="border-b border-border/60 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">Rapid Follow tiers</div>
            <div className="text-xs text-muted-foreground">
              Tier 1 is the first qualifying entry. Tiers 2–4 require Rapid Follow. Every tier
              executes or shadows only once per token.
            </div>
          </div>
          <span
            className={`mono text-xs ${tierTotal <= cfg.convictionMaxPositionPerTokenUsd ? "text-success" : "text-destructive"}`}
          >
            ${tierTotal} / ${cfg.convictionMaxPositionPerTokenUsd}
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {cfg.convictionTierCommitmentThresholdsUsd.map((threshold, index) => (
            <div
              key={index}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 p-2"
            >
              <span className="mono text-xs">TIER {index + 1}</span>
              <NumberInput
                value={threshold}
                onChange={(value) =>
                  setTierValue("convictionTierCommitmentThresholdsUsd", index, value)
                }
                prefix="$"
                suffix="MM"
                min={0.01}
              />
              <NumberInput
                value={cfg.convictionTierBuyAmountsUsd[index]}
                onChange={(value) => setTierValue("convictionTierBuyAmountsUsd", index, value)}
                prefix="$"
                suffix="buy"
                min={0.01}
                step={0.25}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="py-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Transparent score weights</div>
            <div className="text-xs text-muted-foreground">Weights must total exactly 100%.</div>
          </div>
          <span
            className={`mono text-xs ${Math.abs(weightTotal - 100) <= 0.000_001 ? "text-success" : "text-destructive"}`}
          >
            {weightTotal}%
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {weights.map(([label, field, value]) => (
            <label
              key={field}
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              {label}
              <Input
                type="number"
                min={0}
                max={100}
                value={value}
                onChange={(event) =>
                  onChange({ [field]: Number(event.target.value) } as Partial<BotConfig>)
                }
                className="mono mt-1 h-9 text-right"
              />
            </label>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
