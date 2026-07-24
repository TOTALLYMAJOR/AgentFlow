import type {
  PlanningErrorCode,
  PlanningValidationError,
} from "./types.js";

export interface ErrorDetails {
  taskId?: string;
  field?: string;
  line?: number;
  relatedTaskId?: string;
  cycle?: string[];
}

export function planningError(
  code: PlanningErrorCode,
  message: string,
  details: ErrorDetails = {},
): PlanningValidationError {
  return {
    code,
    message,
    ...(details.taskId === undefined ? {} : { taskId: details.taskId }),
    ...(details.field === undefined ? {} : { field: details.field }),
    ...(details.line === undefined ? {} : { line: details.line }),
    ...(details.relatedTaskId === undefined
      ? {}
      : { relatedTaskId: details.relatedTaskId }),
    ...(details.cycle === undefined ? {} : { cycle: details.cycle }),
  };
}

export function uniquePlanningErrors(
  errors: readonly PlanningValidationError[],
): PlanningValidationError[] {
  const seen = new Set<string>();
  const unique: PlanningValidationError[] = [];

  for (const error of errors) {
    const key = JSON.stringify([
      error.code,
      error.taskId,
      error.field,
      error.relatedTaskId,
      error.message,
      error.cycle,
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(error);
  }

  return unique;
}
