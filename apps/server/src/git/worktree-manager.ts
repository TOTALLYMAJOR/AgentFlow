import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  assertSafeConfiguredBranch,
  integrationBranchName,
  taskBranchName,
} from "./branch-names.js";
import { GitCommandRunner } from "./command-runner.js";
import { GitRuntimeError } from "./errors.js";
import {
  assertSafeIdentifier,
  canonicalExistingDirectory,
  ensureCanonicalRoot,
  ensureManagedDirectory,
  isMissingPath,
  isPathInside,
  pathKind,
  pathsOverlap,
} from "./paths.js";
import { parseWorktreePorcelain } from "./worktree-parser.js";

import type {
  BuildWorktreeReconciliation,
  GitCommandRecord,
  GitCommandRecorder,
  GitWorktreeRecord,
  ManagedWorktree,
  PruneInspection,
  RepositoryPreflight,
  WorktreeChangeInspection,
  WorktreeReconciliation,
  WorktreeRemoval,
} from "./types.js";

const COMMIT_HASH = /^[0-9a-f]{40,64}$/;
const IN_PROGRESS_GIT_PATHS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
] as const;

export interface GitWorktreeManagerOptions {
  repositoryRoot: string;
  worktreesRoot: string;
  repositoryId: string;
  buildId: string;
  recorder?: GitCommandRecorder;
}

export interface CreateIntegrationWorktreeInput {
  baseBranch: string;
  remote?: string;
}

export interface CreateTaskWorktreeInput {
  taskId: string;
  integrationCommit: string;
}

export interface ReconcileTaskInput {
  taskId: string;
  baseCommit?: string;
}

