import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BoundedLog } from "./bounded-log.js";
import { JsonlStreamParser, type JsonlLine } from "./jsonl.js";
import { buildWorkerPrompt } from "./prompt.js";
import { createRedactor, redactValue } from "./redaction.js";
import {
  parseWorkerResultEvent,
  WORKER_RESULT_JSON_SCHEMA,
} from "./result.js";
import type {
  CodexWorkerHandle,
  CodexWorkerOptions,
  WorkerFailureCode,
  WorkerLogPaths,
  WorkerOutcome,
  WorkerOutcomeStatus,
  WorkerRuntimeEvent,
  WorkerStructuredResult,
  WorkerTerminationReason,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_MAXIMUM_LOG_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAXIMUM_JSONL_LINE_BYTES = 1024 * 1024;

const PROTECTED_ARGUMENTS = new Set([
  "-",
  "--json",
  "--sandbox",
  "--output-schema",
  "--full-auto",
  "--dangerously-bypass-approvals-and-sandbox",
  "--cd",
  "-C",
]);

const ALLOWED_VALUE_ARGUMENTS = new Set(["--model", "-m"]);
const ALLOWED_SWITCH_ARGUMENTS = new Set(["--skip-git-repo-check"]);
const INHERITED_ENVIRONMENT_KEYS = [
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
  "CODEX_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function validateAdditionalArguments(arguments_: readonly string[]): void {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    const flag = argument.includes("=")
      ? argument.slice(0, argument.indexOf("="))
      : argument;
    if (PROTECTED_ARGUMENTS.has(flag)) {
      throw new Error(`Codex argument ${flag} is controlled by AgentFlow`);
    }
    if (ALLOWED_SWITCH_ARGUMENTS.has(argument)) {
      continue;
    }
    if (argument.startsWith("--model=")) {
      if (argument.slice("--model=".length).trim().length === 0) {
        throw new Error("Codex model argument must include a value");
      }
      continue;
    }
    if (ALLOWED_VALUE_ARGUMENTS.has(argument)) {
      const value = arguments_[index + 1];
      if (value === undefined || value.trim().length === 0) {
        throw new Error(`Codex argument ${argument} requires a value`);
      }
      index += 1;
      continue;
    }
    throw new Error(
      `Codex argument ${argument || "<empty>"} is not permitted by AgentFlow`,
    );
  }
}

export function buildCodexArguments(
  resultSchemaPath: string,
  additionalArguments: readonly string[] = [],
): string[] {
  validateAdditionalArguments(additionalArguments);
  return [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--output-schema",
    resultSchemaPath,
    ...additionalArguments,
    "-",
  ];
}

function createPaths(attemptDirectory: string): WorkerLogPaths {
  return {
    attemptDirectory,
    prompt: path.join(attemptDirectory, "prompt.md"),
    jsonl: path.join(attemptDirectory, "codex-events.jsonl"),
    stderr: path.join(attemptDirectory, "stderr.log"),
    resultSchema: path.join(
      attemptDirectory,
      "worker-result.schema.json",
    ),
    result: path.join(attemptDirectory, "worker-result.json"),
    outcome: path.join(attemptDirectory, "worker-outcome.json"),
  };
}

function safelyEmit(
  callback: CodexWorkerOptions["onEvent"],
  event: WorkerRuntimeEvent,
): void {
  try {
    callback?.(event);
  } catch {
    // Observers must not be able to terminate a worker process.
  }
}

