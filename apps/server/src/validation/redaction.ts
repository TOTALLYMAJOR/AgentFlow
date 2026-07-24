const REDACTION_MARKER = "[REDACTED]";

export class SecretRedactor {
  private readonly secrets: string[];
  private pending = "";
  private readonly retainedCharacters: number;

  constructor(secrets: readonly string[]) {
    this.secrets = [
      ...new Set(secrets.filter((secret) => secret.length > 0)),
    ].sort((first, second) => second.length - first.length);
    this.retainedCharacters = Math.max(
      0,
      ...this.secrets.map((secret) => secret.length - 1),
    );
  }

  redact(value: string): string {
    let redacted = value;
    for (const secret of this.secrets) {
      redacted = redacted.replaceAll(secret, REDACTION_MARKER);
    }
    return redacted;
  }

  write(chunk: string): string {
    this.pending += chunk;
    if (this.pending.length <= this.retainedCharacters) {
      return "";
    }

    const initialBoundary = this.pending.length - this.retainedCharacters;
    let safeBoundary = initialBoundary;
    for (const secret of this.secrets) {
      const crossingIndex = this.pending.lastIndexOf(
        secret,
        initialBoundary - 1,
      );
      if (
        crossingIndex !== -1 &&
        crossingIndex < initialBoundary &&
        crossingIndex + secret.length > initialBoundary
      ) {
        safeBoundary = Math.min(safeBoundary, crossingIndex);
      }
    }

    if (safeBoundary === 0) {
      return "";
    }
    const safe = this.pending.slice(0, safeBoundary);
    this.pending = this.pending.slice(safeBoundary);
    return this.redact(safe);
  }

  end(): string {
    const remaining = this.redact(this.pending);
    this.pending = "";
    return remaining;
  }
}

export function redactSecrets(
  value: string,
  secrets: readonly string[],
): string {
  return new SecretRedactor(secrets).redact(value);
}
