import { PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { CustodyWalletClassification, CustodyWalletType } from "./custody-types.js";

const KNOWN_PROGRAMS = new Map<string, { type: CustodyWalletType; label: string }>([
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", { type: "router", label: "Jupiter v6 program" }],
  ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", { type: "dex_pool", label: "Pump program" }],
  ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", { type: "dex_pool", label: "PumpSwap program" }],
]);

export type AccountFactReader = Pick<Connection, "getAccountInfo">;

export const CUSTODY_ACCOUNT_LOOKUP_TIMEOUT_MS = 8_000;

export type CustodyClassificationOptions = {
  lookupTimeoutMs?: number;
};

export function targetWalletClassification(wallet: string): CustodyWalletClassification {
  return {
    wallet,
    watchable: true,
    inferredType: "target",
    inferredLabel: "Configured target wallet",
    confidence: 1,
    source: "configured_target",
    evidence: "The address is configured as a target wallet.",
  };
}

export async function classifyCustodyWallet(
  reader: AccountFactReader,
  wallet: string,
  targets: ReadonlySet<string>,
  options: CustodyClassificationOptions = {},
): Promise<CustodyWalletClassification> {
  const requestedTimeout = options.lookupTimeoutMs ?? CUSTODY_ACCOUNT_LOOKUP_TIMEOUT_MS;
  const lookupTimeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.trunc(requestedTimeout))
    : CUSTODY_ACCOUNT_LOOKUP_TIMEOUT_MS;
  return classifyWallet(reader, wallet, targets, true, Date.now() + lookupTimeoutMs);
}

async function classifyWallet(
  reader: AccountFactReader,
  wallet: string,
  targets: ReadonlySet<string>,
  allowTokenAccountResolution: boolean,
  lookupDeadlineMs: number,
): Promise<CustodyWalletClassification> {
  if (targets.has(wallet)) return targetWalletClassification(wallet);
  const known = KNOWN_PROGRAMS.get(wallet);
  if (known) {
    return {
      wallet,
      watchable: false,
      inferredType: known.type,
      inferredLabel: known.label,
      confidence: 1,
      source: "known_program",
      evidence: "Address matches a version-controlled program identifier.",
    };
  }

  let publicKey: PublicKey;
  try {
    publicKey = new PublicKey(wallet);
  } catch {
    return unknown(wallet, "Address is not a valid Solana public key.");
  }

  try {
    const account = await lookupAccountInfo(reader, publicKey, lookupDeadlineMs);
    const owner = account?.owner?.toBase58() ?? null;
    if (
      allowTokenAccountResolution &&
      account?.data &&
      (owner === TOKEN_PROGRAM_ID.toBase58() || owner === TOKEN_2022_PROGRAM_ID.toBase58())
    ) {
      const bytes = Buffer.from(account.data);
      if (bytes.length >= 64) {
        const tokenOwner = new PublicKey(bytes.subarray(32, 64)).toBase58();
        if (tokenOwner !== wallet) {
          const resolved = await classifyWallet(
            reader,
            tokenOwner,
            targets,
            false,
            lookupDeadlineMs,
          );
          return {
            ...resolved,
            evidence: `Recipient token account was resolved to its controlling wallet. ${resolved.evidence}`,
          };
        }
      }
    }
    if (!PublicKey.isOnCurve(publicKey.toBytes())) {
      return {
        wallet,
        watchable: false,
        inferredType: "program",
        inferredLabel: "Program-derived custody address",
        confidence: 0.9,
        source: "onchain_account",
        evidence: "Address is off curve. This does not identify an exchange or prove a sale.",
      };
    }
    if (owner && owner !== SystemProgram.programId.toBase58()) {
      return {
        wallet,
        watchable: false,
        inferredType: "program",
        inferredLabel: "Program-controlled account",
        confidence: 0.9,
        source: "onchain_account",
        evidence: "Account owner is a program. The exact entity remains unconfirmed.",
      };
    }
    return unknown(wallet, "On-curve wallet; entity ownership is not known from chain data.", true);
  } catch {
    // A temporary provider failure is not evidence that custody ended. The
    // address is valid and on curve, so keep observing it without inventing an
    // entity identity.
    return PublicKey.isOnCurve(publicKey.toBytes())
      ? {
          ...unknown(
            wallet,
            "Account lookup was temporarily unavailable; valid on-curve wallet remains unlabeled.",
            true,
          ),
          transientFailure: true,
        }
      : {
          ...unknown(
            wallet,
            "Account lookup was temporarily unavailable; off-curve destination could not be resolved safely.",
          ),
          transientFailure: true,
        };
  }
}

async function lookupAccountInfo(
  reader: AccountFactReader,
  publicKey: PublicKey,
  deadlineMs: number,
): ReturnType<AccountFactReader["getAccountInfo"]> {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  if (remainingMs === 0) {
    throw new Error("custody account lookup timed out");
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.getAccountInfo(publicKey, "confirmed"),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("custody account lookup timed out")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function unknown(wallet: string, evidence: string, watchable = false): CustodyWalletClassification {
  return {
    wallet,
    watchable,
    inferredType: "unknown",
    inferredLabel: null,
    confidence: 0,
    source: "unknown",
    evidence,
  };
}
