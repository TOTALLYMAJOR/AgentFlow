import { performance } from "node:perf_hooks";

import {
  DatabaseRepositories,
} from "../db/index.js";
import { GitWorktreeManager } from "../git/index.js";
import { IntegrationError, IntegrationMergeConflictError } from "./errors.js";
import {
  processIntegrationMutex,
  type KeyedMutex,
} from "./mutex.js";
import { WorktreeIntegrationGitRuntime } from "./git-runtime.js";
import { ProcessIntegrationValidationRunner } from "./validation-runner.js";

import type {
  ArtifactEntity,
  TaskDependencyEntity,
  TaskEntity,
} from "../db/index.js";
import type { ValidationCommandInput } from "../validation/index.js";
import type {
  IntegrateTaskInput,
  IntegrationGitRuntime,
  IntegrationPushOptions,
  IntegrationPushResult,
  IntegrationResult,
  IntegrationValidationRunner,
  IntegrationValidationSummary,
} from "./types.js";

export interface IntegrationManagerOptions {
  store: DatabaseRepositories;
  worktrees: GitWorktreeManager;
  validationRunner?: IntegrationValidationRunner;
  git?: IntegrationGitRuntime;
  mutex?: KeyedMutex;
}

export class IntegrationManager {
  readonly #store: DatabaseRepositories;
  readonly #worktrees: GitWorktreeManager;
  readonly #validationRunner: IntegrationValidationRunner;
  readonly #git: IntegrationGitRuntime;
  readonly #mutex: KeyedMutex;

  public constructor(options: IntegrationManagerOptions) {
    this.#store = options.store;
    this.#worktrees = options.worktrees;
    this.#validationRunner =
      options.validationRunner ?? new ProcessIntegrationValidationRunner();
    this.#git =
      options.git ?? new WorktreeIntegrationGitRuntime(options.worktrees);
    this.#mutex = options.mutex ?? processIntegrationMutex;
  }