export class GitWorktreeManager {
  readonly #runner: GitCommandRunner;
  readonly #repositoryWorktreesRoot: string;
  #mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    public readonly repositoryRoot: string,
    public readonly worktreesRoot: string,
    public readonly repositoryId: string,
    public readonly buildId: string,
    runner: GitCommandRunner,
  ) {
    this.#runner = runner;
    this.#repositoryWorktreesRoot = path.join(worktreesRoot, repositoryId);
  }

  public static async create(
    options: GitWorktreeManagerOptions,
  ): Promise<GitWorktreeManager> {
    assertSafeIdentifier("repository ID", options.repositoryId);
    assertSafeIdentifier("build ID", options.buildId);

    const repositoryRoot = await canonicalExistingDirectory(
      options.repositoryRoot,
      "Managed repository",
    );
    const worktreesRoot = await ensureCanonicalRoot(
      options.worktreesRoot,
      "AgentFlow worktrees root",
    );
    if (pathsOverlap(repositoryRoot, worktreesRoot)) {
      throw new GitRuntimeError(
        "GIT_PATH_OVERLAP",
        "The managed repository and AgentFlow worktrees root must not overlap",
        { repositoryRoot, worktreesRoot },
      );
    }

    const runner = new GitCommandRunner(options.recorder);
    const topLevel = (
      await runner.run(repositoryRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
      ])
    ).stdout.trim();
    const canonicalTopLevel = await canonicalExistingDirectory(
      topLevel,
      "Git top-level",
    );
    if (canonicalTopLevel !== repositoryRoot) {
      throw new GitRuntimeError(
        "GIT_WORKTREE_UNSAFE",
        "The managed repository path must be the canonical Git top-level",
        { repositoryRoot, canonicalTopLevel },
      );
    }

    return new GitWorktreeManager(
      repositoryRoot,
      worktreesRoot,
      options.repositoryId,
      options.buildId,
      runner,
    );
  }

  public commandHistory(): readonly GitCommandRecord[] {
    return this.#runner.history();
  }

  public integrationBranch(): string {
    return integrationBranchName(this.buildId);
  }

  public taskBranch(taskId: string): string {
    return taskBranchName(this.buildId, taskId);
  }

  public integrationPath(): string {
    return path.join(
      this.#repositoryWorktreesRoot,
      this.buildId,
      "integration",
    );
  }

  public taskPath(taskId: string): string {
    assertSafeIdentifier("task ID", taskId);
    return path.join(
      this.#repositoryWorktreesRoot,
      this.buildId,
      "tasks",
      taskId,
    );
  }

  public async preflight(
    baseBranch: string,
    remote?: string,
  ): Promise<RepositoryPreflight> {
    assertSafeConfiguredBranch(baseBranch);
    await this.#assertValidBranch(baseBranch);
    const status = await this.#runner.run(this.repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (status.stdout.length > 0) {
      throw new GitRuntimeError(
        "GIT_REPOSITORY_NOT_CLEAN",
        "The user's normal checkout must be clean before AgentFlow creates worktrees",
        { repositoryRoot: this.repositoryRoot },
      );
    }
    await this.#assertNoOperationInProgress();

    const headCommit = await this.#resolveCommit("HEAD");
    const branchName = await this.#currentBranch(this.repositoryRoot);
    const baseCommit = await this.#resolveBaseCommit(baseBranch, remote);
    return {
      repositoryRoot: this.repositoryRoot,
      branchName,
      headCommit,
      baseBranch,
      baseCommit,
    };
  }

  public async createIntegrationWorktree(
    input: CreateIntegrationWorktreeInput,
  ): Promise<ManagedWorktree> {
    return this.#serializeMutation(async () => {
      const preflight = await this.preflight(input.baseBranch, input.remote);
      const result = await this.#createOrReconcileWorktree({
        kind: "integration",
        taskId: null,
        path: this.integrationPath(),
        branchName: this.integrationBranch(),
        baseCommit: preflight.baseCommit,
      });
      await this.#assertMainCheckoutUnchanged(preflight);
      return result;
    });
  }

  public async createTaskWorktree(
    input: CreateTaskWorktreeInput,
  ): Promise<ManagedWorktree> {
    assertSafeIdentifier("task ID", input.taskId);
    return this.#serializeMutation(async () => {
      const snapshot = await this.#mainCheckoutSnapshot();
      const integrationCommit = await this.#resolveCommit(
        input.integrationCommit,
      );
      const integrationBranch = this.integrationBranch();
      if (!(await this.#branchExists(integrationBranch))) {
        throw new GitRuntimeError(
          "GIT_WORKTREE_UNSAFE",
          `Integration branch ${integrationBranch} does not exist`,
          { integrationBranch },
        );
      }
      if (
        !(await this.#isAncestor(
          integrationCommit,
          `refs/heads/${integrationBranch}`,
        ))
      ) {
        throw new GitRuntimeError(
          "GIT_INVALID_COMMIT",
          `Commit ${integrationCommit} is not part of ${integrationBranch}`,
          { integrationCommit, integrationBranch },
        );
      }

      const result = await this.#createOrReconcileWorktree({
        kind: "task",
        taskId: input.taskId,
        path: this.taskPath(input.taskId),
        branchName: this.taskBranch(input.taskId),
        baseCommit: integrationCommit,
      });
      await this.#assertMainCheckoutUnchanged(snapshot);
      return result;
    });
  }

  public async listWorktrees(): Promise<GitWorktreeRecord[]> {
    const output = await this.#runner.run(this.repositoryRoot, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    return parseWorktreePorcelain(output.stdout);
  }

  public async inspectChanges(
    taskId: string,
    baseCommit: string,
  ): Promise<WorktreeChangeInspection> {
    const expectedPath = this.taskPath(taskId);
    const expectedBranch = this.taskBranch(taskId);
    const record = await this.#requireManagedRecord(
      expectedPath,
      expectedBranch,
    );
    const resolvedBase = await this.#resolveCommit(baseCommit);
    if (!(await this.#isAncestor(resolvedBase, record.headCommit))) {
      throw new GitRuntimeError(
        "GIT_INVALID_COMMIT",
        `Worktree ${expectedPath} no longer descends from ${resolvedBase}`,
        { expectedPath, baseCommit: resolvedBase, headCommit: record.headCommit },
      );
    }

    const [committed, tracked, untracked, count, status, head] =
      await Promise.all([
        this.#runner.run(expectedPath, [
          "diff",
          "--name-status",
          "-z",
          "--find-renames",
          resolvedBase,
          "HEAD",
        ]),
        this.#runner.run(expectedPath, [
          "diff",
          "--name-status",
          "-z",
          "--find-renames",
          "HEAD",
        ]),
        this.#runner.run(expectedPath, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ]),
        this.#runner.run(expectedPath, [
          "rev-list",
          "--count",
          `${resolvedBase}..HEAD`,
        ]),
        this.#runner.run(expectedPath, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]),
        this.#runner.run(expectedPath, ["rev-parse", "--verify", "HEAD"]),
      ]);
    const headCommit = this.#validatedCommit(head.stdout.trim());
    const commitCount = Number.parseInt(count.stdout.trim(), 10);
    if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
      throw new GitRuntimeError(
        "GIT_WORKTREE_UNSAFE",
        "Git returned an invalid commit count",
        { output: count.stdout },
      );
    }
    const changedFiles = [
      ...parseNameStatus(committed.stdout),
      ...parseNameStatus(tracked.stdout),
      ...splitNullPaths(untracked.stdout),
    ];

    return {
      worktreePath: expectedPath,
      branchName: expectedBranch,
      baseCommit: resolvedBase,
      headCommit,
      resultCommit: commitCount === 0 ? null : headCommit,
      commitCount,
      clean: status.stdout.length === 0,
      changedFiles: [...new Set(changedFiles)].sort(),
    };
  }

  public async reconcileBuild(
    tasks: readonly ReconcileTaskInput[],
    integrationBaseCommit?: string,
  ): Promise<BuildWorktreeReconciliation> {
    const integration = await this.#reconcileExpected({
      kind: "integration",
      taskId: null,
      path: this.integrationPath(),
      branchName: this.integrationBranch(),
      ...(integrationBaseCommit === undefined
        ? {}
        : { baseCommit: integrationBaseCommit }),
    });
    const taskResults: WorktreeReconciliation[] = [];
    for (const task of tasks) {
      assertSafeIdentifier("task ID", task.taskId);
      taskResults.push(
        await this.#reconcileExpected({
          kind: "task",
          taskId: task.taskId,
          path: this.taskPath(task.taskId),
          branchName: this.taskBranch(task.taskId),
          ...(task.baseCommit === undefined
            ? {}
            : { baseCommit: task.baseCommit }),
        }),
      );
    }
    return {
      repositoryId: this.repositoryId,
      buildId: this.buildId,
      integration,
      tasks: taskResults,
      requiresHumanReview: [integration, ...taskResults].some(
        (result) =>
          !result.safeToReuse &&
          result.state !== "missing" &&
          result.state !== "orphaned-branch",
      ),
    };
  }

  public async removeIntegrationWorktree(
    force = false,
  ): Promise<WorktreeRemoval> {
    return this.#removeExpected(
      this.integrationPath(),
      this.integrationBranch(),
      force,
    );
  }

  public async removeTaskWorktree(
    taskId: string,
    force = false,
  ): Promise<WorktreeRemoval> {
    return this.#removeExpected(
      this.taskPath(taskId),
      this.taskBranch(taskId),
      force,
    );
  }

  public async cleanBuildWorktrees(
    taskIds: readonly string[],
    force = false,
  ): Promise<WorktreeRemoval[]> {
    const removals: WorktreeRemoval[] = [];
    for (const taskId of taskIds) {
      removals.push(await this.removeTaskWorktree(taskId, force));
    }
    removals.push(await this.removeIntegrationWorktree(force));
    return removals;
  }

  public async pruneManagedMetadata(
    execute = false,
  ): Promise<PruneInspection> {
    const worktrees = await this.listWorktrees();
    const candidates = worktrees.filter((record) => record.prunable);
    const unsafe = candidates.filter(
      (record) =>
        !isPathInside(this.#repositoryWorktreesRoot, path.resolve(record.path)) ||
        record.branchName === null ||
        !(
          record.branchName.startsWith("agent/") ||
          record.branchName.startsWith("agent-integration/")
        ),
    );
    if (execute && unsafe.length > 0) {
      throw new GitRuntimeError(
        "GIT_UNSAFE_PRUNE",
        "Git reports stale worktrees outside AgentFlow's managed namespace",
        { unsafe },
      );
    }

    const arguments_ = [
      "worktree",
      "prune",
      ...(execute ? [] : ["--dry-run"]),
      "--verbose",
      "--expire",
      "now",
    ];
    const operation = execute
      ? this.#serializeMutation(async () =>
          this.#runner.run(this.repositoryRoot, arguments_),
        )
      : this.#runner.run(this.repositoryRoot, arguments_);
    const result = await operation;
    return {
      candidates,
      output: `${result.stdout}${result.stderr}`,
      executed: execute,
    };
  }

  async #createOrReconcileWorktree(input: {
    kind: "integration" | "task";
    taskId: string | null;
    path: string;
    branchName: string;
    baseCommit: string;
  }): Promise<ManagedWorktree> {
    await this.#assertValidBranch(input.branchName);
    this.#assertExpectedPath(input.path);
    const worktrees = await this.listWorktrees();
    const exactRecord = this.#findRecord(worktrees, input.path);
    const sameBranch = worktrees.find(
      (record) => record.branchName === input.branchName,
    );
    const branchExists = await this.#branchExists(input.branchName);
    const targetKind = await pathKind(input.path);

    if (
      exactRecord !== undefined ||
      sameBranch !== undefined ||
      branchExists ||
      targetKind !== "missing"
    ) {
      return this.#reconcileExistingForCreate({
        ...input,
        worktrees,
        exactRecord,
        sameBranch,
        branchExists,
        targetKind,
      });
    }

    await this.#ensureParentFor(input.kind);
    await this.#runner.run(this.repositoryRoot, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      input.branchName,
      input.path,
      input.baseCommit,
    ]);
    const created = await this.#requireManagedRecord(
      input.path,
      input.branchName,
    );
    if (!(await this.#isAncestor(input.baseCommit, created.headCommit))) {
      throw new GitRuntimeError(
        "GIT_WORKTREE_UNSAFE",
        "The created worktree does not descend from its requested base",
        { ...input, headCommit: created.headCommit },
      );
    }
    return this.#toManagedWorktree(input, created, false);
  }

  async #reconcileExistingForCreate(input: {
    kind: "integration" | "task";
    taskId: string | null;
    path: string;
    branchName: string;
    baseCommit: string;
    worktrees: GitWorktreeRecord[];
    exactRecord: GitWorktreeRecord | undefined;
    sameBranch: GitWorktreeRecord | undefined;
    branchExists: boolean;
    targetKind: Awaited<ReturnType<typeof pathKind>>;
  }): Promise<ManagedWorktree> {
    if (input.exactRecord === undefined) {
      if (input.sameBranch !== undefined || input.branchExists) {
        throw new GitRuntimeError(
          "GIT_BRANCH_COLLISION",
          `Branch ${input.branchName} already exists without its exact managed worktree`,
          {
            branchName: input.branchName,
            branchWorktree: input.sameBranch?.path ?? null,
          },
        );
      }
      throw new GitRuntimeError(
        input.targetKind === "symlink"
          ? "GIT_SYMLINK_NOT_ALLOWED"
          : "GIT_PATH_COLLISION",
        `Expected worktree path ${input.path} already exists but is not registered by Git`,
        { path: input.path, kind: input.targetKind },
      );
    }
    if (
      input.exactRecord.branchName !== input.branchName ||
      input.sameBranch?.path !== input.exactRecord.path ||
      !input.branchExists
    ) {
      throw new GitRuntimeError(
        "GIT_WORKTREE_COLLISION",
        `Existing worktree ${input.path} is not the expected AgentFlow branch`,
        {
          expectedBranch: input.branchName,
          actualBranch: input.exactRecord.branchName,
          sameBranchPath: input.sameBranch?.path ?? null,
        },
      );
    }
    if (input.exactRecord.locked) {
      throw new GitRuntimeError(
        "GIT_WORKTREE_LOCKED",
        `Existing worktree ${input.path} is locked`,
        { reason: input.exactRecord.lockReason },
      );
    }
    if (
      input.targetKind !== "directory" ||
      (await realpath(input.path)) !== input.path
    ) {
      throw new GitRuntimeError(
        "GIT_WORKTREE_UNSAFE",
        `Existing worktree ${input.path} is missing or non-canonical`,
        { path: input.path, targetKind: input.targetKind },
      );
    }
    if (!(await this.#isAncestor(input.baseCommit, input.exactRecord.headCommit))) {
      throw new GitRuntimeError(
        "GIT_WORKTREE_UNSAFE",
        `Existing branch ${input.branchName} does not descend from its recorded base`,
        {
          baseCommit: input.baseCommit,
          headCommit: input.exactRecord.headCommit,
        },
      );
    }
    return this.#toManagedWorktree(input, input.exactRecord, true);
  }

  async #toManagedWorktree(
    input: {
      kind: "integration" | "task";
      taskId: string | null;
      path: string;
      branchName: string;
      baseCommit: string;
    },
    record: GitWorktreeRecord,
    reconciled: boolean,
  ): Promise<ManagedWorktree> {
    return {
      kind: input.kind,
      repositoryId: this.repositoryId,
      buildId: this.buildId,
      taskId: input.taskId,
      path: input.path,
      branchName: input.branchName,
      baseCommit: input.baseCommit,
      headCommit: this.#validatedCommit(record.headCommit),
      clean: await this.#isClean(input.path),
      reconciled,
    };
  }

  async #reconcileExpected(input: {
    kind: "integration" | "task";
    taskId: string | null;
    path: string;
    branchName: string;
    baseCommit?: string;
  }): Promise<WorktreeReconciliation> {
    this.#assertExpectedPath(input.path);
    const records = await this.listWorktrees();
    const exact = this.#findRecord(records, input.path);
    const branchRecord = records.find(
      (record) => record.branchName === input.branchName,
    );
    const branchExists = await this.#branchExists(input.branchName);
    const targetKind = await pathKind(input.path);
    const base = input.baseCommit === undefined
      ? undefined
      : await this.#resolveCommit(input.baseCommit);
    const common = {
      kind: input.kind,
      taskId: input.taskId,
      path: input.path,
      expectedBranch: input.branchName,
    } as const;

    if (exact === undefined) {
      if (branchExists || branchRecord !== undefined) {
        return {
          ...common,
          actualBranch: branchRecord?.branchName ?? input.branchName,
          headCommit: branchRecord?.headCommit ?? null,
          state: "orphaned-branch",
          safeToReuse: false,
          reason: "The expected branch exists without its exact managed worktree",
        };
      }
      if (targetKind !== "missing") {
        return {
          ...common,
          actualBranch: null,
          headCommit: null,
          state: "unregistered-path",
          safeToReuse: false,
          reason: "The expected path exists but Git does not register it",
        };
      }
      return {
        ...common,
        actualBranch: null,
        headCommit: null,
        state: "missing",
        safeToReuse: false,
        reason: "No branch or worktree exists yet",
      };
    }
    if (targetKind !== "directory" || exact.prunable) {
      return {
        ...common,
        actualBranch: exact.branchName,
        headCommit: exact.headCommit || null,
        state: "missing-path",
        safeToReuse: false,
        reason: "Git records the worktree but its directory is missing",
      };
    }
    if (
      exact.branchName !== input.branchName ||
      branchRecord?.path !== exact.path ||
      !branchExists
    ) {
      return {
        ...common,
        actualBranch: exact.branchName,
        headCommit: exact.headCommit || null,
        state: "branch-mismatch",
        safeToReuse: false,
        reason: "The path and expected branch are not paired uniquely",
      };
    }
    if (exact.locked) {
      return {
        ...common,
        actualBranch: exact.branchName,
        headCommit: exact.headCommit,
        state: "locked",
        safeToReuse: false,
        reason: exact.lockReason ?? "The worktree is locked",
      };
    }
    if (base !== undefined && !(await this.#isAncestor(base, exact.headCommit))) {
      return {
        ...common,
        actualBranch: exact.branchName,
        headCommit: exact.headCommit,
        state: "base-diverged",
        safeToReuse: false,
        reason: "The worktree branch no longer descends from its recorded base",
      };
    }
    const clean = await this.#isClean(input.path);
    return {
      ...common,
      actualBranch: exact.branchName,
      headCommit: exact.headCommit,
      state: clean ? "ready" : "dirty",
      safeToReuse: true,
      reason: clean
        ? "The exact managed branch and worktree are present"
        : "The exact managed worktree is present with preserved changes",
    };
  }

  async #removeExpected(
    expectedPath: string,
    expectedBranch: string,
    force: boolean,
  ): Promise<WorktreeRemoval> {
    return this.#serializeMutation(async () => {
      this.#assertExpectedPath(expectedPath);
      const targetKind = await pathKind(expectedPath);
      const worktrees = await this.listWorktrees();
      const exact = this.#findRecord(worktrees, expectedPath);
      if (exact === undefined) {
        if (targetKind !== "missing") {
          throw new GitRuntimeError(
            "GIT_WORKTREE_UNSAFE",
            `Refusing to remove unregistered path ${expectedPath}`,
            { expectedPath, targetKind },
          );
        }
        return {
          path: expectedPath,
          branchName: expectedBranch,
          removed: false,
          branchPreserved: true,
        };
      }
      if (exact.branchName !== expectedBranch) {
        throw new GitRuntimeError(
          "GIT_WORKTREE_COLLISION",
          `Refusing to remove ${expectedPath} because it uses ${String(exact.branchName)}`,
          { expectedBranch, actualBranch: exact.branchName },
        );
      }
      if (exact.locked) {
        throw new GitRuntimeError(
          "GIT_WORKTREE_LOCKED",
          `Refusing to remove locked worktree ${expectedPath}`,
          { reason: exact.lockReason },
        );
      }
      if (!(await this.#isClean(expectedPath)) && !force) {
        throw new GitRuntimeError(
          "GIT_WORKTREE_DIRTY",
          `Refusing to remove dirty worktree ${expectedPath} without force`,
          { expectedPath },
        );
      }
      await this.#runner.run(this.repositoryRoot, [
        "worktree",
        "remove",
        ...(force ? ["--force"] : []),
        expectedPath,
      ]);
      return {
        path: expectedPath,
        branchName: expectedBranch,
        removed: true,
        branchPreserved: true,
      };
    });
  }

  async #requireManagedRecord(
    expectedPath: string,
    expectedBranch: string,
  ): Promise<GitWorktreeRecord> {
    this.#assertExpectedPath(expectedPath);
    const worktrees = await this.listWorktrees();
    const exact = this.#findRecord(worktrees, expectedPath);
    if (
      exact === undefined ||
      exact.branchName !== expectedBranch ||
      exact.prunable
    ) {
      throw new GitRuntimeError(
        "GIT_WORKTREE_UNSAFE",
        `Expected managed worktree ${expectedPath} is unavailable`,
        {
          expectedBranch,
          actualBranch: exact?.branchName ?? null,
          prunable: exact?.prunable ?? false,
        },
      );
    }
    return exact;
  }

  #findRecord(
    records: readonly GitWorktreeRecord[],
    expectedPath: string,
  ): GitWorktreeRecord | undefined {
    const normalized = path.resolve(expectedPath);
    return records.find((record) => path.resolve(record.path) === normalized);
  }

  async #ensureParentFor(kind: "integration" | "task"): Promise<void> {
    const segments =
      kind === "integration"
        ? [this.repositoryId, this.buildId]
        : [this.repositoryId, this.buildId, "tasks"];
    await ensureManagedDirectory(this.worktreesRoot, segments);
  }

  #assertExpectedPath(expectedPath: string): void {
    const repositoryRoot = path.resolve(this.#repositoryWorktreesRoot);
    const candidate = path.resolve(expectedPath);
    if (
      !isPathInside(this.worktreesRoot, candidate) ||
      !isPathInside(repositoryRoot, candidate) ||
      candidate === this.repositoryRoot ||
      isPathInside(this.repositoryRoot, candidate)
    ) {
      throw new GitRuntimeError(
        "GIT_PATH_OUTSIDE_RUNTIME",
        `Worktree path ${candidate} is outside its AgentFlow repository namespace`,
        {
          worktreesRoot: this.worktreesRoot,
          repositoryWorktreesRoot: repositoryRoot,
          repositoryRoot: this.repositoryRoot,
        },
      );
    }
  }

  async #assertValidBranch(branch: string): Promise<void> {
    assertSafeConfiguredBranch(branch);
    try {
      await this.#runner.run(this.repositoryRoot, [
        "check-ref-format",
        "--branch",
        branch,
      ]);
    } catch (error) {
      throw new GitRuntimeError(
        "GIT_INVALID_BRANCH",
        `Branch ${JSON.stringify(branch)} is not valid`,
        { branch },
        { cause: error },
      );
    }
  }

  async #resolveBaseCommit(
    baseBranch: string,
    remote?: string,
  ): Promise<string> {
    const localReference = `refs/heads/${baseBranch}`;
    if (await this.#refExists(localReference)) {
      return this.#resolveCommit(localReference);
    }
    if (remote !== undefined) {
      assertSafeIdentifier("repository ID", remote);
      const remoteReference = `refs/remotes/${remote}/${baseBranch}`;
      if (await this.#refExists(remoteReference)) {
        return this.#resolveCommit(remoteReference);
      }
    }
    throw new GitRuntimeError(
      "GIT_INVALID_BRANCH",
      `Configured base branch ${baseBranch} does not exist locally${remote === undefined ? "" : ` or on ${remote}`}`,
      { baseBranch, remote: remote ?? null },
    );
  }

  async #resolveCommit(reference: string): Promise<string> {
    if (
      reference.length === 0 ||
      reference.startsWith("-") ||
      reference.includes("\0") ||
      reference.includes("\n") ||
      reference.includes("\r")
    ) {
      throw new GitRuntimeError(
        "GIT_INVALID_COMMIT",
        `Commit reference ${JSON.stringify(reference)} is unsafe`,
        { reference },
      );
    }
    try {
      const result = await this.#runner.run(this.repositoryRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${reference}^{commit}`,
      ]);
      return this.#validatedCommit(result.stdout.trim());
    } catch (error) {
      if (
        error instanceof GitRuntimeError &&
        error.code === "GIT_INVALID_COMMIT"
      ) {
        throw error;
      }
      throw new GitRuntimeError(
        "GIT_INVALID_COMMIT",
        `Commit ${JSON.stringify(reference)} cannot be resolved`,
        { reference },
        { cause: error },
      );
    }
  }

  #validatedCommit(commit: string): string {
    if (!COMMIT_HASH.test(commit)) {
      throw new GitRuntimeError(
        "GIT_INVALID_COMMIT",
        `Git returned invalid commit ID ${JSON.stringify(commit)}`,
        { commit },
      );
    }
    return commit;
  }

  async #branchExists(branch: string): Promise<boolean> {
    return this.#refExists(`refs/heads/${branch}`);
  }

  async #refExists(reference: string): Promise<boolean> {
    try {
      await this.#runner.run(this.repositoryRoot, [
        "show-ref",
        "--verify",
        "--quiet",
        reference,
      ]);
      return true;
    } catch (error) {
      if (
        error instanceof GitRuntimeError &&
        error.code === "GIT_COMMAND_FAILED" &&
        typeof error.details === "object" &&
        error.details !== null &&
        "exitCode" in error.details &&
        error.details.exitCode === 1
      ) {
        return false;
      }
      throw error;
    }
  }

  async #isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.#runner.run(this.repositoryRoot, [
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
      ]);
      return true;
    } catch (error) {
      if (
        error instanceof GitRuntimeError &&
        error.code === "GIT_COMMAND_FAILED" &&
        typeof error.details === "object" &&
        error.details !== null &&
        "exitCode" in error.details &&
        error.details.exitCode === 1
      ) {
        return false;
      }
      throw error;
    }
  }

  async #currentBranch(cwd: string): Promise<string | null> {
    try {
      const result = await this.#runner.run(cwd, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      return result.stdout.trim() || null;
    } catch (error) {
      if (
        error instanceof GitRuntimeError &&
        error.code === "GIT_COMMAND_FAILED" &&
        typeof error.details === "object" &&
        error.details !== null &&
        "exitCode" in error.details &&
        error.details.exitCode === 1
      ) {
        return null;
      }
      throw error;
    }
  }

  async #isClean(cwd: string): Promise<boolean> {
    const status = await this.#runner.run(cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    return status.stdout.length === 0;
  }

  async #mainCheckoutSnapshot(): Promise<RepositoryPreflight> {
    const status = await this.#runner.run(this.repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (status.stdout.length > 0) {
      throw new GitRuntimeError(
        "GIT_REPOSITORY_NOT_CLEAN",
        "The user's normal checkout must be clean before AgentFlow creates worktrees",
        { repositoryRoot: this.repositoryRoot },
      );
    }
    await this.#assertNoOperationInProgress();
    const branchName = await this.#currentBranch(this.repositoryRoot);
    const headCommit = await this.#resolveCommit("HEAD");
    return {
      repositoryRoot: this.repositoryRoot,
      branchName,
      headCommit,
      baseBranch: branchName ?? "(detached)",
      baseCommit: headCommit,
    };
  }

  async #assertMainCheckoutUnchanged(
    snapshot: RepositoryPreflight,
  ): Promise<void> {
    const current = await this.#mainCheckoutSnapshot();
    if (
      current.headCommit !== snapshot.headCommit ||
      current.branchName !== snapshot.branchName
    ) {
      throw new GitRuntimeError(
        "GIT_REPOSITORY_CHANGED_DURING_OPERATION",
        "The user's normal checkout changed while AgentFlow was managing worktrees",
        { before: snapshot, after: current },
      );
    }
  }

  async #assertNoOperationInProgress(): Promise<void> {
    const active: string[] = [];
    for (const marker of IN_PROGRESS_GIT_PATHS) {
      const gitPath = (
        await this.#runner.run(this.repositoryRoot, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          marker,
        ])
      ).stdout.trim();
      try {
        await lstat(gitPath);
        active.push(marker);
      } catch (error) {
        if (!isMissingPath(error)) {
          throw error;
        }
      }
    }
    if (active.length > 0) {
      throw new GitRuntimeError(
        "GIT_REPOSITORY_OPERATION_IN_PROGRESS",
        `The managed repository has an in-progress Git operation: ${active.join(", ")}`,
        { active },
      );
    }
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function splitNullPaths(source: string): string[] {
  return source.split("\0").filter((entry) => entry.length > 0);
}

function parseNameStatus(source: string): string[] {
  const fields = splitNullPaths(source);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    const tab = field.indexOf("\t");
    const status = tab === -1 ? field : field.slice(0, tab);
    const inlinePath = tab === -1 ? null : field.slice(tab + 1);
    const consumesTwoPaths = status.startsWith("R") || status.startsWith("C");
    if (inlinePath !== null) {
      paths.push(inlinePath);
      if (consumesTwoPaths) {
        const second = fields[++index];
        if (second !== undefined) {
          paths.push(second);
        }
      }
      continue;
    }
    const first = fields[++index];
    if (first !== undefined) {
      paths.push(first);
    }
    if (consumesTwoPaths) {
      const second = fields[++index];
      if (second !== undefined) {
        paths.push(second);
      }
    }
  }
  return paths;
}
