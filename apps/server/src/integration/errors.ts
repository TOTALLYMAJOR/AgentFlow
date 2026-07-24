export type IntegrationErrorCode =
  | "INTEGRATION_BUILD_MISMATCH"
  | "INTEGRATION_CONTEXT_MISMATCH"
  | "INTEGRATION_TASK_NOT_VALIDATED"
  | "INTEGRATION_WORKTREE_DIRTY"
  | "INTEGRATION_BRANCH_MISMATCH"
  | "INTEGRATION_TASK_COMMIT_MISMATCH"
  | "INTEGRATION_MERGE_CONFLICT"
  | "INTEGRATION_MERGE_FAILED"
  | "INTEGRATION_VALIDATION_FAILED"
  | "INTEGRATION_ROLLBACK_FAILED"
  | "INTEGRATION_PERSISTENCE_FAILED"
  | "INTEGRATION_PUSH_FAILED";

export class IntegrationError extends Error {
  public constructor(
    public readonly code: IntegrationErrorCode,
    message: string,
    public readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IntegrationError";
  }
}

export class IntegrationMergeConflictError extends IntegrationError {
  public constructor(
    public readonly conflictPaths: string[],
    options?: ErrorOptions,
  ) {
    super(
      "INTEGRATION_MERGE_CONFLICT",
      conflictPaths.length === 0
        ? "The task branch conflicts with the integration branch"
        : `The task branch conflicts in: ${conflictPaths.join(", ")}`,
      { conflictPaths },
      options,
    );
    this.name = "IntegrationMergeConflictError";
  }
}
