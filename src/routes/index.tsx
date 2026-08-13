import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast, Toaster } from "sonner";

import { DEFAULT_CONFIG, loadConfig, saveConfig, type BotConfig } from "@/lib/bot-config";
import {
  getBotConfig,
  saveBotConfig,
  getPositions,
  getFollowers,
  saveFundingKey,
  getFundingKeyStatus,
  getWorkerStatus,
} from "@/lib/bot.functions";
import { isSolanaPublicKey } from "@/lib/base58";
import { useQuery } from "@tanstack/react-query";
import { StatusHeader } from "@/components/dashboard/StatusHeader";
import { WalletPanel } from "@/components/dashboard/WalletPanel";
import { SettingsPanel } from "@/components/dashboard/SettingsPanel";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { StrategyLab } from "@/components/dashboard/StrategyLab";
import { ConvictionDashboard } from "@/components/dashboard/ConvictionDashboard";
import { PositionFollowers } from "@/components/dashboard/PositionFollowers";
import { CustodyJourneyDashboard } from "@/components/dashboard/CustodyJourneyDashboard";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Helix — Solana Copy Trading Bot" },
      {
        name: "description",
        content:
          "Configure sub-second Solana copy trades, follower propagation exits, and risk filters.",
      },
      { property: "og:title", content: "Helix — Solana Copy Trading Bot" },
      {
        property: "og:description",
        content: "Sub-second Solana copy trading with follower-wallet monitoring.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  loader: async () => {
    try {
      const remote = await getBotConfig();
      return { remote, loadError: null as string | null };
    } catch (error) {
      return {
        remote: null,
        loadError: error instanceof Error ? error.message : "Could not load Supabase config",
      };
    }
  },
  component: Dashboard,
  errorComponent: () => (
    <div className="p-8 text-center">Failed to load bot config. Refresh to retry.</div>
  ),
  notFoundComponent: () => <div className="p-8 text-center">Dashboard not found.</div>,
});

