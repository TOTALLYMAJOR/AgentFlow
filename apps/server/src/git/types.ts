export interface GitCommandRecord {
  sequence: number;
  executable: "git";
  cwd: string;
  arguments: readonly string[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type GitCommandRecorder = (record: GitCommandRecord) => void;

export interface GitWorktreeRecord {
  path: string;
  headCommit: string;
  branchReference: string | null;
  branchName: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
}

export interface RepositoryPreflight {
  repositoryRoot: string;
  branchName: string | null;
  headCommit: string;
  baseBranch: string;
  baseCommit: string;
}

export interface ManagedWorktree {
  kind: "integration" | "task";
  repositoryId: string;
  buildId: string;
  taskId: string | null;
  path: string;
  branchName: string;
  baseCommit: string;
  headCommit: string;
  clean: boolean;
  reconciled: boolean;
}

export interface WorktreeChangeInspection {
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  headCommit: string;
  resultCommit: string | null;
  commitCount: number;
  clean: boolean;
  changedFiles: string[];
}

export type WorktreeReconciliationState =
  | "missing"
  | "ready"
  | "dirty"
  | "orphaned-branch"
  | "unregistered-path"
  | "branch-mismatch"
  | "missing-path"
  | "base-diverged"
  | "locked";

export interface WorktreeReconciliation {
  kind: "integration" | "task";
  taskId: string | null;
  path: string;
  expectedBranch: string;
  actualBranch: string | null;
  headCommit: string | null;
  state: WorktreeReconciliationState;
  safeToReuse: boolean;
  reason: string;
}

export interface BuildWorktreeReconciliation {
  repositoryId: string;
  buildId: string;
  integration: WorktreeReconciliation;
  tasks: WorktreeReconciliation[];
  requiresHumanReview: boolean;
}

export interface WorktreeRemoval {
  path: string;
  branchName: string;
  removed: boolean;
  branchPreserved: true;
}

export interface PruneInspection {
  candidates: GitWorktreeRecord[];
  output: string;
  executed: boolean;
}
