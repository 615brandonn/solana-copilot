import { PublicKey } from "@solana/web3.js";
import { safeDiagnostic } from "./diagnostics.js";

type RpcResponse = { data: unknown; error: unknown };

export type FreshTailExitDbClient = {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<RpcResponse>;
};

export type FreshTailExitTriggerKind =
  | "direct_target_sell"
  | "mirror_custody_sell"
  | "terminal_outflow";

export type FreshTailExitIntentStatus = "claimed" | "uncertain";

export type FreshTailExitIntent = {
  intentId: string;
  claimToken: string;
  claimGeneration: number;
  claimExpiresAt: string;
  entryClaimId: string;
  positionId: string;
  epochId: string;
  requestId: string;
  tokenMint: string;
  sourceDomain: "supply" | "custody";
  eventId: string;
  eventKey: string;
  eventKind: string;
  triggerKind: FreshTailExitTriggerKind;
  txSig: string;
  slot: number;
  blockTime: string;
  sourceWallet: string;
  amountRaw: string;
  decimals: number;
  classificationReliable: boolean;
  watchable: boolean | null;
  status: FreshTailExitIntentStatus;
  priorSellClaimId: string | null;
  priorBotTxSig: string | null;
  priorErrorCode: string | null;
};

export type FreshTailExitDisposition =
  | "resolved"
  | "retry"
  | "uncertain"
  | "disabled_by_policy"
  | "position_not_live"
  | "duplicate_sell_claim"
  | "entry_failed"
  | "position_closed";

export type FreshTailExitEvidence = {
  sellClaimId: string;
  botTxSig: string;
};

export type FreshTailExitResolution = {
  intentId: string;
  status: "retry" | "uncertain" | "resolved" | "dismissed";
  disposition: FreshTailExitDisposition;
  claimGeneration: number;
};

function object(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${operation} returned a malformed JSON object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`fresh-tail exit ${field} is missing`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : text(value, field);
}

function uuid(value: unknown, field: string): string {
  const parsed = text(value, field).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parsed)) {
    throw new Error(`fresh-tail exit ${field} is not a UUID`);
  }
  return parsed;
}

function userUuid(value: unknown): string {
  const parsed = text(value, "userId").toLowerCase();
  // The production identity is a legacy nil UUID stored in PostgreSQL. Keep
  // that compatibility exception scoped to user identity; evidence UUIDs
  // continue through the strict RFC validator above.
  return parsed === "00000000-0000-0000-0000-000000000000" ? parsed : uuid(parsed, "userId");
}

function publicKey(value: unknown, field: string): string {
  try {
    return new PublicKey(text(value, field)).toBase58();
  } catch {
    throw new Error(`fresh-tail exit ${field} is not a public key`);
  }
}

function exactRaw(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!/^[1-9][0-9]*$/.test(parsed) || parsed.length > 78) {
    throw new Error(`fresh-tail exit ${field} is not an exact positive raw integer`);
  }
  return parsed;
}

function safeInteger(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`fresh-tail exit ${field} is not a safe integer`);
  }
  return parsed;
}

function iso(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`fresh-tail exit ${field} is invalid`);
  return parsed;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`fresh-tail exit ${field} is not boolean`);
  return value;
}

export function parseFreshTailExitIntent(value: unknown): FreshTailExitIntent {
  const row = object(value, "fresh-tail exit claim");
  const sourceDomain = text(row.sourceDomain, "sourceDomain");
  if (sourceDomain !== "supply" && sourceDomain !== "custody") {
    throw new Error("fresh-tail exit sourceDomain is unsupported");
  }
  const triggerKind = text(row.triggerKind, "triggerKind");
  if (
    triggerKind !== "direct_target_sell" &&
    triggerKind !== "mirror_custody_sell" &&
    triggerKind !== "terminal_outflow"
  ) {
    throw new Error("fresh-tail exit triggerKind is unsupported");
  }
  const status = text(row.status, "status");
  if (status !== "claimed" && status !== "uncertain") {
    throw new Error("fresh-tail exit status is unsupported");
  }
  const priorSellClaimId =
    row.priorSellClaimId === null || row.priorSellClaimId === undefined
      ? null
      : uuid(row.priorSellClaimId, "priorSellClaimId");
  const priorBotTxSig = optionalText(row.priorBotTxSig, "priorBotTxSig");
  if (status === "uncertain" && (!priorSellClaimId || !priorBotTxSig)) {
    throw new Error("fresh-tail uncertain exit omitted exact prepared sell evidence");
  }
  return {
    intentId: uuid(row.intentId, "intentId"),
    claimToken: uuid(row.claimToken, "claimToken"),
    claimGeneration: safeInteger(row.claimGeneration, "claimGeneration", 1),
    claimExpiresAt: iso(row.claimExpiresAt, "claimExpiresAt"),
    entryClaimId: uuid(row.entryClaimId, "entryClaimId"),
    positionId: uuid(row.positionId, "positionId"),
    epochId: uuid(row.epochId, "epochId"),
    requestId: uuid(row.requestId, "requestId"),
    tokenMint: publicKey(row.tokenMint, "tokenMint"),
    sourceDomain,
    eventId: uuid(row.eventId, "eventId"),
    eventKey: text(row.eventKey, "eventKey"),
    eventKind: text(row.eventKind, "eventKind"),
    triggerKind,
    txSig: text(row.txSig, "txSig"),
    slot: safeInteger(row.slot, "slot", 1),
    blockTime: iso(row.blockTime, "blockTime"),
    sourceWallet: publicKey(row.sourceWallet, "sourceWallet"),
    amountRaw: exactRaw(row.amountRaw, "amountRaw"),
    decimals: safeInteger(row.decimals, "decimals", 0, 18),
    classificationReliable: bool(row.classificationReliable, "classificationReliable"),
    watchable:
      row.watchable === null || row.watchable === undefined
        ? null
        : bool(row.watchable, "watchable"),
    status,
    priorSellClaimId,
    priorBotTxSig,
    priorErrorCode: optionalText(row.priorErrorCode, "priorErrorCode"),
  };
}

