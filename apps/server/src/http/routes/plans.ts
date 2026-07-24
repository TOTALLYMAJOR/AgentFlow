import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PlanResult } from "../../domain/types.js";
import { AgentFlowError } from "../errors.js";
import type { AgentFlowContext } from "../context.js";
import {
  loadRepositoryConfig,
} from "../../repositories/index.js";
import { planBacklogMarkdown } from "../../planning/index.js";
import { createId, nowIso } from "../../util/ids.js";

const CreatePlanBody = z.object({
  repositoryId: z.string().min(1),
  backlogPath: z.string().trim().min(1).optional(),
  workerEfficiency: z.number().positive().max(1).optional(),
  overheadPercent: z.number().min(0).max(500).optional(),
});

const PlanIdParameters = z.object({
  id: z.string().min(1),
});

export function registerPlanRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.post("/api/plans", async (request, reply) => {
    const input = CreatePlanBody.parse(request.body);
    const repository = await context.repositoryService.get(input.repositoryId);
    const config = await loadRepositoryConfig(repository.localPath);
    const relativeBacklogPath = input.backlogPath ?? config.backlog.path;
    const backlogPath = await resolveRepositoryFile(
      repository.localPath,
      relativeBacklogPath,
    );
    const markdown = await readFile(backlogPath, "utf8");
    const planning = planBacklogMarkdown(markdown, {
      defaultValidation: config.validation.task_default,
      workerMaximum: config.workers.maximum,
      ...(input.workerEfficiency === undefined
        ? {}
        : { workerEfficiency: input.workerEfficiency }),
      ...(input.overheadPercent === undefined
        ? {}
        : { overheadPercent: input.overheadPercent }),
    });

    if (!planning.valid || planning.plan === undefined) {
      throw new AgentFlowError(
        "BACKLOG_INVALID",
        "The backlog did not pass AgentFlow preflight",
        422,
        planning.errors,
      );
    }

    const id = createId("plan");
    const createdAt = nowIso();
    const backlogSha256 = createHash("sha256").update(markdown).digest("hex");
    const normalizedPlan: PlanResult = {
      id,
      repositoryId: repository.id,
      backlogPath: relativeBacklogPath,
      backlogSha256,
      ...planning.plan,
      createdAt,
    };
    const stored = context.store.plans.create({
      id,
      repositoryId: repository.id,
      backlogPath: relativeBacklogPath,
      backlogSha256,
      backlogContents: markdown,
      repositoryConfig: config,
      normalizedPlan,
      createdAt,
    });
    await reply.status(201).send(stored.normalizedPlan);
  });

  app.get("/api/plans/:id", async (request) => {
    const { id } = PlanIdParameters.parse(request.params);
    return context.store.plans.getById(id).normalizedPlan;
  });
}

async function resolveRepositoryFile(
  repositoryRoot: string,
  relativePath: string,
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new AgentFlowError(
      "INVALID_REPOSITORY_PATH",
      "Backlog paths must be relative to the registered repository",
    );
  }
  const candidate = path.resolve(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new AgentFlowError(
      "INVALID_REPOSITORY_PATH",
      "Backlog path escapes the registered repository",
    );
  }
  const canonical = await realpath(candidate);
  const canonicalRelative = path.relative(repositoryRoot, canonical);
  if (
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new AgentFlowError(
      "INVALID_REPOSITORY_PATH",
      "Backlog symlink escapes the registered repository",
    );
  }
  return canonical;
}
