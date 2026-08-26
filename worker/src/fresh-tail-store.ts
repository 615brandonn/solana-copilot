import type {
  FreshTailCustodyEvent,
  FreshTailSupplyEvent,
} from "./fresh-tail-event-decoder.js";
import { PublicKey } from "@solana/web3.js";
import type { FreshTailFinalizedHead } from "./fresh-tail-finalized-head.js";
import type { PumpFunCreateProof } from "./pump-fun-create-proof.js";
import type { PumpFunSupplySnapshot } from "./pump-fun-supply.js";
import { PUMP_FUN_SNAPSHOT_PARSER_ABI_FINGERPRINT } from "./pump-fun-supply.js";
import { safeDiagnostic } from "./diagnostics.js";

type RpcResponse = { data: unknown; error: unknown };

export type FreshTailDbClient = {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<RpcResponse>;
};

export type FreshTailMutationResult = {
  ok: boolean;
  reason: string;
  [key: string]: unknown;
};

export type FreshTailLease = {
  epochId: string;
  leaseToken: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
};

export type FreshTailActiveEpoch = {
  epochId: string;
  activationSlot: number;
  activationBlockhash: string;
  activationBlockTime: string;
  rootWallets: [string, string, string];
  rootFingerprint: string;
  scopeRevision: number;
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseExpiresAt: string | null;
  status: "active";
};

export type FreshTailWorkRoot = {
  wallet: string;
  ordinal: number;
  floorSlot: number;
  boundaryKind: "exclusive_slot";
};

export type FreshTailWorkMint = {
  tokenMint: string;
  enrollmentEventKey: string;
  enrollmentTxSig: string;
  enrollmentSlot: number;
  enrollmentBlockhash: string;
  enrollmentBlockTime: string;
  enrollmentTargetWallet: string;
  creationSlot: number;
  bondingCurve: string;
  creator: string;
  createVariant: "classic_v1" | "create_v2_token2022";
  tokenProgram: string;
  mintLayoutFingerprint: string;
  parserAbiFingerprint: string;
  totalSupplyRaw: string;
  decimals: number;
  status: "active" | "retired";
  scopeRevision: number;
  poisoned: boolean;
  poisonReason: string | null;
};

export type FreshTailWorkWallet = {
  tokenMint: string;
  wallet: string;
  parentWallet: string;
  discoverySlot: number;
  boundaryKind: "inclusive_slot";
  watchStatus: "active" | "released" | "unwatchable";
  classificationReliable: boolean;
  watchable: boolean;
  addedRevision: number;
};

export type FreshTailWorkCursor = {
  scopeMint: string;
  wallet: string;
  role: "root" | "descendant";
  floorSlot: number;
  initialBoundaryKind: "exclusive_slot" | "inclusive_slot";
  boundaryKind: "exclusive_slot" | "inclusive_slot" | "exact_signature";
  lastSignature: string | null;
  lastSlot: number | null;
  firstAvailableBlock: number | null;
  historyFloorProven: boolean;
  coveredThroughSlot: number | null;
  coveredThroughBlockhash: string | null;
  coverageRevision: number;
  backlogDetected: boolean;
  lastError: string | null;
};

export type FreshTailBackscanRange = {
  rangeId: string;
  tokenMint: string;
  wallet: string;
  floorSlot: number;
  boundaryKind: "inclusive_slot" | "exact_signature";
  lastSignature: string | null;
  lastSlot: number | null;
  firstAvailableBlock: number | null;
  historyFloorProven: boolean;
  coveredThroughSlot: number | null;
  coveredThroughBlockhash: string | null;
  coverageRevision: number;
  backlogDetected: boolean;
  lastError: string | null;
};

export type FreshTailWorkRequest = {
  requestId: string;
  tokenMint: string;
  status: "pending" | "settled" | "expired" | "invalidated";
  triggerEventKey: string;
  triggerSlot: number;
  triggerBlockTime: string;
  expiresAt: string;
  requestedHeadSlot: number;
  requestedHeadBlockhash: string;
  scopeRevision: number;
  settledRevision: number | null;
  settledLeaseGeneration: number | null;
};

