import { createHash } from "node:crypto";

import {
  formatArgv,
  normalizeValidationCommand,
  ValidationCommandError,
} from "./command.js";
import {
  collectGitChanges,
  GitChangeInspectionError,
  normalizeRepositoryPath,
} from "./git-changes.js";
import { evaluateChangedFileOwnership } from "./ownership.js";
import { runValidationProcess } from "./process-runner.js";
import { redactSecrets } from "./redaction.js";
import type {
  NormalizedValidationCommand,
  OwnershipEvaluation,
  TaskValidationErrorCode,
  TaskValidationInput,
  TaskValidationOutputEvent,
  TaskValidationStatus,
  TaskValidationSummary,
  ValidationCommandOutcome,
} from "./types.js";

const DEFAULT_VALIDATION_TIMEOUT_MS = 15 * 60 * 1_000;

export function createComposeProjectName(
  buildId: string,
  taskId: string,
  attempt: number,
): string {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RangeError("Compose project attempt must be a non-negative integer");
  }
  const identity = `${buildId}\0${taskId}\0${attempt}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 10);
  const unboundedSlug =
    `${buildId}-${taskId}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^[-_]+|[-_]+$/gu, "") || "build-task";
  const prefix = "agentflow-";
  const suffix = `-${attempt}-${digest}`;
  const maximumSlugLength = Math.max(
    1,
    63 - prefix.length - suffix.length,
  );
  return `${prefix}${unboundedSlug.slice(0, maximumSlugLength)}${suffix}`;
}

