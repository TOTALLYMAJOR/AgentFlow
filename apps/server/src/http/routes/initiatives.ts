import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GitCommandRunner } from "../../git/index.js";
import { executionDependencies, validateInitiativeGraph } from "../../multi-repo/validation.js";
import { createId } from "../../util/ids.js";
import { AgentFlowError } from "../errors.js";
import type { AgentFlowContext } from "../context.js";
import { createBuildForPlan } from "./builds.js";

const Parameters = z.object({ id: z.string().min(1) });
const CreateBody = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(10).max(4_000),
  members: z.array(z.object({ planId: z.string().min(1), baseCommit: z.string().min(7) })).min(2),
  dependencies: z.array(z.object({ producerPlanId: z.string().min(1), consumerPlanId: z.string().min(1), dependencyType: z.enum(["hard", "artifact", "runtime", "shared_resource"]), artifactName: z.string().min(1).optional(), artifactVersion: z.string().min(1).optional(), sharedResource: z.string().min(1).optional() })).default([]),
});
type CreateInitiativeBody = z.infer<typeof CreateBody>;

export function registerInitiativeRoutes(app: FastifyInstance, context: AgentFlowContext): void {
  app.get("/api/initiative-candidates", async () => {
    const git = new GitCommandRunner();
    const repositories = await context.repositoryService.list();
    return (await Promise.all(repositories.map(async (repository) => {
      const baseCommit = (await git.run(repository.localPath, ["rev-parse", `${repository.baseBranch}^{commit}`])).stdout.trim();
      return context.store.plans.listForRepository(repository.id).map((plan) => ({ repositoryId: repository.id, repositoryName: repository.name, planId: plan.id, baseCommit, planSha256: plan.backlogSha256, createdAt: plan.createdAt, lockedAt: plan.lockedAt, taskCount: plan.normalizedPlan.tasks.length }));
    }))).flat();
  });

  app.get("/api/initiatives", async () => context.store.initiatives.list().map((initiative) => describeInitiative(context, initiative)));

  app.post("/api/initiatives", async (request, reply) => {
    await reply.status(201).send(await createInitiative(context, CreateBody.parse(request.body)));
  });

  app.get("/api/initiatives/:id", async (request) => describeInitiative(context, context.store.initiatives.get(Parameters.parse(request.params).id)));

  app.post("/api/initiatives/:id/approve", async (request) => {
    const id = Parameters.parse(request.params).id;
    const initiative = context.store.initiatives.get(id);
    for (const member of initiative.members) context.store.plans.lock(member.planId);
    return context.store.initiatives.approve(id);
  });

  app.post("/api/initiatives/:id/start", async (request) => {
    const id = Parameters.parse(request.params).id;
    const initiative = context.store.initiatives.get(id);
    if (initiative.status !== "approved") throw new AgentFlowError("INITIATIVE_NOT_APPROVED", `Initiative ${id} cannot start from ${initiative.status}`, 409);
    await assertMemberCommits(context, initiative.members);
    context.store.initiatives.transition(id, "running", "initiative.started");
    return reconcileInitiative(context, id);
  });

  app.post("/api/initiatives/:id/reconcile", async (request) => reconcileInitiative(context, Parameters.parse(request.params).id));

  app.post("/api/initiatives/:id/pause", async (request) => {
    const id = Parameters.parse(request.params).id;
    const initiative = context.store.initiatives.get(id);
    for (const member of initiative.members) if (member.buildId !== null && context.store.builds.getById(member.buildId).status === "running") context.coordinator.pause(member.buildId);
    return context.store.initiatives.transition(id, "paused", "initiative.paused");
  });

  app.post("/api/initiatives/:id/resume", async (request) => {
    const id = Parameters.parse(request.params).id;
    const initiative = context.store.initiatives.get(id);
    for (const member of initiative.members) if (member.buildId !== null && ["paused", "interrupted"].includes(context.store.builds.getById(member.buildId).status)) await context.coordinator.resume(member.buildId);
    context.store.initiatives.transition(id, "running", "initiative.resumed");
    return reconcileInitiative(context, id);
  });

  app.post("/api/initiatives/:id/cancel", async (request) => {
    const id = Parameters.parse(request.params).id;
    const initiative = context.store.initiatives.get(id);
    for (const member of initiative.members) if (member.buildId !== null && !["completed", "failed", "cancelled"].includes(context.store.builds.getById(member.buildId).status)) context.coordinator.cancel(member.buildId);
    return context.store.initiatives.transition(id, "cancelled", "initiative.cancelled");
  });

  app.post("/api/initiatives/:id/replan", async (request, reply) => {
    const previous = context.store.initiatives.get(Parameters.parse(request.params).id);
    const input = CreateBody.parse(request.body);
    const created = await createInitiative(context, input, previous.id);
    await reply.status(201).send(created);
  });
}

async function createInitiative(context: AgentFlowContext, input: CreateInitiativeBody, supersedesInitiativeId?: string): Promise<Record<string, unknown>> {
  const dependencies = input.dependencies.map((dependency) => ({ producerPlanId: dependency.producerPlanId, consumerPlanId: dependency.consumerPlanId, dependencyType: dependency.dependencyType, ...(dependency.artifactName === undefined ? {} : { artifactName: dependency.artifactName }), ...(dependency.artifactVersion === undefined ? {} : { artifactVersion: dependency.artifactVersion }), ...(dependency.sharedResource === undefined ? {} : { sharedResource: dependency.sharedResource }) }));
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
  const initiative = context.store.initiatives.create({ id: createId("initiative"), title: input.title, objective: input.objective, members: evidence, dependencies, ...(supersedesInitiativeId === undefined ? {} : { supersedesInitiativeId }) });
  return { ...initiative, waves: validation.waves };
}

