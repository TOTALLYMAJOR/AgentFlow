import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GitCommandRunner } from "../../git/index.js";
import { validateInitiativeGraph } from "../../multi-repo/validation.js";
import { createId } from "../../util/ids.js";
import { AgentFlowError } from "../errors.js";
import type { AgentFlowContext } from "../context.js";

const Parameters = z.object({ id: z.string().min(1) });
const CreateBody = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(10).max(4_000),
  members: z.array(z.object({ planId: z.string().min(1), baseCommit: z.string().min(7) })).min(2),
  dependencies: z.array(z.object({ producerPlanId: z.string().min(1), consumerPlanId: z.string().min(1), dependencyType: z.enum(["hard", "artifact", "runtime", "shared_resource"]), artifactName: z.string().min(1).optional(), artifactVersion: z.string().min(1).optional(), sharedResource: z.string().min(1).optional() })).default([]),
});

export function registerInitiativeRoutes(app: FastifyInstance, context: AgentFlowContext): void {
  app.post("/api/initiatives", async (request, reply) => {
    const input = CreateBody.parse(request.body);
    const dependencies = input.dependencies.map((dependency) => ({
      producerPlanId: dependency.producerPlanId,
      consumerPlanId: dependency.consumerPlanId,
      dependencyType: dependency.dependencyType,
      ...(dependency.artifactName === undefined ? {} : { artifactName: dependency.artifactName }),
      ...(dependency.artifactVersion === undefined ? {} : { artifactVersion: dependency.artifactVersion }),
      ...(dependency.sharedResource === undefined ? {} : { sharedResource: dependency.sharedResource }),
    }));
    const git = new GitCommandRunner();
    const evidence = await Promise.all(input.members.map(async (member) => {
      const plan = context.store.plans.getById(member.planId);
      const repository = await context.repositoryService.get(plan.repositoryId);
      const actualCommit = (await git.run(repository.localPath, ["rev-parse", `${repository.baseBranch}^{commit}`])).stdout.trim();
      if (actualCommit !== member.baseCommit) throw new AgentFlowError("INITIATIVE_COMMIT_DRIFT", `Repository ${repository.id} no longer matches proposed base commit`, 409, { expected: member.baseCommit, actual: actualCommit });
      return { repositoryId: repository.id, planId: plan.id, baseCommit: actualCommit, planSha256: plan.backlogSha256, producedArtifacts: plan.normalizedPlan.tasks.flatMap((task) => task.produces.map((artifact) => ({ name: artifact.name, version: artifact.version }))) };
    }));
    const validation = validateInitiativeGraph(evidence, dependencies);
    if (!validation.valid) throw new AgentFlowError("INITIATIVE_INVALID", "The multi-repository initiative did not pass preflight", 422, validation.errors);
    const initiative = context.store.initiatives.create({ id: createId("initiative"), title: input.title, objective: input.objective, members: evidence, dependencies });
    await reply.status(201).send({ ...initiative, waves: validation.waves });
  });

  app.get("/api/initiatives/:id", async (request) => context.store.initiatives.get(Parameters.parse(request.params).id));

  app.post("/api/initiatives/:id/approve", async (request) => {
    const id = Parameters.parse(request.params).id;
    const initiative = context.store.initiatives.get(id);
    for (const member of initiative.members) context.store.plans.lock(member.planId);
    return context.store.initiatives.approve(id);
  });
}
