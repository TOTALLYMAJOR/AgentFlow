import type { FileChangeType } from "../db/types.js";

export type ValidationProcessStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error";

export interface ValidationOutputEvent {
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface ValidationProcessOptions {
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string | undefined>>;
  additionalEnvironmentKeys?: readonly string[];
  secrets?: readonly string[];
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  onOutput?: (event: ValidationOutputEvent) => void;
  onSpawn?: (processId: number) => void;
}

export interface ValidationProcessResult {
  argv: string[];
  command: string;
  status: ValidationProcessStatus;
  processId: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: string | null;
}

export interface ValidationCommandDefinition {
  argv: readonly string[];
  required?: boolean;
  timeoutMs?: number;
  label?: string;
}

export type ValidationCommandInput =
  | string
  | readonly string[]
  | ValidationCommandDefinition;

export interface NormalizedValidationCommand {
  argv: string[];
  required: boolean;
  timeoutMs: number | null;
  label: string | null;
}

export interface ValidationCommandOutcome
  extends ValidationProcessResult {
  index: number;
  required: boolean;
  label: string | null;
}

export interface GitChangedFile {
  path: string;
  changeType: FileChangeType;
  previousPath: string | null;
}

export type OwnershipViolationReason =
  | "outside_ownership"
  | "forbidden_path";

export interface OwnershipViolation {
  path: string;
  changePath: string;
  previousPath: string | null;
  reason: OwnershipViolationReason;
}

export interface EvaluatedChangedFile extends GitChangedFile {
  withinOwnership: boolean;
}

export interface OwnershipEvaluation {
  passed: boolean;
  ownedRoots: string[];
  forbiddenRoots: string[];
  changedFiles: EvaluatedChangedFile[];
  violations: OwnershipViolation[];
}

export interface ComposeValidationOptions {
  enabled: boolean;
  composeFile?: string;
  cleanup?: boolean;
  removeVolumes?: boolean;
}

export type TaskValidationStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled";

export type TaskValidationErrorCode =
  | "WORKER_NOT_SUCCESSFUL"
  | "OWNERSHIP_VIOLATION"
  | "NO_CHANGES"
  | "VALIDATION_COMMANDS_MISSING"
  | "VALIDATION_COMMAND_INVALID"
  | "VALIDATION_COMMAND_FAILED"
  | "VALIDATION_TIMED_OUT"
  | "VALIDATION_CANCELLED"
  | "VALIDATION_SPAWN_FAILED"
  | "COMPOSE_CLEANUP_FAILED"
  | "CHANGE_INSPECTION_FAILED";

export interface TaskValidationOutputEvent extends ValidationOutputEvent {
  commandIndex: number;
  command: string;
  phase: "validation" | "compose_cleanup";
}

export interface TaskValidationInput {
  buildId: string;
  taskId: string;
  attempt: number;
  worktreePath: string;
  baseCommit: string;
  ownedPaths: readonly string[];
  commands: readonly ValidationCommandInput[];
  workerCompletedSuccessfully: boolean;
  allowNoChanges?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string | undefined>>;
  additionalEnvironmentKeys?: readonly string[];
  secrets?: readonly string[];
  forbiddenPaths?: readonly string[];
  compose?: ComposeValidationOptions;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  onOutput?: (event: TaskValidationOutputEvent) => void;
}

export interface TaskValidationSummary {
  buildId: string;
  taskId: string;
  attempt: number;
  status: TaskValidationStatus;
  errorCode: TaskValidationErrorCode | null;
  errorMessage: string | null;
  workerCompletedSuccessfully: boolean;
  ownership: OwnershipEvaluation;
  changesRequiredSatisfied: boolean;
  requiredCommandsPassed: boolean;
  optionalFailures: number;
  readyForCommit: boolean;
  composeProjectName: string;
  commands: ValidationCommandOutcome[];
  composeCleanup: ValidationCommandOutcome | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}
