import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import type {
  BuildEntity,
  DatabaseRepositories,
  TaskEntity,
  WorkerEntity,
} from "../db/index.js";
import { createId } from "../util/ids.js";
import type {
  RecoveryDecision,
  RecoveryServiceOptions,
} from "./types.js";

export class RecoveryService {
  private readonly store: DatabaseRepositories;
  private readonly options: RecoveryServiceOptions;

  constructor(options: RecoveryServiceOptions) {
    this.store = options.store;
    this.options = options;
  }

  async reconcileActiveBuilds(): Promise<RecoveryDecision[]> {
    const decisions: RecoveryDecision[] = [];
    for (const build of this.store.builds
      .list()
      .filter((candidate) =>
        ["running", "paused", "interrupted"].includes(candidate.status),
      )) {
      const repositoryPath = await this.options.resolveRepositoryPath(
        build.repositoryId,
      );
      for (const task of this.store.tasks.listForBuild(build.id)) {
        decisions.push(
          await this.reconcileTask(build, task, repositoryPath),
        );
      }
    }
    return decisions;
  }

  private async reconcileTask(
    build: BuildEntity,
    task: TaskEntity,
    repositoryPath: string,
  ): Promise<RecoveryDecision> {
    if (
      ["integrated", "failed", "cancelled", "blocked_failed"].includes(
        task.state,
      )
    ) {
      return this.record(build, task, "no_action", `task is ${task.state}`);
    }
    const worker = this.activeWorkerForTask(build.id, task.id);
    if (
      worker?.processId !== null &&
      worker?.processId !== undefined &&
      this.isProcessAlive(worker.processId)
    ) {
      await this.options.monitorExistingProcess?.(build, task, worker);
      return this.record(
        build,
        task,
        "monitor_existing_process",
        `worker process ${worker.processId} is still alive`,
      );
    }

    if (task.integrationCommit !== null) {
      const integrationDirectory =
        build.integrationWorktree ?? repositoryPath;
      if (
        !(await this.pathExists(integrationDirectory)) ||
        !(await this.commitExists(
          integrationDirectory,
          task.integrationCommit,
        ))
      ) {
        return this.pauseForReview(
          build,
          task,
          "recorded integration commit cannot be verified",
        );
      }
      this.advanceToIntegrating(task.id);
      const integrated = this.store.tasks.markIntegrationSuccess(task.id, {
        integrationCommit: task.integrationCommit,
      });
      await this.options.recoveredIntegration?.(build, integrated);
      return this.record(
        build,
        integrated,
        "mark_integrated",
        "recorded integration commit was verified",
      );
    }

    if (task.resultCommit !== null) {
      const taskDirectory = task.worktreePath ?? repositoryPath;
      if (
        !(await this.pathExists(taskDirectory)) ||
        !(await this.commitExists(taskDirectory, task.resultCommit))
      ) {
        return this.pauseForReview(
          build,
          task,
          "recorded result commit or task worktree cannot be verified",
        );
      }
      const validations = this.store.validations
        .listForBuild(build.id)
        .filter(
          (validation) =>
            validation.taskId === task.id &&
            validation.validationType === "task",
        );
      const validationPassed = validations.some(
        (validation) => validation.status === "passed",
      );
      if (!validationPassed) {
        this.advanceToValidating(task.id);
        await this.options.resumeValidation?.(
          build,
          this.store.tasks.getById(task.id),
        );
        return this.record(
          build,
          task,
          "resume_validation",
          "result commit exists but task validation has not passed",
        );
      }
      this.advanceToValidated(task.id);
      await this.options.queueIntegration?.(
        build,
        this.store.tasks.getById(task.id),
      );
      return this.record(
        build,
        task,
        "queue_integration",
        "result commit and task validation were verified",
      );
    }

    if (["running"].includes(task.state)) {
      this.store.tasks.transition(task.id, "interrupted", {
        eventType: "recovery.task_interrupted",
        errorCode: "WORKER_PROCESS_MISSING",
        errorMessage: "AgentFlow restarted and the recorded worker is absent",
      });
      this.interruptAttempt(task);
      this.stopMissingWorker(worker);
      return this.record(
        build,
        task,
        "mark_interrupted",
        "worker process is absent and no result commit exists",
      );
    }
    if (["validating", "integrating"].includes(task.state)) {
      return this.pauseForReview(
        build,
        task,
        `${task.state} task has no commit evidence`,
      );
    }
    return this.record(
      build,
      task,
      "no_action",
      `task is safely waiting in ${task.state}`,
    );
  }

