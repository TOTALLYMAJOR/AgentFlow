import { performance } from "node:perf_hooks";

import {
  normalizeValidationCommand,
  runValidationProcess,
} from "../validation/index.js";

import type {
  IntegrationValidationRequest,
  IntegrationValidationRunner,
  IntegrationValidationStatus,
  IntegrationValidationSummary,
} from "./types.js";
import type { ValidationCommandOutcome } from "../validation/index.js";

const DEFAULT_INTEGRATION_TIMEOUT_MS = 15 * 60 * 1_000;

export class ProcessIntegrationValidationRunner
  implements IntegrationValidationRunner
{
  public async run(
    request: IntegrationValidationRequest,
  ): Promise<IntegrationValidationSummary> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const commands: ValidationCommandOutcome[] = [];
    let status: IntegrationValidationStatus = "passed";
    let errorMessage: string | null = null;

    if (isAbortRequested(request.signal)) {
      return {
        status: "cancelled",
        commands,
        errorMessage: "Integration validation was cancelled",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, performance.now() - started),
      };
    }
    for (const [index, definition] of request.commands.entries()) {
      const command = normalizeValidationCommand(definition);
      const result = await runValidationProcess({
        argv: command.argv,
        cwd: request.worktreePath,
        timeoutMs:
          command.timeoutMs ??
          request.timeoutMs ??
          DEFAULT_INTEGRATION_TIMEOUT_MS,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const outcome: ValidationCommandOutcome = {
        ...result,
        index,
        required: command.required,
        label: command.label,
      };
      commands.push(outcome);

      if (outcome.status === "passed" || !outcome.required) {
        continue;
      }
      status = mapStatus(outcome.status);
      errorMessage =
        outcome.stderr.trim() ||
        outcome.error ||
        `${outcome.command} exited with ${outcome.exitCode ?? "no exit code"}`;
      break;
    }
    if (isAbortRequested(request.signal) && status === "passed") {
      status = "cancelled";
      errorMessage = "Integration validation was cancelled";
    }

    return {
      status,
      commands,
      errorMessage,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, performance.now() - started),
    };
  }
}

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function mapStatus(
  status: ValidationCommandOutcome["status"],
): IntegrationValidationStatus {
  if (status === "timed_out" || status === "cancelled") {
    return status;
  }
  return status === "passed" ? "passed" : "failed";
}
