import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetch, Response } from "undici";
import { createBotDb, DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS } from "./db.js";

type CapturedRequest = {
  timeoutMs: number;
  signal: AbortSignal | null | undefined;
};

async function exerciseClient(requestTimeoutMs?: number): Promise<CapturedRequest> {
  let capturedTimeoutMs = 0;
  let capturedSignal: AbortSignal | null | undefined;
  const timeoutController = new AbortController();
  const fakeFetch = (async (_input, init) => {
    capturedSignal = init?.signal;
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const timeoutSignalFactory = (timeoutMs: number) => {
    capturedTimeoutMs = timeoutMs;
    return timeoutController.signal;
  };
  const client = createBotDb(requestTimeoutMs, fakeFetch, timeoutSignalFactory);

  const { error } = await client.from("request_timeout_probe").select("id");
  assert.equal(error, null);
  return { timeoutMs: capturedTimeoutMs, signal: capturedSignal };
}

test("the shared Supabase client factory retains the five-second trading default", async () => {
  assert.equal(DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS, 5_000);
  const captured = await exerciseClient();
  assert.equal(captured.timeoutMs, 5_000);
  assert.ok(captured.signal instanceof AbortSignal);
});

test("Custody uses an isolated 30-second client and only two recovery lanes", async () => {
  const captured = await exerciseClient(30_000);
  assert.equal(captured.timeoutMs, 30_000);

  const custodySource = readFileSync(
    fileURLToPath(new URL("../src/custody-index.ts", import.meta.url)),
    "utf8",
  );
  const tradingSource = readFileSync(
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "utf8",
  );
  assert.match(custodySource, /import \{ createBotDb \} from ["']\.\/db\.js["']/);
  assert.doesNotMatch(custodySource, /import \{ db(?:,| \})/);
  assert.match(custodySource, /const db = createBotDb\(30_000\)/);
  assert.match(custodySource, /recoveryConcurrency: 2/);
  assert.match(tradingSource, /import \{ db, type BotConfigRow \} from ["']\.\/db\.js["']/);
  assert.doesNotMatch(tradingSource, /createBotDb/);
});

test("invalid Supabase client deadlines fail before a request can start", () => {
  assert.throws(() => createBotDb(0), /positive safe integer/);
  assert.throws(() => createBotDb(Number.POSITIVE_INFINITY), /positive safe integer/);
});
