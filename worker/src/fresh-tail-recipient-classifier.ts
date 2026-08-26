import { PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type {
  FreshTailRawRecipient,
  FreshTailRecipientClassification,
} from "./fresh-tail-event-decoder.js";
import { solanaRpcWithTimeout } from "./pump-fun-supply.js";

const KNOWN_UNWATCHABLE_PROGRAMS = new Map<string, string>([
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "jupiter_router"],
  ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pump_program"],
  ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "pump_swap_program"],
]);

export type FreshTailRecipientClassifierConnection = Pick<Connection, "getAccountInfoAndContext">;

export type FreshTailRecipientClassificationResult =
  | { ok: true; recipient: FreshTailRecipientClassification }
  | { ok: false; retryable: true; reason: string };

function classified(
  raw: FreshTailRawRecipient,
  classification: string,
  watchable: boolean,
): FreshTailRecipientClassificationResult {
  return {
    ok: true,
    recipient: {
      ...raw,
      classification,
      classificationReliable: true,
      watchable,
    },
  };
}

/**
 * Classifies one exact recipient against a finalized bank at or above H. A
 * temporary RPC failure never becomes durable evidence and therefore blocks
 * cursor advancement. Off-curve/program destinations are definitive terminal
 * evidence, while on-curve system wallets remain watchable descendants.
 */
export async function classifyFreshTailRecipient(
  rpc: FreshTailRecipientClassifierConnection,
  raw: FreshTailRawRecipient,
  roots: ReadonlySet<string>,
  finalizedHeadSlot: number,
  deadlineMs: number,
  nowMs: () => number = Date.now,
  allowTokenAccountResolution = true,
): Promise<FreshTailRecipientClassificationResult> {
  let key: PublicKey;
  try {
    key = new PublicKey(raw.wallet);
  } catch {
    return classified(raw, "invalid_destination_address", false);
  }
  if (roots.has(raw.wallet)) return classified(raw, "configured_epoch_root", true);
  const known = KNOWN_UNWATCHABLE_PROGRAMS.get(raw.wallet);
  if (known) return classified(raw, known, false);
  if (!Number.isSafeInteger(finalizedHeadSlot) || finalizedHeadSlot <= 0) {
    return { ok: false, retryable: true, reason: "invalid finalized classification head" };
  }
  const remainingMs = deadlineMs - Number(nowMs());
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { ok: false, retryable: true, reason: "recipient classification deadline elapsed" };
  }
  let account: Awaited<ReturnType<Connection["getAccountInfoAndContext"]>>;
  try {
    account = await solanaRpcWithTimeout(
      rpc.getAccountInfoAndContext(key, {
        commitment: "finalized",
        minContextSlot: finalizedHeadSlot,
      }),
      Math.max(1, Math.min(4_000, Math.floor(remainingMs))),
    );
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      reason: `finalized recipient account lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (!Number.isSafeInteger(account?.context?.slot) || account.context.slot < finalizedHeadSlot) {
    return { ok: false, retryable: true, reason: "recipient lookup returned below H" };
  }
  const owner = account.value?.owner?.toBase58() ?? null;
  if (
    allowTokenAccountResolution &&
    account.value?.data &&
    (owner === TOKEN_PROGRAM_ID.toBase58() || owner === TOKEN_2022_PROGRAM_ID.toBase58())
  ) {
    const bytes = Buffer.from(account.value.data);
    if (bytes.length < 64) return classified(raw, "malformed_token_account", false);
    let controllingWallet: string;
    try {
      controllingWallet = new PublicKey(bytes.subarray(32, 64)).toBase58();
    } catch {
      return classified(raw, "malformed_token_account_owner", false);
    }
    if (controllingWallet !== raw.wallet) {
      const resolved = await classifyFreshTailRecipient(
        rpc,
        { ...raw, wallet: controllingWallet },
        roots,
        finalizedHeadSlot,
        deadlineMs,
        nowMs,
        false,
      );
      if (!resolved.ok) return resolved;
      return {
        ok: true,
        recipient: {
          ...raw,
          classification: `token_account_owner:${controllingWallet}:${resolved.recipient.classification}`,
          classificationReliable: true,
          watchable: resolved.recipient.watchable,
        },
      };
    }
  }
  if (!PublicKey.isOnCurve(key.toBytes())) {
    return classified(raw, "off_curve_program_derived_destination", false);
  }
  if (owner && owner !== SystemProgram.programId.toBase58()) {
    return classified(raw, `program_controlled_destination:${owner}`, false);
  }
  return classified(raw, "on_curve_system_wallet", true);
}

export async function classifyFreshTailRecipients(
  rpc: FreshTailRecipientClassifierConnection,
  recipients: readonly FreshTailRawRecipient[],
  roots: ReadonlySet<string>,
  finalizedHeadSlot: number,
  deadlineMs: number,
  nowMs: () => number = Date.now,
): Promise<
  | { ok: true; recipients: FreshTailRecipientClassification[] }
  | { ok: false; retryable: true; reason: string }
> {
  const output: FreshTailRecipientClassification[] = [];
  for (const recipient of recipients) {
    const result = await classifyFreshTailRecipient(
      rpc,
      recipient,
      roots,
      finalizedHeadSlot,
      deadlineMs,
      nowMs,
    );
    if (!result.ok) return result;
    output.push(result.recipient);
  }
  return { ok: true, recipients: output };
}
