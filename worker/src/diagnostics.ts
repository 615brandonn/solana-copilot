const MAX_DIAGNOSTIC_LENGTH = 500;

export function safeDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "unknown error");
  const withoutHtml = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const redacted = withoutHtml
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(sb_(?:secret|publishable)_[A-Za-z0-9_-]+)\b/g, "[REDACTED_KEY]")
    .replace(/((?:^|[?&\s])(?:api[_-]?key|token|auth)=)[^&\s]+/gi, "$1[REDACTED]");
  return redacted.length > MAX_DIAGNOSTIC_LENGTH
    ? `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : redacted;
}

export function redactedIdentifier(value: string | null | undefined): string {
  if (!value) return "missing";
  return `[configured:${value.length} chars]`;
}
