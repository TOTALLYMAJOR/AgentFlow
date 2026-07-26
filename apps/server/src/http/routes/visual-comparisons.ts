import { realpath } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createId } from "../../util/ids.js";
import {
  captureBrowserScreenshot,
  comparePngs,
} from "../../visual/comparison.js";
import type { AgentFlowContext } from "../context.js";
import { AgentFlowError } from "../errors.js";

const RepositoryParameters = z.object({ id: z.string().min(1) });
const CreateComparisonBody = z.object({
  repositoryId: z.string().min(1),
  buildId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  url: z.url(),
  baselinePath: z.string().trim().min(1),
  viewport: z
    .object({
      width: z.number().int().min(320).max(3840).default(1440),
      height: z.number().int().min(240).max(2160).default(900),
    })
    .default({ width: 1440, height: 900 }),
  fullPage: z.boolean().default(true),
  pixelThreshold: z.number().min(0).max(1).default(0.1),
  maximumDifferenceRatio: z.number().min(0).max(1).default(0.001),
});

export function registerVisualComparisonRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.get("/api/repositories/:id/visual-comparisons", async (request) => {
    const { id } = RepositoryParameters.parse(request.params);
    await context.repositoryService.get(id);
    return context.store.visualComparisons.listForRepository(id);
  });

  app.post("/api/visual-comparisons", async (request, reply) => {
    const input = CreateComparisonBody.parse(request.body);
    if (
      input.maximumDifferenceRatio >
      context.organizationPolicy.visual.maximum_difference_ratio
    ) {
      throw new AgentFlowError(
        "VISUAL_POLICY_VIOLATION",
        "Requested visual tolerance exceeds organization policy",
        422,
        {
          requested: input.maximumDifferenceRatio,
          maximum:
            context.organizationPolicy.visual.maximum_difference_ratio,
        },
      );
    }
    const repository = await context.repositoryService.get(input.repositoryId);
    const baselinePath = await resolveRepositoryFile(
      repository.localPath,
      input.baselinePath,
    );
    if (input.buildId !== undefined) {
      const build = context.store.builds.getById(input.buildId);
      if (build.repositoryId !== repository.id) {
        throw new AgentFlowError(
          "VISUAL_BUILD_REPOSITORY_MISMATCH",
          "Visual comparison build belongs to a different repository",
          409,
        );
      }
    }
    if (input.taskId !== undefined) {
      if (input.buildId === undefined) {
        throw new AgentFlowError(
          "VISUAL_TASK_BUILD_REQUIRED",
          "A visual comparison task requires its build ID",
          400,
        );
      }
      const task = context.store.tasks.getById(input.taskId);
      if (task.buildId !== input.buildId) {
        throw new AgentFlowError(
          "VISUAL_TASK_BUILD_MISMATCH",
          "Visual comparison task belongs to a different build",
          409,
        );
      }
    }
    const id = createId("visual");
    const artifactDirectory = path.join(
      context.environment.artifactsPath,
      "visual-comparisons",
      id,
    );
    const actualPath = path.join(artifactDirectory, "actual.png");
    const diffPath = path.join(artifactDirectory, "diff.png");
    try {
      await captureBrowserScreenshot({
        url: input.url,
        outputPath: actualPath,
        width: input.viewport.width,
        height: input.viewport.height,
        fullPage: input.fullPage,
      });
      const comparison = await comparePngs({
        baselinePath,
        actualPath,
        diffPath,
        pixelThreshold: input.pixelThreshold,
        maximumDifferenceRatio: input.maximumDifferenceRatio,
      });
      const stored = context.store.visualComparisons.create({
        id,
        repositoryId: repository.id,
        buildId: input.buildId ?? null,
        taskId: input.taskId ?? null,
        routeUrl: input.url,
        baselinePath,
        actualPath,
        diffPath: comparison.diffPath,
        width: comparison.width,
        height: comparison.height,
        differentPixels: comparison.differentPixels,
        differenceRatio: comparison.differenceRatio,
        maximumDifferenceRatio: input.maximumDifferenceRatio,
        status: comparison.status,
      });
      await reply.status(201).send(stored);
    } catch (cause) {
      throw new AgentFlowError(
        "VISUAL_COMPARISON_FAILED",
        cause instanceof Error
          ? cause.message
          : "Browser screenshot comparison failed",
        502,
      );
    }
  });
}

async function resolveRepositoryFile(
  repositoryRoot: string,
  relativePath: string,
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new AgentFlowError(
      "VISUAL_BASELINE_PATH_INVALID",
      "Visual baseline paths must be repository-relative",
      400,
    );
  }
  const [root, candidate] = await Promise.all([
    realpath(repositoryRoot),
    realpath(path.resolve(repositoryRoot, relativePath)),
  ]);
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new AgentFlowError(
      "VISUAL_BASELINE_PATH_INVALID",
      "Visual baseline escapes the repository",
      400,
    );
  }
  return candidate;
}
