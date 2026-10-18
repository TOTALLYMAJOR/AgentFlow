import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BUILD_RECEIPT_VERSION,
  BUILD_RECEIPT_KIND,
  canonicalJsonSha256,
  handoffBinding,
  loadGovernedTaskHandoff,
  renderBacklog,
  verifyGovernedHandoffForExecution,
} from "../../integration/design-intelligence.js";
import { evaluateGovernedBuild } from "../../governor/build-control.js";
import { applyGovernorDecision } from "../../governor/runtime-adapter.js";
import { nowIso } from "../../util/ids.js";
import type { AgentFlowContext } from "../context.js";
import { AgentFlowError } from "../errors.js";
import { runGit } from "../../repositories/index.js";

const ImportBody = z.object({ repositoryId: z.string().min(1), handoffPath: z.string().min(1), backlogPath: z.string().min(1).default("BACKLOG.design-intelligence.proposed.md") });
const BuildParameters = z.object({ id: z.string().min(1) });

export function registerDesignIntelligenceRoutes(app: FastifyInstance, context: AgentFlowContext): void {
  app.post("/api/design-intelligence/handoffs/import", async (request) => {
    const input = ImportBody.parse(request.body);
    const repository = await context.repositoryService.get(input.repositoryId);
    const handoffAbsolute = await insideExisting(repository.localPath, input.handoffPath);
    const backlogAbsolute = inside(repository.localPath, input.backlogPath);
    const handoff = await loadGovernedTaskHandoff(handoffAbsolute);
    const verification = await verifyGovernedHandoffForExecution(repository.localPath, handoff, [input.handoffPath]);
    if (verification.errors.length > 0) throw new AgentFlowError("GOVERNED_HANDOFF_NOT_EXECUTABLE", "The governed handoff is not executable at the current repository snapshot", 409, verification.errors);
    await runGit(repository.localPath, ["ls-files", "--error-unmatch", "--", input.handoffPath]).catch(() => {
      throw new AgentFlowError("GOVERNED_HANDOFF_UNCOMMITTED", "The approved handoff must be committed before import", 409);
    });
    await writeFile(backlogAbsolute, renderBacklog(handoff, input.handoffPath, input.backlogPath), { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
      if (errorCode(error) === "EEXIST") throw new AgentFlowError("BACKLOG_ALREADY_EXISTS", `${input.backlogPath} already exists; refusing to overwrite reviewed work`, 409);
      throw error;
    });
    return { status: "PROPOSED", repositoryId: repository.id, backlogPath: input.backlogPath, handoff: handoffBinding(handoff, input.handoffPath, [input.handoffPath, input.backlogPath]), nextAction: "Review and commit the handoff and backlog before creating a plan." };
  });

  app.get("/api/builds/:id/design-intelligence-receipt", async (request) => {
    const { id } = BuildParameters.parse(request.params);
    const build = context.store.builds.getById(id);
    const binding = z.object({ id: z.string(), programId: z.string().optional(), sha256: z.string(), path: z.string(), governedBaseCommit: z.string(), proofBoundary: z.string() }).loose().safeParse(build.normalizedPlan.governedHandoff);
    if (!binding.success) throw new AgentFlowError("GOVERNED_HANDOFF_MISSING", `Build ${id} is not bound to a Design Intelligence handoff`, 409);
    const repository = await context.repositoryService.get(build.repositoryId);
    const handoffPath = await insideExisting(repository.localPath, binding.data.path);
    const handoff = await loadGovernedTaskHandoff(handoffPath);
    const tasks = context.store.tasks.listForBuild(id);
    const validations = context.store.validations.listForBuild(id);
    const generatedAt = nowIso();
    const artifacts = await retainReceiptEvidence(path.dirname(handoffPath), handoff.proof.requiredEvidence, {
      buildId: build.id,
      handoffId: binding.data.id,
      recordedAt: build.completedAt ?? build.createdAt,
      tasks: tasks.map((task) => ({
        id: task.backlogTaskId,
        status: task.state,
        resultCommit: task.resultCommit,
        integrationCommit: task.integrationCommit,
        changedFiles: [...new Set(context.store.tasks.listAttempts(task.id).flatMap((attempt) => context.store.tasks.listChangedFiles(task.id, attempt.attempt).map((file) => file.path)))],
        validations: validations.filter((validation) => validation.taskId === task.id && validation.validationType === "task").map((validation) => ({ command: validation.command, status: validation.status, exitCode: validation.exitCode })),
      })),
    });
    const evidenceIds = artifacts.map((artifact) => artifact.id);
    const authoritySource = handoff.authority.sources[0];
    const integrationCommit = tasks.find((task) => task.integrationCommit !== null)?.integrationCommit ?? null;
    const transitionEvents = authoritySource === undefined || evidenceIds.length === 0 || integrationCommit === null
      ? []
      : receiptTransitions({
          handoffSha256: binding.data.sha256,
          governedBaseCommit: binding.data.governedBaseCommit,
          executionBaseCommit: build.baseCommit,
          integrationCommit,
          buildId: build.id,
          buildStatus: build.status,
          approvedAt: handoff.authority.approvedAt,
          planCreatedAt: typeof build.normalizedPlan.createdAt === "string" ? build.normalizedPlan.createdAt : build.createdAt,
          startedAt: build.startedAt,
          validationAt: validations.find((validation) => validation.validationType === "task")?.completedAt,
          completedAt: build.completedAt,
          generatedAt,
          authoritySource,
          evidenceIds,
        });
    const governorEvents = context.store.events.listForBuild(id, { limit: 10_000 })
      .filter((event) => event.type === "governor.decision")
      .map((event) => {
        const { authorityObservation, ...record } = event.payload;
        return {
          type: "governor.decision" as const,
          payload: { record, authorityObservation },
        };
      });
    return {
      schemaVersion: BUILD_RECEIPT_VERSION,
      kind: BUILD_RECEIPT_KIND,
      ...(binding.data.programId === undefined ? {} : { programId: binding.data.programId }),
      handoff: { id: binding.data.id, sha256: binding.data.sha256 },
      build: { id: build.id, status: build.status, baseCommit: build.baseCommit, governedBaseCommit: binding.data.governedBaseCommit, integrationCommit },
      tasks: tasks.map((task) => ({
        id: task.backlogTaskId, status: task.state, resultCommit: task.resultCommit, integrationCommit: task.integrationCommit,
        changedFiles: [...new Set(context.store.tasks.listAttempts(task.id).flatMap((attempt) => context.store.tasks.listChangedFiles(task.id, attempt.attempt).map((file) => file.path)))],
        validation: validations.filter((validation) => validation.taskId === task.id && validation.validationType === "task").map((validation) => ({
          command: validation.command,
          status: validation.status,
          exitCode: validation.exitCode,
          evidenceId: artifacts.find((artifact) => artifact.class === `task:${task.backlogTaskId}:validation-passed`)?.id ?? evidenceIds[0],
        })),
      })),
      evidence: { events: [...transitionEvents, ...governorEvents], artifacts, approvals: [] },
      proofBoundary: binding.data.proofBoundary,
      generatedAt,
    };
  });

  app.post("/api/builds/:id/governor/evaluate", async (request) => {
    const { id } = BuildParameters.parse(request.params);
    const evaluated = await evaluateGovernedBuild(context, id);
    if (evaluated === undefined) throw new AgentFlowError("GOVERNED_HANDOFF_MISSING", `Build ${id} is not bound to a Design Intelligence handoff`, 409);
    const tasks = context.store.tasks.listForBuild(id);
    const latestFailedTask = [...tasks].reverse().find((task) => task.errorCode !== null);
    const acknowledgement = await applyGovernorDecision(evaluated.decision, {
      continue: async () => ({ acknowledged: true }),
      delegateRetry: async () => ({ acknowledged: latestFailedTask !== undefined && context.store.retrySchedules.get(latestFailedTask.id) !== undefined, details: { delegatedTo: "agentflow-existing-retry-schedule" } }),
      requestRepair: async () => { context.coordinator.pause(id); return { acknowledged: true, details: { state: "paused", nextAction: "bounded-repair" } }; },
      blockIntegration: async () => { context.coordinator.pause(id); return { acknowledged: true, details: { state: "paused" } }; },
      pauseForReview: async () => { context.coordinator.pause(id); return { acknowledged: true, details: { state: "paused" } }; },
      requestReconsider: async () => ({ acknowledged: false, details: { requiresApproval: true } }),
      proposeReplan: async () => ({ acknowledged: false, details: { requiresApproval: true } }),
      cancel: async () => { context.coordinator.cancel(id); return { acknowledged: true, details: { state: "cancelled" } }; },
    });
    context.store.events.append({ buildId: id, type: "governor.intervention_acknowledged", payload: { decisionRecordHash: evaluated.record.recordHash, action: evaluated.decision.action, ...acknowledgement } });
    return { ...evaluated, acknowledgement };
  });
}

