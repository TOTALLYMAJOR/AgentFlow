import type { ServerResponse } from "node:http";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type {
  BuildEntity,
  BuildStatus,
  CreateTaskInput,
  TaskEntity,
} from "../../db/index.js";
import type { PlannedTask } from "../../domain/types.js";
import {
  AgentFlowRepositoryConfigSchema,
  runGit,
} from "../../repositories/index.js";
import { GitCommandRunner, GitWorktreeManager, isPathInside } from "../../git/index.js";
import { createId } from "../../util/ids.js";
import { AgentFlowError } from "../errors.js";
import type { AgentFlowContext } from "../context.js";

const BuildIdParameters = z.object({
  id: z.string().min(1),
});

const TaskIdParameters = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
});

const ApprovalParameters = z.object({
  id: z.string().min(1),
  approvalId: z.string().min(1),
});

const ApprovalDecisionBody = z.object({
  status: z.enum(["approved", "rejected", "cancelled"]),
  decidedBy: z.string().trim().min(1).max(128).default("local-user"),
  note: z.string().trim().max(4_096).optional(),
});

const AttemptDocumentParameters = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  attempt: z.coerce.number().int().min(1),
  document: z.enum([
    "prompt",
    "jsonl",
    "stderr",
    "result",
    "outcome",
  ]),
});

