import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentFlowContext } from "../http/context.js";
import { canonicalJsonSha256, loadGovernedTaskHandoff } from "../integration/design-intelligence.js";
import { bindTrafficControlContract, projectAgentFlowObservation, type TrafficControlFailure } from "../integration/traffic-control.js";
import { nowIso } from "../util/ids.js";
import { DEFAULT_RETRYABLE_FAILURE_CODES } from "../orchestration/retry-policy.js";
import { GovernorControlService } from "./control-service.js";

type GovernorDependencies = Pick<AgentFlowContext, "store" | "repositoryService" | "environment" | "organizationPolicy">;

export async function evaluateGovernedBuild(dependencies: GovernorDependencies, buildId: string) {
  const build = dependencies.store.builds.getById(buildId);
  const binding = z.object({
    id: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    path: z.string(),
    governedBaseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    executionBaseCommit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    carrierPaths: z.array(z.string()).length(2),
    proofBoundary: z.string(),
  }).loose().safeParse(build.normalizedPlan.governedHandoff);
  if (!binding.success) return undefined;
  const repository = await dependencies.repositoryService.get(build.repositoryId);
  const handoffPath = await safeExistingPath(repository.localPath, binding.data.path);
  const handoff = await loadGovernedTaskHandoff(handoffPath);
  if (
    handoff.handoffId !== binding.data.id
    || handoff.repository.baseCommit !== binding.data.governedBaseCommit
    || canonicalJsonSha256(handoff) !== binding.data.sha256
  ) throw new Error("GOVERNED_HANDOFF_DRIFT: build handoff no longer matches its immutable binding");
  const tasks = dependencies.store.tasks.listForBuild(buildId);
  const events = dependencies.store.events.listForBuild(buildId, { limit: 10_000 });
  const changes = tasks.map((task) => ({
    taskId: task.backlogTaskId,
    paths: dependencies.store.tasks.listAttempts(task.id).flatMap((attempt) => dependencies.store.tasks.listChangedFiles(task.id, attempt.attempt).map((file) => file.path)),
  }));
  const evidence = events.filter((event) => event.type === "evidence.recorded").reduce(
    (current, event) => ({
      items: [...current.items, ...stringArray(event.payload.items)],
      satisfied: [...current.satisfied, ...stringArray(event.payload.satisfied)],
      contradictory: [...current.contradictory, ...stringArray(event.payload.contradictory)],
    }),
    { items: [] as string[], satisfied: [] as string[], contradictory: [] as string[] },
  );
  const failures: TrafficControlFailure[] = tasks.flatMap((task) =>
    dependencies.store.tasks.listAttempts(task.id)
      .filter((attempt) => attempt.errorCode !== null)
      .map((attempt) => {
        const code = attempt.errorCode ?? "UNKNOWN";
        const retryable = DEFAULT_RETRYABLE_FAILURE_CODES.has(code);
        return {
          code,
          classification: retryable ? "transient" as const : "deterministic" as const,
          retryable,
          signature: attempt.errorMessage ?? code,
          files: dependencies.store.tasks.listChangedFiles(task.id, attempt.attempt).map((file) => file.path),
          fingerprint: "",
        };
      }),
  );
  const changedOwners = new Map<string, Set<string>>();
  for (const change of changes) for (const changedPath of change.paths) {
    const owners = changedOwners.get(changedPath) ?? new Set<string>();
    owners.add(change.taskId);
    changedOwners.set(changedPath, owners);
  }
  const contract = bindTrafficControlContract(handoff);
  const observation = projectAgentFlowObservation({
    contract,
    buildId,
    phase: build.status === "completed" ? "INTEGRATED" : tasks.some((task) => task.state === "validated" || task.state === "integrating") ? "INTEGRATING" : "RUNNING",
    attempt: Math.max(0, ...tasks.map((task) => task.attempt)),
    maxAttempts: Math.min(dependencies.environment.retryMaximumAttempts, dependencies.organizationPolicy.retries.maximum_attempts),
    authority: {
      approvalAuthority: "HUMAN_OR_REPOSITORY",
      handoffId: handoff.handoffId,
      handoffSha256: binding.data.sha256,
      repositoryId: handoff.repository.remote ?? null,
      baseCommit: handoff.repository.baseCommit,
      snapshotSha256: handoff.repository.snapshotSha256,
      worktreeState: "clean",
      authorityStateSha256: handoff.authority.stateSha256,
      governanceReportSha256: handoff.authority.governanceReportSha256,
      authoritySources: handoff.authority.sources,
    },
    taskChanges: changes,
    impactedPaths: [],
    activeTaskCollisions: [...changedOwners.entries()].filter(([, owners]) => owners.size > 1).map(([changedPath]) => changedPath),
    evidence,
    failures,
  });
  const prior = events.filter((event) => event.type === "governor.decision").at(-1)?.payload.recordHash;
  return new GovernorControlService(dependencies.store.events).evaluate({
    contract,
    observation,
    recordedAt: nowIso(),
    previousRecordHash: typeof prior === "string" ? prior : null,
  });
}

async function safeExistingPath(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative)) throw new TypeError("Governed handoff path must be repository-relative");
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path.resolve(canonicalRoot, relative));
  const candidate = path.relative(canonicalRoot, canonical);
  if (candidate === ".." || candidate.startsWith(`..${path.sep}`) || path.isAbsolute(candidate)) throw new TypeError("Governed handoff path escapes the repository");
  return canonical;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
