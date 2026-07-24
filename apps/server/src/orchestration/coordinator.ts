import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BuildEntity,
  DatabaseRepositories,
  TaskEntity,
  ValidationStatus,
  ValidationType,
  WorkerEntity,
} from "../db/index.js";
import type {
  PlanResult,
  PlannedTask,
  TaskStatus,
} from "../domain/types.js";
import {
  GitCommandRunner,
  GitWorktreeManager,
} from "../git/index.js";
import {
  IntegrationManager,
  type IntegrationResult,
} from "../integration/index.js";
import {
  AgentFlowRepositoryConfigSchema,
  type AgentFlowRepositoryConfig,
  type RepositoryService,
} from "../repositories/index.js";
import type { AgentFlowEnvironment } from "../config/environment.js";
import type { HandoffManifestService } from "../artifacts/index.js";
import {
  DEFAULT_FORBIDDEN_CHANGED_PATHS,
  validateTask,
  type TaskValidationSummary,
  type ValidationCommandOutcome,
} from "../validation/index.js";
import {
  startCodexWorker,
  type CodexWorkerHandle,
  type WorkerContextDocument,
  type WorkerOutcome,
  type WorkerRuntimeEvent,
} from "../workers/index.js";
import { createId } from "../util/ids.js";
import { AgentFlowError } from "../http/errors.js";
import { scheduleTasks, type SchedulingTask } from "./scheduler.js";
import { TaskCommitService } from "./task-commit.js";

interface ActiveWorker {
  buildId: string;
  taskId: string;
  workerId: string;
  handle: CodexWorkerHandle;
}

export interface BuildCoordinatorOptions {
  environment: AgentFlowEnvironment;
  store: DatabaseRepositories;
  repositoryService: RepositoryService;
  handoffService: HandoffManifestService;
}

export class BuildCoordinator {
  private readonly environment: AgentFlowEnvironment;
  private readonly store: DatabaseRepositories;
  private readonly repositoryService: RepositoryService;
  private readonly handoffService: HandoffManifestService;
  private readonly commitService = new TaskCommitService();
  private readonly worktrees = new Map<string, GitWorktreeManager>();
  private readonly integrations = new Map<string, IntegrationManager>();
  private readonly activeWorkers = new Map<string, ActiveWorker>();
  private readonly dispatching = new Set<string>();
  private readonly tickRunning = new Set<string>();
  private readonly tickRequested = new Set<string>();
  private readonly tickOperations = new Map<string, Promise<void>>();
  private readonly taskOperations = new Map<string, Promise<void>>();
  private readonly taskAbortControllers = new Map<string, AbortController>();
  private readonly shuttingDownTasks = new Set<string>();
  private readonly monitorTimers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(options: BuildCoordinatorOptions) {
    this.environment = options.environment;
    this.store = options.store;
    this.repositoryService = options.repositoryService;
    this.handoffService = options.handoffService;
  }

  async start(buildId: string): Promise<BuildEntity> {
    const build = this.store.builds.getById(buildId);
    if (build.status !== "ready") {
      throw new Error(`Build ${buildId} cannot start from ${build.status}`);
    }
    await this.ensureRuntime(build);
    const running = this.store.builds.transition(buildId, "running", {
      eventType: "build.started",
    });
    this.requestTick(buildId);
    return running;
  }

  pause(buildId: string): BuildEntity {
    return this.store.builds.transition(buildId, "paused", {
      eventType: "build.paused",
    });
  }

  async resume(buildId: string): Promise<BuildEntity> {
    const build = this.store.builds.getById(buildId);
    if (!["paused", "interrupted"].includes(build.status)) {
      throw new Error(`Build ${buildId} cannot resume from ${build.status}`);
    }
    await this.ensureRuntime(build);
    for (const task of this.store.tasks.listForBuild(buildId)) {
      if (
        task.state === "integrated" &&
        this.store.manifests.findForTask(
          task.id,
          "integrated",
          task.attempt,
        ) === undefined
      ) {
        await this.recoverIntegratedManifest(build, task);
      }
    }
    const running = this.store.builds.transition(buildId, "running", {
      eventType: "build.resumed",
    });
    this.requestTick(buildId);
    return running;
  }

  cancel(buildId: string): BuildEntity {
    const build = this.store.builds.transition(buildId, "cancelled", {
      eventType: "build.cancelled",
    });
    for (const task of this.store.tasks.listForBuild(buildId)) {
      this.taskAbortControllers.get(task.id)?.abort();
    }
    for (const active of this.activeWorkers.values()) {
      if (active.buildId === buildId) {
        active.handle.cancel();
      }
    }
    for (const task of this.store.tasks.listForBuild(buildId)) {
      if (
        [
          "integrated",
          "failed",
          "cancelled",
          "blocked_failed",
        ].includes(task.state)
      ) {
        continue;
      }
      this.store.tasks.transition(task.id, "cancelled", {
        eventType: "task.cancelled",
      });
    }
    return build;
  }

  async retry(buildId: string, taskId: string): Promise<TaskEntity> {
    const task = this.store.tasks.getById(taskId);
    if (task.buildId !== buildId) {
      throw new Error(`Task ${taskId} does not belong to build ${buildId}`);
    }
    if (
      this.taskOperations.has(taskId) ||
      this.taskAbortControllers.has(taskId) ||
      this.dispatching.has(taskId) ||
      this.activeWorkers.has(taskId)
    ) {
      throw new AgentFlowError(
        "TASK_OPERATION_IN_PROGRESS",
        `Task ${taskId} still has an active execution operation`,
        409,
      );
    }
    if (!["failed", "blocked_failed", "interrupted"].includes(task.state)) {
      throw new AgentFlowError(
        "TASK_NOT_RETRYABLE",
        `Task ${taskId} cannot be retried from ${task.state}`,
        409,
      );
    }
    const build = this.store.builds.getById(buildId);
    if (
      !["ready", "running", "paused", "interrupted", "failed"].includes(
        build.status,
      )
    ) {
      throw new AgentFlowError(
        "BUILD_NOT_RETRYABLE",
        `Build ${buildId} cannot accept a retry from ${build.status}`,
        409,
      );
    }
    let reactivated = false;
    if (build.status === "failed") {
      const activeBuild = this.store.builds.findActive();
      if (activeBuild !== undefined && activeBuild.id !== buildId) {
        throw new AgentFlowError(
          "ACTIVE_BUILD_EXISTS",
          `Build ${buildId} cannot be retried while ${activeBuild.id} is active`,
          409,
        );
      }
      this.store.builds.transition(buildId, "running", {
        eventType: "build.retry_started",
        payload: { taskId },
        actualElapsedSeconds: null,
      });
      reactivated = true;
      try {
        await this.ensureRuntime(build);
      } catch (error) {
        if (this.store.builds.getById(buildId).status === "running") {
          this.store.builds.transition(buildId, "failed", {
            eventType: "build.retry_setup_failed",
            payload: { taskId, message: errorMessage(error) },
            actualElapsedSeconds: build.actualElapsedSeconds,
          });
        }
        throw error;
      }
      if (this.store.builds.getById(buildId).status !== "running") {
        throw new AgentFlowError(
          "BUILD_RETRY_INTERRUPTED",
          `Build ${buildId} changed state while preparing the retry`,
          409,
        );
      }
    }
    let retried: TaskEntity;
    try {
      retried = this.store.tasks.retry(taskId);
    } catch (error) {
      if (
        reactivated &&
        this.store.builds.getById(buildId).status === "running"
      ) {
        this.store.builds.transition(buildId, "failed", {
          eventType: "build.retry_task_failed",
          payload: { taskId, message: errorMessage(error) },
          actualElapsedSeconds: build.actualElapsedSeconds,
        });
      }
      throw error;
    }
    this.requestTick(buildId);
    return retried;
  }

