import { GitRuntimeError } from "./errors.js";
import { assertSafeIdentifier } from "./paths.js";

export function integrationBranchName(buildId: string): string {
  assertSafeIdentifier("build ID", buildId);
  return `agent-integration/${buildId}`;
}
export function taskBranchName(buildId: string, taskId: string): string {
  assertSafeIdentifier("build ID", buildId);
  assertSafeIdentifier("task ID", taskId);
  return `agent/${buildId}/${taskId}`;
}

export function assertSafeConfiguredBranch(branch: string): void {
  if (
    branch.length === 0 ||
    branch.startsWith("-") ||
    branch.includes("\0") ||
    branch.includes("\n") ||
    branch.includes("\r")
  ) {
    throw new GitRuntimeError(
      "GIT_INVALID_BRANCH",
      `Configured branch ${JSON.stringify(branch)} is unsafe`,
      { branch },
    );
  }
}