export async function validateTask(
  input: TaskValidationInput,
): Promise<TaskValidationSummary> {
  const startedAt = new Date();
  const startedMonotonic = performance.now();
  const composeProjectName = createComposeProjectName(
    input.buildId,
    input.taskId,
    input.attempt,
  );
  let ownership: OwnershipEvaluation;

  try {
    const changes = await collectGitChanges(
      input.worktreePath,
      input.baseCommit,
      input.signal,
    );
    ownership = evaluateChangedFileOwnership(
      changes,
      input.ownedPaths,
      input.forbiddenPaths,
    );
  } catch (error) {
    const emptyOwnership = evaluateChangedFileOwnership(
      [],
      input.ownedPaths,
      input.forbiddenPaths,
    );
    if (input.signal?.aborted === true) {
      return completeSummary({
        input,
        startedAt,
        startedMonotonic,
        composeProjectName,
        ownership: emptyOwnership,
        status: "cancelled",
        errorCode: "VALIDATION_CANCELLED",
        errorMessage: "Task validation was cancelled during change inspection",
      });
    }
    return completeSummary({
      input,
      startedAt,
      startedMonotonic,
      composeProjectName,
      ownership: emptyOwnership,
      status: "failed",
      errorCode: "CHANGE_INSPECTION_FAILED",
      errorMessage:
        error instanceof GitChangeInspectionError
          ? error.message
          : `Could not inspect task changes: ${errorMessage(error)}`,
    });
  }

  let changesRequiredSatisfied =
    ownership.changedFiles.length > 0 || input.allowNoChanges === true;

  if (!input.workerCompletedSuccessfully) {
    return completeSummary({
      input,
      startedAt,
      startedMonotonic,
      composeProjectName,
      ownership,
      changesRequiredSatisfied,
      status: "failed",
      errorCode: "WORKER_NOT_SUCCESSFUL",
      errorMessage: "Worker completion was not successful",
    });
  }

  if (!ownership.passed) {
    return completeSummary({
      input,
      startedAt,
      startedMonotonic,
      composeProjectName,
      ownership,
      changesRequiredSatisfied,
      status: "failed",
      errorCode: "OWNERSHIP_VIOLATION",
      errorMessage: `${ownership.violations.length} changed path${
        ownership.violations.length === 1 ? " is" : "s are"
      } outside task ownership or forbidden`,
    });
  }

  if (!changesRequiredSatisfied) {
    return completeSummary({
      input,
      startedAt,
      startedMonotonic,
      composeProjectName,
      ownership,
      changesRequiredSatisfied,
      status: "failed",
      errorCode: "NO_CHANGES",
      errorMessage:
        "The worker produced no changes and allow_no_changes is false",
    });
  }

  if (input.commands.length === 0) {
    return completeSummary({
      input,
      startedAt,
      startedMonotonic,
      composeProjectName,
      ownership,
      changesRequiredSatisfied,
      status: "failed",
      errorCode: "VALIDATION_COMMANDS_MISSING",
      errorMessage: "Task validation requires at least one command",
    });
  }

  let commands: NormalizedValidationCommand[];
  try {
    commands = input.commands.map(normalizeValidationCommand);
  } catch (error) {
    return completeSummary({
      input,
      startedAt,
      startedMonotonic,
      composeProjectName,
      ownership,
      changesRequiredSatisfied,
      status: "failed",
      errorCode: "VALIDATION_COMMAND_INVALID",
      errorMessage:
        error instanceof ValidationCommandError
          ? error.message
          : `Invalid validation command: ${errorMessage(error)}`,
    });
  }

  const defaultTimeoutMs = input.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
  assertPositiveInteger(defaultTimeoutMs, "Task validation timeout");
  const commandOutcomes: ValidationCommandOutcome[] = [];
  let blockingOutcome: ValidationCommandOutcome | null = null;
  let optionalFailures = 0;

  for (const [index, command] of commands.entries()) {
    const outcome = await runCommand(
      input,
      command,
      index,
      defaultTimeoutMs,
      composeProjectName,
      "validation",
    );
    commandOutcomes.push(outcome);

    if (outcome.status === "passed") {
      continue;
    }
    if (outcome.status === "cancelled") {
      blockingOutcome = outcome;
      break;
    }
    if (command.required) {
      blockingOutcome = outcome;
      break;
    }
    optionalFailures += 1;
  }

  const composeCleanup =
    input.compose?.enabled === true &&
    input.compose.cleanup !== false &&
    commandOutcomes.length > 0
      ? await runComposeCleanup(
          input,
          composeProjectName,
          commands.length,
          defaultTimeoutMs,
        )
      : null;

  if (
    blockingOutcome === null &&
    (composeCleanup === null || composeCleanup.status === "passed")
  ) {
    try {
      const finalChanges = await collectGitChanges(
        input.worktreePath,
        input.baseCommit,
      );
      ownership = evaluateChangedFileOwnership(
        finalChanges,
        input.ownedPaths,
        input.forbiddenPaths,
      );
      if (!ownership.passed) {
        return completeSummary({
          input,
          startedAt,
          startedMonotonic,
          composeProjectName,
          ownership,
          changesRequiredSatisfied,
          status: "failed",
          errorCode: "OWNERSHIP_VIOLATION",
          errorMessage:
            "Validation produced changes outside task ownership or in a forbidden path",
          requiredCommandsPassed: false,
          optionalFailures,
          commands: commandOutcomes,
          composeCleanup,
        });
      }
      changesRequiredSatisfied =
        finalChanges.length > 0 || input.allowNoChanges === true;
      if (!changesRequiredSatisfied) {
        return completeSummary({
          input,
          startedAt,
          startedMonotonic,
          composeProjectName,
          ownership,
          changesRequiredSatisfied,
          status: "failed",
          errorCode: "NO_CHANGES",
          errorMessage:
            "Validation left no task changes and allow_no_changes is false",
          requiredCommandsPassed: false,
          optionalFailures,
          commands: commandOutcomes,
          composeCleanup,
        });
      }
    } catch (error) {
      if (input.signal?.aborted === true) {
        return completeSummary({
          input,
          startedAt,
          startedMonotonic,
          composeProjectName,
          ownership,
          changesRequiredSatisfied,
          status: "cancelled",
          errorCode: "VALIDATION_CANCELLED",
          errorMessage:
            "Task validation was cancelled during final change inspection",
          requiredCommandsPassed: false,
          optionalFailures,
          commands: commandOutcomes,
          composeCleanup,
        });
      }
      return completeSummary({
        input,
        startedAt,
        startedMonotonic,
        composeProjectName,
        ownership,
        changesRequiredSatisfied,
        status: "failed",
        errorCode: "CHANGE_INSPECTION_FAILED",
        errorMessage: `Could not inspect final task changes: ${errorMessage(
          error,
        )}`,
        requiredCommandsPassed: false,
        optionalFailures,
        commands: commandOutcomes,
        composeCleanup,
      });
    }
  }

  let status: TaskValidationStatus = "passed";
  let errorCode: TaskValidationErrorCode | null = null;
  let errorMessageValue: string | null = null;

  if (blockingOutcome !== null) {
    const classified = classifyCommandFailure(blockingOutcome);
    status = classified.status;
    errorCode = classified.errorCode;
    errorMessageValue = classified.errorMessage;
  } else if (composeCleanup !== null && composeCleanup.status !== "passed") {
    status =
      composeCleanup.status === "timed_out"
        ? "timed_out"
        : composeCleanup.status === "cancelled"
          ? "cancelled"
          : "failed";
    errorCode = "COMPOSE_CLEANUP_FAILED";
    errorMessageValue = `Compose cleanup failed: ${commandFailureDetail(
      composeCleanup,
    )}`;
  }

  const requiredCommandsPassed = commandOutcomes
    .filter((outcome) => outcome.required)
    .every((outcome) => outcome.status === "passed");

  return completeSummary({
    input,
    startedAt,
    startedMonotonic,
    composeProjectName,
    ownership,
    changesRequiredSatisfied,
    status,
    errorCode,
    errorMessage: errorMessageValue,
    requiredCommandsPassed,
    optionalFailures,
    commands: commandOutcomes,
    composeCleanup,
  });
}

