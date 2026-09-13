import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BUILD_RECEIPT_KIND,
  GOVERNED_HANDOFF_VERSION,
  handoffBinding,
  loadGovernedTaskHandoff,
  renderBacklog,
  verifyHandoffAuthoritySources,
} from "../../integration/design-intelligence.js";
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
    const status = await runGit(repository.localPath, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.stdout.trim().length > 0) throw new AgentFlowError("REPOSITORY_NOT_CLEAN", "Handoff import requires a clean committed checkout", 409, status.stdout.trim().split("\n"));
    const handoffAbsolute = await insideExisting(repository.localPath, input.handoffPath);
    const backlogAbsolute = inside(repository.localPath, input.backlogPath);
    const handoff = await loadGovernedTaskHandoff(handoffAbsolute);
    const authorityErrors = await verifyHandoffAuthoritySources(repository.localPath, handoff);
    if (authorityErrors.length > 0) throw new AgentFlowError("GOVERNED_AUTHORITY_DRIFT", "The governed handoff authority sources are stale or invalid", 409, authorityErrors);
    await runGit(repository.localPath, ["ls-files", "--error-unmatch", "--", input.handoffPath]).catch(() => {
      throw new AgentFlowError("GOVERNED_HANDOFF_UNCOMMITTED", "The approved handoff must be committed before import", 409);
    });
    await runGit(repository.localPath, ["merge-base", "--is-ancestor", handoff.repository.baseCommit, "HEAD"]).catch(() => {
      throw new AgentFlowError("GOVERNED_BASE_MISMATCH", "The governed handoff base commit is not an ancestor of HEAD", 409);
    });
    await writeFile(backlogAbsolute, renderBacklog(handoff, input.handoffPath), { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
      if (errorCode(error) === "EEXIST") throw new AgentFlowError("BACKLOG_ALREADY_EXISTS", `${input.backlogPath} already exists; refusing to overwrite reviewed work`, 409);
      throw error;
    });
    return { status: "PROPOSED", repositoryId: repository.id, backlogPath: input.backlogPath, handoff: handoffBinding(handoff, input.handoffPath), nextAction: "Review and commit the handoff and backlog before creating a plan." };
  });

  app.get("/api/builds/:id/design-intelligence-receipt", async (request) => {
    const { id } = BuildParameters.parse(request.params);
    const build = context.store.builds.getById(id);
    const binding = z.object({ id: z.string(), sha256: z.string(), proofBoundary: z.string() }).loose().safeParse(build.normalizedPlan.governedHandoff);
    if (!binding.success) throw new AgentFlowError("GOVERNED_HANDOFF_MISSING", `Build ${id} is not bound to a Design Intelligence handoff`, 409);
    const tasks = context.store.tasks.listForBuild(id);
    return {
      schemaVersion: GOVERNED_HANDOFF_VERSION,
      kind: BUILD_RECEIPT_KIND,
      handoff: { id: binding.data.id, sha256: binding.data.sha256 },
      build: { id: build.id, status: build.status, baseCommit: build.baseCommit, integrationCommit: tasks.find((task) => task.integrationCommit !== null)?.integrationCommit ?? null },
      tasks: tasks.map((task) => ({
        id: task.backlogTaskId, status: task.state, resultCommit: task.resultCommit, integrationCommit: task.integrationCommit,
        changedFiles: context.store.tasks.listAttempts(task.id).flatMap((attempt) => context.store.tasks.listChangedFiles(task.id, attempt.attempt).map((file) => file.path)),
        validation: context.store.validations.listForBuild(id).filter((validation) => validation.taskId === task.id),
      })),
      evidence: { events: context.store.events.listForBuild(id, { limit: 10_000 }), artifacts: context.store.artifacts.listForBuild(id), approvals: context.store.approvals.listForBuild(id) },
      proofBoundary: binding.data.proofBoundary,
      generatedAt: nowIso(),
    };
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
