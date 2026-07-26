import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  analyzeImpact,
  scanCodebaseGraph,
} from "../../knowledge/graph.js";
import { createId } from "../../util/ids.js";
import type { AgentFlowContext } from "../context.js";
import { AgentFlowError } from "../errors.js";

const RepositoryParameters = z.object({ id: z.string().min(1) });
const ImpactBody = z.object({
  changedPaths: z.array(z.string().trim().min(1)).min(1).max(100),
});

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.post("/api/repositories/:id/knowledge/scan", async (request, reply) => {
    const { id } = RepositoryParameters.parse(request.params);
    const repository = await context.repositoryService.get(id);
    const graph = await scanCodebaseGraph(repository.localPath);
    const snapshot = context.store.knowledge.createSnapshot({
      id: createId("knowledge"),
      repositoryId: id,
      baseCommit: graph.baseCommit,
      nodes: graph.nodes,
      edges: graph.edges,
    });
    await reply.status(201).send({
      snapshot,
      skippedFiles: graph.skippedFiles,
    });
  });

  app.get("/api/repositories/:id/knowledge", async (request) => {
    const { id } = RepositoryParameters.parse(request.params);
    await context.repositoryService.get(id);
    const snapshot = context.store.knowledge.latest(id);
    return snapshot === undefined
      ? { snapshot: null, nodes: [], edges: [] }
      : {
          snapshot,
          nodes: context.store.knowledge.nodes(snapshot.id),
          edges: context.store.knowledge.edges(snapshot.id),
        };
  });

  app.post("/api/repositories/:id/knowledge/impact", async (request) => {
    const { id } = RepositoryParameters.parse(request.params);
    await context.repositoryService.get(id);
    const input = ImpactBody.parse(request.body);
    const snapshot = context.store.knowledge.latest(id);
    if (snapshot === undefined) {
      throw new AgentFlowError(
        "KNOWLEDGE_SNAPSHOT_REQUIRED",
        "Scan the repository knowledge graph before impact analysis",
        409,
      );
    }
    const impactedFiles = analyzeImpact(
      input.changedPaths,
      context.store.knowledge.nodes(snapshot.id),
      context.store.knowledge.edges(snapshot.id),
    );
    const impactedTasks = context.store.builds
      .listActive()
      .filter((build) => build.repositoryId === id)
      .flatMap((build) =>
        context.store.tasks.listForBuild(build.id).flatMap((task) => {
          const ownedPaths = context.store.tasks.listOwnedPaths(task.id);
          const matchedFiles = impactedFiles
            .filter((file) =>
              ownedPaths.some((ownedPath) =>
                ownershipMatches(ownedPath, file.path),
              ),
            )
            .map((file) => file.path);
          return matchedFiles.length === 0
            ? []
            : [
                {
                  buildId: build.id,
                  taskId: task.id,
                  backlogTaskId: task.backlogTaskId,
                  state: task.state,
                  ownedPaths,
                  matchedFiles,
                },
              ];
        }),
      );
    return {
      snapshot,
      changedPaths: input.changedPaths,
      impactedFiles,
      impactedTasks,
      summary: {
        directFiles: impactedFiles.filter((file) => file.distance === 0).length,
        transitiveFiles: impactedFiles.filter((file) => file.distance > 0)
          .length,
        activeTasks: impactedTasks.length,
        maximumDistance: Math.max(
          0,
          ...impactedFiles.map((file) => file.distance),
        ),
      },
    };
  });
}

function ownershipMatches(ownedPath: string, filePath: string): boolean {
  const normalized = ownedPath
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
  return filePath === normalized || filePath.startsWith(`${normalized}/`);
}