async function runCommand(
  input: TaskValidationInput,
  command: NormalizedValidationCommand,
  index: number,
  defaultTimeoutMs: number,
  composeProjectName: string,
  phase: TaskValidationOutputEvent["phase"],
  includeCancellationSignal = true,
): Promise<ValidationCommandOutcome> {
  const environment = {
    ...(input.environment ?? {}),
    COMPOSE_PROJECT_NAME: composeProjectName,
  };
  const result = await runValidationProcess({
    argv: command.argv,
    cwd: input.worktreePath,
    timeoutMs: command.timeoutMs ?? defaultTimeoutMs,
    ...(includeCancellationSignal && input.signal !== undefined
      ? { signal: input.signal }
      : {}),
    environment,
    ...(input.additionalEnvironmentKeys === undefined
      ? {}
      : { additionalEnvironmentKeys: input.additionalEnvironmentKeys }),
    ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
    ...(input.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: input.maxOutputBytes }),
    ...(input.terminationGraceMs === undefined
      ? {}
      : { terminationGraceMs: input.terminationGraceMs }),
    ...(input.onOutput === undefined
      ? {}
      : {
          onOutput: (event) => {
            input.onOutput?.({
              ...event,
              commandIndex: index,
              command: redactSecrets(
                command.label ?? formatArgv(command.argv),
                input.secrets ?? [],
              ),
              phase,
            });
          },
        }),
  });
  return {
    ...result,
    index,
    required: command.required,
    label: command.label,
  };
}

