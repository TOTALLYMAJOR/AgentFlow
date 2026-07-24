import { mkdir, readFile, writeFile } from "node:fs/promises";
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
      if (task.state === "integrating") {
        continue;
      }
      this.store.tasks.transition(task.id, "cancelled", {
        eventType: "task.cancelled",
      });
    }
    return build;
  }

  retry(buildId: string, taskId: string): TaskEntity {
    const task = this.store.tasks.getById(taskId);
    if (task.buildId !== buildId) {
      throw new Error(`Task ${taskId} does not belong to build ${buildId}`);
    }
    const retried = this.store.tasks.retry(taskId);
    this.requestTick(buildId);
    return retried;
  }

  async resumeValidation(build: BuildEntity, task: TaskEntity): Promise<void> {
    await this.ensureRuntime(build);
    void this.validateCommitAndIntegrate(build.id, task.id, true).finally(() => {
      this.requestTick(build.id);
    });
  }

  async queueIntegration(build: BuildEntity, task: TaskEntity): Promise<void> {
    await this.ensureRuntime(build);
    void this.integrateValidatedTask(build.id, task.id).finally(() => {
      this.requestTick(build.id);
    });
  }

  async recoverIntegratedManifest(
    build: BuildEntity,
    task: TaskEntity,
  ): Promise<void> {
    if (
      this.store.manifests.findForTask(task.id, "integrated") !== undefined
    ) {
      return;
    }
    const latest = this.store.tasks.getById(task.id);
    const plannedTask = findPlannedTask(build, latest);
    const worktreePath =
      latest.worktreePath ?? build.integrationWorktree;
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
    for (const active of this.activeWorkers.values()) {
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
      const operation = this.executeTask(buildId, taskId, worker.id)
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
          this.dispatching.delete(taskId);
          this.taskOperations.delete(taskId);
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
      const handle = await startCodexWorker({
        executable: this.environment.codexBinary,
        worktreePath: worktree.path,
        attemptDirectory,
        prompt: promptContext,
        timeoutMs: this.environment.workerTimeoutMs,
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
      this.activeWorkers.delete(taskId);
      this.persistWorkerOutcome(runningTask, outcome);
      this.stopAndRecycleWorker(workerId, outcome.success);
      const current = this.store.tasks.getById(taskId);
      if (current.state === "cancelled") {
        return;
      }
      if (this.shuttingDownTasks.delete(taskId)) {
        if (current.state === "running") {
          this.store.tasks.transition(taskId, "interrupted", {
            eventType: "task.interrupted_for_shutdown",
            errorCode: "AGENTFLOW_SHUTDOWN",
            errorMessage: "AgentFlow stopped while the worker was active",
          });
        }
        this.store.tasks.updateAttempt(taskId, current.attempt, {
          status: "interrupted",
          completedAt: outcome.completedAt,
        });
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
      await this.validateCommitAndIntegrate(buildId, taskId, true);
    } catch (error) {
      const task = this.store.tasks.getById(taskId);
      if (this.closed && !assigned) {
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
    });
    await this.persistValidationSummary(
      build,
      task,
      summary,
      "task",
    );
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
    await this.integrateValidatedTask(buildId, taskId);
  }

  private async integrateValidatedTask(
    buildId: string,
    taskId: string,
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
    });
    await this.persistIntegrationValidation(build, task, result);
    if (
      result.status !== "integrated" ||
      result.integrationCommit === null
    ) {
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
        worktreePath: task.worktreePath ?? result.previousHead,
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
          content = await readBoundedArtifact(
            build.integrationWorktree,
            artifact.repositoryPath,
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
      status: outcome.success ? "running" : "failed",
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
    result: IntegrationResult,
  ): Promise<void> {
    if (result.validation === null) {
      return;
    }
    const directory = path.join(
      this.environment.runsPath,
      safeSegment(build.id),
      "integration",
      safeSegment(task.id),
    );
    for (const outcome of result.validation.commands) {
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

async function readBoundedArtifact(
  integrationWorktree: string,
  repositoryPath: string,
): Promise<unknown> {
  const candidate = path.resolve(integrationWorktree, repositoryPath);
  const relative = path.relative(integrationWorktree, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Artifact path escapes integration worktree`);
  }
  const contents = await readFile(candidate);
  if (contents.length > 512 * 1024) {
    return {
      path: repositoryPath,
      truncated: true,
      sizeBytes: contents.length,
    };
  }
  const text = contents.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
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

export function taskStateIsActive(state: TaskStatus): boolean {
  return ["running", "validating", "validated", "integrating"].includes(
    state,
  );
}
