import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { formatArgv, validateArgv } from "./command.js";
import { buildValidationEnvironment } from "./environment.js";
import { redactSecrets, SecretRedactor } from "./redaction.js";
import type {
  ValidationOutputEvent,
  ValidationProcessOptions,
  ValidationProcessResult,
  ValidationProcessStatus,
} from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

class BoundedOutput {
  private value = "";
  private bytes = 0;
  private wasTruncated = false;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: string): void {
    if (chunk.length === 0 || this.wasTruncated) {
      return;
    }
    const available = this.maximumBytes - this.bytes;
    if (available <= 0) {
      this.wasTruncated = true;
      return;
    }

    const chunkBytes = Buffer.byteLength(chunk);
    if (chunkBytes <= available) {
      this.value += chunk;
      this.bytes += chunkBytes;
      return;
    }

    let lower = 0;
    let upper = chunk.length;
    while (lower < upper) {
      const midpoint = Math.ceil((lower + upper) / 2);
      if (Buffer.byteLength(chunk.slice(0, midpoint)) <= available) {
        lower = midpoint;
      } else {
        upper = midpoint - 1;
      }
    }
    this.value += chunk.slice(0, lower);
    this.bytes += Buffer.byteLength(chunk.slice(0, lower));
    this.wasTruncated = true;
  }

  get text(): string {
    if (!this.wasTruncated) {
      return this.value;
    }
    return `${this.value}\n[output truncated after ${this.maximumBytes} bytes]\n`;
  }

  get truncated(): boolean {
    return this.wasTruncated;
  }
}

interface StreamCapture {
  decoder: StringDecoder;
  redactor: SecretRedactor;
  output: BoundedOutput;
  stream: ValidationOutputEvent["stream"];
}

type TerminationReason = "timed_out" | "cancelled";

export async function runValidationProcess(
  options: ValidationProcessOptions,
): Promise<ValidationProcessResult> {
  validateArgv(options.argv);
  assertPositiveInteger(options.timeoutMs, "timeoutMs");
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const terminationGraceMs =
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  assertPositiveInteger(maxOutputBytes, "maxOutputBytes");
  assertNonNegativeInteger(terminationGraceMs, "terminationGraceMs");

  const argv = [...options.argv];
  const secrets = options.secrets ?? [];
  const command = redactSecrets(formatArgv(argv), secrets);
  const recordedArgv = argv.map((argument) =>
    redactSecrets(argument, secrets),
  );
  const startedAt = new Date();
  const startedMonotonic = performance.now();

  if (options.signal?.aborted === true) {
    return createEarlyResult(
      recordedArgv,
      command,
      "cancelled",
      startedAt,
      startedMonotonic,
      "Validation was cancelled before it started",
    );
  }

  const environment = buildValidationEnvironment(
    process.env,
    options.environment,
    options.additionalEnvironmentKeys,
  );
  const executable = argv[0];
  if (executable === undefined) {
    throw new Error("Validated command unexpectedly has no executable");
  }

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, argv.slice(1), {
        cwd: options.cwd,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolve(
        createEarlyResult(
          recordedArgv,
          command,
          "spawn_error",
          startedAt,
          startedMonotonic,
          redactSecrets(errorMessage(error), secrets),
        ),
      );
      return;
    }

    const stdout = createStreamCapture("stdout", secrets, maxOutputBytes);
    const stderr = createStreamCapture("stderr", secrets, maxOutputBytes);
    child.stdin.end();
    let terminationReason: TerminationReason | null = null;
    let spawnError: string | null = null;
    let closed = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const emit = (capture: StreamCapture, chunk: string): void => {
      if (chunk.length === 0) {
        return;
      }
      capture.output.append(chunk);
      try {
        options.onOutput?.({ stream: capture.stream, chunk });
      } catch (error) {
        spawnError ??= redactSecrets(
          `Validation output sink failed: ${errorMessage(error)}`,
          secrets,
        );
      }
    };

    const consume = (capture: StreamCapture, chunk: Buffer): void => {
      emit(capture, capture.redactor.write(capture.decoder.write(chunk)));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      consume(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      consume(stderr, chunk);
    });

    const terminate = (reason: TerminationReason): void => {
      if (closed || terminationReason !== null) {
        return;
      }
      terminationReason = reason;
      killProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!closed) {
          killProcessTree(child, "SIGKILL");
        }
      }, terminationGraceMs);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => {
      terminate("timed_out");
    }, options.timeoutMs);
    timeout.unref();

    const abort = (): void => {
      terminate("cancelled");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) {
      abort();
    }

    child.once("spawn", () => {
      if (child.pid !== undefined) {
        try {
          options.onSpawn?.(child.pid);
        } catch (error) {
          spawnError ??= redactSecrets(
            `Validation process observer failed: ${errorMessage(error)}`,
            secrets,
          );
        }
      }
    });

    child.once("error", (error) => {
      spawnError = redactSecrets(errorMessage(error), secrets);
    });

    child.once("close", (exitCode, exitSignal) => {
      closed = true;
      clearTimeout(timeout);
      if (forceKillTimer !== null) {
        clearTimeout(forceKillTimer);
      }
      options.signal?.removeEventListener("abort", abort);

      emit(
        stdout,
        stdout.redactor.write(stdout.decoder.end()) + stdout.redactor.end(),
      );
      emit(
        stderr,
        stderr.redactor.write(stderr.decoder.end()) + stderr.redactor.end(),
      );

      const status = resolveStatus(
        terminationReason,
        spawnError,
        exitCode,
      );
      const completedAt = new Date();
      resolve({
        argv: recordedArgv,
        command,
        status,
        processId: child.pid ?? null,
        exitCode,
        signal: exitSignal,
        stdout: stdout.output.text,
        stderr: stderr.output.text,
        stdoutTruncated: stdout.output.truncated,
        stderrTruncated: stderr.output.truncated,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Math.max(
          0,
          Math.round(performance.now() - startedMonotonic),
        ),
        error: spawnError,
      });
    });
  });
}

function createStreamCapture(
  stream: ValidationOutputEvent["stream"],
  secrets: readonly string[],
  maxOutputBytes: number,
): StreamCapture {
  return {
    decoder: new StringDecoder("utf8"),
    redactor: new SecretRedactor(secrets),
    output: new BoundedOutput(maxOutputBytes),
    stream,
  };
}

function resolveStatus(
  terminationReason: TerminationReason | null,
  spawnError: string | null,
  exitCode: number | null,
): ValidationProcessStatus {
  if (terminationReason !== null) {
    return terminationReason;
  }
  if (spawnError !== null) {
    return "spawn_error";
  }
  return exitCode === 0 ? "passed" : "failed";
}

function createEarlyResult(
  argv: string[],
  command: string,
  status: ValidationProcessStatus,
  startedAt: Date,
  startedMonotonic: number,
  error: string,
): ValidationProcessResult {
  const completedAt = new Date();
  return {
    argv,
    command,
    status,
    processId: null,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(
      0,
      Math.round(performance.now() - startedMonotonic),
    ),
    error,
  };
}

function killProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  const processId = child.pid;
  if (processId === undefined) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-processId, signal);
      return;
    } catch (error) {
      if (!isMissingProcess(error)) {
        try {
          child.kill(signal);
        } catch {
          // The process raced with cancellation and is already gone.
        }
      }
      return;
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process raced with cancellation and is already gone.
  }
}

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}