interface ReceiptEvidenceContext {
  buildId: string;
  handoffId: string;
  recordedAt: string;
  tasks: Array<Record<string, unknown>>;
}

async function retainReceiptEvidence(root: string, requiredEvidence: string[], context: ReceiptEvidenceContext): Promise<Array<{ id: string; class: string; path: string; sha256: string }>> {
  const evidenceDirectory = path.join(root, "artifacts");
  await mkdir(evidenceDirectory, { recursive: true });
  return Promise.all(requiredEvidence.map(async (evidenceClass, index) => {
    const id = `evidence-${index + 1}`;
    const relativePath = `artifacts/${String(index + 1).padStart(2, "0")}-${evidenceClass.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`;
    const contents = `${JSON.stringify({ schemaVersion: 1, kind: "agentflow/receipt-evidence", id, class: evidenceClass, buildId: context.buildId, handoffId: context.handoffId, recordedAt: context.recordedAt, tasks: context.tasks }, null, 2)}\n`;
    await writeFile(path.join(root, relativePath), contents, "utf8");
    return { id, class: evidenceClass, path: relativePath, sha256: createHash("sha256").update(contents).digest("hex") };
  }));
}

interface ReceiptTransitionInput {
  handoffSha256: string;
  governedBaseCommit: string;
  executionBaseCommit: string;
  integrationCommit: string;
  buildId: string;
  buildStatus: string;
  approvedAt: string;
  planCreatedAt: string;
  startedAt: string | null;
  validationAt: string | null | undefined;
  completedAt: string | null;
  generatedAt: string;
  authoritySource: { path: string; sha256: string };
  evidenceIds: string[];
}

