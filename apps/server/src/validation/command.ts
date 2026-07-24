import type {
  NormalizedValidationCommand,
  ValidationCommandDefinition,
  ValidationCommandInput,
} from "./types.js";

const SHELL_CONTROL_ARGUMENTS = new Set([
  "&&",
  "||",
  "|",
  "&",
  ";",
  ">",
  ">>",
  "<",
  "<<",
]);

export class ValidationCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationCommandError";
  }
}

export function parseCommandLine(command: string): string[] {
  if (
    command.trim().length === 0 ||
    command.includes("\0") ||
    /[\r\n]/u.test(command)
  ) {
    throw new ValidationCommandError(
      "Validation commands must be non-empty single lines without NUL characters",
    );
  }

  const arguments_: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let tokenStarted = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }

    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      if (tokenStarted) {
        arguments_.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += character;
    tokenStarted = true;
  }

  if (escaped) {
    throw new ValidationCommandError(
      "Validation command ends with an incomplete escape",
    );
  }
  if (quote !== null) {
    throw new ValidationCommandError(
      "Validation command contains an unterminated quote",
    );
  }
  if (tokenStarted) {
    arguments_.push(current);
  }

  validateArgv(arguments_);
  return arguments_;
}

export function validateArgv(argv: readonly string[]): asserts argv is readonly [
  string,
  ...string[],
] {
  if (argv.length === 0) {
    throw new ValidationCommandError(
      "Validation command must include an executable",
    );
  }

  for (const argument of argv) {
    if (argument.includes("\0")) {
      throw new ValidationCommandError(
        "Validation command arguments cannot contain NUL characters",
      );
    }
    if (SHELL_CONTROL_ARGUMENTS.has(argument)) {
      throw new ValidationCommandError(
        `Shell control operator ${argument} is not supported; configure separate argv commands`,
      );
    }
  }

  const executable = argv[0];
  if (
    executable === undefined ||
    executable.length === 0 ||
    executable.startsWith("-") ||
    /^[A-Za-z_][A-Za-z0-9_]*=/u.test(executable)
  ) {
    throw new ValidationCommandError(
      "Validation command executable is invalid; environment assignments and option-like executables are not supported",
    );
  }
}

export function normalizeValidationCommand(
  input: ValidationCommandInput,
): NormalizedValidationCommand {
  if (typeof input === "string") {
    return {
      argv: parseCommandLine(input),
      required: true,
      timeoutMs: null,
      label: null,
    };
  }

  if (!isValidationCommandDefinition(input)) {
    const argv: readonly string[] = input;
    validateArgv(argv);
    return {
      argv: [...argv],
      required: true,
      timeoutMs: null,
      label: null,
    };
  }

  validateArgv(input.argv);
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
  ) {
    throw new ValidationCommandError(
      "Validation command timeout must be a positive integer",
    );
  }

  const normalized: NormalizedValidationCommand = {
    argv: [...input.argv],
    required: input.required ?? true,
    timeoutMs: input.timeoutMs ?? null,
    label: input.label?.trim() || null,
  };
  return normalized;
}

function isValidationCommandDefinition(
  input: readonly string[] | ValidationCommandDefinition,
): input is ValidationCommandDefinition {
  return !Array.isArray(input);
}

export function formatArgv(argv: readonly string[]): string {
  return argv
    .map((argument) =>
      /^[A-Za-z0-9_./:@%+=,-]+$/u.test(argument)
        ? argument
        : JSON.stringify(argument),
    )
    .join(" ");
}
