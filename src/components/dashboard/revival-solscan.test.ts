import assert from "node:assert/strict";
import test from "node:test";

import { solscanTokenUrl } from "./revival-solscan.js";

test("builds a Solscan token URL for a valid Solana mint", () => {
  const mint = "So11111111111111111111111111111111111111112";

  assert.equal(solscanTokenUrl(mint), `https://solscan.io/token/${mint}`);
});

test("does not create links for malformed or non-32-byte mint values", () => {
  assert.equal(solscanTokenUrl("javascript:alert(1)"), null);
  assert.equal(solscanTokenUrl("0oIl-not-base58-111111111111111111111111111111"), null);
  assert.equal(solscanTokenUrl("So11111111111111111111111111111111111111112 "), null);
  assert.equal(solscanTokenUrl("1111111111111111111111111111111"), null);
});