  async resumeValidation(build: BuildEntity, task: TaskEntity): Promise<void> {
    await this.ensureRuntime(build);
    this.startRecoveredTaskOperation(build.id, task.id, (signal) =>
      this.validateCommitAndIntegrate(build.id, task.id, true, signal),
    );
  }

  async queueIntegration(build: BuildEntity, task: TaskEntity): Promise<void> {
    await this.ensureRuntime(build);
    this.startRecoveredTaskOperation(build.id, task.id, (signal) =>
      this.integrateValidatedTask(build.id, task.id, signal),
    );
  }

  private startRecoveredTaskOperation(
    buildId: string,
    taskId: string,
    run: (signal: AbortSignal) => Promise<void>,
  ): void {
    if (this.taskOperations.has(taskId)) {
      return;
    }
    const controller = new AbortController();
    this.taskAbortControllers.set(taskId, controller);
    const operation = run(controller.signal)
      .catch((error: unknown) => {
        if (!this.closed) {
          this.store.events.append({
            buildId,
            taskId,
            type: "task.recovered_pipeline_unhandled_error",
            payload: { message: errorMessage(error) },
          });
        }
      })
      .finally(() => {
        if (this.taskOperations.get(taskId) === operation) {
          this.taskOperations.delete(taskId);
          if (this.taskAbortControllers.get(taskId) === controller) {
            this.taskAbortControllers.delete(taskId);
          }
        }
        this.requestTick(buildId);
      });
    this.taskOperations.set(taskId, operation);
    void operation;
  }

  async recoverIntegratedManifest(
    build: BuildEntity,
    task: TaskEntity,
  ): Promise<void> {
    if (
      this.store.manifests.findForTask(
        task.id,
        "integrated",
        task.attempt,
      ) !== undefined
    ) {
      return;
    }
    const latest = this.store.tasks.getById(task.id);
    const plannedTask = findPlannedTask(build, latest);
    const worktreePath =
      latest.worktreePath !== null &&
      (await pathExists(latest.worktreePath))
        ? latest.worktreePath
        : build.integrationWorktree;
    if (
      worktreePath === null ||
      latest.baseCommit === null ||
      latest.resultCommit === null ||
      latest.integrationCommit === null ||
      latest.branchName === null
    ) {
      throw new Error(
        `Cannot recover integrated manifest for ${latest.id}: Git context is incomplete`,
      );
    }
    await this.handoffService.publish({
      buildId: build.id,
      taskId: latest.id,
      backlogTaskId: latest.backlogTaskId,
      attempt: latest.attempt,
      status: "integrated",
      baseCommit: latest.baseCommit,
      resultCommit: latest.resultCommit,
      integrationCommit: latest.integrationCommit,
      branch: latest.branchName,
      worktreePath,
      changedFiles: this.store.tasks
        .listChangedFiles(latest.id, latest.attempt)
        .map((change) => change.path),
      consumes: plannedTask.consumes.map((artifact) => ({
        name: artifact.artifact,
        version: artifact.version,
      })),
      produces: plannedTask.produces,
    });
  }

  monitorExistingProcess(
    build: BuildEntity,
    task: TaskEntity,
    worker: WorkerEntity,
  ): void {
    if (
      worker.processId === null ||
      this.monitorTimers.has(task.id)
    ) {
      return;
    }
    const timer = setInterval(() => {
      if (isProcessAlive(worker.processId)) {
        return;
      }
      clearInterval(timer);
      this.monitorTimers.delete(task.id);
      const current = this.store.tasks.getById(task.id);
      if (current.state === "running" && current.resultCommit === null) {
        this.store.tasks.transition(task.id, "interrupted", {
          eventType: "recovery.monitored_process_ended",
          errorCode: "WORKER_PROCESS_DISAPPEARED",
          errorMessage:
            "A worker preserved across restart ended without a recorded result",
        });
        const attempt = this.store.tasks
          .listAttempts(task.id)
          .find((candidate) => candidate.attempt === current.attempt);
        if (attempt?.status === "running") {
          this.store.tasks.updateAttempt(task.id, current.attempt, {
            status: "interrupted",
            errorCode: "WORKER_PROCESS_DISAPPEARED",
            errorMessage:
              "The recovered worker process ended without a recorded result",
            completedAt: new Date().toISOString(),
          });
        }
      }
      const latestWorker = this.store.workers.getById(worker.id);
      if (
        ["starting", "running", "stopping"].includes(latestWorker.status)
      ) {
        this.store.workers.release(worker.id, "failed");
        this.store.workers.recycle(worker.id);
      }
      this.requestTick(build.id);
    }, 5_000);
    timer.unref();
    this.monitorTimers.set(task.id, timer);
  }

