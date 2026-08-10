import assert from "node:assert/strict";
import test from "node:test";

import { hasVerifiedSwapSignal, VERIFIED_SWAP_PROGRAMS } from "./swap-signal.js";

const { jupiterV6, pump, pumpSwap } = VERIFIED_SWAP_PROGRAMS;
const UNTRUSTED_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

test("accepts successful supported trade instructions and nested CPIs", () => {
  assert.equal(
    hasVerifiedSwapSignal([
      `Program ${jupiterV6} invoke [1]`,
      "Program log: Instruction: Route",
      `Program ${TOKEN_PROGRAM} invoke [2]`,
      `Program ${TOKEN_PROGRAM} success`,
      `Program ${jupiterV6} success`,
    ]),
    true,
  );
  assert.equal(
    hasVerifiedSwapSignal([
      `Program ${pump} invoke [1]`,
      "Program log: Instruction: Buy",
      `Program ${pump} success`,
    ]),
    true,
  );
  assert.equal(
    hasVerifiedSwapSignal([
      `Program ${pumpSwap} invoke [1]`,
      "Program log: Instruction: BuyExactQuoteIn",
      `Program ${pumpSwap} success`,
    ]),
    true,
  );
});

test("rejects untrusted, spoofed, non-trade, failed, and malformed logs", () => {
  assert.equal(
    hasVerifiedSwapSignal([
      `Program ${UNTRUSTED_PROGRAM} invoke [1]`,
      "Program log: Instruction: Swap",
      `Program ${UNTRUSTED_PROGRAM} success`,
    ]),
    false,
  );
  assert.equal(
    hasVerifiedSwapSignal([
      `Program ${UNTRUSTED_PROGRAM} invoke [1]`,
      `Program log: Program ${jupiterV6} invoke [2]`,
      "Program log: Instruction: Route",
      `Program ${UNTRUSTED_PROGRAM} success`,
    ]),
    false,
  );
  assert.equal(
    hasVerifiedSwapSignal([
      `Program ${jupiterV6} invoke [1]`,
      "Program log: Instruction: Initialize",
      `Program ${jupiterV6} success`,
    ]),
    false,
  );
  assert.equal(
    hasVerifiedSwapSignal([
      `Program ${jupiterV6} invoke [1]`,
      "Program log: Instruction: Route",
      `Program ${jupiterV6} failed: custom program error: 0x1`,
    ]),
    false,
  );
  assert.equal(
    hasVerifiedSwapSignal([`Program ${jupiterV6} invoke [1]`, "Program log: Instruction: Route"]),
    false,
  );
});

test("a trade word outside the trusted frame cannot verify a swap", () => {
  assert.equal(
    hasVerifiedSwapSignal([
      `Program ${jupiterV6} invoke [1]`,
      "Program log: Instruction: Initialize",
      `Program ${jupiterV6} success`,
      `Program ${UNTRUSTED_PROGRAM} invoke [1]`,
      "Program log: Instruction: Route",
      `Program ${UNTRUSTED_PROGRAM} success`,
    ]),
    false,
  );
});
