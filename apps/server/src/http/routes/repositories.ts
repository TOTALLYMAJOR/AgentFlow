import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AgentFlowContext } from "../context.js";
import { calculateEstimateCalibration } from "../../planning/calibration.js";

const RepositoryIdParameters = z.object({
  id: z.string().min(1),
});

const RegisterRepositoryBody = z.object({
  path: z.string().min(1),
  initializeIfMissing: z.boolean().default(true),
});

const InitializeRepositoryBody = z.object({
  path: z.string().min(1),
});

export function registerRepositoryRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.get("/api/repositories", async () => context.repositoryService.list());

  app.post("/api/repositories", async (request, reply) => {
    const input = RegisterRepositoryBody.parse(request.body);
    const repository = await context.repositoryService.register(input.path, {
      initializeIfMissing: input.initializeIfMissing,
    });
    await reply.status(201).send(repository);
  });

  app.post("/api/repositories/initialize", async (request, reply) => {
    const input = InitializeRepositoryBody.parse(request.body);
    const result = await context.repositoryService.initialize(input.path);
    await reply.status(result.created ? 201 : 200).send(result);
  });

  app.get("/api/repositories/:id", async (request) => {
    const { id } = RepositoryIdParameters.parse(request.params);
    return context.repositoryService.get(id);
  });

  app.get("/api/repositories/:id/estimate-calibration", async (request) => {
    const { id } = RepositoryIdParameters.parse(request.params);
    await context.repositoryService.get(id);
    return calculateEstimateCalibration(context.database, id);
  });

  app.post("/api/repositories/:id/inspect", async (request) => {
    const { id } = RepositoryIdParameters.parse(request.params);
    return context.repositoryService.inspect(id);
  });

  app.delete("/api/repositories/:id", async (request, reply) => {
    const { id } = RepositoryIdParameters.parse(request.params);
    await context.repositoryService.remove(id);
    await reply.status(204).send();
  });
}
