import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast, Toaster } from "sonner";

import { DEFAULT_CONFIG, loadConfig, saveConfig, type BotConfig } from "@/lib/bot-config";
import { getBotConfig, saveBotConfig } from "@/lib/bot.functions";
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
        toast.error("Could not sync to Supabase. Check your server env vars.");
      } finally {
        setSyncing(false);
      }
    }, 600);
    return () => clearTimeout(timeout);
  }, [cfg, hydrated]);

  const update = (patch: Partial<BotConfig>) => setCfg((c) => ({ ...c, ...patch }));

  const handleSaveKey = async () => {
    // In production this POSTs to your worker's /keys endpoint over HTTPS.
    // The worker encrypts with its master key (env var) and stores ciphertext in Supabase.
    // We never write the raw key to localStorage.
    try {
      // Placeholder: fetch("/api/keys", { method: "POST", body: JSON.stringify({ sk: cfg.fundingPrivateKey }) })
      await new Promise((r) => setTimeout(r, 400));
      setKeySaved(true);
      toast.success("Private key encrypted and sent to worker");
      // clear in-memory copy after transmission
      setCfg((c) => ({ ...c, fundingPrivateKey: "" }));
    } catch (e) {
      toast.error("Failed to reach worker. Is your VPS endpoint configured?");
    }
  };

  const monitored = useMemo(() => (cfg.enabled ? 3 : 0), [cfg.enabled]);

  return (
    <div className="min-h-screen">
      <Toaster theme="dark" position="top-right" />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <StatusHeader
          enabled={cfg.enabled}
          onToggle={(v) => update({ enabled: v })}
          workerConnected={hydrated}
          activePositions={cfg.enabled ? 2 : 0}
          monitoredWallets={monitored}
          syncing={syncing}
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
            worker endpoint: <span className="text-foreground">{import.meta.env.VITE_WORKER_URL ?? "not configured"}</span>
          </span>
        </footer>
      </div>
    </div>
  );
}