function Dashboard() {
  const { remote, loadError } = Route.useLoaderData();
  const [cfg, setCfg] = useState<BotConfig>(remote ?? DEFAULT_CONFIG);
  const cfgRef = useRef(cfg);
  const [hydrated, setHydrated] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [configRevision, setConfigRevision] = useState(0);

  useEffect(() => {
    // Supabase is authoritative. Local settings are only a fallback when the
    // remote row could not be loaded, preventing stale browser data from
    // silently overwriting a live VPS configuration.
    if (!remote) {
      const local = loadConfig();
      setCfg((current) => {
        const next = { ...current, ...local };
        cfgRef.current = next;
        return next;
      });
    }
    setHydrated(true);
    if (loadError) toast.error(`Config not loaded: ${loadError}`);
  }, [loadError, remote]);

  useEffect(() => {
    if (!hydrated || configRevision === 0) return;
    // Persist non-sensitive settings locally for fast startup.
    const configToSave = cfgRef.current;
    saveConfig(configToSave);
    // Sync to your own Supabase.
    const timeout = setTimeout(async () => {
      setSyncing(true);
      try {
        await saveBotConfig({ data: configToSave });
        toast.success("Settings synced to Supabase");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        console.error("Supabase sync failed:", msg);
        toast.error(`Could not sync: ${msg}`);
      } finally {
        setSyncing(false);
      }
    }, 600);
    return () => clearTimeout(timeout);
  }, [configRevision, hydrated]);

  const update = (patch: Partial<BotConfig>) => {
    setCfg((current) => {
      const next = { ...current, ...patch };
      cfgRef.current = next;
      return next;
    });
    if (Object.keys(patch).some((key) => key !== "fundingPrivateKey")) {
      setConfigRevision((revision) => revision + 1);
    }
  };

  const fundingKeyQ = useQuery({
    queryKey: ["funding-key-status"],
    queryFn: () => getFundingKeyStatus(),
    refetchInterval: 10_000,
  });
  const workerQ = useQuery({
    queryKey: ["worker-status"],
    queryFn: () => getWorkerStatus(),
    refetchInterval: 10_000,
    retry: false,
  });
  const keySaved = fundingKeyQ.data?.saved ?? false;
  const readinessPending = fundingKeyQ.isPending || workerQ.isPending;
  const readinessIssues: string[] = [];
  if (!isSolanaPublicKey(cfg.targetWallet || ""))
    readinessIssues.push("Target wallet missing or invalid.");
  const configuredTargetCount =
    (isSolanaPublicKey(cfg.targetWallet || "") ? 1 : 0) + cfg.additionalTargetWallets.length;
  const convictionTargetCount = new Set(
    [cfg.targetWallet, ...cfg.additionalTargetWallets]
      .map((wallet) => wallet.trim())
      .filter(isSolanaPublicKey),
  ).size;
  if (cfg.coordinatedModeEnabled && configuredTargetCount < cfg.coordinatedTargetWalletCount) {
    readinessIssues.push(
      `Coordinated mode needs ${cfg.coordinatedTargetWalletCount} target wallets; ${configuredTargetCount} configured.`,
    );
  }
  if (cfg.convictionModeEnabled && convictionTargetCount !== 3) {
    readinessIssues.push(
      `Conviction Mode requires exactly 3 unique valid target wallets; ${convictionTargetCount} configured.`,
    );
  }
  if (fundingKeyQ.isError) {
    readinessIssues.push(
      `Funding-key status check failed: ${fundingKeyQ.error instanceof Error ? fundingKeyQ.error.message : "unknown error"}.`,
    );
  } else if (fundingKeyQ.data?.identityMismatch) {
    readinessIssues.push("Funding key exists under a different HELIX_USER_ID.");
  } else if (fundingKeyQ.isSuccess && !keySaved) {
    readinessIssues.push("Funding key missing.");
  }
  if (workerQ.isError) {
    readinessIssues.push(
      `Worker heartbeat check failed: ${workerQ.error instanceof Error ? workerQ.error.message : "unknown error"}.`,
    );
  } else if (workerQ.data?.identityMismatch) {
    readinessIssues.push("Worker heartbeat exists under a different HELIX_USER_ID.");
  } else if (workerQ.isSuccess && !workerQ.data.online) {
    readinessIssues.push("No recent VPS heartbeat.");
  } else if (workerQ.data?.followerBalanceReconciliationDegraded) {
    readinessIssues.push(
      "Follower-wallet balance reconciliation is degraded; new entries are blocked.",
    );
  } else if ((workerQ.data?.followerBalanceMismatchCount ?? 0) > 0) {
    readinessIssues.push(
      `${workerQ.data?.followerBalanceMismatchCount} follower-wallet balance mismatch(es) need review; new entries are blocked.`,
    );
  } else if ((workerQ.data?.rpcBacklogWalletCount ?? 0) > 0) {
    readinessIssues.push(
      `RPC catch-up is still draining for ${workerQ.data?.rpcBacklogWalletCount} monitored wallet(s).`,
    );
  } else if (workerQ.data?.monitoringDegraded) {
    readinessIssues.push(
      "Transaction monitoring is degraded; new entries are blocked while exits stay active.",
    );
  }
  if (workerQ.data?.fundingKeyCheckedAt && workerQ.data.fundingKeyReady === false) {
    readinessIssues.push(workerQ.data.lastError ?? "The worker cannot use the saved funding key.");
  }
  const ready = !readinessPending && readinessIssues.length === 0;
  const readinessMessage = readinessPending
    ? "Checking funding key and VPS heartbeat…"
    : ready
      ? "Target wallet, funding key, and worker heartbeat are ready."
      : readinessIssues.join(" ");
  const workerDegraded =
    workerQ.data?.monitoringDegraded === true ||
    workerQ.data?.followerBalanceReconciliationDegraded === true ||
    (workerQ.data?.followerBalanceMismatchCount ?? 0) > 0 ||
    (workerQ.data?.rpcBacklogWalletCount ?? 0) > 0;
  const workerStatusMessage = workerQ.isError
    ? `Worker heartbeat unavailable: ${workerQ.error instanceof Error ? workerQ.error.message : "unknown error"}`
    : !workerQ.data?.online
      ? "No recent VPS heartbeat"
      : workerQ.data.followerBalanceReconciliationDegraded
        ? "Heartbeat current; follower-wallet balance reconciliation is degraded; exits remain active"
        : workerQ.data.followerBalanceMismatchCount > 0
          ? `Heartbeat current; ${workerQ.data.followerBalanceMismatchCount} follower-wallet balance mismatch(es) block new entries; exits remain active`
          : workerQ.data.rpcBacklogWalletCount > 0
            ? `Heartbeat current; RPC catch-up pending for ${workerQ.data.rpcBacklogWalletCount} monitored wallet(s)`
            : workerQ.data.monitoringDegraded
              ? "Heartbeat current, but transaction monitoring is degraded; exits remain active"
              : workerQ.data.followerBalanceCandidateCount > 0
                ? `Heartbeat current; verifying ${workerQ.data.followerBalanceCandidateCount} first-snapshot follower balance difference(s); entries remain available unless confirmed twice`
                : workerQ.data.geyserConnected
                  ? `Heartbeat current; Geyser connected; ${workerQ.data.decodedEventCount} decoded events`
                  : workerQ.data.rpcLastSuccessAt
                    ? `Heartbeat current; RPC fallback healthy; ${workerQ.data.decodedEventCount} decoded events`
                    : `Heartbeat current; ${workerQ.data.decodedEventCount} decoded events`;

  const handleSaveKey = async () => {
    try {
      const result = await saveFundingKey({ data: { privateKey: cfg.fundingPrivateKey } });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await fundingKeyQ.refetch();
      toast.success("Private key encrypted and saved");
      setCfg((c) => ({ ...c, fundingPrivateKey: "" }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      toast.error(`Key save failed: ${msg}`);
    }
  };

  const positionsQ = useQuery({
    queryKey: ["positions"],
    queryFn: () => getPositions(),
    refetchInterval: 3000,
  });
  const followersQ = useQuery({
    queryKey: ["followers"],
    queryFn: () => getFollowers(),
    refetchInterval: 3000,
  });
  const activePositions = (positionsQ.data as unknown[] | undefined)?.length ?? 0;
  const monitored =
    (
      followersQ.data as Array<{ position_id?: string | null; observed_only?: boolean }> | undefined
    )?.filter((follower) => follower.position_id && follower.observed_only !== true).length ?? 0;

  return (
    <div className="min-h-screen">
      <Toaster theme="dark" position="top-right" />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <StatusHeader
          enabled={cfg.enabled}
          onToggle={(v) => {
            if (v && !ready) {
              toast.error(`Entries remain off: ${readinessMessage}`);
              return;
            }
            update({ enabled: v });
          }}
          ready={ready}
          readinessPending={readinessPending}
          readinessMessage={readinessMessage}
          workerConnected={workerQ.isSuccess ? workerQ.data.online : undefined}
          workerDegraded={workerDegraded}
          workerStatusMessage={workerStatusMessage}
          activePositions={activePositions}
          monitoredWallets={monitored}
          syncing={syncing}
          coordinatedModeEnabled={cfg.coordinatedModeEnabled}
          convictionModeEnabled={cfg.convictionModeEnabled}
          convictionTradingMode={cfg.convictionTradingMode}
        />

        <main className="mt-8 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <WalletPanel
              targetWallet={cfg.targetWallet}
              additionalTargetWallets={cfg.additionalTargetWallets}
              fundingPrivateKey={cfg.fundingPrivateKey}
              onChange={update}
              onSaveKey={handleSaveKey}
              keySaved={keySaved}
            />
            <PositionFollowers />
            <SettingsPanel cfg={cfg} onChange={update} />
          </div>

          <aside className="space-y-6">
            <ActivityFeed />
          </aside>
        </main>

        <ConvictionDashboard
          enabled={cfg.convictionModeEnabled}
          tradingMode={cfg.convictionTradingMode}
        />
        <StrategyLab />
        <CustodyJourneyDashboard
          enabled={cfg.custodyJourneyEnabled}
          onToggleEnabled={(value) => update({ custodyJourneyEnabled: value })}
        />

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-6 text-[11px] text-muted-foreground">
          <span className="mono">helix · self-hosted · supabase + cloudflare + jito</span>
          <span className="mono">worker status: Supabase heartbeat</span>
        </footer>
      </div>
    </div>
  );
}
