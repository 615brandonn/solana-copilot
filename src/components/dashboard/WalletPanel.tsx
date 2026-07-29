import { Crosshair, KeyRound, ShieldCheck, Eye, EyeOff, Network } from "lucide-react";
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { isSolanaPublicKey } from "@/lib/base58";
import { SectionCard } from "./SettingRow";

type Props = {
  targetWallet: string;
  additionalTargetWallets: string[];
  fundingPrivateKey: string;
  onChange: (patch: {
    targetWallet?: string;
    additionalTargetWallets?: string[];
    fundingPrivateKey?: string;
  }) => void;
  onSaveKey: () => void;
  keySaved: boolean;
};

export function WalletPanel({
  targetWallet,
  additionalTargetWallets,
  fundingPrivateKey,
  onChange,
  onSaveKey,
  keySaved,
}: Props) {
  const [reveal, setReveal] = useState(false);
  const [additionalDraft, setAdditionalDraft] = useState(
    additionalTargetWallets.join("\n"),
  );
  useEffect(() => {
    setAdditionalDraft(additionalTargetWallets.join("\n"));
  }, [additionalTargetWallets.join("\n")]);
  const isValidSolAddr = isSolanaPublicKey(targetWallet);
  const invalidAdditionalTargets = additionalTargetWallets.filter(
    (wallet) => !isSolanaPublicKey(wallet),
  );

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
          <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Network className="h-3.5 w-3.5" />
            Additional market-maker buying wallets
          </label>
          <Textarea
            value={additionalDraft}
            onChange={(event) => {
              setAdditionalDraft(event.target.value);
              const wallets = Array.from(
                new Set(
                  event.target.value
                    .split(/[\s,]+/)
                    .map((wallet) => wallet.trim())
                    .filter(Boolean),
                ),
              );
              onChange({ additionalTargetWallets: wallets });
            }}
            placeholder={"One wallet per line\nBuys from every wallet build one combined position"}
            className="mono min-h-28 resize-y"
            spellCheck={false}
          />
          <p
            className={`mt-2 text-[11px] ${
              invalidAdditionalTargets.length || additionalTargetWallets.length > 20
                ? "text-destructive"
                : "text-muted-foreground"
            }`}
          >
            {additionalTargetWallets.length > 20
              ? "Use no more than 20 additional target wallets."
              : invalidAdditionalTargets.length
                ? `${invalidAdditionalTargets.length} wallet address${
                    invalidAdditionalTargets.length === 1 ? " is" : "es are"
                  } invalid.`
                : `${additionalTargetWallets.length}/20 added. Every listed wallet can start or scale a copied position. Transfers between them do not cause duplicate buys, and wallets they fund remain tracked for proportional sells.`}
          </p>
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
            Sent securely, encrypted by your backend, then stored for the worker. Never stored in
            plain text; never in localStorage.
            {keySaved && <span className="mono ml-2 text-success">✓ sent to worker</span>}
          </p>
        </div>
      </div>
    </SectionCard>
  );
}