function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): boolean {
  if (child.pid === undefined || child.exitCode !== null) {
    return false;
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return true;
    }
    return child.kill(signal);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function classifyOutcome(input: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: Error | null;
  terminationReason: WorkerTerminationReason | null;
  finalResult: WorkerStructuredResult | null;
  resultCandidateFound: boolean;
  resultError: string | null;
}): {
  status: WorkerOutcomeStatus;
  failureCode: WorkerFailureCode | null;
  failureMessage: string | null;
  success: boolean;
} {
  if (input.terminationReason === "cancelled") {
    return {
      status: "cancelled",
      failureCode: "cancelled",
      failureMessage: "Worker execution was cancelled",
      success: false,
    };
  }
  if (input.terminationReason === "timeout") {
    return {
      status: "timed_out",
      failureCode: "timeout",
      failureMessage: "Worker exceeded its execution timeout",
      success: false,
    };
  }
  if (input.terminationReason === "idle_timeout") {
    return {
      status: "idle_timed_out",
      failureCode: "idle_timeout",
      failureMessage: "Worker produced no output before its idle timeout",
      success: false,
    };
  }
  if (input.spawnError !== null) {
    return {
      status: "failed",
      failureCode: "spawn_error",
      failureMessage: input.spawnError.message,
      success: false,
    };
  }
  if (input.exitCode === null) {
    return {
      status: "process_disappeared",
      failureCode: "process_disappeared",
      failureMessage:
        input.signal === null
          ? "Worker process disappeared without an exit code"
          : `Worker process disappeared after signal ${input.signal}`,
      success: false,
    };
  }
  if (input.exitCode !== 0) {
    return {
      status: "failed",
      failureCode: "process_exit_nonzero",
      failureMessage: `Codex exited with code ${input.exitCode}`,
      success: false,
    };
  }
  if (input.finalResult === null) {
    return {
      status: "failed",
      failureCode: input.resultCandidateFound
        ? "structured_result_invalid"
        : "structured_result_missing",
      failureMessage:
        input.resultError ??
        "Codex exited without a valid structured final result",
      success: false,
    };
  }
  if (input.finalResult.status === "blocked") {
    return {
      status: "failed",
      failureCode: "worker_reported_blocked",
      failureMessage: input.finalResult.summary,
      success: false,
    };
  }
  if (input.finalResult.status === "failed") {
    return {
      status: "failed",
      failureCode: "worker_reported_failed",
      failureMessage: input.finalResult.summary,
      success: false,
    };
  }
  return {
    status: "succeeded",
    failureCode: null,
    failureMessage: null,
    success: true,
  };
}

