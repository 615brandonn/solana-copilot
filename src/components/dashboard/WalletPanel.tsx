import { Crosshair, KeyRound, ShieldCheck, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SectionCard } from "./SettingRow";

type Props = {
  targetWallet: string;
  fundingPrivateKey: string;
  onChange: (patch: { targetWallet?: string; fundingPrivateKey?: string }) => void;
  onSaveKey: () => void;
  keySaved: boolean;
};

export function WalletPanel({ targetWallet, fundingPrivateKey, onChange, onSaveKey, keySaved }: Props) {
  const [reveal, setReveal] = useState(false);
  const isValidSolAddr = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(targetWallet);

  return (
    <SectionCard
      title="Wallets"
      description="Your funding wallet signs trades. The target wallet is the one you're mirroring."
      icon={<Crosshair className="h-4 w-4" />}
    >
      <div className="space-y-5 pt-2">
        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Target wallet address
          </label>
          <div className="relative">
            <Input
              value={targetWallet}
              onChange={(e) => onChange({ targetWallet: e.target.value.trim() })}
              placeholder="e.g. 7xKX...ozAg"
              className="mono pr-24 h-11"
            />
            {targetWallet && (
              <span
                className={`absolute right-3 top-1/2 -translate-y-1/2 mono text-[10px] uppercase tracking-widest ${
                  isValidSolAddr ? "text-success" : "text-destructive"
                }`}
              >
                {isValidSolAddr ? "valid" : "invalid"}
              </span>
            )}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Funding wallet private key
          </label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <KeyRound className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type={reveal ? "text" : "password"}
                value={fundingPrivateKey}
                onChange={(e) => onChange({ fundingPrivateKey: e.target.value })}
                placeholder="Base58 secret key (never persisted client-side)"
                className="mono pl-9 pr-10 h-11"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={reveal ? "Hide" : "Show"}
              >
                {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button onClick={onSaveKey} disabled={!fundingPrivateKey} className="h-11 px-4">
              <ShieldCheck className="mr-1.5 h-4 w-4" />
              Encrypt & send
            </Button>
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3 w-3 text-success" />
            AES-GCM encrypted with your worker's master key before it leaves this device. Never stored in plain text; never in localStorage.
            {keySaved && <span className="mono ml-2 text-success">✓ sent to worker</span>}
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
