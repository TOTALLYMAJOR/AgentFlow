const REDACTION_MARKER = "[REDACTED]";

const DEFAULT_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{12,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu,
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/giu,
] as const;

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export type Redactor = (value: string) => string;

export function createRedactor(secrets: readonly string[] = []): Redactor {
  const exactSecrets = [...new Set(secrets)]
    .filter((secret) => secret.length >= 3)
    .sort((first, second) => second.length - first.length)
    .map((secret) => new RegExp(escapeRegularExpression(secret), "gu"));

  return (value: string): string => {
    let redacted = value;
    for (const secret of exactSecrets) {
      redacted = redacted.replace(secret, REDACTION_MARKER);
    }
    for (const pattern of DEFAULT_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, (match, prefix: unknown) =>
        typeof prefix === "string"
          ? `${prefix}${REDACTION_MARKER}`
          : REDACTION_MARKER,
      );
    }
    return redacted;
  };
}

export function redactValue(value: unknown, redact: Redactor): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redact));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, redact),
      ]),
    );
  }
  return value;
}
