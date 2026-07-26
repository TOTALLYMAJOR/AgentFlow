export type ScreenId =
  | "overview"
  | "repositories"
  | "planner"
  | "build"
  | "results";

export interface HealthResponse {
  status: "ok";
  version: string;
  host: string;
  database: {
    status: "ok" | "degraded";
    journalMode: string;
  };
  activeBuildId: string | null;
  activeBuildIds: string[];
  resources: {
    workerCapacity: number;
    busyWorkers: number;
    availableWorkers: number;
  };
  agentProviders: {
    default: string;
    configured: Array<{
      id: string;
      execution: "local";
    }>;
  };
  runners: {
    total: number;
    online: number;
    availableSlots: number;
  };
  remoteJobs: {
    queued: number;
    leased: number;
    completed: number;
    failed: number;
    expired: number;
  };
  retries: {
    pending: number;
    maximumAttempts: number;
    baseDelayMs: number;
    maximumDelayMs: number;
  };
  uptimeSeconds: number;
}

export interface RepositorySummary {
  id: string;
  name: string;
  localPath: string;
  configPath?: string;
  baseBranch: string;
  remoteName?: string | null;
  status: "ready" | "invalid" | "unavailable";
  detectedStack: {
    packageManager?: string;
    frameworks: string[];
    monorepo: boolean;
    scripts?: string[];
    composeFiles?: string[];
    commonRoots?: string[];
  };
  createdAt?: string;
  updatedAt: string;
}

export interface TaskSummary {
  id: string;
  buildId?: string;
  backlogTaskId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  state: string;
  attempt: number;
  estimateHours: number | null;
  branchName: string | null;
  worktreePath?: string | null;
  baseCommit?: string | null;
  resultCommit?: string | null;
  integrationCommit?: string | null;
  workerId: string | null;
  allowNoChanges?: boolean;
  riskScore?: number;
  requiresApproval?: boolean;
  rankingScore?: number | null;
  rankingExplanation?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt?: string;
}

export interface WorkerSummary {
  id: string;
  slot: number;
  status: string;
  taskId: string | null;
  processId?: number | null;
  startedAt?: string | null;
  heartbeatAt: string | null;
  stoppedAt?: string | null;
  createdAt?: string;
}

export interface BuildSummary {
  id: string;
  repositoryId: string;
  repositoryName?: string;
  status: string;
  integrationBranch: string;
  integrationWorktree?: string | null;
  baseCommit?: string;
  planId?: string | null;
  backlogPath?: string;
  workerLimit: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  actualElapsedSeconds?: number | null;
  pushStatus?: string | null;
  normalizedPlan?: {
    estimates?: {
      criticalPathTaskIds?: string[];
    };
  };
  estimates: {
    sequentialHours: number | null;
    criticalPathHours: number | null;
    expectedElapsedHours: number | null;
    expectedSavingsPercent: number | null;
  };
  tasks?: TaskSummary[];
  workers?: WorkerSummary[];
}

export interface PlanSummary {
  id: string;
  repositoryId: string;
  backlogPath: string;
  backlogSha256?: string;
  createdAt?: string;
  tasks: Array<{
    id: string;
    title: string;
    description?: string;
    estimateHours: number;
    dependsOn: string[];
    owns: string[];
    validate?: string[];
    acceptanceCriteria?: string[];
    riskScore?: number;
    requiresApproval?: boolean;
  }>;
  waves: string[][];
  ownershipConflicts: Array<{
    firstTaskId: string;
    secondTaskId: string;
    firstPath: string;
    secondPath: string;
  }>;
  estimates: {
    sequentialHours: number;
    criticalPathHours: number;
    expectedElapsedHours: number;
    expectedSavingsPercent: number;
    maximumTheoreticalConcurrency: number;
    criticalPathTaskIds: string[];
  };
  calibration?: {
    taskSampleCount: number;
    buildSampleCount: number;
    appliedMultiplier: number;
    confidence: "insufficient" | "low" | "medium" | "high";
  };
  epics: Array<{
    id: string;
    title: string;
    outcome: string;
    taskIds: string[];
    dependsOnEpicIds: string[];
    estimateHours: number;
  }>;
  adrDrafts: Array<{
    id: string;
    title: string;
    status: "proposed";
    sourceTaskIds: string[];
    markdown: string;
  }>;
}

export interface BacklogGenerationResult {
  repositoryId: string;
  backlogPath: string;
  mode: "objective" | "auto";
  changed: boolean;
  summary: string;
  warnings: string;
  nextAction: string;
  decomposition: {
    valid: boolean;
    epics: PlanSummary["epics"];
    adrDrafts: PlanSummary["adrDrafts"];
    errors: unknown[];
  };
}