  requestTick(buildId: string): void {
    if (this.closed) {
      return;
    }
    this.tickRequested.add(buildId);
    if (this.tickRunning.has(buildId)) {
      return;
    }
    this.tickRunning.add(buildId);
    const operation = this.runTickLoop(buildId).finally(() => {
      this.tickRunning.delete(buildId);
      this.tickOperations.delete(buildId);
      if (this.tickRequested.has(buildId)) {
        this.requestTick(buildId);
      }
    });
    this.tickOperations.set(buildId, operation);
    void operation;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.tickRequested.clear();
    for (const timer of this.monitorTimers.values()) {
      clearInterval(timer);
    }
    this.monitorTimers.clear();
    await Promise.allSettled(this.tickOperations.values());
    const completions: Promise<WorkerOutcome>[] = [];
    for (const taskId of this.taskOperations.keys()) {
      const active = this.activeWorkers.get(taskId);
      if (active !== undefined) {
        this.shuttingDownTasks.add(taskId);
        active.handle.cancel();
        completions.push(active.handle.completion);
        continue;
      }
      const task = this.store.tasks.getById(taskId);
      if (task.state === "running") {
        this.shuttingDownTasks.add(taskId);
        this.taskAbortControllers.get(taskId)?.abort();
      }
    }
    for (const active of this.activeWorkers.values()) {
      if (this.shuttingDownTasks.has(active.taskId)) {
        continue;
      }
      this.shuttingDownTasks.add(active.taskId);
      active.handle.cancel();
      completions.push(active.handle.completion);
    }
    await Promise.allSettled(completions);
    await Promise.allSettled(this.taskOperations.values());
  }

  private async runTickLoop(buildId: string): Promise<void> {
    while (this.tickRequested.delete(buildId)) {
      try {
        await this.tickOnce(buildId);
      } catch (error) {
        this.store.events.append({
          buildId,
          type: "scheduler.error",
          payload: { message: errorMessage(error) },
        });
        const build = this.store.builds.getById(buildId);
        if (build.status === "running") {
          this.store.builds.transition(buildId, "paused", {
            eventType: "scheduler.paused_after_error",
            payload: { message: errorMessage(error) },
          });
        }
      }
    }
  }

  private async tickOnce(buildId: string): Promise<void> {
    const build = this.store.builds.getById(buildId);
    if (build.status !== "running") {
      return;
    }
    await this.ensureRuntime(build);
    if (this.store.builds.getById(buildId).status !== "running") {
      return;
    }
    const tasks = this.store.tasks.listForBuild(buildId);
    if (this.completeBuildIfTerminal(build, tasks)) {
      return;
    }
    const candidateIds = tasks
      .filter((task) => ["pending", "blocked", "ready"].includes(task.state))
      .map((task) => task.id);
    const cycle = this.store.scheduler.advance(buildId, candidateIds);
    const plan = asPlan(build.normalizedPlan);
    const criticalPath = new Set(plan.estimates.criticalPathTaskIds);
    const artifacts = this.store.artifacts.listForBuild(buildId);
    const pendingApprovals = this.store.approvals.listPending(buildId);
    const schedulingTasks: SchedulingTask[] = tasks.map((task) => {
      const dependencies = this.store.tasks.listDependencies(task.id);
      return {
        id: task.id,
        state: task.state,
        dependencyIds: [
          ...new Set(
            dependencies.map((dependency) => dependency.dependencyTaskId),
          ),
        ],
        owns: this.store.tasks.listOwnedPaths(task.id),
        artifactRequirements: dependencies.flatMap((dependency) => {
          if (
            dependency.requiredArtifactName === null ||
            dependency.requiredArtifactVersion === null
          ) {
            return [];
          }
          const artifact = artifacts.find(
            (candidate) =>
              candidate.name === dependency.requiredArtifactName &&
              candidate.version === dependency.requiredArtifactVersion,
          );
          return [
            {
              name: dependency.requiredArtifactName,
              version: dependency.requiredArtifactVersion,
              status: artifact?.status ?? "missing",
            },
          ];
        }),
        criticalPath: criticalPath.has(task.backlogTaskId),
        readyAgeCycles: cycle.readyAgeCycles[task.id] ?? 0,
        riskScore: task.riskScore,
        approvalOutstanding: pendingApprovals.some(
          (approval) => approval.taskId === null || approval.taskId === task.id,
        ),
      };
    });
    const activeTaskIds = tasks
      .filter(
        (task) =>
          taskStateIsActive(task.state) || this.dispatching.has(task.id),
      )
      .map((task) => task.id);
    const assignedWorkerCount =
      this.store.workers
        .listForBuild(buildId)
        .filter((worker) =>
          ["starting", "running", "stopping"].includes(worker.status),
        ).length + this.dispatching.size;
    const decision = scheduleTasks(
      build.status,
      schedulingTasks,
      activeTaskIds,
      build.workerLimit,
      assignedWorkerCount,
    );
    for (const ranking of decision.rankings) {
      this.store.tasks.setRanking(
        ranking.taskId,
        ranking.explanation.score,
        `${ranking.reason}; ${ranking.explanation.summary}`,
      );
    }
    for (const taskId of decision.blockedFailedTaskIds) {
      const task = this.store.tasks.getById(taskId);
      if (["pending", "blocked", "ready"].includes(task.state)) {
        this.store.tasks.transition(taskId, "blocked_failed", {
          eventType: "task.blocked_by_failed_dependency",
          errorCode: "DEPENDENCY_FAILED",
          errorMessage: "A required dependency did not integrate",
        });
      }
    }
    if (decision.deadlock !== null) {
      this.store.events.append({
        buildId,
        type: "scheduler.deadlock",
        payload: { diagnostic: decision.deadlock, cycle: cycle.cycle },
      });
      this.store.builds.transition(buildId, "paused", {
        eventType: "scheduler.deadlock_paused",
        payload: { diagnostic: decision.deadlock },
      });
      return;
    }
    const idleWorkers = this.store.workers
      .listForBuild(buildId)
      .filter((worker) => worker.status === "idle" && worker.taskId === null)
      .sort((first, second) => first.id.localeCompare(second.id));
    for (const [index, taskId] of decision.selectedTaskIds.entries()) {
      if (this.closed) {
        break;
      }
      const worker = idleWorkers[index];
      if (worker === undefined) {
        break;
      }
      this.dispatching.add(taskId);
      const controller = new AbortController();
      this.taskAbortControllers.set(taskId, controller);
      const operation = this.executeTask(
        buildId,
        taskId,
        worker.id,
        controller.signal,
      )
        .catch((error: unknown) => {
          if (!this.closed) {
            this.store.events.append({
              buildId,
              taskId,
              type: "task.pipeline_unhandled_error",
              payload: { message: errorMessage(error) },
            });
          }
        })
        .finally(() => {
          if (this.taskOperations.get(taskId) === operation) {
            this.dispatching.delete(taskId);
            this.taskOperations.delete(taskId);
            if (this.taskAbortControllers.get(taskId) === controller) {
              this.taskAbortControllers.delete(taskId);
            }
          }
          this.requestTick(buildId);
        });
      this.taskOperations.set(taskId, operation);
      void operation;
    }
    this.store.events.append({
      buildId,
      type: "scheduler.cycle",
      payload: {
        cycle: cycle.cycle,
        selectedTaskIds: decision.selectedTaskIds,
        activeTaskIds,
      },
    });
  }

