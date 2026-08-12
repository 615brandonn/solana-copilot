const MAX_DIAGNOSTIC_LENGTH = 500;

const URL_PATTERN = /\b(?:https?|wss?|postgres(?:ql)?):\/\/[^\s<>"'`]+/gi;
const SENSITIVE_LABEL =
  /((?:^|[?&\s,;])(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|credential|password|private[_-]?key|secret|token)\s*[:=]\s*["']?)[^\s,&;"']+/gi;

function redactUrl(value: string): string {
  const trailing = value.match(/[),.;\]}]+$/)?.[0] ?? "";
  let url = trailing ? value.slice(0, -trailing.length) : value;

  // Redact the complete user-info component. Even a database username can
  // contain a project reference, while passwords may contain URL punctuation.
  url = url.replace(/(:\/\/)[^/\s]*@/, "$1[REDACTED_USERINFO]@");
  url = url.replace(
    /([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|private[_-]?key|secret|token)=)[^&#\s]*/gi,
    "$1[REDACTED]",
  );

  // Credentials are sometimes embedded as opaque path segments rather than a
  // named query parameter. Preserve ordinary route names and short error codes.
  url = url.replace(/\/([A-Za-z0-9_+=.-]{32,})(?=\/|[?#]|$)/g, (segment, token: string) => {
    return looksOpaque(token) ? "/[REDACTED_PATH]" : segment;
  });
  return `${url}${trailing}`;
}

function looksOpaque(value: string): boolean {
  if (/^(?:[a-f0-9]{32,}|[1-9A-HJ-NP-Za-km-z]{40,})$/i.test(value)) return true;
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value)].filter(Boolean);
  return value.length >= 40 && classes.length >= 2 && !/^[a-z0-9_]+$/.test(value);
}

export function safeDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "unknown error");
  const withoutHtml = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const redacted = withoutHtml
    .replace(URL_PATTERN, redactUrl)
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(SENSITIVE_LABEL, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(
      /\b(?:sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g,
      "[REDACTED_KEY]",
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_ID]")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{40,88}\b/g, "[REDACTED_ID]");
  return redacted.length > MAX_DIAGNOSTIC_LENGTH
    ? `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : redacted;
}

export function redactedIdentifier(value: string | null | undefined): string {
  if (!value) return "missing";
  return `[configured:${value.length} chars]`;
}
