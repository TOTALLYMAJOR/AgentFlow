export type ScreenId =
  | "overview"
  | "repositories"
  | "initiatives"
  | "planner"
  | "build"
  | "results";

export interface InitiativeSummary {
  id: string;
  title: string;
  objective: string;
  status: "proposed" | "approved" | "running" | "paused" | "partial" | "completed" | "failed" | "cancelled";
  digest: string | null;
  members: Array<{ repositoryId: string; planId: string; baseCommit: string; buildId: string | null }>;
  dependencies: Array<{ producerPlanId: string; consumerPlanId: string; dependencyType: string; artifactName?: string; artifactVersion?: string; sharedResource?: string }>;
  blockers: Array<{ planId: string; code: string; message: string; recovery: string }>;
  builds: Array<{ id: string; status: string }>;
  cleanup: Array<{ buildId: string; status: string; completedAt: string | null; eligibleAt: string | null; receipts: Array<{ sequence: number; targetType: "worktree" | "branch"; target: string; action: "removed" | "deleted" | "preserved" | "missing"; reason: string; createdAt: string }> }>;
  supersedesInitiativeId: string | null;
  updatedAt: string;
}

export interface InitiativeCandidate {
  repositoryId: string;
  repositoryName: string;
  planId: string;
  baseCommit: string;
  planSha256: string;
  createdAt: string;
  lockedAt: string | null;
  taskCount: number;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  host: string;
  runtime: {
    home: string;
    entrypoint: string | null;
    pid: number;
  };
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

export interface RepositoryPreflight {
  localPath: string;
  configPath: string;
  status: "ready" | "invalid" | "unavailable";
  checks: {
    pathExists: boolean;
    directory: boolean;
    accessible: boolean;
    gitRepository: boolean;
    configPresent: boolean;
    configValid: boolean;
    baseBranchExists: boolean;
  };
  issues: Array<{
    code: string;
    message: string;
    details?: unknown;
  }>;
  detectedStack: RepositorySummary["detectedStack"];
  canConnect: boolean;
  requiresInitialization: boolean;
  proposedChanges: string[];
  nextAction: string;
}

export interface ConfigurationReviewSnapshot {
  repositoryId: string;
  configurationPath: string;
  configurationContents: string;
  configurationSha256: string;
  valid: true;
  nextAction: string;
}

export interface ReviewedConfigurationCommitResult {
  repositoryId: string;
  configurationPath: string;
  commitSha: string;
  commitMessage: string;
  committedPaths: string[];
  requiresWorktreeReview: boolean;
  nextAction: string;
}

export interface ReviewedBacklogSnapshot {
  repositoryId: string;
  backlogPath: string;
  absoluteBacklogPath: string;
  configurationPath: ".agentflow.yaml";
  backlogContents: string;
  configurationContents: string;
  backlogSha256: string;
  configurationSha256: string;
  valid: boolean;
  validationErrors: string[];
  nextAction: string;
}

export interface ReviewedBacklogCommitResult {
  repositoryId: string;
  commitSha: string;
  commitMessage: string;
  committedPaths: string[];
  backlogPath: string;
  requiresWorktreeReview: boolean;
  nextAction: string;
}

export interface RepositoryTarget {
  repositoryId: string;
  name: string;
  path: string;
  baseBranch: string;
  currentBranch: string | null;
  head: string | null;
  clean: boolean;
  upstream: { ahead: number; behind: number } | null;
  backlog: { path: string | null; present: boolean; tracked: boolean };
  designIntelligence: {
    configured: boolean;
    status: "available" | "not_configured";
  };
  activeBuild: { id: string; status: string } | null;
  eligible: boolean;
  blockers: Array<{ code: string; message: string; recovery: string }>;
  warnings: Array<{ code: string; message: string; recovery: string }>;
  stateFingerprint: string;
  checkedAt: string;
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
    // Captured display context only; native admission and recovery remain authoritative.
    governedHandoff?: Record<string, unknown> | null;
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

// Advisory tab-local continuation only. Native repository and approval records remain authoritative.
// Persist identities, never source contents, credentials or an authorization decision.
export interface PendingConfigurationReview {
  repositoryId: string;
  commitSha: string;
  configurationSha256: string;
}

const pendingConfigurationReviews = new Map<string, PendingConfigurationReview>();
const clearedConfigurationReviews = new Set<string>();
const configurationReviewEvent = "agentflow:configuration-review-required";
const configurationReviewStoragePrefix = "agentflow.configuration-review-required.v1:";

export function pendingConfigurationReview(repositoryId: string): PendingConfigurationReview | null {
  if (clearedConfigurationReviews.has(repositoryId)) {
    return null;
  }
  const remembered = pendingConfigurationReviews.get(repositoryId);
  if (remembered !== undefined) {
    return remembered;
  }
  try {
    const raw = globalThis.sessionStorage.getItem(configurationReviewStoragePrefix + repositoryId);
    if (raw === null) {
      return null;
    }
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null &&
      "repositoryId" in value && value.repositoryId === repositoryId &&
      "commitSha" in value && typeof value.commitSha === "string" && /^[a-f0-9]{40,64}$/iu.test(value.commitSha) &&
      "configurationSha256" in value && typeof value.configurationSha256 === "string" && /^[a-f0-9]{64}$/iu.test(value.configurationSha256)) {
      const review = { repositoryId, commitSha: value.commitSha, configurationSha256: value.configurationSha256 };
      pendingConfigurationReviews.set(repositoryId, review);
      return review;
    }
  } catch {
    // Storage can be unavailable or malformed. Never attach unverified stored context to a repository.
  }
  return null;
}

export function retainConfigurationReview(review: PendingConfigurationReview): void {
  clearedConfigurationReviews.delete(review.repositoryId);
  pendingConfigurationReviews.set(review.repositoryId, review);
  try {
    globalThis.sessionStorage.setItem(configurationReviewStoragePrefix + review.repositoryId, JSON.stringify(review));
  } catch {
    // Keep the in-memory continuation gate when browser storage is unavailable.
  }
  if (typeof globalThis.dispatchEvent === "function") {
    globalThis.dispatchEvent(new Event(configurationReviewEvent));
  }
}

export function clearConfigurationReview(repositoryId: string): void {
  clearedConfigurationReviews.add(repositoryId);
  pendingConfigurationReviews.delete(repositoryId);
  try {
    globalThis.sessionStorage.removeItem(configurationReviewStoragePrefix + repositoryId);
  } catch {
    // In-memory recovery still completes; this store never authorizes a native action.
  }
  if (typeof globalThis.dispatchEvent === "function") {
    globalThis.dispatchEvent(new Event(configurationReviewEvent));
  }
}

export function subscribeConfigurationReviews(onChange: () => void): () => void {
  globalThis.addEventListener(configurationReviewEvent, onChange);
  return () => globalThis.removeEventListener(configurationReviewEvent, onChange);
}