  public integrate(input: IntegrateTaskInput): Promise<IntegrationResult> {
    return this.#mutex.runExclusive(this.#worktrees.buildId, async () =>
      this.#integrateLocked(input),
    );
  }

  async #integrateLocked(input: IntegrateTaskInput): Promise<IntegrationResult> {
    const build = this.#store.builds.getById(this.#worktrees.buildId);
    const task = this.#store.tasks.getById(input.taskId);
    this.#assertContext(build.id, build.integrationBranch, build.integrationWorktree, task);

    const taskBranch = task.branchName;
    const taskCommit = task.resultCommit;
    if (taskBranch === null || taskCommit === null) {
      throw new IntegrationError(
        "INTEGRATION_CONTEXT_MISMATCH",
        `Task ${task.id} has no validated branch and result commit`,
      );
    }
    const noChanges = task.resultCommit === task.baseCommit;
    if (noChanges && !task.allowNoChanges) {
      throw new IntegrationError(
        "INTEGRATION_CONTEXT_MISMATCH",
        `Task ${task.id} has no result commit beyond its base and does not allow no-change completion`,
      );
    }

    const previousHead = await this.#git.verifyReady({
      integrationBranch: build.integrationBranch,
      taskBranch,
      expectedTaskCommit: taskCommit,
    });
    if (isAbortRequested(input.signal)) {
      return this.#handleCancellation(task, previousHead, false, null);
    }
    this.#store.transitionTask(task.id, "integrating", {
      eventType: "task.integration_started",
      payload: { previousHead, taskBranch },
      errorCode: null,
      errorMessage: null,
    });

    let integrationCommit = previousHead;
    let mergePerformed = false;
    if (!noChanges) {
      try {
        integrationCommit = (
          await this.#git.merge(taskBranch, previousHead)
        ).integrationCommit;
        mergePerformed = true;
      } catch (error) {
        return this.#handleMergeFailure(
          task,
          taskBranch,
          previousHead,
          error,
        );
      }
    }
    if (isAbortRequested(input.signal)) {
      return this.#handleCancellation(
        task,
        previousHead,
        mergePerformed,
        null,
      );
    }

    const validationCommands =
      input.validationCommands ?? integrationCommands(build.repositoryConfig);
    const validation = await this.#runValidation({
      buildId: build.id,
      taskId: task.id,
      worktreePath: this.#git.integrationPath,
      commands: validationCommands,
      ...(input.validationTimeoutMs === undefined
        ? {}
        : { timeoutMs: input.validationTimeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    try {
      await input.onValidationCompleted?.(validation);
    } catch (error) {
      const rollbackError = await this.#rollback(previousHead);
      const errorCode =
        rollbackError === null
          ? "INTEGRATION_EVIDENCE_PERSISTENCE_FAILED"
          : "INTEGRATION_ROLLBACK_FAILED";
      const errorMessage = `Could not persist integration validation evidence: ${message(
        error,
      )}${
        rollbackError === null ? "" : `; rollback failed: ${rollbackError}`
      }`;
      this.#recordFailure(task.id, errorCode, errorMessage, {
        previousHead,
        attemptedCommit: integrationCommit,
        validationStatus: validation.status,
      });
      return this.#result({
        task,
        status:
          rollbackError === null ? "persistence_failed" : "rollback_failed",
        previousHead,
        mergePerformed,
        validation,
        errorCode,
        errorMessage,
      });
    }
    if (
      validation.status === "cancelled" ||
      isAbortRequested(input.signal)
    ) {
      return this.#handleCancellation(
        task,
        previousHead,
        mergePerformed,
        validation,
      );
    }
    if (validation.status !== "passed") {
      const rollbackError = await this.#rollback(previousHead);
      const errorCode =
        rollbackError === null
          ? "INTEGRATION_VALIDATION_FAILED"
          : "INTEGRATION_ROLLBACK_FAILED";
      const errorMessage =
        rollbackError === null
          ? validation.errorMessage ?? "Integration validation failed"
          : `Integration validation failed and rollback failed: ${rollbackError}`;
      this.#recordFailure(task.id, errorCode, errorMessage, {
        previousHead,
        attemptedCommit: integrationCommit,
        validationStatus: validation.status,
      });
      return this.#result({
        task,
        status:
          rollbackError === null ? "validation_failed" : "rollback_failed",
        previousHead,
        mergePerformed,
        validation,
        errorCode,
        errorMessage,
      });
    }

    if (isAbortRequested(input.signal)) {
      return this.#handleCancellation(
        task,
        previousHead,
        mergePerformed,
        validation,
      );
    }
    let releasedTaskIds: string[];
    try {
      releasedTaskIds = this.#recordSuccess(
        task,
        integrationCommit,
        validation,
        mergePerformed,
      );
    } catch (error) {
      const rollbackError = await this.#rollback(previousHead);
      const errorMessage = `Could not persist integration success: ${message(
        error,
      )}${
        rollbackError === null ? "" : `; rollback failed: ${rollbackError}`
      }`;
      if (this.#store.tasks.getById(task.id).state === "integrating") {
        this.#recordFailure(
          task.id,
          rollbackError === null
            ? "INTEGRATION_PERSISTENCE_FAILED"
            : "INTEGRATION_ROLLBACK_FAILED",
          errorMessage,
          { previousHead, attemptedCommit: integrationCommit },
        );
      }
      return this.#result({
        task,
        status:
          rollbackError === null ? "persistence_failed" : "rollback_failed",
        previousHead,
        mergePerformed,
        validation,
        errorCode:
          rollbackError === null
            ? "INTEGRATION_PERSISTENCE_FAILED"
            : "INTEGRATION_ROLLBACK_FAILED",
        errorMessage,
      });
    }

    if (isAbortRequested(input.signal)) {
      return this.#result({
        task,
        status: "integrated",
        previousHead,
        integrationCommit,
        mergePerformed,
        validation,
        releasedTaskIds,
      });
    }
    const pushes = await this.#pushValidatedBranches(
      taskBranch,
      build.integrationBranch,
      input.push,
      build.repositoryConfig,
      build.repositoryId,
    );
    return {
      ...this.#result({
        task,
        status: "integrated",
        previousHead,
        integrationCommit,
        mergePerformed,
        validation,
        releasedTaskIds,
      }),
      pushes,
    };
  }

  async #handleCancellation(
    task: TaskEntity,
    previousHead: string,
    mergePerformed: boolean,
    validation: IntegrationValidationSummary | null,
  ): Promise<IntegrationResult> {
    const rollbackError = mergePerformed
      ? await this.#rollback(previousHead)
      : null;
    if (rollbackError !== null) {
      if (this.#store.tasks.getById(task.id).state === "integrating") {
        this.#recordFailure(
          task.id,
          "INTEGRATION_ROLLBACK_FAILED",
          `Integration was cancelled but rollback failed: ${rollbackError}`,
          { previousHead },
        );
      } else {
        this.#store.events.append({
          buildId: task.buildId,
          taskId: task.id,
          type: "integration.rollback_failed_after_cancel",
          payload: { previousHead, error: rollbackError },
        });
      }
      return this.#result({
        task,
        status: "rollback_failed",
        previousHead,
        mergePerformed,
        validation,
        errorCode: "INTEGRATION_ROLLBACK_FAILED",
        errorMessage: rollbackError,
      });
    }
    this.#store.transaction((store) => {
      const current = store.tasks.getById(task.id);
      if (["validated", "integrating"].includes(current.state)) {
        store.tasks.transition(task.id, "cancelled", {
          eventType: "task.integration_cancelled",
          errorCode: "INTEGRATION_CANCELLED",
          errorMessage: "Integration was cancelled and rolled back",
        });
      }
      store.events.append({
        buildId: task.buildId,
        taskId: task.id,
        type: "integration.cancelled",
        payload: { previousHead, mergePerformed },
      });
    });
    return this.#result({
      task,
      status: "cancelled",
      previousHead,
      mergePerformed,
      validation,
      errorCode: "INTEGRATION_CANCELLED",
      errorMessage: "Integration was cancelled and rolled back",
    });
  }

  #assertContext(
    buildId: string,
    integrationBranch: string,
    integrationWorktree: string | null,
    task: TaskEntity,
  ): void {
    if (task.buildId !== buildId) {
      throw new IntegrationError(
        "INTEGRATION_BUILD_MISMATCH",
        `Task ${task.id} does not belong to build ${buildId}`,
      );
    }
    if (task.state !== "validated") {
      throw new IntegrationError(
        "INTEGRATION_TASK_NOT_VALIDATED",
        `Task ${task.id} must be validated before integration`,
        { state: task.state },
      );
    }
    const expectedTaskBranch = this.#worktrees.taskBranch(task.id);
    const expectedTaskPath = this.#worktrees.taskPath(task.id);
    if (
      integrationBranch !== this.#worktrees.integrationBranch() ||
      integrationWorktree !== this.#git.integrationPath ||
      task.branchName !== expectedTaskBranch ||
      task.worktreePath !== expectedTaskPath
    ) {
      throw new IntegrationError(
        "INTEGRATION_CONTEXT_MISMATCH",
        "Persisted build or task Git context does not match the managed worktrees",
        {
          integrationBranch,
          integrationWorktree,
          taskBranch: task.branchName,
          taskWorktree: task.worktreePath,
        },
      );
    }
  }

  async #handleMergeFailure(
    task: TaskEntity,
    taskBranch: string,
    previousHead: string,
    error: unknown,
  ): Promise<IntegrationResult> {
    const conflict =
      error instanceof IntegrationMergeConflictError ? error : null;
    let cleanupError: string | null = null;
    try {
      await this.#git.abortMerge();
    } catch (abortError) {
      cleanupError = message(abortError);
      const resetError = await this.#rollback(previousHead);
      if (resetError !== null) {
        cleanupError = `${cleanupError}; reset failed: ${resetError}`;
      } else {
        cleanupError = null;
      }
    }

    const errorCode =
      cleanupError !== null
        ? "INTEGRATION_ROLLBACK_FAILED"
        : conflict === null
          ? "INTEGRATION_MERGE_FAILED"
          : "INTEGRATION_MERGE_CONFLICT";
    const errorMessage =
      cleanupError !== null
        ? `Merge failed and integration cleanup failed: ${cleanupError}`
        : message(error);
    this.#recordFailure(task.id, errorCode, errorMessage, {
      previousHead,
      taskBranch,
      conflictPaths: conflict?.conflictPaths ?? [],
    });
    return this.#result({
      task,
      status:
        cleanupError !== null
          ? "rollback_failed"
          : conflict === null
            ? "merge_failed"
            : "merge_conflict",
      previousHead,
      conflictPaths: conflict?.conflictPaths ?? [],
      errorCode,
      errorMessage,
    });
  }

  async #runValidation(
    request: Parameters<IntegrationValidationRunner["run"]>[0],
  ): Promise<IntegrationValidationSummary> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    try {
      return await this.#validationRunner.run(request);
    } catch (error) {
      return {
        status: "failed",
        commands: [],
        errorMessage: message(error),
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, performance.now() - started),
      };
    }
  }

  #recordSuccess(
    task: TaskEntity,
    integrationCommit: string,
    validation: IntegrationValidationSummary,
    mergePerformed: boolean,
  ): string[] {
    return this.#store.transaction((store) => {
      store.events.append({
        buildId: task.buildId,
        taskId: task.id,
        type: "integration.validation_passed",
        payload: {
          integrationCommit,
          mergePerformed,
          commandCount: validation.commands.length,
          durationMs: validation.durationMs,
        },
      });
      for (const artifact of store.artifacts
        .listForBuild(task.buildId)
        .filter(isIntegrableArtifactFor(task.id))) {
        store.artifacts.setStatus(artifact.id, "integrated");
      }
      store.recordIntegrationSuccess(task.id, { integrationCommit });
      const releasedTaskIds = releaseDependents(store, task);
      store.events.append({
        buildId: task.buildId,
        taskId: task.id,
        type: "integration.completed",
        payload: { integrationCommit, mergePerformed, releasedTaskIds },
      });
      return releasedTaskIds;
    });
  }

  #recordFailure(
    taskId: string,
    errorCode: string,
    errorMessage: string,
    payload: Record<string, unknown>,
  ): void {
    this.#store.transaction((store) => {
      const task = store.recordIntegrationFailure(taskId, {
        errorCode,
        errorMessage,
      });
      store.events.append({
        buildId: task.buildId,
        taskId,
        type: "integration.failed",
        payload: { errorCode, errorMessage, ...payload },
      });
    });
  }

  async #rollback(previousHead: string): Promise<string | null> {
    try {
      await this.#git.resetAndClean(previousHead);
      return null;
    } catch (error) {
      return message(error);
    }
  }

  async #pushValidatedBranches(
    taskBranch: string,
    integrationBranch: string,
    requested: IntegrationPushOptions | undefined,
    repositoryConfig: Record<string, unknown>,
    repositoryId: string,
  ): Promise<IntegrationResult["pushes"]> {
    const configured = gitPushConfiguration(repositoryConfig);
    const repository = this.#store.repositories.getById(repositoryId);
    const remote =
      requested?.remote ??
      configured.remote ??
      repository.remoteName ??
      "origin";
    const task = await this.#pushOne(
      remote,
      taskBranch,
      requested?.taskBranch ?? configured.taskBranch,
    );
    const integration = await this.#pushOne(
      remote,
      integrationBranch,
      requested?.integrationBranch ?? configured.integrationBranch,
    );
    return { task, integration };
  }

  async #pushOne(
    remote: string,
    branch: string,
    enabled: boolean,
  ): Promise<IntegrationPushResult> {
    if (!enabled) {
      return {
        branch,
        attempted: false,
        succeeded: false,
        error: null,
      };
    }
    try {
      await this.#git.push(remote, branch);
      this.#store.events.append({
        buildId: this.#worktrees.buildId,
        type: "integration.branch_pushed",
        payload: { remote, branch },
      });
      return { branch, attempted: true, succeeded: true, error: null };
    } catch (error) {
      const errorText = message(error);
      this.#store.events.append({
        buildId: this.#worktrees.buildId,
        type: "integration.push_failed",
        payload: { remote, branch, error: errorText },
      });
      return {
        branch,
        attempted: true,
        succeeded: false,
        error: errorText,
      };
    }
  }

  #result(
    input: {
      task: TaskEntity;
      status: IntegrationResult["status"];
      previousHead: string;
      integrationCommit?: string | null;
      mergePerformed?: boolean;
      conflictPaths?: string[];
      validation?: IntegrationValidationSummary | null;
      releasedTaskIds?: string[];
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): IntegrationResult {
    const noTaskPush = disabledPush(input.task.branchName ?? "");
    const noIntegrationPush = disabledPush(this.#worktrees.integrationBranch());
    return {
      buildId: input.task.buildId,
      taskId: input.task.id,
      status: input.status,
      previousHead: input.previousHead,
      integrationCommit: input.integrationCommit ?? null,
      mergePerformed: input.mergePerformed ?? false,
      conflictPaths: input.conflictPaths ?? [],
      validation: input.validation ?? null,
      releasedTaskIds: input.releasedTaskIds ?? [],
      pushes: {
        task: noTaskPush,
        integration: noIntegrationPush,
      },
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
    };
  }
}