  private activeWorkerForTask(
    buildId: string,
    taskId: string,
  ): WorkerEntity | undefined {
    return this.store.workers
      .listForBuild(buildId)
      .find(
        (worker) =>
          worker.taskId === taskId &&
          ["starting", "running", "stopping"].includes(worker.status),
      );
  }

  private advanceToValidating(taskId: string): void {
    const task = this.store.tasks.getById(taskId);
    if (task.state === "running" || task.state === "interrupted") {
      this.store.tasks.transition(taskId, "validating", {
        eventType: "recovery.validation_resumed",
        resultCommit: task.resultCommit,
      });
    } else if (task.state !== "validating") {
      throw new Error(
        `Cannot safely resume validation for ${taskId} from ${task.state}`,
      );
    }
  }

  private advanceToValidated(taskId: string): void {
    this.advanceToValidating(taskId);
    const task = this.store.tasks.getById(taskId);
    if (task.state === "validating") {
      this.store.tasks.transition(taskId, "validated", {
        eventType: "recovery.validation_confirmed",
        resultCommit: task.resultCommit,
      });
    }
  }

  private advanceToIntegrating(taskId: string): void {
    const task = this.store.tasks.getById(taskId);
    if (task.state !== "integrating") {
      this.advanceToValidated(taskId);
      this.store.tasks.transition(taskId, "integrating", {
        eventType: "recovery.integration_confirmed",
        resultCommit: task.resultCommit,
      });
    }
  }

  private interruptAttempt(task: TaskEntity): void {
    const attempt = this.store.tasks
      .listAttempts(task.id)
      .find((candidate) => candidate.attempt === task.attempt);
    if (attempt?.status === "running") {
      this.store.tasks.updateAttempt(task.id, task.attempt, {
        status: "interrupted",
        errorCode: "WORKER_PROCESS_MISSING",
        errorMessage: "Recorded worker process was absent during recovery",
        completedAt: new Date().toISOString(),
      });
    }
  }

  private stopMissingWorker(worker: WorkerEntity | undefined): void {
    if (worker === undefined) {
      return;
    }
    this.store.workers.release(worker.id, "failed");
    this.store.workers.recycle(worker.id);
  }

  private pauseForReview(
    build: BuildEntity,
    task: TaskEntity,
    reason: string,
  ): RecoveryDecision {
    const existing = this.store.approvals
      .listPending(build.id, task.id)
      .find((approval) => approval.approvalType === "manual");
    if (existing === undefined) {
      this.store.approvals.create({
        id: createId("approval"),
        buildId: build.id,
        taskId: task.id,
        approvalType: "manual",
        reason: `Recovery requires review: ${reason}`,
      });
    }
    const latestBuild = this.store.builds.getById(build.id);
    if (["running", "interrupted"].includes(latestBuild.status)) {
      this.store.builds.transition(build.id, "paused", {
        eventType: "recovery.build_paused",
        payload: { taskId: task.id, reason },
      });
    }
    return this.record(build, task, "pause_for_review", reason);
  }

  private record(
    build: BuildEntity,
    task: TaskEntity,
    action: RecoveryDecision["action"],
    reason: string,
  ): RecoveryDecision {
    this.store.events.append({
      buildId: build.id,
      taskId: task.id,
      type: "recovery.decision",
      payload: { action, reason },
    });
    return { buildId: build.id, taskId: task.id, action, reason };
  }

  private isProcessAlive(processId: number): boolean {
    return (this.options.isProcessAlive ?? defaultIsProcessAlive)(processId);
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    return (this.options.pathExists ?? defaultPathExists)(targetPath);
  }

  private async commitExists(
    workingDirectory: string,
    commit: string,
  ): Promise<boolean> {
    return (this.options.commitExists ?? defaultCommitExists)(
      workingDirectory,
      commit,
    );
  }
}

function defaultIsProcessAlive(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
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

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function defaultCommitExists(
  workingDirectory: string,
  commit: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      "git",
      ["cat-file", "-e", `${commit}^{commit}`],
      {
        cwd: workingDirectory,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: process.env.LANG ?? "C.UTF-8",
          LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
        },
        shell: false,
        stdio: "ignore",
      },
    );
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}
