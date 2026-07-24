export const DEFAULT_VALIDATION_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "CI",
  "FORCE_COLOR",
  "NO_COLOR",
  "COLORTERM",
  "TZ",
  "COMPOSE_PROJECT_NAME",
] as const;

export class ValidationEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationEnvironmentError";
  }
}

export function buildValidationEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string | undefined>> = {},
  additionalAllowedKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set<string>([
    ...DEFAULT_VALIDATION_ENVIRONMENT_KEYS,
    ...additionalAllowedKeys,
  ]);

  for (const key of additionalAllowedKeys) {
    assertEnvironmentKey(key);
  }

  for (const key of Object.keys(overrides)) {
    assertEnvironmentKey(key);
    if (!allowed.has(key)) {
      throw new ValidationEnvironmentError(
        `Validation environment variable ${key} is not allowlisted`,
      );
    }
  }

  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value =
      Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key]
        : source[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

function assertEnvironmentKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
    throw new ValidationEnvironmentError(
      `Invalid validation environment variable name: ${key}`,
    );
  }
}