const CreateBuildBody = z.object({
  planId: z.string().min(1),
});
const CleanupBuildBody = z.object({
  force: z.boolean().default(false),
  deleteMergedBranches: z.boolean().default(false),
  deleteRemoteBranches: z.boolean().default(false),
  retentionHours: z.number().min(0).max(24 * 365).default(24),
});
const BuildListQuery = z.object({
  repositoryId: z.string().min(1).optional(),
  scope: z.enum(["active", "terminal", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const activeBuildStatuses: readonly BuildStatus[] = [
  "planning",
  "ready",
  "running",
  "paused",
  "interrupted",
];
const terminalBuildStatuses: readonly BuildStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function registerBuildRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.post("/api/builds", async (request, reply) => {
    const { planId } = CreateBuildBody.parse(request.body);
    const build = await createBuildForPlan(context, planId);
    await reply.status(201).send(await serializeBuild(context, build));
  });

  app.get("/api/builds", async (request) => {
    const query = BuildListQuery.parse(request.query);
    const statuses =
      query.scope === "active"
        ? activeBuildStatuses
        : query.scope === "terminal"
          ? terminalBuildStatuses
          : undefined;
    return Promise.all(
      context.store.builds
        .list({
          limit: query.limit,
          ...(query.repositoryId === undefined
            ? {}
            : { repositoryId: query.repositoryId }),
          ...(statuses === undefined ? {} : { statuses }),
        })
        .map(async (build) => serializeBuild(context, build)),
    );
  });

  app.get("/api/builds/:id", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    return serializeBuild(context, context.store.builds.getById(id));
  });
  app.post("/api/builds/:id/start", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    return serializeBuild(
      context,
      await context.coordinator.start(id),
    );
  });

  app.post("/api/builds/:id/cleanup", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    const input = CleanupBuildBody.parse(request.body ?? {});
    const build = context.store.builds.getById(id);
    if (input.deleteRemoteBranches) throw new AgentFlowError("REMOTE_BRANCH_DELETION_DISABLED", "Remote branch deletion requires a separately approved publication policy and is disabled", 409);
    if (input.force) throw new AgentFlowError("DESTRUCTIVE_CLEANUP_DISABLED", "Forced worktree removal can destroy uncommitted source and is disabled", 409);
    if (build.status !== "completed") {
      context.store.cleanupReceipts.append({ buildId: id, targetType: "worktree", target: context.environment.worktreesPath, action: "preserved", reason: `build is ${build.status}; only completed builds are cleanup eligible` });
      throw new AgentFlowError("BUILD_NOT_CLEANUP_ELIGIBLE", `Build ${id} is ${build.status}; failed, cancelled, interrupted, and active work are preserved`, 409);
    }
    const repository = await context.repositoryService.get(build.repositoryId);
    const manager = await GitWorktreeManager.create({ repositoryRoot: repository.localPath, worktreesRoot: context.environment.worktreesPath, repositoryId: repository.id, buildId: id });
    const tasks = context.store.tasks.listForBuild(id);
    const taskIds = tasks.map((task) => task.id);
    const reconciliation = await manager.reconcileBuild(tasks.map((task) => ({ taskId: task.id, ...(task.baseCommit === null ? {} : { baseCommit: task.baseCommit }) })), build.baseCommit);
    const unsafeWorktrees = [reconciliation.integration, ...reconciliation.tasks].filter((worktree) => !["missing", "ready"].includes(worktree.state));
    if (unsafeWorktrees.length > 0) {
      for (const worktree of unsafeWorktrees) context.store.cleanupReceipts.append({ buildId: id, targetType: "worktree", target: worktree.path, action: "preserved", reason: `${worktree.state}: ${worktree.reason}` });
      throw new AgentFlowError("WORKTREE_CLEANUP_REFUSED", `Build ${id} has worktrees requiring recovery; source was preserved`, 409, unsafeWorktrees);
    }
    const removals = await manager.cleanBuildWorktrees(taskIds, false);
    for (const removal of removals) context.store.cleanupReceipts.append({ buildId: id, targetType: "worktree", target: removal.path, action: removal.removed ? "removed" : "missing", reason: removal.removed ? "managed worktree removed" : "managed worktree was already absent" });
    const completedAt = build.completedAt === null ? Number.NaN : Date.parse(build.completedAt);
    const retentionElapsed = Number.isFinite(completedAt) && Date.now() >= completedAt + input.retentionHours * 60 * 60 * 1000;
    let retirement = null;
    if (input.deleteMergedBranches && retentionElapsed) retirement = await manager.retireMergedBranches(taskIds, repository.baseBranch);
    else if (input.deleteMergedBranches) {
      const reason = `retention-window-active:${input.retentionHours}h`;
      for (const taskId of taskIds) context.store.cleanupReceipts.append({ buildId: id, targetType: "branch", target: manager.taskBranch(taskId), action: "preserved", reason });
      context.store.cleanupReceipts.append({ buildId: id, targetType: "branch", target: manager.integrationBranch(), action: "preserved", reason });
    }
    for (const decision of retirement === null ? [] : [...retirement.tasks, retirement.integration]) context.store.cleanupReceipts.append({ buildId: id, targetType: "branch", target: decision.branchName, action: decision.deleted ? "deleted" : decision.reason === "missing" ? "missing" : "preserved", reason: decision.reason });
    return { buildId: id, removals, retirement, receipts: context.store.cleanupReceipts.list(id) };
  });

  app.get("/api/builds/:id/cleanup-receipts", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    context.store.builds.getById(id);
    return context.store.cleanupReceipts.list(id);
  });

  app.post("/api/builds/:id/pause", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    return serializeBuild(
      context,
      context.coordinator.pause(id),
    );
  });

  app.post("/api/builds/:id/resume", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    return serializeBuild(
      context,
      await context.coordinator.resume(id),
    );
  });

  app.post("/api/builds/:id/cancel", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    const build = context.coordinator.cancel(id);
    return serializeBuild(context, build);
  });

  app.get("/api/builds/:id/tasks", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    context.store.builds.getById(id);
    return context.store.tasks.listForBuild(id);
  });

  app.get("/api/builds/:id/tasks/:taskId", async (request) => {
    const { id, taskId } = TaskIdParameters.parse(request.params);
    const task = assertTaskInBuild(context, id, taskId);
    return {
      ...task,
      dependencies: context.store.tasks.listDependencies(task.id),
      ownership: context.store.tasks.listOwnedPaths(task.id),
      validationCommands: context.store.tasks.listValidationCommands(task.id),
      attempts: context.store.tasks.listAttempts(task.id),
      approvals: context.store.approvals
        .listForBuild(id)
        .filter((approval) => approval.taskId === task.id),
      artifacts: context.store.artifacts
        .listForBuild(id)
        .filter((artifact) => artifact.producerTaskId === task.id),
      manifests: context.store.manifests
        .listForBuild(id)
        .filter((manifest) => manifest.taskId === task.id),
      validations: context.store.validations
        .listForBuild(id)
        .filter((validation) => validation.taskId === task.id),
      changedFiles: context.store.tasks
        .listAttempts(task.id)
        .flatMap((attempt) =>
          context.store.tasks.listChangedFiles(task.id, attempt.attempt),
        ),
      events: context.store.events
        .listForBuild(id, { limit: 10_000 })
        .filter((event) => event.taskId === task.id),
    };
  });

  app.post("/api/builds/:id/tasks/:taskId/retry", async (request) => {
    const { id, taskId } = TaskIdParameters.parse(request.params);
    assertTaskInBuild(context, id, taskId);
    return context.coordinator.retry(id, taskId);
  });

  app.get(
    "/api/builds/:id/tasks/:taskId/attempts/:attempt/:document",
    async (request) => {
      const parameters = AttemptDocumentParameters.parse(request.params);
      const task = assertTaskInBuild(context, parameters.id, parameters.taskId);
      const attempt = context.store.tasks.getAttempt(
        task.id,
        parameters.attempt,
      );
      const documentPath = resolveAttemptDocumentPath(
        attempt,
        parameters.document,
      );
      return readRuntimeDocument(
        context.environment.runsPath,
        documentPath,
      );
    },
  );

  app.get("/api/builds/:id/tasks/:taskId/diff", async (request) => {
    const { id, taskId } = TaskIdParameters.parse(request.params);
    const task = assertTaskInBuild(context, id, taskId);
    if (task.worktreePath === null || task.baseCommit === null) {
      return { available: false, reason: "Task worktree is not available" };
    }
    const target = task.resultCommit ?? "working-tree";
    const result = await new GitCommandRunner().run(task.worktreePath, [
      "diff",
      "--no-ext-diff",
      "--unified=3",
      task.baseCommit,
      ...(task.resultCommit === null ? [] : [task.resultCommit]),
      "--",
    ]);
    return {
      available: true,
      baseCommit: task.baseCommit,
      target,
      diff: result.stdout,
    };
  });

  app.get("/api/builds/:id/artifacts", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    context.store.builds.getById(id);
    return context.store.artifacts.listForBuild(id);
  });

  app.get("/api/builds/:id/manifests", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    context.store.builds.getById(id);
    return context.store.manifests.listForBuild(id);
  });

  app.get("/api/builds/:id/approvals", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    context.store.builds.getById(id);
    return context.store.approvals.listForBuild(id);
  });

  app.post(
    "/api/builds/:id/approvals/:approvalId/decision",
    async (request) => {
      const { id, approvalId } = ApprovalParameters.parse(request.params);
      const body = ApprovalDecisionBody.parse(request.body);
      const approval = context.store.approvals.getById(approvalId);
      if (approval.buildId !== id) {
        throw new AgentFlowError(
          "APPROVAL_BUILD_MISMATCH",
          `Approval ${approvalId} does not belong to build ${id}`,
          404,
        );
      }
      return context.store.approvals.decide(approvalId, body.status, {
        decidedBy: body.decidedBy,
        decisionNote: body.note ?? null,
      });
    },
  );

  app.get("/api/builds/:id/metrics", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    const build = context.store.builds.getById(id);
    const tasks = context.store.tasks.listForBuild(id);
    return {
      estimatedSequentialHours: build.sequentialEstimateHours,
      criticalPathHours: build.criticalPathHours,
      expectedElapsedHours: build.expectedElapsedHours,
      expectedSavingsPercent: build.expectedSavingsPercent,
      actualElapsedSeconds: build.actualElapsedSeconds,
      totalTasks: tasks.length,
      integratedTasks: tasks.filter((task) => task.state === "integrated").length,
      failedTasks: tasks.filter((task) =>
        ["failed", "blocked_failed"].includes(task.state),
      ).length,
      ownershipViolations: countOwnershipViolations(context, id),
    };
  });

  app.get("/api/builds/:id/events", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    const query = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(10_000).default(1_000),
      })
      .parse(request.query);
    context.store.builds.getById(id);
    return context.store.events.listForBuild(id, {
      afterSequence: query.after,
      limit: query.limit,
    });
  });

  app.get("/api/builds/:id/events/stream", async (request, reply) => {
    const { id } = BuildIdParameters.parse(request.params);
    context.store.builds.getById(id);
    const header = request.headers["last-event-id"];
    const lastEventId = parseLastEventId(
      Array.isArray(header) ? header[0] : header,
    );
    openEventStream(reply, context, id, lastEventId);
  });
}