async function runComposeCleanup(
  input: TaskValidationInput,
  composeProjectName: string,
  index: number,
  defaultTimeoutMs: number,
): Promise<ValidationCommandOutcome> {
  const compose = input.compose;
  if (compose === undefined) {
    throw new Error("Compose cleanup requires Compose options");
  }
  const argv = ["docker", "compose"];
  if (compose.composeFile !== undefined) {
    argv.push("-f", normalizeRepositoryPath(compose.composeFile));
  }
  argv.push("-p", composeProjectName, "down", "--remove-orphans");
  if (compose.removeVolumes === true) {
    argv.push("--volumes");
  }
  return runCommand(
    input,
    {
      argv,
      required: true,
      timeoutMs: defaultTimeoutMs,
      label: "Compose cleanup",
    },
    index,
    defaultTimeoutMs,
    composeProjectName,
    "compose_cleanup",
    false,
  );
}

interface CompleteSummaryInput {
  input: TaskValidationInput;
  startedAt: Date;
  startedMonotonic: number;
  composeProjectName: string;
  ownership: OwnershipEvaluation;
  status: TaskValidationStatus;
  errorCode: TaskValidationErrorCode | null;
  errorMessage: string | null;
  changesRequiredSatisfied?: boolean;
  requiredCommandsPassed?: boolean;
  optionalFailures?: number;
  commands?: ValidationCommandOutcome[];
  composeCleanup?: ValidationCommandOutcome | null;
}

function completeSummary(options: CompleteSummaryInput): TaskValidationSummary {
  const completedAt = new Date();
  const requiredCommandsPassed = options.requiredCommandsPassed ?? false;
  const changesRequiredSatisfied =
    options.changesRequiredSatisfied ?? false;
  const composeCleanupPassed =
    options.composeCleanup === undefined ||
    options.composeCleanup === null ||
    options.composeCleanup.status === "passed";
  return {
    buildId: options.input.buildId,
    taskId: options.input.taskId,
    attempt: options.input.attempt,
    status: options.status,
    errorCode: options.errorCode,
    errorMessage:
      options.errorMessage === null
        ? null
        : redactSecrets(options.errorMessage, options.input.secrets ?? []),
    workerCompletedSuccessfully:
      options.input.workerCompletedSuccessfully,
    ownership: options.ownership,
    changesRequiredSatisfied,
    requiredCommandsPassed,
    optionalFailures: options.optionalFailures ?? 0,
    readyForCommit:
      options.status === "passed" &&
      options.input.workerCompletedSuccessfully &&
      options.ownership.passed &&
      changesRequiredSatisfied &&
      requiredCommandsPassed &&
      composeCleanupPassed,
    composeProjectName: options.composeProjectName,
    commands: options.commands ?? [],
    composeCleanup: options.composeCleanup ?? null,
    startedAt: options.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(
      0,
      Math.round(performance.now() - options.startedMonotonic),
    ),
  };
}

function classifyCommandFailure(outcome: ValidationCommandOutcome): {
  status: TaskValidationStatus;
  errorCode: TaskValidationErrorCode;
  errorMessage: string;
} {
  switch (outcome.status) {
    case "timed_out":
      return {
        status: "timed_out",
        errorCode: "VALIDATION_TIMED_OUT",
        errorMessage: `Validation command timed out: ${outcome.command}`,
      };
    case "cancelled":
      return {
        status: "cancelled",
        errorCode: "VALIDATION_CANCELLED",
        errorMessage: `Validation command was cancelled: ${outcome.command}`,
      };
    case "spawn_error":
      return {
        status: "failed",
        errorCode: "VALIDATION_SPAWN_FAILED",
        errorMessage: `Validation command could not start: ${commandFailureDetail(
          outcome,
        )}`,
      };
    case "failed":
      return {
        status: "failed",
        errorCode: "VALIDATION_COMMAND_FAILED",
        errorMessage: `Validation command failed: ${commandFailureDetail(
          outcome,
        )}`,
      };
    case "passed":
      throw new Error("Cannot classify a passed validation command");
  }
}

function commandFailureDetail(outcome: ValidationCommandOutcome): string {
  return (
    outcome.error ||
    outcome.stderr.trim() ||
    `${outcome.command} exited with ${outcome.exitCode ?? "no exit code"}`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}
