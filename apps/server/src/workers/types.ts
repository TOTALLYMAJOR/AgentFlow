export type WorkerResultStatus = "completed" | "blocked" | "failed";

export interface WorkerStructuredResult {
  status: WorkerResultStatus;
  summary: string;
  validation_notes: string[];
  handoff_notes: string[];
  risks?: string[];
}

export interface WorkerContextDocument {
  name: string;
  version?: string;
  sourcePath?: string;
  sha256?: string;
  content: unknown;
}

export interface WorkerPromptContext {
  buildId: string;
  attempt: number;
  task: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    ownedPaths: string[];
    validationCommands: string[];
  };
  repositoryInstructions: string;
  previousAttempt?: WorkerContextDocument;
  dependencyManifests: WorkerContextDocument[];
  consumedContracts: WorkerContextDocument[];
  consumedArtifacts: WorkerContextDocument[];
  examplePayloads: WorkerContextDocument[];
}

export type WorkerRuntimeEvent =
  | {
      type: "worker.started";
      occurredAt: string;
      pid: number;
      command: string;
      arguments: string[];
    }
  | {
      type: "worker.jsonl";
      occurredAt: string;
      raw: string;
      value: unknown;
    }
  | {
      type: "worker.jsonl_malformed";
      occurredAt: string;
      raw: string;
      error: string;
    }
  | {
      type: "worker.stderr";
      occurredAt: string;
      text: string;
    }
  | {
      type: "worker.heartbeat";
      occurredAt: string;
      pid: number;
      reason: "activity" | "interval";
    }
  | {
      type: "worker.stopping";
      occurredAt: string;
      pid: number;
      reason: WorkerTerminationReason;
    }
  | {
      type: "worker.completed";
      occurredAt: string;
      outcomeStatus: WorkerOutcomeStatus;
      failureCode: WorkerFailureCode | null;
    };

export type WorkerTerminationReason =
  | "cancelled"
  | "timeout"
  | "idle_timeout";

export type WorkerOutcomeStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "idle_timed_out"
  | "process_disappeared";

export type WorkerFailureCode =
  | "runtime_error"
  | "spawn_error"
  | "process_exit_nonzero"
  | "process_disappeared"
  | "structured_result_missing"
  | "structured_result_invalid"
  | "worker_reported_blocked"
  | "worker_reported_failed"
  | "cancelled"
  | "timeout"
  | "idle_timeout";

export interface WorkerLogPaths {
  attemptDirectory: string;
  prompt: string;
  jsonl: string;
  stderr: string;
  resultSchema: string;
  result: string;
  outcome: string;
}

export interface WorkerOutcome {
  success: boolean;
  status: WorkerOutcomeStatus;
  failureCode: WorkerFailureCode | null;
  failureMessage: string | null;
  pid: number | null;
  startedAt: string;
  heartbeatAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finalResult: WorkerStructuredResult | null;
  eventCount: number;
  malformedEventCount: number;
  logsTruncated: {
    jsonl: boolean;
    stderr: boolean;
  };
  paths: WorkerLogPaths;
}

export interface WorkerHeartbeat {
  pid: number;
  occurredAt: string;
  reason: "activity" | "interval";
}

export interface CodexWorkerOptions {
  executable?: string;
  additionalArguments?: string[];
  worktreePath: string;
  attemptDirectory: string;
  prompt: WorkerPromptContext;
  environment?: NodeJS.ProcessEnv;
  secrets?: string[];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  terminationGraceMs?: number;
  maximumLogBytes?: number;
  maximumJsonlLineBytes?: number;
  maximumPromptBytes?: number;
  signal?: AbortSignal;
  onStarted?: (pid: number, startedAt: string) => void;
  onHeartbeat?: (heartbeat: WorkerHeartbeat) => void;
  onEvent?: (event: WorkerRuntimeEvent) => void;
}

export interface CodexWorkerHandle {
  readonly pid: number | null;
  readonly completion: Promise<WorkerOutcome>;
  cancel: () => void;
}
