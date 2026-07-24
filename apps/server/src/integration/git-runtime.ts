import {
  assertSafeConfiguredBranch,
  GitCommandRunner,
  GitWorktreeManager,
} from "../git/index.js";
import {
  IntegrationError,
  IntegrationMergeConflictError,
} from "./errors.js";

import type { GitCommandRecorder } from "../git/index.js";
import type {
  IntegrationGitMergeResult,
  IntegrationGitReadyInput,
  IntegrationGitRuntime,
} from "./types.js";

const COMMIT_HASH = /^[0-9a-f]{40,64}$/u;
const REMOTE_NAME = /^(?!-)(?!.*(?:^|\/)\.\.?($|\/))[A-Za-z0-9._/-]+$/u;

export class WorktreeIntegrationGitRuntime implements IntegrationGitRuntime {
  readonly #runner: GitCommandRunner;

  public constructor(
    private readonly worktrees: GitWorktreeManager,
    recorder?: GitCommandRecorder,
  ) {
    this.#runner = new GitCommandRunner(recorder);
  }

  public get integrationPath(): string {
    return this.worktrees.integrationPath();
  }

  public async verifyReady(input: IntegrationGitReadyInput): Promise<string> {
    assertSafeConfiguredBranch(input.integrationBranch);
    assertSafeConfiguredBranch(input.taskBranch);
    const expectedTaskCommit = validateCommit(input.expectedTaskCommit);
    const [branchRecord, statusRecord, headRecord, taskRecord] =
      await Promise.all([
        this.#runner.run(this.integrationPath, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "HEAD",
        ]),
        this.#runner.run(this.integrationPath, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]),
        this.#runner.run(this.integrationPath, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ]),
        this.#runner.run(this.worktrees.repositoryRoot, [
          "rev-parse",
          "--verify",
          `refs/heads/${input.taskBranch}^{commit}`,
        ]),
      ]);

    const actualBranch = branchRecord.stdout.trim();
    if (actualBranch !== input.integrationBranch) {
      throw new IntegrationError(
        "INTEGRATION_BRANCH_MISMATCH",
        `Expected integration branch ${input.integrationBranch}, found ${actualBranch}`,
        { expected: input.integrationBranch, actual: actualBranch },
      );
    }
    if (statusRecord.stdout.length > 0) {
      throw new IntegrationError(
        "INTEGRATION_WORKTREE_DIRTY",
        "The integration worktree must be clean before a merge",
        { worktreePath: this.integrationPath },
      );
    }

    const taskHead = validateCommit(taskRecord.stdout.trim());
    if (taskHead !== expectedTaskCommit) {
      throw new IntegrationError(
        "INTEGRATION_TASK_COMMIT_MISMATCH",
        `Task branch ${input.taskBranch} moved after validation`,
        {
          expectedTaskCommit,
          actualTaskCommit: taskHead,
          taskBranch: input.taskBranch,
        },
      );
    }
    return validateCommit(headRecord.stdout.trim());
  }

  public async merge(
    taskBranch: string,
    previousHead: string,
  ): Promise<IntegrationGitMergeResult> {
    assertSafeConfiguredBranch(taskBranch);
    const expectedPreviousHead = validateCommit(previousHead);
    const actualPreviousHead = await this.#head();
    if (actualPreviousHead !== expectedPreviousHead) {
      throw new IntegrationError(
        "INTEGRATION_CONTEXT_MISMATCH",
        "The integration branch changed after its merge snapshot was recorded",
        { expectedPreviousHead, actualPreviousHead },
      );
    }

    try {
      await this.#runner.run(this.integrationPath, [
        "merge",
        "--no-ff",
        "--no-edit",
        taskBranch,
      ]);
    } catch (error) {
      const conflicts = await this.#conflictedPaths();
      if (conflicts.length > 0) {
        throw new IntegrationMergeConflictError(conflicts, { cause: error });
      }
      throw new IntegrationError(
        "INTEGRATION_MERGE_FAILED",
        errorMessage(error),
        { taskBranch },
        { cause: error },
      );
    }

    return {
      previousHead: expectedPreviousHead,
      integrationCommit: await this.#head(),
    };
  }

  public async abortMerge(): Promise<void> {
    await this.#runner.run(this.integrationPath, ["merge", "--abort"]);
  }

  public async resetAndClean(commit: string): Promise<void> {
    const expected = validateCommit(commit);
    await this.#runner.run(this.integrationPath, ["reset", "--hard", expected]);
    await this.#runner.run(this.integrationPath, ["clean", "-fd", "--"]);
    const [head, status] = await Promise.all([
      this.#head(),
      this.#runner.run(this.integrationPath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ]);
    if (head !== expected || status.stdout.length > 0) {
      throw new IntegrationError(
        "INTEGRATION_ROLLBACK_FAILED",
        "The integration worktree did not return to its recorded clean state",
        { expectedHead: expected, actualHead: head },
      );
    }
  }

  public async push(remote: string, branch: string): Promise<void> {
    if (!REMOTE_NAME.test(remote)) {
      throw new IntegrationError(
        "INTEGRATION_PUSH_FAILED",
        `Invalid Git remote name: ${remote}`,
      );
    }
    assertSafeConfiguredBranch(branch);
    await this.#runner.run(this.integrationPath, [
      "push",
      "--",
      remote,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ]);
  }

  async #head(): Promise<string> {
    const result = await this.#runner.run(this.integrationPath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    return validateCommit(result.stdout.trim());
  }

  async #conflictedPaths(): Promise<string[]> {
    const result = await this.#runner.run(this.integrationPath, [
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=U",
      "--",
    ]);
    return result.stdout
      .split("\0")
      .filter((candidate) => candidate.length > 0)
      .sort();
  }
}

function validateCommit(candidate: string): string {
  if (!COMMIT_HASH.test(candidate)) {
    throw new IntegrationError(
      "INTEGRATION_CONTEXT_MISMATCH",
      `Git returned an invalid commit object ID: ${candidate}`,
    );
  }
  return candidate;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
