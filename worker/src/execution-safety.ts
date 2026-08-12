import { safeDiagnostic } from "./diagnostics.js";

export type SubmissionRoute = "jito" | "rpc" | "jupiter-v2" | "pump.fun";

type SubmissionErrorOptions = {
  route: SubmissionRoute;
  txSig?: string;
  detail?: unknown;
};

/**
 * Base class for errors raised after a transaction submission may have begun.
 * Callers must not respond to these errors by constructing a different trade.
 */
export class PostSubmissionError extends Error {
  readonly route: SubmissionRoute;
  readonly txSig?: string;

  protected constructor(name: string, summary: string, options: SubmissionErrorOptions) {
    const detail = options.detail === undefined ? "" : safeDiagnostic(options.detail);
    const signature = options.txSig ? ` Signature: ${options.txSig}.` : "";
    super(`${summary}${signature}${detail ? ` Diagnostic: ${detail}` : ""}`);
    this.name = name;
    this.route = options.route;
    this.txSig = options.txSig;
  }
}

export class SubmissionUncertainError extends PostSubmissionError {
  readonly code = "TRANSACTION_SUBMISSION_UNCERTAIN" as const;

  constructor(options: SubmissionErrorOptions) {
    super(
      "SubmissionUncertainError",
      `${options.route} transaction may have been submitted; automatic alternate-route fallback is blocked.`,
      options,
    );
  }
}

export class SubmittedTransactionFailedError extends PostSubmissionError {
  readonly code = "SUBMITTED_TRANSACTION_FAILED" as const;

  constructor(options: SubmissionErrorOptions) {
    super(
      "SubmittedTransactionFailedError",
      `${options.route} transaction was submitted but failed; automatic alternate-route fallback is blocked.`,
      options,
    );
  }
}

export function isPostSubmissionError(error: unknown): error is PostSubmissionError {
  return error instanceof PostSubmissionError;
}

export function mayTryAlternateExecution(error: unknown): boolean {
  return !isPostSubmissionError(error);
}

/** Parse a comma-separated secret-backed setting without echoing its values in errors. */
export function parseUniqueCsvSetting(raw: string | undefined, label: string): string[] {
  const values = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const uniqueCount = new Set(values).size;
  if (uniqueCount !== values.length) {
    throw new Error(
      `${label} must contain unique values (configured ${values.length}, unique ${uniqueCount})`,
    );
  }
  return values;
}
