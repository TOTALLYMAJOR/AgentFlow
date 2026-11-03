import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AgentFlowContext } from "../context.js";
import { calculateEstimateCalibration } from "../../planning/calibration.js";
import { RepositoryServiceError } from "../../repositories/errors.js";
import { inspectRepositoryTarget } from "../../repositories/target-catalog.js";

const RepositoryIdParameters = z.object({
  id: z.string().min(1),
});

const RegisterRepositoryBody = z.object({
  path: z.string().min(1),
  initializeIfMissing: z.boolean().default(false),
});

const PreflightRepositoryBody = z.object({
  path: z.string().min(1),
});

const InitializeRepositoryBody = z.object({
  path: z.string().min(1),
});

const CommitReviewedBacklogBody = z.object({
  expectedBacklogPath: z.string().min(1).optional(),
  expectedBacklogSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expectedConfigurationSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

const CommitReviewedConfigurationBody = z.object({
  expectedConfigurationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export function registerRepositoryRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.get("/api/repositories", async () => context.repositoryService.list());

  app.post("/api/repositories/preflight", async (request) => {
    const input = PreflightRepositoryBody.parse(request.body);
    return context.repositoryService.preflight(input.path);
  });

  app.get("/api/repositories/targets", async () => {
    const repositories = await context.repositoryService.list();
    const checkedAt = new Date().toISOString();
    return Promise.all(
      repositories.map((repository) =>
        inspectRepositoryTarget(
          repository,
          context.store.builds.findActive(repository.id),
          checkedAt,
        ),
      ),
    );
  });

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

  app.get("/api/repositories/:id/backlog/review", async (request) => {
    const { id } = RepositoryIdParameters.parse(request.params);
    return context.repositoryService.reviewBacklog(id);
  });

  app.get("/api/repositories/:id/configuration/review", async (request) => {
    const { id } = RepositoryIdParameters.parse(request.params);
    return context.repositoryService.reviewConfiguration(id);
  });

  app.post("/api/repositories/:id/backlog/commit", async (request) => {
    const { id } = RepositoryIdParameters.parse(request.params);
    const expectations = CommitReviewedBacklogBody.parse(request.body ?? {});
    if (context.store.builds.findActive(id)) throw new RepositoryServiceError(
      "REPOSITORY_GIT_BUSY", "An active build must finish before saving reviewed repository files.", 409);
    return context.repositoryService.commitReviewedBacklog(id, expectations);
  });

  app.post("/api/repositories/:id/configuration/commit", async (request) => {
    const { id } = RepositoryIdParameters.parse(request.params);
    const expectations = CommitReviewedConfigurationBody.parse(request.body ?? {});
    if (context.store.builds.findActive(id)) throw new RepositoryServiceError(
      "REPOSITORY_GIT_BUSY", "An active build must finish before saving reviewed repository setup.", 409);
    return context.repositoryService.commitReviewedConfiguration(id, expectations);
  });

  app.delete("/api/repositories/:id", async (request, reply) => {
    const { id } = RepositoryIdParameters.parse(request.params);
    await context.repositoryService.remove(id);
    await reply.status(204).send();
  });
}