export type FreshTailWork = {
  ok: true;
  reason: string;
  epoch: {
    epochId: string;
    activationSlot: number;
    activationBlockhash: string;
    status: "active";
    scopeRevision: number;
    leaseGeneration: number;
    leaseExpiresAt: string;
  };
  roots: FreshTailWorkRoot[];
  latestFinalizedHead:
    | Record<string, never>
    | {
        slot: number;
        blockhash: string;
        blockTime: string;
        firstLeaseGeneration: number;
        lastLeaseGeneration: number;
      };
  mints: FreshTailWorkMint[];
  rejections: Array<Record<string, unknown>>;
  wallets: FreshTailWorkWallet[];
  cursors: FreshTailWorkCursor[];
  backscanRanges: FreshTailBackscanRange[];
  requests: FreshTailWorkRequest[];
  armedBindings: Array<Record<string, unknown>>;
  exitIntentHealth: Record<string, number>;
};

export type FreshTailCursorWrite = {
  scopeMint: string;
  wallet: string;
  expectedLastSignature: string | null;
  nextLastSignature: string | null;
  nextLastSlot: number | null;
  lastBlockTimeSeconds: number | null;
  firstAvailableBlock: number;
  coveredHead: FreshTailFinalizedHead;
  coverageRevision: number;
  backlogDetected: boolean;
  lastError: string | null;
};

export type FreshTailRequestInput = {
  tokenMint: string;
  windowStartedAt: string;
  triggerEventKey: string;
  triggerTxSig: string;
  triggerSlot: number;
  targetWallet: string;
  triggerBlockTime: string;
  finalizedHead: FreshTailFinalizedHead;
  snapshot: PumpFunSupplySnapshot & {
    curveStateFingerprint: string;
    mintLayoutFingerprint: string;
    tokenProgram: string;
  };
};

export type FreshTailHeartbeat = {
  epochId: string;
  workerId: string;
  lease: FreshTailLease;
  enabled: boolean;
  shadow: boolean;
  latestHead: FreshTailFinalizedHead;
  lastSuccessAt: string | null;
  lastError: string | null;
};

