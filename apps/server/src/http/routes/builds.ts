import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type {
  BuildEntity,
  CreateTaskInput,
  TaskEntity,
} from "../../db/index.js";
import type { PlannedTask } from "../../domain/types.js";
import { runGit } from "../../repositories/index.js";
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

const CreateBuildBody = z.object({
  planId: z.string().min(1),
});

export function registerBuildRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.post("/api/builds", async (request, reply) => {
    const { planId } = CreateBuildBody.parse(request.body);
    if (context.store.builds.findActive() !== undefined) {
      throw new AgentFlowError(
        "ACTIVE_BUILD_EXISTS",
        "Only one build may be active across this AgentFlow installation",
        409,
      );
    }
    const plan = context.store.plans.getById(planId);
    const repository = await context.repositoryService.get(plan.repositoryId);
    const baseCommit = (
      await runGit(repository.localPath, [
        "rev-parse",
        `${repository.baseBranch}^{commit}`,
      ])
    ).stdout.trim();
    const buildId = createId("build");
    const taskIds = new Map(
      plan.normalizedPlan.tasks.map((task) => [
        task.id,
        createId(`task_${safeId(task.id)}`),
      ]),
    );
    const tasks = plan.normalizedPlan.tasks.map((task) =>
      createTaskInput(task, taskIds),
    );
    const build = context.store.builds.create({
      id: buildId,
      repositoryId: repository.id,
      planId,
      backlogPath: plan.backlogPath,
      baseCommit,
      integrationBranch: `agent-integration/${buildId}`,
      status: "ready",
      workerLimit: Math.min(4, plan.normalizedPlan.estimates.maximumTheoreticalConcurrency),
      tasks,
    });
    for (let slot = 1; slot <= build.workerLimit; slot += 1) {
      context.store.workers.create({
        id: `${buildId}:worker:${slot}`,
        buildId,
        status: "idle",
      });
    }
    await reply.status(201).send(await serializeBuild(context, build));
  });

  app.get("/api/builds", async () =>
    Promise.all(
      context.store.builds.list().map(async (build) =>
        serializeBuild(context, build),
      ),
    ),
  );

  app.get("/api/builds/:id", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    return serializeBuild(context, context.store.builds.getById(id));
  });

  app.post("/api/builds/:id/start", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    return serializeBuild(
      context,
      context.store.builds.transition(id, "running", {
        eventType: "build.started",
      }),
    );
  });

  app.post("/api/builds/:id/pause", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    return serializeBuild(
      context,
      context.store.builds.transition(id, "paused", {
        eventType: "build.paused",
      }),
    );
  });

  app.post("/api/builds/:id/resume", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    return serializeBuild(
      context,
      context.store.builds.transition(id, "running", {
        eventType: "build.resumed",
      }),
    );
  });

  app.post("/api/builds/:id/cancel", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    const build = context.store.builds.transition(id, "cancelled", {
      eventType: "build.cancelled",
    });
    cancelNonTerminalTasks(context, id);
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
      approvals: context.store.approvals.listPending(id, task.id),
      artifacts: context.store.artifacts
        .listForBuild(id)
        .filter((artifact) => artifact.producerTaskId === task.id),
    };
  });

  app.post("/api/builds/:id/tasks/:taskId/retry", async (request) => {
    const { id, taskId } = TaskIdParameters.parse(request.params);
    assertTaskInBuild(context, id, taskId);
    return context.store.tasks.retry(taskId);
  });

  app.get("/api/builds/:id/artifacts", async (request) => {
    const { id } = BuildIdParameters.parse(request.params);
    context.store.builds.getById(id);
    return context.store.artifacts.listForBuild(id);
  });

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
    state: task.dependsOn.length === 0 ? "ready" : "blocked",
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

function cancelNonTerminalTasks(
  context: AgentFlowContext,
  buildId: string,
): void {
  for (const task of context.store.tasks.listForBuild(buildId)) {
    if (
      ["integrated", "failed", "cancelled", "blocked_failed"].includes(
        task.state,
      )
    ) {
      continue;
    }
    try {
      context.store.tasks.transition(task.id, "cancelled", {
        eventType: "task.cancelled",
      });
    } catch {
      context.store.tasks.transition(task.id, "interrupted", {
        eventType: "task.interrupted_for_cancellation",
      });
    }
  }
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