function isIntegrableArtifactFor(
  taskId: string,
): (artifact: ArtifactEntity) => boolean {
  return (artifact) =>
    artifact.producerTaskId === taskId &&
    (artifact.status === "produced" || artifact.status === "validated");
}

function releaseDependents(
  store: DatabaseRepositories,
  integratedTask: TaskEntity,
): string[] {
  const released: string[] = [];
  const tasks = store.tasks.listForBuild(integratedTask.buildId);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const artifacts = store.artifacts.listForBuild(integratedTask.buildId);
  const pendingApprovals = store.approvals.listPending(integratedTask.buildId);

  for (const task of tasks) {
    if (!["pending", "blocked", "blocked_failed"].includes(task.state)) {
      continue;
    }
    const dependencies = store.tasks.listDependencies(task.id);
    if (
      !dependencies.some(
        (dependency) => dependency.dependencyTaskId === integratedTask.id,
      ) ||
      !dependencies.every((dependency) =>
        dependencyAvailable(dependency, byId, artifacts),
      ) ||
      pendingApprovals.some(
        (approval) => approval.taskId === null || approval.taskId === task.id,
      )
    ) {
      continue;
    }
    store.transitionTask(task.id, "ready", {
      eventType: "task.dependencies_released",
      payload: { integratedTaskId: integratedTask.id },
      errorCode: null,
      errorMessage: null,
    });
    released.push(task.id);
  }
  return released;
}