export async function startCodexWorker(
  options: CodexWorkerOptions,
): Promise<CodexWorkerHandle> {
  const timeoutMs = requirePositiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "timeout",
  );
  const idleTimeoutMs = requirePositiveInteger(
    options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    "idle timeout",
  );
  const heartbeatIntervalMs = requirePositiveInteger(
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    "heartbeat interval",
  );
  const terminationGraceMs = requirePositiveInteger(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    "termination grace period",
  );
  const maximumLogBytes = requirePositiveInteger(
    options.maximumLogBytes ?? DEFAULT_MAXIMUM_LOG_BYTES,
    "maximum log size",
  );
  const maximumJsonlLineBytes = requirePositiveInteger(
    options.maximumJsonlLineBytes ?? DEFAULT_MAXIMUM_JSONL_LINE_BYTES,
    "maximum JSONL line size",
  );
  const paths = createPaths(path.resolve(options.attemptDirectory));
  const worktreePath = path.resolve(options.worktreePath);
  const redact = createRedactor(options.secrets);
  const prompt = buildWorkerPrompt(
    options.prompt,
    options.maximumPromptBytes,
  );

  await mkdir(path.dirname(paths.attemptDirectory), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(paths.attemptDirectory, { mode: 0o700 });
  await Promise.all([
    writeFile(paths.prompt, redact(prompt), { encoding: "utf8", mode: 0o600 }),
    writeFile(
      paths.resultSchema,
      `${JSON.stringify(WORKER_RESULT_JSON_SCHEMA, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ),
  ]);

  const jsonlLog = new BoundedLog(paths.jsonl, maximumLogBytes);
  const stderrLog = new BoundedLog(paths.stderr, maximumLogBytes);
  await jsonlLog.initialize();
  try {
    await stderrLog.initialize();
  } catch (error) {
    await jsonlLog.close();
    throw error;
  }

  const executable = options.executable ?? "codex";
  const arguments_ = buildCodexArguments(
    paths.resultSchema,
    options.additionalArguments,
  );
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let child: ChildProcessWithoutNullStreams;

  try {
    child = spawn(executable, arguments_, {
      cwd: worktreePath,
      env: {
        ...inheritedWorkerEnvironment(process.env),
        ...options.environment,
        AGENTFLOW_BUILD_ID: options.prompt.buildId,
        AGENTFLOW_TASK_ID: options.prompt.task.id,
        AGENTFLOW_ATTEMPT: String(options.prompt.attempt),
        AGENTFLOW_DOCKER_ACCESS: "prohibited",
      },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    await Promise.all([jsonlLog.close(), stderrLog.close()]);
    throw error;
  }

  const pid = child.pid ?? null;
  let heartbeatAtMs = startedAtMs;
  let lastActivityAtMs = startedAtMs;
  let eventCount = 0;
  let malformedEventCount = 0;
  let finalResult: WorkerStructuredResult | null = null;
  let resultCandidateFound = false;
  let resultError: string | null = null;
  let spawnError: Error | null = null;
  let terminationReason: WorkerTerminationReason | null = null;
  let stopping = false;
  let processClosed = false;
  let forceKillTimer: NodeJS.Timeout | null = null;

  const emitHeartbeat = (reason: "activity" | "interval"): void => {
    if (pid === null) {
      return;
    }
    const occurredAt = new Date().toISOString();
    heartbeatAtMs = Date.now();
    const heartbeat = { pid, occurredAt, reason } as const;
    try {
      options.onHeartbeat?.(heartbeat);
    } catch {
      // Heartbeat persistence is an observer and cannot own the child process.
    }
    safelyEmit(options.onEvent, {
      type: "worker.heartbeat",
      ...heartbeat,
    });
  };

  const recordActivity = (): void => {
    lastActivityAtMs = Date.now();
    emitHeartbeat("activity");
  };

  const handleJsonlLine = (line: JsonlLine): void => {
    const occurredAt = new Date().toISOString();
    const safeRaw = redact(line.raw);
    jsonlLog.write(`${safeRaw}\n`);
    eventCount += 1;
    recordActivity();

    if (line.malformed) {
      malformedEventCount += 1;
      safelyEmit(options.onEvent, {
        type: "worker.jsonl_malformed",
        occurredAt,
        raw: safeRaw,
        error: line.error ?? "Invalid JSON",
      });
      return;
    }

    const safeValue = redactValue(line.value, redact);
    const parsedResult = parseWorkerResultEvent(safeValue);
    if (parsedResult.candidateFound) {
      resultCandidateFound = true;
      resultError = parsedResult.error;
      if (parsedResult.result !== null) {
        finalResult = parsedResult.result;
      }
    }
    safelyEmit(options.onEvent, {
      type: "worker.jsonl",
      occurredAt,
      raw: safeRaw,
      value: safeValue,
    });
  };

  const jsonlParser = new JsonlStreamParser(
    maximumJsonlLineBytes,
    handleJsonlLine,
  );
  const stderrDecoder = new StringDecoder("utf8");
  let stderrBuffer = "";

  const flushStderrLines = (flushRemainder = false): void => {
    let newline = stderrBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stderrBuffer.slice(0, newline).replace(/\r$/u, "");
      stderrBuffer = stderrBuffer.slice(newline + 1);
      const safeLine = redact(line);
      stderrLog.write(`${safeLine}\n`);
      safelyEmit(options.onEvent, {
        type: "worker.stderr",
        occurredAt: new Date().toISOString(),
        text: safeLine,
      });
      newline = stderrBuffer.indexOf("\n");
    }
    if (flushRemainder && stderrBuffer.length > 0) {
      const safeLine = redact(stderrBuffer);
      stderrLog.write(safeLine);
      safelyEmit(options.onEvent, {
        type: "worker.stderr",
        occurredAt: new Date().toISOString(),
        text: safeLine,
      });
      stderrBuffer = "";
    }
  };

  const requestStop = (reason: WorkerTerminationReason): void => {
    if (stopping || processClosed) {
      return;
    }
    stopping = true;
    terminationReason = reason;
    if (pid !== null) {
      safelyEmit(options.onEvent, {
        type: "worker.stopping",
        occurredAt: new Date().toISOString(),
        pid,
        reason,
      });
    }
    terminateProcessTree(child, "SIGTERM");
    forceKillTimer = setTimeout(() => {
      terminateProcessTree(child, "SIGKILL");
    }, terminationGraceMs);
    forceKillTimer.unref();
  };

  if (pid !== null) {
    safelyEmit(options.onEvent, {
      type: "worker.started",
      occurredAt: startedAt,
      pid,
      command: redact(executable),
      arguments: arguments_.map((argument) => redact(argument)),
    });
    try {
      options.onStarted?.(pid, startedAt);
    } catch {
      // Start persistence is an observer and cannot own the child process.
    }
  }

  child.stdout.on("data", (chunk: Buffer) => {
    recordActivity();
    jsonlParser.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    recordActivity();
    stderrBuffer += stderrDecoder.write(chunk);
    flushStderrLines();
    if (
      Buffer.byteLength(stderrBuffer, "utf8") > maximumJsonlLineBytes
    ) {
      const safeLine = redact(
        Buffer.from(stderrBuffer, "utf8")
          .subarray(0, maximumJsonlLineBytes)
          .toString("utf8"),
      );
      const marker = `[AgentFlow stderr line exceeded ${maximumJsonlLineBytes} bytes; remainder discarded]`;
      stderrLog.write(`${safeLine}\n${marker}\n`);
      safelyEmit(options.onEvent, {
        type: "worker.stderr",
        occurredAt: new Date().toISOString(),
        text: `${safeLine}\n${marker}`,
      });
      stderrBuffer = "";
    }
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  const wallTimer = setTimeout(() => {
    requestStop("timeout");
  }, timeoutMs);
  wallTimer.unref();

  const heartbeatTimer = setInterval(() => {
    emitHeartbeat("interval");
    if (Date.now() - lastActivityAtMs >= idleTimeoutMs) {
      requestStop("idle_timeout");
    }
  }, Math.min(heartbeatIntervalMs, idleTimeoutMs));
  heartbeatTimer.unref();

  const abort = (): void => {
    requestStop("cancelled");
  };
  if (options.signal?.aborted === true) {
    abort();
  } else {
    options.signal?.addEventListener("abort", abort, { once: true });
  }

  const completion = new Promise<WorkerOutcome>((resolve) => {
    child.once("close", (exitCode, signal) => {
      processClosed = true;
      const finalize = async (): Promise<WorkerOutcome> => {
        clearTimeout(wallTimer);
        clearInterval(heartbeatTimer);
        if (forceKillTimer !== null) {
          clearTimeout(forceKillTimer);
        }
        options.signal?.removeEventListener("abort", abort);

        jsonlParser.end();
        stderrBuffer += stderrDecoder.end();
        flushStderrLines(true);
        await Promise.all([jsonlLog.close(), stderrLog.close()]);

        const classification = classifyOutcome({
          exitCode,
          signal,
          spawnError,
          terminationReason,
          finalResult,
          resultCandidateFound,
          resultError,
        });
        const completedAtMs = Date.now();
        const completedAt = new Date(completedAtMs).toISOString();
        const outcome: WorkerOutcome = {
          ...classification,
          pid,
          startedAt,
          heartbeatAt: new Date(heartbeatAtMs).toISOString(),
          completedAt,
          durationMs: Math.max(0, completedAtMs - startedAtMs),
          exitCode,
          signal,
          finalResult,
          eventCount,
          malformedEventCount,
          logsTruncated: {
            jsonl: jsonlLog.truncated,
            stderr: stderrLog.truncated,
          },
          paths,
        };
        await writeFile(
          paths.result,
          `${JSON.stringify(finalResult, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        await writeFile(
          paths.outcome,
          `${JSON.stringify(outcome, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        safelyEmit(options.onEvent, {
          type: "worker.completed",
          occurredAt: completedAt,
          outcomeStatus: outcome.status,
          failureCode: outcome.failureCode,
        });
        return outcome;
      };

      void finalize().then(resolve, async (error: unknown) => {
        clearTimeout(wallTimer);
        clearInterval(heartbeatTimer);
        if (forceKillTimer !== null) {
          clearTimeout(forceKillTimer);
        }
        options.signal?.removeEventListener("abort", abort);
        await Promise.allSettled([jsonlLog.close(), stderrLog.close()]);

        const completedAtMs = Date.now();
        const completedAt = new Date(completedAtMs).toISOString();
        const failureMessage =
          error instanceof Error ? error.message : "Worker cleanup failed";
        const outcome: WorkerOutcome = {
          success: false,
          status: "failed",
          failureCode: "runtime_error",
          failureMessage,
          pid,
          startedAt,
          heartbeatAt: new Date(heartbeatAtMs).toISOString(),
          completedAt,
          durationMs: Math.max(0, completedAtMs - startedAtMs),
          exitCode,
          signal,
          finalResult,
          eventCount,
          malformedEventCount,
          logsTruncated: {
            jsonl: jsonlLog.truncated,
            stderr: stderrLog.truncated,
          },
          paths,
        };
        await writeFile(
          paths.result,
          `${JSON.stringify(finalResult, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        ).catch(() => undefined);
        await writeFile(
          paths.outcome,
          `${JSON.stringify(outcome, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        ).catch(() => undefined);
        safelyEmit(options.onEvent, {
          type: "worker.completed",
          occurredAt: completedAt,
          outcomeStatus: outcome.status,
          failureCode: outcome.failureCode,
        });
        resolve(outcome);
      });
    });
  });

  await pipeline(Readable.from([prompt]), child.stdin).catch(() => {
    // A child that disappears before reading stdin is classified on close.
  });

  return {
    pid,
    completion,
    cancel: () => {
      requestStop("cancelled");
    },
  };
}

function inheritedWorkerEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    INHERITED_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = source[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export async function runCodexWorker(
  options: CodexWorkerOptions,
): Promise<WorkerOutcome> {
  const handle = await startCodexWorker(options);
  return handle.completion;
}