  private async executeTask(
    buildId: string,
    taskId: string,
    workerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let assigned = false;
    try {
      const build = this.store.builds.getById(buildId);
      const task = this.store.tasks.getById(taskId);
      const manager = await this.ensureRuntime(build);
      const integrationHead = (
        await new GitCommandRunner().run(manager.integrationPath(), [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ])
      ).stdout.trim();
      const worktree = await manager.createTaskWorktree({
        taskId,
        integrationCommit: task.baseCommit ?? integrationHead,
      });
      this.store.tasks.setExecutionContext(taskId, {
        branchName: worktree.branchName,
        worktreePath: worktree.path,
        baseCommit: worktree.baseCommit,
      });
      if (this.closed) {
        this.shuttingDownTasks.delete(taskId);
        return;
      }
      if (
        isAbortRequested(signal) ||
        this.store.builds.getById(buildId).status === "cancelled"
      ) {
        const current = this.store.tasks.getById(taskId);
        if (current.attempt > 0) {
          this.store.tasks.updateAttempt(taskId, current.attempt, {
            status: "cancelled",
            errorCode: "TASK_CANCELLED",
            errorMessage: "Task execution was cancelled before worker start",
            completedAt: new Date().toISOString(),
          });
        }
        return;
      }
      this.store.workers.assign({ workerId, taskId });
      assigned = true;
      this.dispatching.delete(taskId);
      const runningTask = this.store.tasks.getById(taskId);
      const plannedTask = findPlannedTask(build, runningTask);
      const attemptDirectory = path.join(
        this.environment.runsPath,
        safeSegment(buildId),
        safeSegment(taskId),
        `attempt-${runningTask.attempt}`,
      );
      const promptContext = await this.buildPromptContext(
        build,
        runningTask,
        plannedTask,
      );
      if (
        isAbortRequested(signal) ||
        this.store.builds.getById(buildId).status === "cancelled" ||
        this.store.tasks.getById(taskId).state === "cancelled"
      ) {
        if (this.shuttingDownTasks.has(taskId)) {
          this.interruptTaskForShutdown(taskId, new Date().toISOString());
        } else {
          this.store.tasks.updateAttempt(taskId, runningTask.attempt, {
            status: "cancelled",
            errorCode: "TASK_CANCELLED",
            errorMessage: "Task execution was cancelled before worker start",
            completedAt: new Date().toISOString(),
          });
        }
        this.stopAndRecycleWorker(workerId, false);
        return;
      }
      const handle = await startCodexWorker({
        executable: this.environment.codexBinary,
        worktreePath: worktree.path,
        attemptDirectory,
        prompt: promptContext,
        timeoutMs: this.environment.workerTimeoutMs,
        signal,
        onStarted: (processId) => {
          try {
            this.store.workers.updateProcessId(workerId, processId);
          } catch (error) {
            this.store.events.append({
              buildId,
              taskId,
              type: "worker.pid_persistence_failed",
              payload: { processId, message: errorMessage(error) },
            });
          }
        },
        onHeartbeat: ({ occurredAt }) => {
          try {
            this.store.workers.heartbeat(workerId, occurredAt);
          } catch {
            // A completion race can recycle the slot before the final heartbeat.
          }
        },
        onEvent: (event) => {
          this.store.events.append({
            buildId,
            taskId,
            type: event.type,
            payload: boundedWorkerEvent(event),
          });
        },
      });
      this.activeWorkers.set(taskId, {
        buildId,
        taskId,
        workerId,
        handle,
      });
      const outcome = await handle.completion;
      if (this.activeWorkers.get(taskId)?.handle === handle) {
        this.activeWorkers.delete(taskId);
      }
      this.persistWorkerOutcome(runningTask, outcome);
      this.stopAndRecycleWorker(workerId, outcome.success);
      const current = this.store.tasks.getById(taskId);
      if (current.state === "cancelled") {
        return;
      }
      if (this.shuttingDownTasks.delete(taskId)) {
        this.interruptTaskForShutdown(taskId, outcome.completedAt);
        return;
      }
      if (!outcome.success) {
        if (current.state === "running") {
          this.store.tasks.transition(taskId, "failed", {
            eventType: "task.worker_failed",
            errorCode: outcome.failureCode ?? "WORKER_FAILED",
            errorMessage: outcome.failureMessage ?? "Worker execution failed",
          });
        }
        return;
      }
      await this.validateCommitAndIntegrate(
        buildId,
        taskId,
        true,
        signal,
      );
    } catch (error) {
      const task = this.store.tasks.getById(taskId);
      if (this.closed && !assigned) {
        this.shuttingDownTasks.delete(taskId);
        return;
      }
      if (this.shuttingDownTasks.has(taskId)) {
        if (assigned) {
          this.stopAndRecycleWorker(workerId, false);
        }
        this.interruptTaskForShutdown(taskId, new Date().toISOString());
        return;
      }
      if (
        isAbortRequested(signal) ||
        this.store.builds.getById(buildId).status === "cancelled" ||
        task.state === "cancelled"
      ) {
        if (assigned) {
          this.stopAndRecycleWorker(workerId, false);
        }
        if (task.attempt > 0) {
          this.store.tasks.updateAttempt(taskId, task.attempt, {
            status: "cancelled",
            errorCode: "TASK_CANCELLED",
            errorMessage: "Task execution was cancelled",
            completedAt: new Date().toISOString(),
          });
        }
        return;
      }
      if (
        !["failed", "cancelled", "integrated", "blocked_failed"].includes(
          task.state,
        )
      ) {
        this.store.tasks.transition(taskId, "failed", {
          eventType: "task.execution_pipeline_failed",
          errorCode: "EXECUTION_PIPELINE_FAILED",
          errorMessage: errorMessage(error),
        });
      }
      if (assigned) {
        this.stopAndRecycleWorker(workerId, false);
        const attempt = this.store.tasks.getById(taskId).attempt;
        if (attempt > 0) {
          this.store.tasks.updateAttempt(taskId, attempt, {
            status: "failed",
            errorCode: "EXECUTION_PIPELINE_FAILED",
            errorMessage: errorMessage(error),
            completedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  private async validateCommitAndIntegrate(
    buildId: string,
    taskId: string,
    workerCompletedSuccessfully: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const build = this.store.builds.getById(buildId);
    let task = this.store.tasks.getById(taskId);
    if (task.state === "running" || task.state === "interrupted") {
      task = this.store.tasks.transition(taskId, "validating", {
        eventType: "task.validation_started",
      });
    }
    if (task.state !== "validating") {
      return;
    }
    if (
      task.worktreePath === null ||
      task.baseCommit === null ||
      task.branchName === null
    ) {
      throw new Error(`Task ${taskId} has no execution context`);
    }
    const commands = this.store.tasks
      .listValidationCommands(taskId)
      .map((command) => command.command);
    const config = parseBuildConfig(build);
    const summary = await validateTask({
      buildId,
      taskId,
      attempt: task.attempt,
      worktreePath: task.worktreePath,
      baseCommit: task.baseCommit,
      ownedPaths: this.store.tasks.listOwnedPaths(taskId),
      commands,
      workerCompletedSuccessfully,
      allowNoChanges: task.allowNoChanges,
      forbiddenPaths: DEFAULT_FORBIDDEN_CHANGED_PATHS,
      compose: {
        enabled: config.docker.enabled,
        composeFile: config.docker.compose_file,
        cleanup: true,
      },
      ...(signal === undefined ? {} : { signal }),
    });
    await this.persistValidationSummary(
      build,
      task,
      summary,
      "task",
    );
    if (
      summary.status === "cancelled" ||
      isAbortRequested(signal) ||
      this.store.tasks.getById(taskId).state === "cancelled" ||
      this.store.builds.getById(buildId).status === "cancelled"
    ) {
      this.recordChangedFiles(task, summary, false);
      if (this.shuttingDownTasks.has(taskId)) {
        this.interruptTaskForShutdown(taskId, summary.completedAt);
        return;
      }
      this.store.tasks.updateAttempt(taskId, task.attempt, {
        status: "cancelled",
        errorCode: summary.errorCode ?? "VALIDATION_CANCELLED",
        errorMessage: summary.errorMessage ?? "Task validation was cancelled",
        completedAt: summary.completedAt,
      });
      const current = this.store.tasks.getById(taskId);
      if (current.state === "validating") {
        this.store.tasks.transition(taskId, "cancelled", {
          eventType: "task.validation_cancelled",
          errorCode: summary.errorCode ?? "VALIDATION_CANCELLED",
          errorMessage:
            summary.errorMessage ?? "Task validation was cancelled",
        });
      }
      return;
    }
    if (!summary.readyForCommit) {
      this.recordChangedFiles(task, summary, false);
      this.store.tasks.updateAttempt(taskId, task.attempt, {
        status: "failed",
        errorCode: summary.errorCode,
        errorMessage: summary.errorMessage,
        completedAt: summary.completedAt,
      });
      this.store.tasks.transition(taskId, "failed", {
        eventType: "task.validation_failed",
        errorCode: summary.errorCode,
        errorMessage: summary.errorMessage,
      });
      return;
    }
    if (
      this.store.tasks.getById(taskId).state !== "validating" ||
      this.store.builds.getById(buildId).status === "cancelled"
    ) {
      return;
    }

    const plannedTask = findPlannedTask(build, task);
    const committed = await this.commitService.commit({
      worktreePath: task.worktreePath,
      baseCommit: task.baseCommit,
      branchName: task.branchName,
      backlogTaskId: task.backlogTaskId,
      title: task.title,
      changedFiles: summary.ownership.changedFiles,
      allowNoChanges: task.allowNoChanges,
    });
    this.store.tasks.recordChangedFiles(
      task.id,
      task.attempt,
      committed.changedFiles,
    );
    if (
      isAbortRequested(signal) ||
      this.store.tasks.getById(taskId).state !== "validating" ||
      this.store.builds.getById(buildId).status === "cancelled"
    ) {
      this.store.tasks.updateAttempt(taskId, task.attempt, {
        status: "cancelled",
        errorCode: "VALIDATION_CANCELLED",
        errorMessage: "Task validation was cancelled before handoff",
        completedAt: new Date().toISOString(),
      });
      const current = this.store.tasks.getById(taskId);
      if (current.state === "validating") {
        this.store.tasks.transition(taskId, "cancelled", {
          eventType: "task.validation_cancelled",
          errorCode: "VALIDATION_CANCELLED",
          errorMessage: "Task validation was cancelled before handoff",
        });
      }
      return;
    }
    await this.handoffService.publish({
      buildId,
      taskId,
      backlogTaskId: task.backlogTaskId,
      attempt: task.attempt,
      status: "validated",
      baseCommit: task.baseCommit,
      resultCommit: committed.resultCommit,
      branch: task.branchName,
      worktreePath: task.worktreePath,
      changedFiles: committed.changedFiles.map((change) => change.path),
      consumes: plannedTask.consumes.map((artifact) => ({
        name: artifact.artifact,
        version: artifact.version,
      })),
      produces: plannedTask.produces,
    });
    task = this.store.tasks.transition(taskId, "validated", {
      eventType: "task.validated",
      resultCommit: committed.resultCommit,
    });
    this.store.tasks.updateAttempt(taskId, task.attempt, {
      status: "succeeded",
      resultCommit: committed.resultCommit,
      completedAt: new Date().toISOString(),
      errorCode: null,
      errorMessage: null,
    });
    if (
      isAbortRequested(signal) ||
      this.store.builds.getById(buildId).status === "cancelled"
    ) {
      const current = this.store.tasks.getById(taskId);
      if (current.state === "validated") {
        this.store.tasks.transition(taskId, "cancelled", {
          eventType: "task.cancelled_before_integration",
        });
      }
      this.store.tasks.updateAttempt(taskId, task.attempt, {
        status: "cancelled",
        errorCode: "TASK_CANCELLED",
        errorMessage: "Task was cancelled before integration",
        completedAt: new Date().toISOString(),
      });
      return;
    }
    if (config.git.push_task_branches) {
      try {
        await this.commitService.pushTaskBranch(
          task.worktreePath ?? "",
          config.git.remote,
          task.branchName ?? "",
        );
        this.store.events.append({
          buildId,
          taskId,
          type: "git.task_branch_pushed",
          payload: { remote: config.git.remote, branch: task.branchName },
        });
      } catch (error) {
        this.store.events.append({
          buildId,
          taskId,
          type: "git.task_branch_push_failed",
          payload: { message: errorMessage(error) },
        });
      }
    }
    await this.integrateValidatedTask(buildId, taskId, signal);
  }

  private async integrateValidatedTask(
    buildId: string,
    taskId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const build = this.store.builds.getById(buildId);
    const task = this.store.tasks.getById(taskId);
    if (task.state !== "validated") {
      return;
    }
    const plannedTask = findPlannedTask(build, task);
    const config = parseBuildConfig(build);
    const integration = this.integrations.get(buildId);
    if (integration === undefined) {
      throw new Error(`Integration runtime for ${buildId} is unavailable`);
    }
    const result = await integration.integrate({
      taskId,
      validationCommands: config.validation.integration,
      push: {
        remote: config.git.remote,
        taskBranch: false,
        integrationBranch: config.git.push_integration_branch,
      },
      onValidationCompleted: (summary) =>
        this.persistIntegrationValidation(build, task, summary),
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      result.status !== "integrated" ||
      result.integrationCommit === null
    ) {
      this.store.tasks.updateAttempt(taskId, task.attempt, {
        status: result.status === "cancelled" ? "cancelled" : "failed",
        errorCode: result.errorCode ?? "INTEGRATION_FAILED",
        errorMessage:
          result.errorMessage ?? `Integration ended with ${result.status}`,
        completedAt: new Date().toISOString(),
      });
      return;
    }
    try {
      await this.handoffService.publish({
        buildId,
        taskId,
        backlogTaskId: task.backlogTaskId,
        attempt: task.attempt,
        status: "integrated",
        baseCommit: task.baseCommit ?? build.baseCommit,
        resultCommit: task.resultCommit ?? build.baseCommit,
        integrationCommit: result.integrationCommit,
        branch: task.branchName ?? build.integrationBranch,
        worktreePath:
          task.worktreePath ??
          build.integrationWorktree ??
          (() => {
            throw new Error(
              `Task ${taskId} has no worktree for integrated manifest publication`,
            );
          })(),
        changedFiles: this.store.tasks
          .listChangedFiles(taskId, task.attempt)
          .map((change) => change.path),
        consumes: plannedTask.consumes.map((artifact) => ({
          name: artifact.artifact,
          version: artifact.version,
        })),
        produces: plannedTask.produces,
      });
    } catch (error) {
      this.store.events.append({
        buildId,
        taskId,
        type: "manifest.integrated_publication_failed",
        payload: { message: errorMessage(error) },
      });
      const latest = this.store.builds.getById(buildId);
      if (latest.status === "running") {
        this.store.builds.transition(buildId, "paused", {
          eventType: "build.paused_for_manifest_recovery",
          payload: { taskId, message: errorMessage(error) },
        });
      }
      throw error;
    }
  }

  private async ensureRuntime(
    build: BuildEntity,
  ): Promise<GitWorktreeManager> {
    const existing = this.worktrees.get(build.id);
    if (existing !== undefined) {
      return existing;
    }
    const repository = await this.repositoryService.get(build.repositoryId);
    const config = parseBuildConfig(build);
    const manager = await GitWorktreeManager.create({
      repositoryRoot: repository.localPath,
      worktreesRoot: this.environment.worktreesPath,
      repositoryId: repository.id,
      buildId: build.id,
      recorder: (command) => {
        this.store.events.append({
          buildId: build.id,
          type: "git.command",
          payload: {
            arguments: command.arguments,
            cwd: command.cwd,
            exitCode: command.exitCode,
            durationMs: command.durationMs,
          },
          occurredAt: command.completedAt,
        });
      },
    });
    let integrationPath: string;
    if (build.integrationWorktree === null) {
      const integrationWorktree = await manager.createIntegrationWorktree({
        baseBranch: repository.baseBranch,
        remote: config.git.remote,
      });
      if (integrationWorktree.baseCommit !== build.baseCommit) {
        throw new Error(
          `Build base ${build.baseCommit} differs from resolved base ${integrationWorktree.baseCommit}`,
        );
      }
      integrationPath = integrationWorktree.path;
      this.store.builds.setIntegrationWorktree(
        build.id,
        integrationWorktree.path,
      );
    } else {
      const reconciliation = await manager.reconcileBuild(
        this.store.tasks.listForBuild(build.id).map((task) => ({
          taskId: task.id,
          ...(task.baseCommit === null
            ? {}
            : { baseCommit: task.baseCommit }),
        })),
        build.baseCommit,
      );
      if (
        reconciliation.requiresHumanReview ||
        !reconciliation.integration.safeToReuse ||
        reconciliation.integration.path !== build.integrationWorktree
      ) {
        throw new Error(
          `Build ${build.id} worktrees require human reconciliation: ${reconciliation.integration.reason}`,
        );
      }
      integrationPath = reconciliation.integration.path;
    }
    if (integrationPath !== manager.integrationPath()) {
      throw new Error(`Build ${build.id} integration path is inconsistent`);
    }
    this.worktrees.set(build.id, manager);
    this.integrations.set(
      build.id,
      new IntegrationManager({ store: this.store, worktrees: manager }),
    );
    return manager;
  }

  private async buildPromptContext(
    build: BuildEntity,
    task: TaskEntity,
    plannedTask: PlannedTask,
  ) {
    const dependencies = this.store.tasks.listDependencies(task.id);
    const dependencyManifests: WorkerContextDocument[] = dependencies.flatMap(
      (dependency) => {
        const manifest = this.store.manifests.findForTask(
          dependency.dependencyTaskId,
          "integrated",
        );
        return manifest === undefined
          ? []
          : [
              {
                name: `handoff-${dependency.dependencyTaskId}`,
                sourcePath: manifest.manifestPath,
                sha256: manifest.sha256,
                content: manifest.manifest,
              },
            ];
      },
    );
    const context = this.handoffService.downstreamContext(
      build.id,
      plannedTask.consumes.map((artifact) => ({
        name: artifact.artifact,
        version: artifact.version,
      })),
    );
    const documents = await Promise.all(
      context.artifacts.map(async (artifact) => {
        let content: unknown = artifact.metadata;
        if (
          artifact.repositoryPath !== null &&
          build.integrationWorktree !== null
        ) {
          const producer = this.store.tasks.getById(
            artifact.producerTaskId,
          );
          if (producer.integrationCommit === null) {
            throw new Error(
              `Artifact ${artifact.name}@${artifact.version} has no producer integration commit`,
            );
          }
          content = await readVersionedArtifact(
            build.integrationWorktree,
            artifact.repositoryPath,
            producer.integrationCommit,
            artifact.sha256,
          );
        }
        return {
          name: artifact.name,
          version: artifact.version,
          ...(artifact.repositoryPath === null
            ? {}
            : { sourcePath: artifact.repositoryPath }),
          ...(artifact.sha256 === null ? {} : { sha256: artifact.sha256 }),
          content,
          artifactType: artifact.artifactType,
        };
      }),
    );
    const previousAttempt =
      task.attempt <= 1
        ? undefined
        : this.store.tasks.getAttempt(task.id, task.attempt - 1);
    const contractKinds = /contract|openapi|schema|generated|ui-state/iu;
    const exampleKinds = /example|fixture|mock/iu;
    return {
      buildId: build.id,
      attempt: task.attempt,
      task: {
        id: task.backlogTaskId,
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        ownedPaths: this.store.tasks.listOwnedPaths(task.id),
        validationCommands: this.store.tasks
          .listValidationCommands(task.id)
          .map((command) => command.command),
      },
      repositoryInstructions: await readRepositoryInstructions(
        (await this.repositoryService.get(build.repositoryId)).localPath,
      ),
      ...(previousAttempt === undefined
        ? {}
        : {
            previousAttempt: {
              name: `attempt-${previousAttempt.attempt}-failure`,
              content: {
                status: previousAttempt.status,
                errorCode: previousAttempt.errorCode,
                errorMessage: previousAttempt.errorMessage,
                resultCommit: previousAttempt.resultCommit,
              },
            },
          }),
      dependencyManifests,
      consumedContracts: documents
        .filter((document) => contractKinds.test(document.artifactType))
        .map(stripArtifactType),
      consumedArtifacts: documents.map(stripArtifactType),
      examplePayloads: documents
        .filter((document) => exampleKinds.test(document.artifactType))
        .map(stripArtifactType),
    };
  }

  private persistWorkerOutcome(
    task: TaskEntity,
    outcome: WorkerOutcome,
  ): void {
    this.store.tasks.updateAttempt(task.id, task.attempt, {
      status: outcome.success
        ? "running"
        : outcome.status === "cancelled"
          ? "cancelled"
          : "failed",
      promptPath: outcome.paths.prompt,
      jsonlPath: outcome.paths.jsonl,
      logPath: outcome.paths.stderr,
      errorCode: outcome.failureCode,
      errorMessage: outcome.failureMessage,
      completedAt: outcome.success ? null : outcome.completedAt,
    });
  }

  private stopAndRecycleWorker(workerId: string, success: boolean): void {
    const worker = this.store.workers.getById(workerId);
    if (!["stopped", "failed"].includes(worker.status)) {
      this.store.workers.release(workerId, success ? "stopped" : "failed");
    }
    const stopped = this.store.workers.getById(workerId);
    if (["stopped", "failed"].includes(stopped.status)) {
      this.store.workers.recycle(workerId);
    }
  }

  private interruptTaskForShutdown(
    taskId: string,
    completedAt: string,
  ): void {
    this.shuttingDownTasks.delete(taskId);
    const current = this.store.tasks.getById(taskId);
    if (
      !["running", "validating", "validated", "integrating"].includes(
        current.state,
      )
    ) {
      return;
    }
    this.store.tasks.transition(taskId, "interrupted", {
      eventType: "task.interrupted_for_shutdown",
      errorCode: "AGENTFLOW_SHUTDOWN",
      errorMessage: "AgentFlow stopped while task execution was active",
    });
    if (current.attempt > 0) {
      this.store.tasks.updateAttempt(taskId, current.attempt, {
        status: "interrupted",
        errorCode: "AGENTFLOW_SHUTDOWN",
        errorMessage: "AgentFlow stopped while task execution was active",
        completedAt,
      });
    }
  }

  private recordChangedFiles(
    task: TaskEntity,
    summary: TaskValidationSummary,
    withHashes: boolean,
  ): void {
    this.store.tasks.recordChangedFiles(
      task.id,
      task.attempt,
      summary.ownership.changedFiles.map((change) => ({
        ...change,
        ...(withHashes ? { sha256: null } : {}),
      })),
    );
  }

  private async persistValidationSummary(
    build: BuildEntity,
    task: TaskEntity,
    summary: TaskValidationSummary,
    type: ValidationType,
  ): Promise<void> {
    const directory = path.join(
      this.environment.runsPath,
      safeSegment(build.id),
      safeSegment(task.id),
      `attempt-${task.attempt}`,
    );
    for (const outcome of summary.commands) {
      await this.persistValidationOutcome(
        build.id,
        task.id,
        type,
        directory,
        outcome,
      );
    }
    if (summary.composeCleanup !== null) {
      await this.persistValidationOutcome(
        build.id,
        task.id,
        type,
        directory,
        summary.composeCleanup,
      );
    }
  }

  private async persistIntegrationValidation(
    build: BuildEntity,
    task: TaskEntity,
    summary: NonNullable<IntegrationResult["validation"]>,
  ): Promise<void> {
    const directory = path.join(
      this.environment.runsPath,
      safeSegment(build.id),
      "integration",
      safeSegment(task.id),
    );
    for (const outcome of summary.commands) {
      await this.persistValidationOutcome(
        build.id,
        task.id,
        "integration",
        directory,
        outcome,
      );
    }
  }

  private async persistValidationOutcome(
    buildId: string,
    taskId: string,
    validationType: ValidationType,
    directory: string,
    outcome: ValidationCommandOutcome,
  ): Promise<void> {
    const id = createId("validation");
    const logPath = path.join(directory, `${id}.json`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      logPath,
      `${JSON.stringify(outcome, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    this.store.validations.create({
      id,
      buildId,
      taskId,
      validationType,
      command: outcome.command,
      exitCode: outcome.exitCode,
      status: mapValidationStatus(outcome.status),
      logPath,
      startedAt: outcome.startedAt,
      completedAt: outcome.completedAt,
      createdAt: outcome.startedAt,
    });
  }

  private completeBuildIfTerminal(
    build: BuildEntity,
    tasks: readonly TaskEntity[],
  ): boolean {
    if (tasks.length === 0) {
      return false;
    }
    if (tasks.every((task) => task.state === "integrated")) {
      const missingManifestTaskIds = tasks
        .filter(
          (task) =>
            this.store.manifests.findForTask(
              task.id,
              "integrated",
              task.attempt,
            ) === undefined,
        )
        .map((task) => task.id);
      if (missingManifestTaskIds.length > 0) {
        this.store.builds.transition(build.id, "paused", {
          eventType: "build.paused_for_manifest_recovery",
          payload: { taskIds: missingManifestTaskIds },
        });
        return true;
      }
      this.store.builds.transition(build.id, "completed", {
        eventType: "build.completed",
        actualElapsedSeconds: elapsedSeconds(build.startedAt),
      });
      return true;
    }
    if (
      tasks.every((task) =>
        [
          "integrated",
          "failed",
          "cancelled",
          "blocked_failed",
        ].includes(task.state),
      ) &&
      tasks.some((task) =>
        ["failed", "blocked_failed"].includes(task.state),
      )
    ) {
      this.store.builds.transition(build.id, "failed", {
        eventType: "build.failed",
        actualElapsedSeconds: elapsedSeconds(build.startedAt),
      });
      return true;
    }
    return false;
  }
}

function parseBuildConfig(build: BuildEntity): AgentFlowRepositoryConfig {
  return AgentFlowRepositoryConfigSchema.parse(build.repositoryConfig);
}

function asPlan(value: Record<string, unknown>): PlanResult {
  return value as unknown as PlanResult;
}

function findPlannedTask(
  build: BuildEntity,
  task: TaskEntity,
): PlannedTask {
  const planned = asPlan(build.normalizedPlan).tasks.find(
    (candidate) => candidate.id === task.backlogTaskId,
  );
  if (planned === undefined) {
    throw new Error(
      `Build snapshot does not contain backlog task ${task.backlogTaskId}`,
    );
  }
  return planned;
}

function mapValidationStatus(
  status: ValidationCommandOutcome["status"],
): ValidationStatus {
  switch (status) {
    case "passed":
      return "passed";
    case "timed_out":
      return "timed_out";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "spawn_error":
      return "failed";
  }
}

function boundedWorkerEvent(
  event: WorkerRuntimeEvent,
): Record<string, unknown> {
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") <= 32 * 1024) {
    return { ...event };
  }
  return {
    type: event.type,
    occurredAt: event.occurredAt,
    truncated: true,
    preview: serialized.slice(0, 32 * 1024),
  };
}

function safeSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 128);
}

function elapsedSeconds(startedAt: string | null): number {
  if (startedAt === null) {
    return 0;
  }
  return Math.max(
    0,
    Math.round((Date.now() - new Date(startedAt).getTime()) / 1_000),
  );
}

async function readRepositoryInstructions(
  repositoryPath: string,
): Promise<string> {
  const instructions: string[] = [];
  for (const filename of ["AGENTS.md", "CODEX.md"]) {
    try {
      const value = await readFile(path.join(repositoryPath, filename), "utf8");
      instructions.push(
        `# ${filename}\n${value.slice(0, 128 * 1024)}`,
      );
    } catch {
      // Repository instructions are optional.
    }
  }
  return instructions.join("\n\n");
}

export async function readVersionedArtifact(
  integrationWorktree: string,
  repositoryPath: string,
  integrationCommit: string,
  expectedSha256: string | null,
): Promise<unknown> {
  const normalized = repositoryPath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.length === 0 ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`Artifact path escapes integration worktree`);
  }
  const git = new GitCommandRunner();
  const object = `${integrationCommit}:${normalized}`;
  const treeEntry = (
    await git.run(integrationWorktree, [
      "ls-tree",
      integrationCommit,
      "--",
      normalized,
    ])
  ).stdout.trim();
  const mode = treeEntry.split(/\s+/u, 1)[0];
  if (mode === "120000") {
    throw new Error(
      `Artifact ${repositoryPath} is a symbolic link and cannot be consumed`,
    );
  }
  const objectType = (
    await git.run(integrationWorktree, ["cat-file", "-t", object])
  ).stdout.trim();
  if (objectType === "tree") {
    const listing = (
      await git.run(integrationWorktree, [
        "ls-tree",
        "-r",
        "--name-only",
        integrationCommit,
        "--",
        normalized,
      ])
    ).stdout
      .split("\n")
      .filter(Boolean);
    return {
      path: repositoryPath,
      kind: "directory",
      integrationCommit,
      fileCount: listing.length,
      files: listing.slice(0, 200),
      truncated: listing.length > 200,
    };
  }
  if (objectType !== "blob") {
    throw new Error(
      `Artifact ${repositoryPath} has unsupported Git object type ${objectType}`,
    );
  }
  if (expectedSha256 === null) {
    throw new Error(
      `File artifact ${repositoryPath} has no validated SHA-256 digest`,
    );
  }
  const sizeText = (
    await git.run(integrationWorktree, ["cat-file", "-s", object])
  ).stdout.trim();
  const sizeBytes = Number.parseInt(sizeText, 10);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Artifact ${repositoryPath} has an invalid Git object size`);
  }
  const contents = await readAndVerifyGitBlob(
    integrationWorktree,
    object,
    expectedSha256,
    sizeBytes <= 512 * 1024,
  );
  if (contents === null) {
    return {
      path: repositoryPath,
      kind: "file",
      truncated: true,
      sizeBytes,
      sha256: expectedSha256,
      verified: true,
      integrationCommit,
    };
  }
  const text = contents.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function readAndVerifyGitBlob(
  workingDirectory: string,
  object: string,
  expectedSha256: string,
  collect: boolean,
): Promise<Buffer | null> {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "git",
      ["-C", workingDirectory, "cat-file", "blob", object],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      if (collect) {
        chunks.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8 * 1024) {
        stderr += chunk.toString("utf8");
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Git could not read artifact object${stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`}`,
          ),
        );
      }
    });
  });
  const actualSha256 = hash.digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Artifact SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`,
    );
  }
  return collect ? Buffer.concat(chunks) : null;
}

function stripArtifactType(document: {
  name: string;
  version: string;
  sourcePath?: string;
  sha256?: string;
  content: unknown;
  artifactType: string;
}): WorkerContextDocument {
  return {
    name: document.name,
    version: document.version,
    ...(document.sourcePath === undefined
      ? {}
      : { sourcePath: document.sourcePath }),
    ...(document.sha256 === undefined ? {} : { sha256: document.sha256 }),
    content: document.content,
  };
}

function isProcessAlive(processId: number | null): boolean {
  if (processId === null || !Number.isSafeInteger(processId) || processId <= 0) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function taskStateIsActive(state: TaskStatus): boolean {
  return ["running", "validating", "validated", "integrating"].includes(
    state,
  );
}