function dependencyAvailable(
  dependency: TaskDependencyEntity,
  tasks: ReadonlyMap<string, TaskEntity>,
  artifacts: readonly ArtifactEntity[],
): boolean {
  if (tasks.get(dependency.dependencyTaskId)?.state !== "integrated") {
    return false;
  }
  if (
    dependency.requiredArtifactName === null ||
    dependency.requiredArtifactVersion === null
  ) {
    return true;
  }
  return artifacts.some(
    (artifact) =>
      artifact.producerTaskId === dependency.dependencyTaskId &&
      artifact.name === dependency.requiredArtifactName &&
      artifact.version === dependency.requiredArtifactVersion &&
      artifact.status === "integrated",
  );
}

function integrationCommands(
  repositoryConfig: Record<string, unknown>,
): readonly ValidationCommandInput[] {
  const validation = repositoryConfig["validation"];
  if (
    typeof validation !== "object" ||
    validation === null ||
    Array.isArray(validation)
  ) {
    return [];
  }
  const integration = (validation as Record<string, unknown>)["integration"];
  if (integration === undefined) {
    return [];
  }
  if (
    !Array.isArray(integration) ||
    !integration.every((command) => typeof command === "string")
  ) {
    throw new IntegrationError(
      "INTEGRATION_CONTEXT_MISMATCH",
      "repositoryConfig.validation.integration must be an array of commands",
    );
  }
  return integration;
}

function gitPushConfiguration(repositoryConfig: Record<string, unknown>): {
  remote: string | null;
  taskBranch: boolean;
  integrationBranch: boolean;
} {
  const git = repositoryConfig["git"];
  if (typeof git !== "object" || git === null || Array.isArray(git)) {
    return { remote: null, taskBranch: false, integrationBranch: false };
  }
  const record = git as Record<string, unknown>;
  return {
    remote: typeof record["remote"] === "string" ? record["remote"] : null,
    taskBranch: record["push_task_branches"] === true,
    integrationBranch: record["push_integration_branch"] === true,
  };
}

function disabledPush(branch: string): IntegrationPushResult {
  return {
    branch,
    attempted: false,
    succeeded: false,
    error: null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