export interface VisualComparison {
  id: string;
  repositoryId: string;
  routeUrl: string;
  baselinePath: string;
  actualPath: string;
  diffPath: string | null;
  width: number;
  height: number;
  differentPixels: number;
  differenceRatio: number;
  maximumDifferenceRatio: number;
  status: "passed" | "failed" | "dimension_mismatch";
  createdAt: string;
}

export interface KnowledgeSnapshot {
  id: string;
  repositoryId: string;
  baseCommit: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
}

export interface ImpactAnalysis {
  snapshot: KnowledgeSnapshot;
  changedPaths: string[];
  impactedFiles: Array<{
    path: string;
    distance: number;
    importedChangedPaths: string[];
  }>;
  impactedTasks: Array<{
    buildId: string;
    taskId: string;
    backlogTaskId: string;
    state: string;
    ownedPaths: string[];
    matchedFiles: string[];
  }>;
  summary: {
    directFiles: number;
    transitiveFiles: number;
    activeTasks: number;
    maximumDistance: number;
  };
}

export interface TaskDependency {
  taskId: string;
  dependencyTaskId: string;
  dependencyType: string;
  requiredArtifactName: string | null;
  requiredArtifactVersion: string | null;
}

export interface TaskOwnership {
  taskId?: string;
  path: string;
}

export interface TaskValidationCommand {
  taskId?: string;
  commandOrder: number;
  command: string;
}

export interface TaskAttempt {
  id: string;
  taskId: string;
  buildId: string;
  attempt: number;
  workerId: string | null;
  status: string;
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

export interface ChangedFile {
  taskId: string;
  attempt: number;
  path: string;
  changeType: string;
  previousPath: string | null;
  withinOwnership: boolean;
  sha256: string | null;
}

export interface ValidationRun {
  id: string;
  buildId: string;
  taskId: string | null;
  validationType: string;
  command: string;
  exitCode: number | null;
  status: string;
  logPath: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface ArtifactSummary {
  id: string;
  buildId: string;
  producerTaskId: string;
  name: string;
  artifactType: string;
  version: string;
  repositoryPath: string | null;
  storagePath: string | null;
  sha256: string | null;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  integratedAt: string | null;
}

export interface TaskManifest {
  id: string;
  buildId: string;
  taskId: string;
  attempt: number;
  status: string;
  schemaVersion: string;
  manifestPath: string;
  sha256: string;
  manifest: Record<string, unknown>;
  createdAt: string;
}

export interface ApprovalSummary {
  id: string;
  buildId: string;
  taskId: string | null;
  approvalType: string;
  status: string;
  reason: string;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

export interface BuildEvent {
  sequence: number;
  buildId: string;
  taskId: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface TaskDetail extends TaskSummary {
  buildId: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: TaskDependency[];
  ownership: Array<TaskOwnership | string>;
  validationCommands: Array<TaskValidationCommand | string>;
  attempts: TaskAttempt[];
  approvals: ApprovalSummary[];
  artifacts: ArtifactSummary[];
  manifests: TaskManifest[];
  validations: ValidationRun[];
  changedFiles: ChangedFile[];
  events: BuildEvent[];
}

export type AttemptDocumentName =
  | "prompt"
  | "jsonl"
  | "stderr"
  | "result"
  | "outcome";

export interface AttemptDocumentResponse {
  path: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}

export interface TaskDiffResponse {
  available: boolean;
  reason?: string;
  baseCommit?: string;
  target?: string;
  diff?: string;
}

export interface BuildMetrics {
  estimatedSequentialHours: number | null;
  criticalPathHours: number | null;
  expectedElapsedHours: number | null;
  expectedSavingsPercent: number | null;
  actualElapsedSeconds: number | null;
  totalTasks: number;
  integratedTasks: number;
  failedTasks: number;
  ownershipViolations: number;
  workerUtilizationPercent?: number | null;
  actualSavingsPercent?: number | null;
  pushStatus?: string | null;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface GovernanceTemplate {
  id: string;
  name: string;
  description: string;
}

export interface GovernanceOverview {
  policyPath: string;
  policy: {
    version: 1;
    workers: { maximum_per_repository: number };
    retries: { maximum_attempts: number };
    validation: { required_commands: string[] };
    ownership: { forbidden_prefixes: string[] };
    providers: { allowed: string[] };
    visual: { maximum_difference_ratio: number };
  };
  templates: GovernanceTemplate[];
}
