export type GitRuntimeErrorCode =
  | "GIT_COMMAND_FAILED"
  | "GIT_INVALID_IDENTIFIER"
  | "GIT_INVALID_BRANCH"
  | "GIT_INVALID_COMMIT"
  | "GIT_REPOSITORY_NOT_CLEAN"
  | "GIT_REPOSITORY_OPERATION_IN_PROGRESS"
  | "GIT_REPOSITORY_CHANGED_DURING_OPERATION"
  | "GIT_PATH_OUTSIDE_RUNTIME"
  | "GIT_PATH_OVERLAP"
  | "GIT_PATH_COLLISION"
  | "GIT_SYMLINK_NOT_ALLOWED"
  | "GIT_BRANCH_COLLISION"
  | "GIT_WORKTREE_COLLISION"
  | "GIT_WORKTREE_DIRTY"
  | "GIT_WORKTREE_LOCKED"
  | "GIT_WORKTREE_UNSAFE"
  | "GIT_UNSAFE_PRUNE";

export class GitRuntimeError extends Error {
  public constructor(
    public readonly code: GitRuntimeErrorCode,
    message: string,
    public readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitRuntimeError";
  }
}
