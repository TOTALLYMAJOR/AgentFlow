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
  uptimeSeconds: number;
}

export interface RepositorySummary {
  id: string;
  name: string;
  localPath: string;
  baseBranch: string;
  status: "ready" | "invalid" | "unavailable";
  detectedStack: {
    packageManager?: string;
    frameworks: string[];
    monorepo: boolean;
  };
  updatedAt: string;
}

export interface TaskSummary {
  id: string;
  backlogTaskId: string;
  title: string;
  state: string;
  attempt: number;
  estimateHours: number | null;
  branchName: string | null;
  workerId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface WorkerSummary {
  id: string;
  slot: number;
  status: string;
  taskId: string | null;
  heartbeatAt: string | null;
}

export interface BuildSummary {
  id: string;
  repositoryId: string;
  repositoryName?: string;
  status: string;
  integrationBranch: string;
  workerLimit: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
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
  tasks: Array<{
    id: string;
    title: string;
    estimateHours: number;
    dependsOn: string[];
    owns: string[];
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
}

export interface BuildEvent {
  sequence: number;
  buildId: string;
  taskId: string | null;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
