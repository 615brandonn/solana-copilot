import { Gauge, ShieldAlert } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { BotConfig } from "@/lib/bot-config";
import { SectionCard, SettingRow } from "./SettingRow";

type Props = {
  cfg: BotConfig;
  onChange: (patch: Partial<BotConfig>) => void;
};

function NumberInput({
  value,
  onChange,
  prefix,
  suffix,
  min,
  max,
  step = 1,
}: {
  value: number;
  onChange: (value: number) => void;
  prefix?: string;
  suffix?: string;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <div className="relative">
      {prefix && (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
          {prefix}
        </span>
      )}
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className={`h-9 w-32 text-right font-mono ${prefix ? "pl-7" : ""} ${suffix ? "pr-10" : ""}`}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  );
}

export function SupplyAccumulationSettingsCard({ cfg, onChange }: Props) {
  const targetCount = new Set(
    [cfg.targetWallet, ...cfg.additionalTargetWallets]
      .map((wallet) => wallet.trim())
      .filter(Boolean),
  ).size;

  return (
    <SectionCard
      title="Supply Accumulation Entry"
      description="Enter only after the configured market-maker roots acquire a large verified share of a Pump.fun coin"
      icon={<Gauge className="h-4 w-4" />}
    >
      <div className="mb-2 flex items-center justify-between rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
            <ShieldAlert className="h-3.5 w-3.5" /> LIVE AUTOMATIC ENTRY
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Requires Custody Journey, this strategy, and the global Entries switch. Default is OFF.
          </div>
        </div>
        <Switch
          checked={cfg.supplyAccumulationModeEnabled}
          disabled={
            !cfg.supplyAccumulationModeEnabled && (targetCount === 0 || !cfg.custodyJourneyEnabled)
          }
          onCheckedChange={(enabled) =>
            onChange(
              enabled
                ? {
                    supplyAccumulationModeEnabled: true,
                    convictionModeEnabled: false,
                    coordinatedModeEnabled: false,
                  }
                : { supplyAccumulationModeEnabled: false },
            )
          }
          aria-label="Enable live Supply Accumulation entry strategy"
        />
      </div>

      {targetCount === 0 ? (
        <div className="mb-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-400">
          Add at least one market-maker wallet before enabling this strategy.
        </div>
      ) : (
        <div className="mb-2 rounded-xl border border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          Aggregates verified buys and sells across all {targetCount} configured root
          {targetCount === 1 ? " wallet" : " wallets"}. A combined 3% supply share cannot trigger an
          entry; the configured threshold cannot be set below 10%.
        </div>
      )}

      {!cfg.custodyJourneyEnabled && (
        <div className="mb-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-400">
          Turn on Custody Journey above before enabling Supply Accumulation. Every supply entry
          requires a fresh, complete custody-chain safety proof.
        </div>
      )}

      <SettingRow
        label="Verified net supply threshold"
        hint="Enter when rolling verified buys minus verified sells reach this share of authoritative total supply."
      >
        <NumberInput
          value={cfg.supplyAccumulationThresholdPct}
          onChange={(value) => onChange({ supplyAccumulationThresholdPct: value })}
          suffix="%"
          min={10}
          max={20}
          step={0.1}
        />
      </SettingRow>

      <SettingRow
        label="Accumulation window"
        hint="Only verified market-maker activity inside this rolling window contributes to net supply share."
      >
        <NumberInput
          value={cfg.supplyAccumulationWindowSeconds}
          onChange={(value) => onChange({ supplyAccumulationWindowSeconds: Math.round(value) })}
          suffix="sec"
          min={30}
          max={3_600}
        />
      </SettingRow>

      <SettingRow
        label="Copy-buy amount"
        hint="Dedicated USD amount for the one replay-protected entry when the threshold is first crossed."
      >
        <NumberInput
          value={cfg.supplyAccumulationBuyUsd}
          onChange={(value) => onChange({ supplyAccumulationBuyUsd: value })}
          prefix="$"
          min={0.01}
          max={1_000_000}
          step={0.01}
        />
      </SettingRow>

      <SettingRow
        label="Hard market-cap ceiling"
        hint="Missing or stale valuation blocks entry. The worker rechecks strict current and estimated post-fill market cap before submission."
      >
        <NumberInput
          value={cfg.supplyAccumulationMaxMarketCapUsd}
          onChange={(value) => onChange({ supplyAccumulationMaxMarketCapUsd: value })}
          prefix="$"
          min={1}
          max={15_000}
          step={100}
        />
      </SettingRow>

      <div className="mt-2 rounded-xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-xs text-amber-200">
        Custody Journey must be ON for every Supply Accumulation entry. Fresh observer health, the
        exact target buy, and positive live attribution must be verified atomically; any verified
        descendant sell, unresolved outflow, degraded observer, stale proof, or backlog blocks the
        buy. Direct/private-program forwarding remains marked for audit.
      </div>

      <div className="mt-2 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3 text-xs text-muted-foreground">
        This is an exclusive entry strategy. Enabling it turns off the Conviction and Coordinated
        toggles; their detailed settings remain unchanged. Every landed buy opens a standard
        position, so the bot&apos;s existing take-profit, stop-loss, trailing-stop, custody,
        direct-target, follower-sell, and inactivity exits continue unchanged.
      </div>
    </SectionCard>
  );
}
