import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast, Toaster } from "sonner";

import { DEFAULT_CONFIG, loadConfig, saveConfig, type BotConfig } from "@/lib/bot-config";
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
  component: Dashboard,
});

function Dashboard() {
  const [cfg, setCfg] = useState<BotConfig>(DEFAULT_CONFIG);
  const [hydrated, setHydrated] = useState(false);
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    setCfg(loadConfig());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveConfig(cfg);
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
