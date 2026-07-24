import type {
  OwnershipConflict,
  PlanEstimates,
  PlannedTask,
} from "../domain/types.js";

export const PLANNING_ERROR_CODES = [
  "NO_TASKS",
  "MISSING_TASK_TITLE",
  "MISSING_YAML_METADATA",
  "INVALID_YAML",
  "INVALID_METADATA",
  "INVALID_METADATA_FIELD",
  "DUPLICATE_TASK_ID",
  "MISSING_DEPENDENCY",
  "SELF_DEPENDENCY",
  "DEPENDENCY_CYCLE",
  "MISSING_ACCEPTANCE_CRITERIA",
  "INVALID_ESTIMATE",
  "EMPTY_OWNERSHIP",
  "INVALID_OWNERSHIP_PATH",
  "FORBIDDEN_OWNERSHIP_PATH",
  "MISSING_VALIDATION",
  "INVALID_VALIDATION_COMMAND",
  "INVALID_ARTIFACT",
  "ARTIFACT_VERSION_REQUIRED",
  "ARTIFACT_VERSION_NOT_EXACT",
  "ARTIFACT_PRODUCER_MISSING",
  "ARTIFACT_PRODUCER_NOT_DEPENDENCY",
  "ARTIFACT_NOT_PRODUCED",
  "ARTIFACT_VERSION_MISMATCH",
  "DUPLICATE_PRODUCED_ARTIFACT",
  "INVALID_WORKER_MAXIMUM",
  "INVALID_WORKER_EFFICIENCY",
  "INVALID_OVERHEAD_PERCENT",
] as const;

export type PlanningErrorCode = (typeof PLANNING_ERROR_CODES)[number];

export interface PlanningValidationError {
  code: PlanningErrorCode;
  message: string;
  taskId?: string;
  field?: string;
  line?: number;
  relatedTaskId?: string;
  cycle?: string[];
}

export interface BacklogParserOptions {
  defaultValidation?: readonly string[];
}

export interface PlanningOptions extends BacklogParserOptions {
  workerMaximum?: number;
  workerEfficiency?: number;
  overheadPercent?: number;
}

export interface ParsedBacklog {
  tasks: PlannedTask[];
  errors: PlanningValidationError[];
}

export interface BacklogPlan {
  tasks: PlannedTask[];
  waves: string[][];
  ownershipConflicts: OwnershipConflict[];
  estimates: PlanEstimates;
}

export interface BacklogPlanResult extends ParsedBacklog {
  valid: boolean;
  plan?: BacklogPlan;
}

export interface ResolvedPlanningOptions {
  defaultValidation: string[];
  workerMaximum: number;
  workerEfficiency: number;
  overheadPercent: number;
}

export const DEFAULT_PLANNING_OPTIONS: Readonly<
  Omit<ResolvedPlanningOptions, "defaultValidation">
> = Object.freeze({
  workerMaximum: 4,
  workerEfficiency: 0.85,
  overheadPercent: 10,
});

export class BacklogPlanningError extends Error {
  readonly errors: PlanningValidationError[];

  constructor(errors: readonly PlanningValidationError[]) {
    super(
      errors.length === 1
        ? errors[0]?.message
        : `Backlog planning failed with ${errors.length} validation errors`,
    );
    this.name = "BacklogPlanningError";
    this.errors = [...errors];
  }
}
