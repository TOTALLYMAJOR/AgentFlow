import type {
  ValidationCommandInput,
  ValidationCommandOutcome,
} from "../validation/index.js";

export type IntegrationValidationStatus =
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface IntegrationValidationRequest {
  buildId: string;
  taskId: string;
  worktreePath: string;
  commands: readonly ValidationCommandInput[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface IntegrationValidationSummary {
  status: IntegrationValidationStatus;
  commands: ValidationCommandOutcome[];
  errorMessage: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface IntegrationValidationRunner {
  run(
    request: IntegrationValidationRequest,
  ): Promise<IntegrationValidationSummary>;
}

export interface IntegrationPushOptions {
  remote?: string;
  taskBranch?: boolean;
  integrationBranch?: boolean;
}

export interface IntegrateTaskInput {
  taskId: string;
  validationCommands?: readonly ValidationCommandInput[];
  validationTimeoutMs?: number;
  signal?: AbortSignal;
  onValidationCompleted?: (
    summary: IntegrationValidationSummary,
  ) => void | Promise<void>;
  push?: IntegrationPushOptions;
}

export type IntegrationResultStatus =
  | "integrated"
  | "cancelled"
  | "merge_conflict"
  | "merge_failed"
  | "validation_failed"
  | "rollback_failed"
  | "persistence_failed";

export interface IntegrationPushResult {
  branch: string;
  attempted: boolean;
  succeeded: boolean;
  error: string | null;
}

export interface IntegrationResult {
  buildId: string;
  taskId: string;
  status: IntegrationResultStatus;
  previousHead: string;
  integrationCommit: string | null;
  mergePerformed: boolean;
  conflictPaths: string[];
  validation: IntegrationValidationSummary | null;
  releasedTaskIds: string[];
  pushes: {
    task: IntegrationPushResult;
    integration: IntegrationPushResult;
  };
  errorCode: string | null;
  errorMessage: string | null;
}

export type IntegrationCompletion = IntegrationResult;

export interface IntegrationGitMergeResult {
  previousHead: string;
  integrationCommit: string;
}

export interface IntegrationGitReadyInput {
  integrationBranch: string;
  taskBranch: string;
  expectedTaskCommit: string;
}

export interface IntegrationGitRuntime {
  readonly integrationPath: string;
  verifyReady(input: IntegrationGitReadyInput): Promise<string>;
  merge(taskBranch: string, previousHead: string): Promise<IntegrationGitMergeResult>;
  abortMerge(): Promise<void>;
  resetAndClean(commit: string): Promise<void>;
  push(remote: string, branch: string): Promise<void>;
}