export function createFreshTailExitStore(
  client: FreshTailExitDbClient,
  userId: string,
  workerId: string,
) {
  const canonicalUserId = userUuid(userId);
  const canonicalWorkerId = text(workerId, "workerId");
  const invoke = async (name: string, parameters: Record<string, unknown>) => {
    const response = await client.rpc(name, parameters);
    if (response.error) throw new Error(`${name} failed: ${safeDiagnostic(response.error)}`);
    return object(response.data, name);
  };
  const claim = async (
    name: "claim_custody_fresh_tail_exit_intents" | "claim_custody_fresh_tail_uncertain_intents",
    expectedReason: "claimed" | "uncertain_claimed",
    limit: number,
    claimSeconds: number,
  ) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("fresh-tail exit claim limit is invalid");
    }
    if (!Number.isSafeInteger(claimSeconds) || claimSeconds < 180 || claimSeconds > 600) {
      throw new Error("fresh-tail exit lease duration is invalid");
    }
    const result = await invoke(name, {
      p_user_id: canonicalUserId,
      p_worker_id: canonicalWorkerId,
      p_limit: limit,
      p_claim_seconds: claimSeconds,
    });
    if (result.ok !== true || result.reason !== expectedReason || !Array.isArray(result.intents)) {
      throw new Error(`${name} returned an incomplete claim result`);
    }
    return result.intents.map(parseFreshTailExitIntent);
  };

  return {
    claim(limit = 25, claimSeconds = 180) {
      return claim("claim_custody_fresh_tail_exit_intents", "claimed", limit, claimSeconds);
    },

    claimUncertain(limit = 25, claimSeconds = 180) {
      return claim(
        "claim_custody_fresh_tail_uncertain_intents",
        "uncertain_claimed",
        limit,
        claimSeconds,
      );
    },

    async resolve(
      intent: FreshTailExitIntent,
      expectedStatus: FreshTailExitIntentStatus,
      disposition: FreshTailExitDisposition,
      evidence: FreshTailExitEvidence | null,
      errorCode: string | null,
    ): Promise<FreshTailExitResolution> {
      if (intent.status !== expectedStatus) {
        throw new Error("fresh-tail exit expected status does not match its claimed payload");
      }
      const canonicalEvidence = evidence
        ? {
            sellClaimId: uuid(evidence.sellClaimId, "sellClaimId"),
            botTxSig: text(evidence.botTxSig, "botTxSig"),
          }
        : null;
      if (
        (disposition === "resolved" ||
          (expectedStatus === "claimed" && disposition === "uncertain")) &&
        !canonicalEvidence
      ) {
        throw new Error("fresh-tail exit resolution requires exact sell evidence");
      }
      if (
        expectedStatus === "uncertain" &&
        disposition === "resolved" &&
        (canonicalEvidence?.sellClaimId !== intent.priorSellClaimId ||
          canonicalEvidence?.botTxSig !== intent.priorBotTxSig)
      ) {
        throw new Error("fresh-tail uncertain exit resolution evidence changed");
      }
      const result = await invoke("resolve_custody_fresh_tail_exit_intent", {
        p_user_id: canonicalUserId,
        p_intent_id: intent.intentId,
        p_claim_token: intent.claimToken,
        p_claim_generation: intent.claimGeneration,
        p_expected_status: expectedStatus,
        p_disposition: disposition,
        p_sell_claim_id: canonicalEvidence?.sellClaimId ?? null,
        p_bot_tx_sig: canonicalEvidence?.botTxSig ?? null,
        p_error_code: errorCode ? text(errorCode, "errorCode").slice(0, 1_000) : null,
      });
      if (result.ok !== true || result.reason !== "intent_resolved") {
        throw new Error(
          `fresh-tail exit resolution rejected: ${String(result.reason ?? "unknown")}`,
        );
      }
      const resolution: FreshTailExitResolution = {
        intentId: uuid(result.intentId, "intentId"),
        status: text(result.status, "resolved status") as FreshTailExitResolution["status"],
        disposition: text(result.disposition, "resolved disposition") as FreshTailExitDisposition,
        claimGeneration: safeInteger(result.claimGeneration, "resolved claimGeneration", 1),
      };
      const expectedResolutionStatus: FreshTailExitResolution["status"] =
        disposition === "resolved"
          ? "resolved"
          : disposition === "uncertain"
            ? "uncertain"
            : disposition === "disabled_by_policy" ||
                disposition === "entry_failed" ||
                disposition === "position_closed"
              ? "dismissed"
              : "retry";
      if (
        resolution.intentId !== intent.intentId ||
        resolution.claimGeneration !== intent.claimGeneration ||
        resolution.disposition !== disposition ||
        resolution.status !== expectedResolutionStatus
      ) {
        throw new Error("fresh-tail exit resolution changed its fenced identity");
      }
      return resolution;
    },
  };
}

export type FreshTailExitStore = ReturnType<typeof createFreshTailExitStore>;