export async function createBuildForPlan(
  context: AgentFlowContext,
  planId: string,
): Promise<BuildEntity> {
  const plan = context.store.plans.getById(planId);
  const activeBuild = context.store.builds.findActive(plan.repositoryId);
  if (activeBuild !== undefined) {
    throw new AgentFlowError("ACTIVE_BUILD_EXISTS", `Repository ${plan.repositoryId} already has active build ${activeBuild.id}`, 409);
  }
  const repositoryConfig = AgentFlowRepositoryConfigSchema.parse(plan.repositoryConfig);
  const repository = await context.repositoryService.get(plan.repositoryId);
  const baseCommit = (await runGit(repository.localPath, ["rev-parse", `${repository.baseBranch}^{commit}`])).stdout.trim();
  const buildId = createId("build");
  const taskIds = new Map(plan.normalizedPlan.tasks.map((task) => [task.id, createId(`task_${safeId(task.id)}`)]));
  const build = context.store.builds.create({ id: buildId, repositoryId: repository.id, planId, backlogPath: plan.backlogPath, baseCommit, integrationBranch: `agent-integration/${buildId}`, status: "ready", workerLimit: repositoryConfig.workers.maximum, tasks: plan.normalizedPlan.tasks.map((task) => createTaskInput(task, taskIds)) });
  for (let slot = 1; slot <= build.workerLimit; slot += 1) context.store.workers.create({ id: `${buildId}:worker:${slot}`, buildId, providerId: context.environment.defaultAgentProvider, status: "idle" });
  for (const task of context.store.tasks.listForBuild(build.id)) if (task.requiresApproval) context.store.approvals.create({ id: createId("approval"), buildId: build.id, taskId: task.id, approvalType: "manual", reason: `Task ${task.backlogTaskId} requires approval before dispatch` });
  return build;
}

