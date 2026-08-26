import { SubmissionUncertainError, type SubmissionRoute } from "./execution-safety.js";

export type KnownSignatureSubmissionInput = {
  route: SubmissionRoute;
  knownSig: string;
  timeoutMs: number;
  send: () => Promise<string>;
};

/**
 * Bound a raw RPC submission without ever treating a timeout as pre-submit.
 * Once `send` is invoked the HTTP request may reach the validator even when
 * the local promise times out, so every error retains the signed identity and
 * blocks alternate-route execution.
 */
export async function submitKnownSignatureWithTimeout(
  input: KnownSignatureSubmissionInput,
): Promise<string> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("raw submission timeout must be positive");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const returnedSig = await Promise.race([
      input.send(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("raw transaction submission timed out")),
          Math.max(1, Math.trunc(input.timeoutMs)),
        );
      }),
    ]);
    if (returnedSig !== input.knownSig) {
      throw new SubmissionUncertainError({
        route: input.route,
        txSig: input.knownSig,
        detail: "RPC returned a different transaction signature",
      });
    }
    return input.knownSig;
  } catch (error) {
    if (error instanceof SubmissionUncertainError) throw error;
    throw new SubmissionUncertainError({
      route: input.route,
      txSig: input.knownSig,
      detail: error,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
