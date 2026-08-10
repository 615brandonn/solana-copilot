const JUPITER_V6_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const TRADE_INSTRUCTIONS = new Map<string, ReadonlySet<string>>([
  [
    JUPITER_V6_PROGRAM,
    new Set([
      "route",
      "routewithtokenledger",
      "sharedaccountsroute",
      "sharedaccountsroutewithtokenledger",
      "exactoutroute",
      "sharedaccountsexactoutroute",
    ]),
  ],
  [
    PUMP_PROGRAM,
    new Set([
      "buy",
      "buyv2",
      "buyexactsolin",
      "buyexactquotein",
      "buyexactquoteinv2",
      "sell",
      "sellv2",
    ]),
  ],
  [
    PUMP_SWAP_PROGRAM,
    new Set(["buy", "buyv2", "buyexactquotein", "buyexactquoteinv2", "sell", "sellv2"]),
  ],
]);

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const SUCCESS_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) success$/;
const FAILED_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed:/;
const INSTRUCTION_RE = /^Program log: Instruction: ([A-Za-z0-9_]+)$/;

type ProgramFrame = {
  programId: string;
  sawTradeInstruction: boolean;
};

function normalizeInstruction(value: string): string {
  return value.toLowerCase().replaceAll("_", "");
}

/**
 * Verifies that a supported swap program itself logged a known trade
 * instruction and then returned successfully. Program-owned log text cannot
 * forge the Solana runtime's anchored `Program <id> invoke/success` records.
 */
export function hasVerifiedSwapSignal(logMessages: readonly unknown[]): boolean {
  const stack: ProgramFrame[] = [];
  let verified = false;

  for (const rawLine of logMessages) {
    if (typeof rawLine !== "string") return false;
    const invoke = rawLine.match(INVOKE_RE);
    if (invoke) {
      const depth = Number(invoke[2]);
      if (!Number.isSafeInteger(depth) || depth !== stack.length + 1) return false;
      stack.push({ programId: invoke[1], sawTradeInstruction: false });
      continue;
    }

    const instruction = rawLine.match(INSTRUCTION_RE);
    if (instruction) {
      const frame = stack.at(-1);
      if (!frame) return false;
      const allowed = TRADE_INSTRUCTIONS.get(frame.programId);
      if (allowed?.has(normalizeInstruction(instruction[1]))) {
        frame.sawTradeInstruction = true;
      }
      continue;
    }

    const success = rawLine.match(SUCCESS_RE);
    if (success) {
      const frame = stack.pop();
      if (!frame || frame.programId !== success[1]) return false;
      if (frame.sawTradeInstruction) verified = true;
      continue;
    }

    const failed = rawLine.match(FAILED_RE);
    if (failed) {
      const frame = stack.pop();
      if (!frame || frame.programId !== failed[1]) return false;
    }
  }

  return stack.length === 0 && verified;
}

export const VERIFIED_SWAP_PROGRAMS = {
  jupiterV6: JUPITER_V6_PROGRAM,
  pump: PUMP_PROGRAM,
  pumpSwap: PUMP_SWAP_PROGRAM,
} as const;