function record(value: unknown, operation: string): FreshTailMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${operation} returned a malformed JSON object`);
  }
  const row = value as Record<string, unknown>;
  if (typeof row.ok !== "boolean" || typeof row.reason !== "string") {
    throw new Error(`${operation} omitted its ok/reason contract`);
  }
  return row as FreshTailMutationResult;
}

function isoFromMs(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid block time");
  return new Date(value).toISOString();
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function parseActiveEpoch(value: FreshTailMutationResult): FreshTailActiveEpoch {
  const epochId = typeof value.epochId === "string" ? value.epochId.trim() : "";
  const activationSlot = Number(value.activationSlot);
  const activationBlockhash =
    typeof value.activationBlockhash === "string" ? value.activationBlockhash.trim() : "";
  const rootWallets = Array.isArray(value.rootWallets) ? value.rootWallets : [];
  const normalizedRoots: string[] = [];
  for (const root of rootWallets) {
    try {
      normalizedRoots.push(new PublicKey(String(root ?? "")).toBase58());
    } catch {
      throw new Error("active fresh-tail epoch contains an invalid root wallet");
    }
  }
  const scopeRevision = Number(value.scopeRevision);
  const leaseGeneration = Number(value.leaseGeneration);
  const leaseOwner = value.leaseOwner === null ? null : String(value.leaseOwner ?? "").trim();
  const leaseExpiresAt = value.leaseExpiresAt === null ? null : value.leaseExpiresAt;
  if (
    !epochId ||
    !Number.isSafeInteger(activationSlot) ||
    activationSlot < 0 ||
    !activationBlockhash ||
    !validIso(value.activationBlockTime) ||
    normalizedRoots.length !== 3 ||
    new Set(normalizedRoots).size !== 3 ||
    normalizedRoots.some((root, index) => root !== [...normalizedRoots].sort()[index]) ||
    typeof value.rootFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.rootFingerprint) ||
    !Number.isSafeInteger(scopeRevision) ||
    scopeRevision < 0 ||
    !Number.isSafeInteger(leaseGeneration) ||
    leaseGeneration < 0 ||
    (leaseOwner !== null && leaseOwner.length === 0) ||
    (leaseExpiresAt !== null && !validIso(leaseExpiresAt)) ||
    (leaseOwner === null) !== (leaseExpiresAt === null) ||
    value.status !== "active"
  ) {
    throw new Error("active fresh-tail epoch response is malformed");
  }
  return {
    epochId,
    activationSlot,
    activationBlockhash,
    activationBlockTime: value.activationBlockTime,
    rootWallets: normalizedRoots as [string, string, string],
    rootFingerprint: value.rootFingerprint,
    scopeRevision,
    leaseOwner,
    leaseGeneration,
    leaseExpiresAt: leaseExpiresAt as string | null,
    status: "active",
  };
}

export function createSupabaseFreshTailStore(client: FreshTailDbClient, userId: string) {
  const invoke = async (
    name: string,
    parameters: Record<string, unknown>,
  ): Promise<FreshTailMutationResult> => {
    const response = await client.rpc(name, parameters);
    if (response.error) {
      throw new Error(`${name} failed: ${safeDiagnostic(response.error)}`);
    }
    return record(response.data, name);
  };

  const fenced = (epochId: string, lease: FreshTailLease) => ({
    p_user_id: userId,
    p_epoch_id: epochId,
    p_lease_token: lease.leaseToken,
    p_lease_generation: lease.leaseGeneration,
  });

  return {
    async loadActiveEpoch(): Promise<FreshTailActiveEpoch | null> {
      const result = await invoke("get_custody_fresh_tail_active_epoch", {
        p_user_id: userId,
      });
      if (!result.ok) {
        if (result.reason === "no_active_epoch") return null;
        throw new Error(`active fresh-tail epoch unavailable: ${result.reason}`);
      }
      return parseActiveEpoch(result);
    },

    async activate(
      rootWallets: readonly string[],
      activation: FreshTailFinalizedHead,
    ): Promise<FreshTailMutationResult> {
      return invoke("activate_custody_fresh_tail_epoch", {
        p_user_id: userId,
        p_root_wallets: [...rootWallets],
        p_activation_slot: activation.slot,
        p_activation_blockhash: activation.blockhash,
        p_activation_block_time: isoFromMs(activation.blockTimeMs),
      });
    },

    async acquireLease(
      epochId: string,
      workerId: string,
      leaseSeconds = 30,
      expectedLease: FreshTailLease | null = null,
    ): Promise<FreshTailLease | null> {
      const result = await invoke("acquire_custody_fresh_tail_lease", {
        p_user_id: userId,
        p_epoch_id: epochId,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
        p_expected_lease_token: expectedLease?.leaseToken ?? null,
        p_expected_lease_generation: expectedLease?.leaseGeneration ?? null,
      });
      if (!result.ok) return null;
      if (
        typeof result.epochId !== "string" ||
        typeof result.leaseToken !== "string" ||
        !Number.isSafeInteger(Number(result.leaseGeneration)) ||
        typeof result.leaseExpiresAt !== "string"
      ) {
        throw new Error("acquire fresh-tail lease returned malformed identity");
      }
      return {
        epochId: result.epochId,
        leaseToken: result.leaseToken,
        leaseGeneration: Number(result.leaseGeneration),
        leaseExpiresAt: result.leaseExpiresAt,
      };
    },

    async getWork(epochId: string, lease: FreshTailLease): Promise<FreshTailWork> {
      const result = await invoke("get_custody_fresh_tail_work", fenced(epochId, lease));
      if (!result.ok) throw new Error(`fresh-tail work unavailable: ${result.reason}`);
      for (const field of ["roots", "mints", "wallets", "cursors", "backscanRanges"] as const) {
        if (!Array.isArray(result[field])) throw new Error(`fresh-tail work ${field} is malformed`);
      }
      if (!result.epoch || typeof result.epoch !== "object") {
        throw new Error("fresh-tail work epoch is malformed");
      }
      return result as FreshTailWork;
    },

    async attestHead(
      epochId: string,
      lease: FreshTailLease,
      head: FreshTailFinalizedHead,
    ): Promise<FreshTailMutationResult> {
      return invoke("attest_custody_fresh_tail_finalized_head", {
        ...fenced(epochId, lease),
        p_finalized_head_slot: head.slot,
        p_finalized_head_blockhash: head.blockhash,
        p_finalized_head_block_time: isoFromMs(head.blockTimeMs),
      });
    },

    async rejectMint(
      epochId: string,
      lease: FreshTailLease,
      input: {
        tokenMint: string;
        sourceTxSig: string;
        sourceSlot: number;
        rejectionCode: string;
        parserAbiFingerprint: string;
        proofFingerprint: string;
        finalizedHead: FreshTailFinalizedHead;
      },
    ): Promise<FreshTailMutationResult> {
      return invoke("reject_custody_fresh_tail_mint", {
        ...fenced(epochId, lease),
        p_token_mint: input.tokenMint,
        p_source_tx_sig: input.sourceTxSig,
        p_source_slot: input.sourceSlot,
        p_rejection_code: input.rejectionCode,
        p_parser_abi_fingerprint: input.parserAbiFingerprint,
        p_proof_fingerprint: input.proofFingerprint,
        p_finalized_head_slot: input.finalizedHead.slot,
        p_finalized_head_blockhash: input.finalizedHead.blockhash,
      });
    },

    async attestMintCreation(
      epochId: string,
      lease: FreshTailLease,
      input: {
        enrollmentEventKey: string;
        enrollmentTxSig: string;
        enrollmentSlot: number;
        enrollmentBlock: FreshTailFinalizedHead;
        enrollmentTargetWallet: string;
        proof: PumpFunCreateProof;
        finalizedHead: FreshTailFinalizedHead;
      },
    ): Promise<FreshTailMutationResult> {
      const proof = input.proof;
      return invoke("attest_custody_fresh_tail_mint_creation", {
        ...fenced(epochId, lease),
        p_token_mint: proof.mint,
        p_enrollment_event_key: input.enrollmentEventKey,
        p_enrollment_tx_sig: input.enrollmentTxSig,
        p_enrollment_slot: input.enrollmentSlot,
        p_enrollment_blockhash: input.enrollmentBlock.blockhash,
        p_enrollment_block_time: isoFromMs(input.enrollmentBlock.blockTimeMs),
        p_enrollment_target_wallet: input.enrollmentTargetWallet,
        p_creation_tx_sig: proof.txSig,
        p_creation_slot: proof.slot,
        p_creation_blockhash: proof.blockhash,
        p_bonding_curve: proof.bondingCurve,
        p_creator: proof.creator,
        p_create_variant: proof.createVariant,
        p_token_program: proof.tokenProgram,
        p_mint_layout_fingerprint: proof.mintLayoutFingerprint,
        p_parser_abi_fingerprint: proof.abi,
        p_total_supply_raw: proof.totalSupplyRaw,
        p_decimals: proof.decimals,
        p_finalized_head_slot: input.finalizedHead.slot,
        p_finalized_head_blockhash: input.finalizedHead.blockhash,
      });
    },

    async recordSupplyEvent(
      epochId: string,
      lease: FreshTailLease,
      event: FreshTailSupplyEvent,
      valuation: { marketCapUsd: number | null; reliable: boolean },
      finalizedHead: FreshTailFinalizedHead,
    ): Promise<FreshTailMutationResult> {
      return invoke("record_custody_fresh_tail_supply_event", {
        ...fenced(epochId, lease),
        p_event_key: event.eventKey,
        p_tx_sig: event.txSig,
        p_slot: event.slot,
        p_block_time: isoFromMs(event.blockTimeMs),
        p_target_wallet: event.targetWallet,
        p_token_mint: event.tokenMint,
        p_side: event.side,
        p_amount_raw: event.amountRaw,
        p_total_supply_raw: event.totalSupplyRaw,
        p_decimals: event.decimals,
        p_market_cap_usd: valuation.marketCapUsd,
        p_valuation_slot: valuation.reliable ? event.slot : null,
        p_market_data_reliable: valuation.reliable,
        p_pump_fun_verified: event.pumpFunVerified,
        p_classification_reliable: event.classificationReliable,
        p_parser_domain: event.parserDomain,
        p_parser_abi_fingerprint: event.parserAbiFingerprint,
        p_finalized_head_slot: finalizedHead.slot,
        p_finalized_head_blockhash: finalizedHead.blockhash,
      });
    },

    async recordCustodyEvent(
      epochId: string,
      lease: FreshTailLease,
      event: FreshTailCustodyEvent,
      finalizedHead: FreshTailFinalizedHead,
    ): Promise<FreshTailMutationResult> {
      return invoke("record_custody_fresh_tail_custody_event", {
        ...fenced(epochId, lease),
        p_event_key: event.eventKey,
        p_tx_sig: event.txSig,
        p_slot: event.slot,
        p_block_time: isoFromMs(event.blockTimeMs),
        p_source_wallet: event.sourceWallet,
        p_token_mint: event.tokenMint,
        p_event_kind: event.eventKind,
        p_amount_raw: event.amountRaw,
        p_source_pre_raw: event.sourcePreRaw,
        p_source_post_raw: event.sourcePostRaw,
        p_decimals: event.decimals,
        p_recipients: event.recipients.map((recipient) => ({
          wallet: recipient.wallet,
          amountRaw: recipient.amountRaw,
          preRaw: recipient.preRaw,
          postRaw: recipient.postRaw,
          classification: recipient.classification,
          classificationReliable: recipient.classificationReliable,
          watchable: recipient.watchable,
        })),
        p_classification: event.classification,
        p_classification_reliable: event.classificationReliable,
        p_watchable: event.watchable,
        p_parser_domain: event.parserDomain,
        p_parser_abi_fingerprint: event.parserAbiFingerprint,
        p_finalized_head_slot: finalizedHead.slot,
        p_finalized_head_blockhash: finalizedHead.blockhash,
      });
    },

    async syncScope(
      epochId: string,
      lease: FreshTailLease,
      tokenMint: string,
      expectedRevision: number,
    ): Promise<FreshTailMutationResult> {
      return invoke("sync_custody_fresh_tail_scope", {
        ...fenced(epochId, lease),
        p_token_mint: tokenMint,
        p_expected_scope_revision: expectedRevision,
      });
    },

    async requestCoverage(
      epochId: string,
      lease: FreshTailLease,
      input: FreshTailRequestInput,
    ): Promise<FreshTailMutationResult> {
      const snapshot = input.snapshot;
      return invoke("request_custody_fresh_tail_coverage", {
        ...fenced(epochId, lease),
        p_token_mint: input.tokenMint,
        p_window_started_at: input.windowStartedAt,
        p_trigger_event_key: input.triggerEventKey,
        p_trigger_tx_sig: input.triggerTxSig,
        p_trigger_slot: input.triggerSlot,
        p_target_wallet: input.targetWallet,
        p_trigger_block_time: input.triggerBlockTime,
        p_finalized_head_slot: input.finalizedHead.slot,
        p_finalized_head_blockhash: input.finalizedHead.blockhash,
        p_finalized_head_block_time: isoFromMs(input.finalizedHead.blockTimeMs),
        p_head_snapshot_parser_abi_fingerprint:
          PUMP_FUN_SNAPSHOT_PARSER_ABI_FINGERPRINT,
        p_head_curve_state_fingerprint: snapshot.curveStateFingerprint,
        p_head_curve_observed_slot: snapshot.observedSlot,
        p_head_curve_complete: snapshot.complete,
        p_head_virtual_token_reserves_raw: snapshot.virtualTokenReservesRaw.toString(),
        p_head_virtual_sol_reserves_lamports: snapshot.virtualSolReservesLamports.toString(),
        p_head_real_token_reserves_raw: snapshot.realTokenReservesRaw.toString(),
        p_head_real_sol_reserves_lamports: snapshot.realSolReservesLamports.toString(),
        p_head_curve_total_supply_raw: snapshot.totalSupplyRaw.toString(),
        p_head_mint_layout_fingerprint: snapshot.mintLayoutFingerprint,
        p_head_token_program: snapshot.tokenProgram,
        p_head_mint_supply_raw: snapshot.totalSupplyRaw.toString(),
        p_head_mint_decimals: snapshot.decimals,
      });
    },

    async recordCursor(
      epochId: string,
      lease: FreshTailLease,
      input: FreshTailCursorWrite,
    ): Promise<FreshTailMutationResult> {
      return invoke("record_custody_fresh_tail_cursor", {
        ...fenced(epochId, lease),
        p_scope_mint: input.scopeMint,
        p_wallet: input.wallet,
        p_expected_last_signature: input.expectedLastSignature,
        p_next_last_signature: input.nextLastSignature,
        p_next_last_slot: input.nextLastSlot,
        p_last_block_time: input.lastBlockTimeSeconds,
        p_first_available_block: input.firstAvailableBlock,
        p_covered_head_slot: input.coveredHead.slot,
        p_covered_head_blockhash: input.coveredHead.blockhash,
        p_coverage_revision: input.coverageRevision,
        p_backlog_detected: input.backlogDetected,
        p_last_error: input.lastError,
      });
    },

    async recordBackscanCursor(
      epochId: string,
      lease: FreshTailLease,
      rangeId: string,
      input: Omit<FreshTailCursorWrite, "scopeMint" | "wallet">,
    ): Promise<FreshTailMutationResult> {
      return invoke("record_custody_fresh_tail_backscan_cursor", {
        ...fenced(epochId, lease),
        p_range_id: rangeId,
        p_expected_last_signature: input.expectedLastSignature,
        p_next_last_signature: input.nextLastSignature,
        p_next_last_slot: input.nextLastSlot,
        p_last_block_time: input.lastBlockTimeSeconds,
        p_first_available_block: input.firstAvailableBlock,
        p_covered_head_slot: input.coveredHead.slot,
        p_covered_head_blockhash: input.coveredHead.blockhash,
        p_coverage_revision: input.coverageRevision,
        p_backlog_detected: input.backlogDetected,
        p_last_error: input.lastError,
      });
    },

    async settleRequest(
      epochId: string,
      lease: FreshTailLease,
      requestId: string,
      expectedRevision: number,
    ): Promise<FreshTailMutationResult> {
      return invoke("settle_custody_fresh_tail_request", {
        ...fenced(epochId, lease),
        p_request_id: requestId,
        p_expected_scope_revision: expectedRevision,
      });
    },

    async retireMint(
      epochId: string,
      lease: FreshTailLease,
      tokenMint: string,
      expectedRevision: number,
      reason: string,
    ): Promise<FreshTailMutationResult> {
      return invoke("retire_custody_fresh_tail_mint", {
        ...fenced(epochId, lease),
        p_token_mint: tokenMint,
        p_expected_scope_revision: expectedRevision,
        p_reason: reason,
      });
    },

    async saveHeartbeat(heartbeat: FreshTailHeartbeat): Promise<FreshTailMutationResult> {
      return invoke("record_custody_fresh_tail_heartbeat", {
        ...fenced(heartbeat.epochId, heartbeat.lease),
        p_worker_id: heartbeat.workerId,
        p_enabled: heartbeat.enabled,
        p_shadow: heartbeat.shadow,
        p_latest_head_slot: heartbeat.latestHead.slot,
        p_latest_head_blockhash: heartbeat.latestHead.blockhash,
        p_latest_head_block_time: isoFromMs(heartbeat.latestHead.blockTimeMs),
        p_last_success_at: heartbeat.lastSuccessAt,
        p_last_error: heartbeat.lastError,
      });
    },
  };
}

export type FreshTailStore = ReturnType<typeof createSupabaseFreshTailStore>;
