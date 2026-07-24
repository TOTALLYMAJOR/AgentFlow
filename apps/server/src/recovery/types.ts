import type {
  BuildEntity,
  DatabaseRepositories,
  TaskEntity,
  WorkerEntity,
} from "../db/index.js";

export type RecoveryAction =
  | "monitor_existing_process"
  | "mark_interrupted"
  | "resume_validation"
  | "queue_integration"
  | "mark_integrated"
  | "recover_integrated_manifest"
  | "pause_for_review"
  | "no_action";

export interface RecoveryDecision {
  buildId: string;
  taskId: string;
  action: RecoveryAction;
  reason: string;
}

export interface RecoveryHooks {
  isProcessAlive?: (processId: number) => boolean;
  pathExists?: (targetPath: string) => Promise<boolean>;
  commitExists?: (workingDirectory: string, commit: string) => Promise<boolean>;
  monitorExistingProcess?: (
    build: BuildEntity,
    task: TaskEntity,
    worker: WorkerEntity,
  ) => Promise<void> | void;
  resumeValidation?: (
    build: BuildEntity,
    task: TaskEntity,
  ) => Promise<void> | void;
  queueIntegration?: (
    build: BuildEntity,
    task: TaskEntity,
  ) => Promise<void> | void;
  recoveredIntegration?: (
    build: BuildEntity,
    task: TaskEntity,
  ) => Promise<void> | void;
}

export interface RecoveryServiceOptions extends RecoveryHooks {
  store: DatabaseRepositories;
  resolveRepositoryPath: (repositoryId: string) => Promise<string>;
}
