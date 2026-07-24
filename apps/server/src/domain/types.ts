export const BUILD_STATUSES = [
  "planning",
  "ready",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type BuildStatus = (typeof BUILD_STATUSES)[number];

export const TASK_STATUSES = [
  "pending",
  "blocked",
  "ready",
  "running",
  "validating",
  "validated",
  "integrating",
  "integrated",
  "failed",
  "cancelled",
  "interrupted",
  "blocked_failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface ConsumedArtifact {
  task: string;
  artifact: string;
  version: string;
}

export interface ProducedArtifact {
  name: string;
  type: string;
  version: string;
  path?: string;
}

export interface PlannedTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  estimateHours: number;
  dependsOn: string[];
  owns: string[];
  validate: string[];
  consumes: ConsumedArtifact[];
  produces: ProducedArtifact[];
  allowNoChanges: boolean;
  riskScore: number;
  requiresApproval: boolean;
}

export interface OwnershipConflict {
  firstTaskId: string;
  secondTaskId: string;
  firstPath: string;
  secondPath: string;
}

export interface PlanEstimates {
  sequentialHours: number;
  criticalPathHours: number;
  expectedElapsedHours: number;
  expectedSavingsPercent: number;
  maximumTheoreticalConcurrency: number;
  criticalPathTaskIds: string[];
  workerEfficiency: number;
  overheadPercent: number;
}

export interface PlanResult {
  id: string;
  repositoryId: string;
  backlogPath: string;
  backlogSha256: string;
  tasks: PlannedTask[];
  waves: string[][];
  ownershipConflicts: OwnershipConflict[];
  estimates: PlanEstimates;
  createdAt: string;
}

export interface RepositoryRecord {
  id: string;
  name: string;
  localPath: string;
  configPath: string;
  baseBranch: string;
  remoteName: string | null;
  status: "ready" | "invalid" | "unavailable";
  detectedStack: DetectedStack;
  createdAt: string;
  updatedAt: string;
}

export interface DetectedStack {
  packageManager?: "npm" | "pnpm" | "yarn";
  scripts: string[];
  frameworks: string[];
  composeFile?: string;
  monorepo: boolean;
  frontendRoots: string[];
  backendRoots: string[];
  contractRoots: string[];
  suggestedValidation: string[];
}

export interface BuildEvent {
  sequence: number;
  buildId: string;
  taskId: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}