function createTaskInput(
  task: PlannedTask,
  taskIds: ReadonlyMap<string, string>,
): CreateTaskInput {
  const id = taskIds.get(task.id);
  if (id === undefined) {
    throw new Error(`Task ID mapping is missing for ${task.id}`);
  }
  const dependencies: NonNullable<CreateTaskInput["dependencies"]> =
    task.dependsOn.map((dependencyId) => ({
      dependencyTaskId: requireMappedTaskId(taskIds, dependencyId),
      dependencyType: "hard",
    }));
  for (const consumed of task.consumes) {
    dependencies.push({
      dependencyTaskId: requireMappedTaskId(taskIds, consumed.task),
      dependencyType: "artifact",
      requiredArtifactName: consumed.artifact,
      requiredArtifactVersion: consumed.version,
    });
  }
  return {
    id,
    backlogTaskId: task.id,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    state: dependencies.length === 0 ? "ready" : "blocked",
    estimateHours: task.estimateHours,
    allowNoChanges: task.allowNoChanges,
    riskScore: task.riskScore,
    requiresApproval: task.requiresApproval,
    dependencies,
    ownedPaths: task.owns,
    validationCommands: task.validate,
  };
}

function requireMappedTaskId(
  taskIds: ReadonlyMap<string, string>,
  backlogTaskId: string,
): string {
  const id = taskIds.get(backlogTaskId);
  if (id === undefined) {
    throw new Error(`Task dependency mapping is missing for ${backlogTaskId}`);
  }
  return id;
}

async function serializeBuild(
  context: AgentFlowContext,
  build: BuildEntity,
): Promise<Record<string, unknown>> {
  const repository = await context.repositoryService.get(build.repositoryId);
  const tasks = context.store.tasks.listForBuild(build.id);
  const workers = context.store.workers.listForBuild(build.id);
  return {
    ...build,
    repositoryName: repository.name,
    estimates: {
      sequentialHours: build.sequentialEstimateHours,
      criticalPathHours: build.criticalPathHours,
      expectedElapsedHours: build.expectedElapsedHours,
      expectedSavingsPercent: build.expectedSavingsPercent,
    },
    tasks: tasks.map((task) => ({
      ...task,
      workerId:
        workers.find((worker) => worker.taskId === task.id)?.id ?? null,
    })),
    workers: workers.map((worker, index) => ({
      ...worker,
      slot: index + 1,
    })),
  };
}

