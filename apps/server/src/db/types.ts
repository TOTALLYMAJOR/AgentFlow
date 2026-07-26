import type {
  BuildStatus,
  DetectedStack,
  PlanResult,
  TaskStatus,
} from "../domain/types.js";

export type { BuildStatus, TaskStatus };

export type RepositoryStatus = "ready" | "invalid" | "unavailable";
export type DependencyType = "hard" | "contract" | "artifact" | "runtime";
export type WorkerStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";
export type RunnerStatus = "online" | "offline" | "draining" | "disabled";
export type RunnerTransport = "local" | "remote";
export type RemoteJobStatus =
  | "queued"
  | "leased"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";
export type ArtifactStatus =
  | "produced"
  | "validated"
  | "integrated"
  | "invalidated";
export type ValidationType =
  | "task"
  | "contract"
  | "integration"
  | "browser"
  | "migration";
export type ValidationStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "timed_out";
export type AttemptStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export type ApprovalType =
  | "migration"
  | "security"
  | "shared_architecture"
  | "breaking_contract"
  | "manual";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";
export type TaskManifestStatus = "validated" | "integrated";
export type FileChangeType =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked";

export interface RepositoryEntity {
  id: string;
  name: string;
  localPath: string;
  configPath: string;
  baseBranch: string;
  remoteName: string | null;
  status: RepositoryStatus;
  detectedStack: DetectedStack;
  createdAt: string;
  updatedAt: string;
}
export interface CreateRepositoryInput {
  id: string;
  name: string;
  localPath: string;
  configPath: string;
  baseBranch: string;
  remoteName?: string | null;
  status?: RepositoryStatus;
  detectedStack?: DetectedStack;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateRepositoryInput {
  name?: string;
  configPath?: string;
  baseBranch?: string;
  remoteName?: string | null;
  status?: RepositoryStatus;
  detectedStack?: DetectedStack;
  updatedAt?: string;
}

export interface PlanEntity {
  id: string;
  repositoryId: string;
  backlogPath: string;
  backlogSha256: string;
  backlogContents: string;
  repositoryConfig: Record<string, unknown>;
  normalizedPlan: PlanResult;
  sequentialEstimateHours: number;
  criticalPathHours: number;
  expectedElapsedHours: number;
  expectedSavingsPercent: number;
  maximumTheoreticalConcurrency: number;
  workerEfficiency: number;
  overheadPercent: number;
  lockedAt: string | null;
  createdAt: string;
}

export interface CreatePlanInput {
  id: string;
  repositoryId: string;
  backlogPath: string;
  backlogSha256: string;
  backlogContents: string;
  repositoryConfig?: Record<string, unknown>;
  normalizedPlan: PlanResult;
  sequentialEstimateHours?: number;
  criticalPathHours?: number;
  expectedElapsedHours?: number;
  expectedSavingsPercent?: number;
  maximumTheoreticalConcurrency?: number;
  workerEfficiency?: number;
  overheadPercent?: number;
  createdAt?: string;
}

export interface BuildEntity {
  id: string;
  repositoryId: string;
  planId: string | null;
  backlogPath: string;
  backlogSha256: string | null;
  baseCommit: string;
  integrationBranch: string;
  integrationWorktree: string | null;
  repositoryConfig: Record<string, unknown>;
  backlogContents: string;
  normalizedPlan: Record<string, unknown>;
  status: BuildStatus;
  workerLimit: number;
  sequentialEstimateHours: number | null;
  criticalPathHours: number | null;
  expectedElapsedHours: number | null;
  expectedSavingsPercent: number | null;
  actualElapsedSeconds: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreateBuildInput {
  id: string;
  repositoryId: string;
  planId?: string | null;
  backlogPath: string;
  backlogSha256?: string | null;
  baseCommit: string;
  integrationBranch: string;
  integrationWorktree?: string | null;
  repositoryConfig?: Record<string, unknown>;
  backlogContents?: string;
  normalizedPlan?: Record<string, unknown>;
  status?: BuildStatus;
  workerLimit?: number;
  sequentialEstimateHours?: number | null;
  criticalPathHours?: number | null;
  expectedElapsedHours?: number | null;
  expectedSavingsPercent?: number | null;
  actualElapsedSeconds?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  tasks?: CreateTaskInput[];
}

export interface TaskEntity {
  id: string;
  buildId: string;
  backlogTaskId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  state: TaskStatus;
  branchName: string | null;
  worktreePath: string | null;
  baseCommit: string | null;
  resultCommit: string | null;
  integrationCommit: string | null;
  estimateHours: number | null;
  attempt: number;
  allowNoChanges: boolean;
  riskScore: number;
  requiresApproval: boolean;
  rankingScore: number | null;
  rankingExplanation: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface TaskDependencyInput {
  dependencyTaskId: string;
  dependencyType?: DependencyType;
  requiredArtifactName?: string | null;
  requiredArtifactVersion?: string | null;
}

export interface CreateTaskInput {
  id: string;
  buildId?: string;
  backlogTaskId?: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  state?: TaskStatus;
  branchName?: string | null;
  worktreePath?: string | null;
  baseCommit?: string | null;
  resultCommit?: string | null;
  integrationCommit?: string | null;
  estimateHours?: number | null;
  attempt?: number;
  allowNoChanges?: boolean;
  riskScore?: number;
  requiresApproval?: boolean;
  rankingScore?: number | null;
  rankingExplanation?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
  dependencies?: TaskDependencyInput[];
  ownedPaths?: string[];
  validationCommands?: string[];
}

export interface TaskDependencyEntity {
  taskId: string;
  dependencyTaskId: string;
  dependencyType: DependencyType;
  requiredArtifactName: string | null;
  requiredArtifactVersion: string | null;
}

export interface TaskValidationCommandEntity {
  taskId: string;
  commandOrder: number;
  command: string;
}

export interface WorkerEntity {
  id: string;
  buildId: string;
  taskId: string | null;
  providerId: string;
  runnerId: string | null;
  processId: number | null;
  status: WorkerStatus;
  startedAt: string | null;
  heartbeatAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
}

export interface RunnerEntity {
  id: string;
  name: string;
  providerId: string;
  transport: RunnerTransport;
  status: RunnerStatus;
  capacity: number;
  busySlots: number;
  capabilities: Record<string, string | number | boolean>;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunnerInput {
  id: string;
  name: string;
  providerId: string;
  transport: RunnerTransport;
  status?: RunnerStatus;
  capacity: number;
  busySlots?: number;
  capabilities?: Record<string, string | number | boolean>;
  tokenSha256?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface RemoteJobEntity {
  id: string;
  buildId: string;
  taskId: string;
  attempt: number;
  providerId: string;
  runnerId: string | null;
  status: RemoteJobStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  leaseExpiresAt: string | null;
  queuedAt: string;
  leasedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface QueueRemoteJobInput {
  id: string;
  buildId: string;
  taskId: string;
  attempt: number;
  providerId: string;
  payload: Record<string, unknown>;
  queuedAt?: string;
}

export interface RetryScheduleEntity {
  taskId: string;
  buildId: string;
  failedAttempt: number;
  nextAttempt: number;
  failureCode: string;
  dueAt: string;
  createdAt: string;
}

export type VisualComparisonStatus =
  | "passed"
  | "failed"
  | "dimension_mismatch";

export interface VisualComparisonEntity {
  id: string;
  repositoryId: string;
  buildId: string | null;
  taskId: string | null;
  routeUrl: string;
  baselinePath: string;
  actualPath: string;
  diffPath: string | null;
  width: number;
  height: number;
  differentPixels: number;
  differenceRatio: number;
  maximumDifferenceRatio: number;
  status: VisualComparisonStatus;
  createdAt: string;
}

export interface KnowledgeNodeEntity {
  path: string;
  kind: "source" | "test" | "config" | "document";
  sha256: string;
}

export interface KnowledgeEdgeEntity {
  sourcePath: string;
  targetPath: string;
  edgeType: "imports";
}

export interface KnowledgeSnapshotEntity {
  id: string;
  repositoryId: string;
  baseCommit: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
}

export interface CreateWorkerInput {
  id: string;
  buildId: string;
  taskId?: string | null;
  providerId?: string;
  runnerId?: string | null;
  processId?: number | null;
  status?: WorkerStatus;
  startedAt?: string | null;
  heartbeatAt?: string | null;
  stoppedAt?: string | null;
  createdAt?: string;
}

export interface ArtifactEntity {
  id: string;
  buildId: string;
  producerTaskId: string;
  name: string;
  artifactType: string;
  version: string;
  repositoryPath: string | null;
  storagePath: string | null;
  sha256: string | null;
  status: ArtifactStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  integratedAt: string | null;
}

export interface PublishArtifactInput {
  id: string;
  buildId: string;
  producerTaskId: string;
  name: string;
  artifactType: string;
  version: string;
  repositoryPath?: string | null;
  storagePath?: string | null;
  sha256?: string | null;
  status?: ArtifactStatus;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  integratedAt?: string | null;
}

export interface ValidationRunEntity {
  id: string;
  buildId: string;
  taskId: string | null;
  validationType: ValidationType;
  command: string;
  exitCode: number | null;
  status: ValidationStatus;
  logPath: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreateValidationRunInput {
  id: string;
  buildId: string;
  taskId?: string | null;
  validationType: ValidationType;
  command: string;
  exitCode?: number | null;
  status?: ValidationStatus;
  logPath?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
}

export interface BuildEventEntity {
  sequence: number;
  buildId: string;
  taskId: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface AppendBuildEventInput {
  buildId: string;
  taskId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
}

export interface TaskAttemptEntity {
  id: string;
  taskId: string;
  buildId: string;
  attempt: number;
  workerId: string | null;
  status: AttemptStatus;
  promptPath: string | null;
  jsonlPath: string | null;
  logPath: string | null;
  resultCommit: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreateTaskAttemptInput {
  id: string;
  taskId: string;
  buildId: string;
  attempt: number;
  workerId?: string | null;
  status?: AttemptStatus;
  promptPath?: string | null;
  jsonlPath?: string | null;
  logPath?: string | null;
  resultCommit?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
}

export interface ChangedFileEntity {
  taskId: string;
  attempt: number;
  path: string;
  changeType: FileChangeType;
  previousPath: string | null;
  withinOwnership: boolean;
  sha256: string | null;
}

export interface RecordChangedFileInput {
  path: string;
  changeType: FileChangeType;
  previousPath?: string | null;
  withinOwnership: boolean;
  sha256?: string | null;
}

export interface ApprovalEntity {
  id: string;
  buildId: string;
  taskId: string | null;
  approvalType: ApprovalType;
  status: ApprovalStatus;
  reason: string;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

export interface CreateApprovalInput {
  id: string;
  buildId: string;
  taskId?: string | null;
  approvalType: ApprovalType;
  status?: ApprovalStatus;
  reason: string;
  requestedAt?: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
  decisionNote?: string | null;
}

export interface TaskManifestEntity {
  id: string;
  buildId: string;
  taskId: string;
  attempt: number;
  status: TaskManifestStatus;
  schemaVersion: string;
  manifestPath: string;
  sha256: string;
  manifest: Record<string, unknown>;
  createdAt: string;
}

export interface CreateTaskManifestInput {
  id: string;
  buildId: string;
  taskId: string;
  attempt: number;
  status: TaskManifestStatus;
  schemaVersion: string;
  manifestPath: string;
  sha256: string;
  manifest: Record<string, unknown>;
  createdAt?: string;
}