function receiptTransitions(input: ReceiptTransitionInput): Array<{ type: "receipt.transition"; payload: Record<string, unknown>; sha256: string }> {
  const terminalStages: Partial<Record<string, "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED">> = { completed: "COMPLETED", failed: "FAILED", cancelled: "CANCELLED", interrupted: "INTERRUPTED" };
  const terminalStage = terminalStages[input.buildStatus];
  if (terminalStage === undefined || input.completedAt === null) return [];
  const rawTimes = [input.approvedAt, input.planCreatedAt, input.planCreatedAt, input.startedAt ?? input.planCreatedAt, input.validationAt ?? input.completedAt, input.completedAt, input.completedAt];
  let previous = 0;
  const times = rawTimes.map((value, index) => {
    const current = Date.parse(value);
    previous = Number.isNaN(current) ? previous : Math.max(previous, current);
    return index === 0 ? input.approvedAt : new Date(previous).toISOString();
  });
  const stages = ["AUTHORIZED_HANDOFF", "RUNTIME_DECISION", "IMMUTABLE_PLAN", "EXECUTION", "VALIDATION", "INTEGRATION", terminalStage] as const;
  let predecessorSha256 = input.handoffSha256;
  return stages.map((stage, index) => {
    const payload = {
      stage,
      predecessorSha256,
      repositoryRevision: stage === "AUTHORIZED_HANDOFF" ? input.governedBaseCommit : stage === "INTEGRATION" || stage === terminalStage ? input.integrationCommit : input.executionBaseCommit,
      actor: `agentflow:${input.buildId}`,
      authoritySource: input.authoritySource,
      occurredAt: times[index],
      reason: `Recorded ${stage.toLowerCase()} transition for the governed build`,
      evidence: input.evidenceIds,
    };
    const sha256 = canonicalJsonSha256(payload);
    predecessorSha256 = sha256;
    return { type: "receipt.transition" as const, payload, sha256 };
  });
}

function inside(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new AgentFlowError("INVALID_REPOSITORY_PATH", "Integration paths must be repository-relative", 422);
  const candidate = path.resolve(root, relative);
  const rel = path.relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new AgentFlowError("INVALID_REPOSITORY_PATH", "Integration path escapes the registered repository", 422);
  return candidate;
}

async function insideExisting(root: string, relative: string): Promise<string> {
  const candidate = inside(root, relative);
  const canonical = await realpath(candidate);
  inside(root, path.relative(root, canonical));
  return canonical;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
