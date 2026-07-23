import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast, Toaster } from "sonner";

import { DEFAULT_CONFIG, loadConfig, saveConfig, type BotConfig } from "@/lib/bot-config";
import { getBotConfig, saveBotConfig, getPositions, getFollowers, saveFundingKey } from "@/lib/bot.functions";
import { useQuery } from "@tanstack/react-query";
import { StatusHeader } from "@/components/dashboard/StatusHeader";
import { WalletPanel } from "@/components/dashboard/WalletPanel";
import { SettingsPanel } from "@/components/dashboard/SettingsPanel";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { MonitoredWallets } from "@/components/dashboard/MonitoredWallets";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Helix — Solana Copy Trading Bot" },
      { name: "description", content: "Configure sub-second Solana copy trades, follower propagation exits, and risk filters." },
      { property: "og:title", content: "Helix — Solana Copy Trading Bot" },
      { property: "og:description", content: "Sub-second Solana copy trading with follower-wallet monitoring." },
    ],
  }),
  loader: async () => {
    try {
      const remote = await getBotConfig();
      return { remote: remote ?? DEFAULT_CONFIG };
    } catch {
      return { remote: DEFAULT_CONFIG };
    }
  },
  component: Dashboard,
  errorComponent: () => <div className="p-8 text-center">Failed to load bot config. Refresh to retry.</div>,
  notFoundComponent: () => <div className="p-8 text-center">Dashboard not found.</div>,
});

function Dashboard() {
  const { remote } = Route.useLoaderData();
  const [cfg, setCfg] = useState<BotConfig>(remote);
  const [hydrated, setHydrated] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    // Merge local settings with remote (local wins for in-memory preferences).
    const local = loadConfig();
    setCfg((r) => ({ ...r, ...local }));
    if (typeof window !== "undefined" && localStorage.getItem("helix_key_saved") === "1") {
      setKeySaved(true);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    // Persist non-sensitive settings locally for fast startup.
    saveConfig(cfg);
    // Sync to your own Supabase.
    const timeout = setTimeout(async () => {
      setSyncing(true);
      try {
        await saveBotConfig({ data: cfg });
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
  }, [cfg, hydrated]);

  const update = (patch: Partial<BotConfig>) => setCfg((c) => ({ ...c, ...patch }));

  const handleSaveKey = async () => {
    try {
      await saveFundingKey({ data: { privateKey: cfg.fundingPrivateKey } });
      setKeySaved(true);
      if (typeof window !== "undefined") localStorage.setItem("helix_key_saved", "1");
      toast.success("Private key encrypted and saved");
      setCfg((c) => ({ ...c, fundingPrivateKey: "" }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      toast.error(`Key save failed: ${msg}`);
    }
  };

  const positionsQ = useQuery({ queryKey: ["positions"], queryFn: () => getPositions(), refetchInterval: 3000 });
  const followersQ = useQuery({ queryKey: ["followers"], queryFn: () => getFollowers(), refetchInterval: 3000 });
  const activePositions = (positionsQ.data as unknown as any[] | undefined)?.length ?? 0;
  const monitored = (followersQ.data as unknown as any[] | undefined)?.length ?? 0;

  return (
    <div className="min-h-screen">
      <Toaster theme="dark" position="top-right" />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <StatusHeader
          enabled={cfg.enabled}
          onToggle={(v) => update({ enabled: v })}
          workerConnected={hydrated}
          activePositions={activePositions}
          monitoredWallets={monitored}
          syncing={syncing}
          targetWalletValid={/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cfg.targetWallet || "")}
          fundingKeySaved={keySaved}
        />


        <main className="mt-8 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <WalletPanel
              targetWallet={cfg.targetWallet}
              fundingPrivateKey={cfg.fundingPrivateKey}
              onChange={update}
              onSaveKey={handleSaveKey}
              keySaved={keySaved}
            />
            <SettingsPanel cfg={cfg} onChange={update} />
          </div>

          <aside className="space-y-6">
            <ActivityFeed />
            <MonitoredWallets />
          </aside>
        </main>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-6 text-[11px] text-muted-foreground">
          <span className="mono">helix · self-hosted · supabase + cloudflare + jito</span>
          <span className="mono">
            worker endpoint: <span className="text-foreground">{import.meta.env.PUBLIC_WORKER_URL ?? "not configured"}</span>
          </span>
        </footer>
      </div>
    </div>
  );
}
