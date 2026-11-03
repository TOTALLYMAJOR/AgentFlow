import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  handoffBinding,
  loadGovernedTaskHandoff,
  renderBacklog,
  verifyGovernedHandoffForExecution,
} from "../../integration/design-intelligence.js";
import { evaluateGovernedBuild } from "../../governor/build-control.js";
import { applyGovernorDecision } from "../../governor/runtime-adapter.js";
import { makeDesignIntelligenceReceipt } from "../../integration/design-intelligence-receipt.js";
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
    return (await makeDesignIntelligenceReceipt(context, id)).receipt;
  });

  app.post("/api/builds/:id/governor/evaluate", async (request) => {
    const { id } = BuildParameters.parse(request.params);
    const evaluated = await evaluateGovernedBuild(context, id);
    if (evaluated === undefined) throw new AgentFlowError("GOVERNED_HANDOFF_MISSING", `Build ${id} is not bound to a Design Intelligence handoff`, 409);
    let acknowledgement: Awaited<ReturnType<typeof applyGovernorDecision>> | undefined;
    let observedBuildStatusBefore: string | undefined;
    let runtimeApplyInvoked = false;
    let receiptPersistAttempted = false;
    try {
      const tasks = context.store.tasks.listForBuild(id);
      const latestFailedTask = [...tasks].reverse().find((task) => task.errorCode !== null);
      observedBuildStatusBefore = context.store.builds.getById(id).status;
      runtimeApplyInvoked = true;
      acknowledgement = await applyGovernorDecision(evaluated.decision, {
        continue: async () => ({ acknowledged: true }),
        delegateRetry: async () => ({ acknowledged: latestFailedTask !== undefined && context.store.retrySchedules.get(latestFailedTask.id) !== undefined, details: { delegatedTo: "agentflow-existing-retry-schedule" } }),
        requestRepair: async () => { context.coordinator.pause(id); return { acknowledged: true, details: { state: "paused", nextAction: "bounded-repair" } }; },
        blockIntegration: async () => { context.coordinator.pause(id); return { acknowledged: true, details: { state: "paused" } }; },
        pauseForReview: async () => { context.coordinator.pause(id); return { acknowledged: true, details: { state: "paused" } }; },
        requestReconsider: async () => ({ acknowledged: false, details: { requiresApproval: true } }),
        proposeReplan: async () => ({ acknowledged: false, details: { requiresApproval: true } }),
        cancel: async () => { context.coordinator.cancel(id); return { acknowledged: true, details: { state: "cancelled" } }; },
      });
      receiptPersistAttempted = true;
      context.store.events.append({ buildId: id, type: "governor.intervention_acknowledged", payload: { decisionRecordHash: evaluated.record.recordHash, action: evaluated.decision.action, ...acknowledgement } });
      return { ...evaluated, acknowledgement };
    } catch (error) {
      let observedBuildStatusAfter: string | undefined;
      try { observedBuildStatusAfter = context.store.builds.getById(id).status; }
      catch { /* Failed readback cannot establish whether an effect occurred. */ }
      context.store.events.append({
        buildId: id,
        type: "governor.evaluation_failed",
        payload: {
          decisionRecordHash: evaluated.record.recordHash,
          action: evaluated.decision.action,
          message: error instanceof Error ? error.message : String(error),
          // A returned ACK survives a later persistence error. Missing ACK is
          // not evidence that the runtime action had no effect.
          acknowledged: acknowledgement?.acknowledged ?? false,
          details: {
            runtimeApplyInvoked,
            acknowledgementAvailable: acknowledgement !== undefined,
            receiptPersistAttempted,
            observedBuildStatusBefore,
            observedBuildStatusAfter,
          },
        },
      });
      throw error;
    }
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