async function assertMemberCommits(context: AgentFlowContext, members: Array<{ repositoryId: string; baseCommit: string }>): Promise<void> {
  const git = new GitCommandRunner();
  for (const member of members) {
    const repository = await context.repositoryService.get(member.repositoryId);
    const actual = (await git.run(repository.localPath, ["rev-parse", `${repository.baseBranch}^{commit}`])).stdout.trim();
    if (actual !== member.baseCommit) throw new AgentFlowError("INITIATIVE_COMMIT_DRIFT", `Repository ${repository.id} changed after initiative review`, 409, { expected: member.baseCommit, actual });
  }
}

export async function reconcileInitiative(context: AgentFlowContext, id: string): Promise<Record<string, unknown>> {
  let initiative = context.store.initiatives.get(id);
  if (!["running", "partial"].includes(initiative.status)) throw new AgentFlowError("INITIATIVE_NOT_RUNNING", `Initiative ${id} cannot reconcile from ${initiative.status}`, 409);
  const memberByPlan = new Map(initiative.members.map((member) => [member.planId, member]));
  const executionEdges = executionDependencies(initiative.dependencies);
  let startedCount = 0;
  for (const member of initiative.members) {
    if (member.buildId !== null) continue;
    const memberBlockers = blockersForPlan(context, executionEdges, memberByPlan, member.planId);
    if (memberBlockers.length > 0) continue;
    const build = await createBuildForPlan(context, member.planId);
    context.store.initiatives.attachBuild(id, member.planId, build.id);
    await context.coordinator.start(build.id);
    startedCount += 1;
  }
  initiative = context.store.initiatives.get(id);
  if (startedCount > 0 && initiative.status === "partial") initiative = context.store.initiatives.transition(id, "running", "initiative.resumed");
  const builds = initiative.members.flatMap((member) => member.buildId === null ? [] : [context.store.builds.getById(member.buildId)]);
  if (builds.length === initiative.members.length && builds.every((build) => build.status === "completed") && initiative.status === "running") initiative = context.store.initiatives.transition(id, "completed", "initiative.completed");
  else if (builds.some((build) => ["paused", "interrupted"].includes(build.status)) && initiative.status === "running") initiative = context.store.initiatives.transition(id, "paused", "initiative.recovery_paused", { builds: builds.map((build) => ({ id: build.id, status: build.status })) });
  else if (builds.some((build) => ["failed", "cancelled"].includes(build.status)) && initiative.status === "running") initiative = context.store.initiatives.transition(id, builds.some((build) => build.status === "completed") ? "partial" : "failed", "initiative.blocked", { builds: builds.map((build) => ({ id: build.id, status: build.status })) });
  return describeInitiative(context, initiative);
}

function describeInitiative(context: AgentFlowContext, initiative: ReturnType<AgentFlowContext["store"]["initiatives"]["get"]>): Record<string, unknown> {
  const memberByPlan = new Map(initiative.members.map((member) => [member.planId, member]));
  const blockers = initiative.members.filter((member) => member.buildId === null).flatMap((member) => blockersForPlan(context, executionDependencies(initiative.dependencies), memberByPlan, member.planId));
  const builds = initiative.members.flatMap((member) => member.buildId === null ? [] : [context.store.builds.getById(member.buildId)]);
  const cleanup = builds.map((build) => ({ buildId: build.id, status: build.status, completedAt: build.completedAt, eligibleAt: build.completedAt === null ? null : new Date(Date.parse(build.completedAt) + 24 * 60 * 60 * 1000).toISOString(), receipts: context.store.cleanupReceipts.list(build.id) }));
  return { ...initiative, builds, blockers, cleanup };
}

function blockersForPlan(context: AgentFlowContext, dependencies: ReturnType<typeof executionDependencies>, memberByPlan: Map<string, ReturnType<AgentFlowContext["store"]["initiatives"]["get"]>["members"][number]>, planId: string): Array<{ planId: string; code: string; message: string; recovery: string }> {
  return dependencies.filter((edge) => edge.consumerPlanId === planId).flatMap((edge) => {
    const producer = memberByPlan.get(edge.producerPlanId);
    if (producer?.buildId === null || producer?.buildId === undefined) return [{ planId, code: "UPSTREAM_NOT_STARTED", message: `Waiting for upstream plan ${edge.producerPlanId} to start`, recovery: "Start or recover the upstream repository build" }];
    const producerBuild = context.store.builds.getById(producer.buildId);
    if (producerBuild.status !== "completed") return [{ planId, code: "UPSTREAM_NOT_COMPLETED", message: `Waiting for upstream build ${producerBuild.id}; current state is ${producerBuild.status}`, recovery: "Complete or recover the upstream repository build" }];
    if (edge.dependencyType !== "artifact") return [];
    const integrated = context.store.artifacts.listForBuild(producerBuild.id).some((artifact) => artifact.name === edge.artifactName && artifact.version === edge.artifactVersion && artifact.status === "integrated");
    return integrated ? [] : [{ planId, code: "ARTIFACT_NOT_INTEGRATED", message: `Required artifact ${edge.artifactName}@${edge.artifactVersion} from ${edge.producerPlanId} is not integrated`, recovery: "Validate and integrate the exact upstream artifact, then reconcile" }];
  });
}