function assertTaskInBuild(
  context: AgentFlowContext,
  buildId: string,
  taskId: string,
): TaskEntity {
  context.store.builds.getById(buildId);
  const task = context.store.tasks.getById(taskId);
  if (task.buildId !== buildId) {
    throw new AgentFlowError(
      "TASK_BUILD_MISMATCH",
      `Task ${taskId} does not belong to build ${buildId}`,
      404,
    );
  }
  return task;
}

function countOwnershipViolations(
  context: AgentFlowContext,
  buildId: string,
): number {
  return context.store.tasks
    .listForBuild(buildId)
    .flatMap((task) =>
      context.store.tasks
        .listAttempts(task.id)
        .flatMap((attempt) =>
          context.store.tasks.listChangedFiles(task.id, attempt.attempt),
        ),
    )
    .filter((file) => !file.withinOwnership).length;
}

function parseLastEventId(header: string | undefined): number {
  if (header === undefined) {
    return 0;
  }
  const parsed = Number(header);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function openEventStream(
  reply: FastifyReply,
  context: AgentFlowContext,
  buildId: string,
  afterSequence: number,
): void {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  let cursor = afterSequence;

  const flush = (): void => {
    const events = context.store.events.listForBuild(buildId, {
      afterSequence: cursor,
      limit: 1_000,
    });
    for (const event of events) {
      writeEvent(response, event.sequence, event);
      cursor = event.sequence;
    }
  };

  flush();
  const interval = setInterval(flush, 1_000);
  interval.unref();
  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 15_000);
  heartbeat.unref();
  response.on("close", () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
}

function writeEvent(
  response: ServerResponse,
  sequence: number,
  event: unknown,
): void {
  response.write(`id: ${sequence}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function safeId(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-");
}

function resolveAttemptDocumentPath(
  attempt: ReturnType<AgentFlowContext["store"]["tasks"]["getAttempt"]>,
  document: z.infer<typeof AttemptDocumentParameters>["document"],
): string {
  const known = {
    prompt: attempt.promptPath,
    jsonl: attempt.jsonlPath,
    stderr: attempt.logPath,
  } as const;
  if (document in known) {
    const selected = known[document as keyof typeof known];
    if (selected === null) {
      throw new AgentFlowError(
        "ATTEMPT_DOCUMENT_UNAVAILABLE",
        `Attempt ${attempt.attempt} has no ${document} document`,
        404,
      );
    }
    return selected;
  }
  if (attempt.promptPath === null) {
    throw new AgentFlowError(
      "ATTEMPT_DOCUMENT_UNAVAILABLE",
      `Attempt ${attempt.attempt} has no runtime directory`,
      404,
    );
  }
  return path.join(
    path.dirname(attempt.promptPath),
    document === "result" ? "worker-result.json" : "worker-outcome.json",
  );
}

async function readRuntimeDocument(
  runsRoot: string,
  documentPath: string,
): Promise<{
  path: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}> {
  const canonicalRoot = await realpath(runsRoot);
  const canonicalDocument = await realpath(documentPath);
  if (!isPathInside(canonicalRoot, canonicalDocument)) {
    throw new AgentFlowError(
      "RUNTIME_PATH_OUTSIDE_ROOT",
      "Attempt document is outside the AgentFlow runs directory",
      403,
    );
  }
  const metadata = await stat(canonicalDocument);
  if (!metadata.isFile()) {
    throw new AgentFlowError(
      "ATTEMPT_DOCUMENT_INVALID",
      "Attempt document is not a regular file",
      400,
    );
  }
  const maximumBytes = 2 * 1024 * 1024;
  const start = Math.max(0, metadata.size - maximumBytes);
  const handle = await open(canonicalDocument, "r");
  try {
    const buffer = Buffer.alloc(Math.min(metadata.size, maximumBytes));
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      start,
    );
    return {
      path: canonicalDocument,
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: start > 0,
      sizeBytes: metadata.size,
    };
  } finally {
    await handle.close();
  }
}
