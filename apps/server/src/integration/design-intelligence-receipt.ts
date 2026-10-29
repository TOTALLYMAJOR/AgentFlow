import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { BUILD_RECEIPT_VERSION, BUILD_RECEIPT_KIND, canonicalJsonSha256, loadGovernedTaskHandoff, usesNativeValidationEvidence } from "./design-intelligence.js";
import { readVerifiedNativeValidationEvidence, readManagedNativeEvidenceBytes } from "../governor/build-control.js";
import { nowIso } from "../util/ids.js";
import type { BuildEventEntity } from "../db/index.js";
import type { AgentFlowContext } from "../http/context.js";
import { AgentFlowError } from "../http/errors.js";
export type DesignIntelligenceReceiptContext = AgentFlowContext;
export interface ReceiptExportSource { relativePath: string; sourcePath: string; sha256: string | null }
export async function makeDesignIntelligenceReceipt(context: AgentFlowContext, id: string) {
    const boundBuild = context.store.builds.getById(id);
    const binding = z.object({ id: z.string(), programId: z.string().optional(), sha256: z.string(), path: z.string(), governedBaseCommit: z.string(), proofBoundary: z.string() }).loose().safeParse(boundBuild.normalizedPlan.governedHandoff);
    if (!binding.success) throw new AgentFlowError("GOVERNED_HANDOFF_MISSING", `Build ${id} is not bound to a Design Intelligence handoff`, 409);
    const repository = await context.repositoryService.get(boundBuild.repositoryId);
    const handoffPath = await insideExisting(repository.localPath, binding.data.path);
    const handoff = await loadGovernedTaskHandoff(handoffPath);
    if (handoff.handoffId !== binding.data.id || canonicalJsonSha256(handoff) !== binding.data.sha256) throw new AgentFlowError("GOVERNED_HANDOFF_DRIFT", "Receipt handoff differs from immutable binding", 409);
    const sourceSnapshot = captureReceiptSource(context, id);
    const { build, tasks, validations: allValidations } = sourceSnapshot;
    if (build.repositoryId !== boundBuild.repositoryId || canonicalJsonSha256(build.normalizedPlan.governedHandoff) !== canonicalJsonSha256(boundBuild.normalizedPlan.governedHandoff)) throw new AgentFlowError("GOVERNED_HANDOFF_DRIFT", "Receipt binding changed while loading authority", 409);
    const ownRetentionEvents: BuildEventEntity[] = [];
    const generatedAt = build.completedAt ?? nowIso();
    const nativeProfile = usesNativeValidationEvidence(handoff);
    const certificates = nativeProfile ? await readVerifiedNativeValidationEvidence(context, id, handoff) : [];
    if (nativeProfile && tasks.some((task) => ["validated", "integrating", "integrated"].includes(task.state)) && certificates.length !== handoff.proof.requiredEvidence.length) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Current native validation evidence is unavailable", 409);
    const certifiedValidationIds = new Set(certificates.flatMap((certificate) => certificate.body.validations.map((validation) => validation.id)));
    const validations = nativeProfile ? allValidations.filter((validation) => certificates.length > 0
      ? certifiedValidationIds.has(validation.id)
      : tasks.some((task) => task.id === validation.taskId && validation.logPath !== null && path.dirname(path.resolve(validation.logPath)) === path.resolve(context.environment.runsPath, build.id, task.id, `attempt-${task.attempt}`))) : allValidations;
    const changedFiles = (task: { id: string; attempt: number }): string[] => {
      const evidence = sourceSnapshot.taskEvidence.find((item) => item.taskId === task.id);
      if (evidence === undefined) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Native task evidence snapshot is unavailable", 409);
      return [...new Set(evidence.changes.filter((item) => nativeProfile ? item.attempt === task.attempt : evidence.attempts.some((attempt) => attempt.attempt === item.attempt)).flatMap((item) => item.files.map((file) => file.path)))];
    };
    const snapshots = certificates.length > 0 ? [] : await retainReceiptEvidence(context, path.dirname(handoffPath), nativeProfile ? ["native-record-snapshot"] : handoff.proof.requiredEvidence, {
      buildId: build.id,
      handoffId: binding.data.id,
      buildStatus: build.status,
      terminal: ["completed", "failed", "cancelled"].includes(build.status),
      recordedAt: build.completedAt ?? build.createdAt,
      tasks: tasks.map((task) => ({
        id: task.backlogTaskId,
        status: task.state,
        resultCommit: task.resultCommit,
        integrationCommit: task.integrationCommit,
        changedFiles: changedFiles(task),
        validations: validations.filter((validation) => validation.taskId === task.id && validation.validationType === "task").map((validation) => ({ command: validation.command, status: validation.status, exitCode: validation.exitCode })),
      })),
    }, (event) => ownRetentionEvents.push(event));
    const artifacts = certificates.length === 0 ? snapshots : certificates.map((certificate) => ({ id: certificate.id, class: certificate.body.artifact.name, path: certificate.relativePath, sha256: certificate.sha256 }));
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
    const capturedEvents = allBuildEvents(context, id);
    const expectedSnapshot = { ...sourceSnapshot, events: [...sourceSnapshot.events, ...ownRetentionEvents] };
    if (canonicalJsonSha256(capturedEvents) !== canonicalJsonSha256(expectedSnapshot.events)) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Native event stream changed during receipt generation", 409);
    const sourceEventWatermark = capturedEvents.at(-1)?.sequence ?? 0;
    const governorProvenance = await retainGovernorProvenance(context, id, binding.data.sha256, capturedEvents);
    if (governorProvenance !== undefined) artifacts.push(governorProvenance.artifact);
    const receipt = {
      schemaVersion: BUILD_RECEIPT_VERSION,
      kind: BUILD_RECEIPT_KIND,
      ...(binding.data.programId === undefined ? {} : { programId: binding.data.programId }),
      handoff: { id: binding.data.id, sha256: binding.data.sha256 },
      build: { id: build.id, status: build.status, baseCommit: build.baseCommit, governedBaseCommit: binding.data.governedBaseCommit, integrationCommit },
      tasks: tasks.map((task) => ({
        id: task.backlogTaskId, status: task.state, resultCommit: task.resultCommit, integrationCommit: task.integrationCommit,
        changedFiles: changedFiles(task),
        validation: validations.filter((validation) => validation.taskId === task.id && validation.validationType === "task").map((validation) => ({
          command: validation.command,
          status: validation.status,
          exitCode: validation.exitCode,
          evidenceId: artifacts.find((artifact) => artifact.class === `task:${task.backlogTaskId}:validation-passed`)?.id ?? evidenceIds[0],
        })),
      })),
      evidence: { events: transitionEvents, artifacts, approvals: [] },
      proofBoundary: binding.data.proofBoundary,
      generatedAt,
    };
    if (nativeProfile) {
      const currentCertificates = await readVerifiedNativeValidationEvidence(context, id, handoff);
      if (canonicalJsonSha256(currentCertificates) !== canonicalJsonSha256(certificates)) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Current certificate evidence changed during receipt generation", 409);
    }
    // No await after this fence. Only this call's exact retained-evidence append
    // may extend the original native snapshot; all other record/event drift refuses.
    if (canonicalJsonSha256(captureReceiptSource(context, id)) !== canonicalJsonSha256(expectedSnapshot)) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Native source records changed during receipt generation", 409);
    return { receipt, sourceEventWatermark, sources: artifacts.map((artifact) => ({ relativePath: artifact.path, sourcePath: certificates.find((certificate) => certificate.id === artifact.id)?.sourcePath ?? (governorProvenance?.artifact.id === artifact.id ? governorProvenance.sourcePath : path.join(path.dirname(handoffPath), artifact.path)), sha256: artifact.sha256 })) };
}
interface ReceiptEvidenceContext {
  buildId: string;
  handoffId: string;
  buildStatus: string;
  terminal: boolean;
  recordedAt: string;
  tasks: Array<Record<string, unknown>>;
}

async function retainReceiptEvidence(storeContext: AgentFlowContext, root: string, requiredEvidence: string[], context: ReceiptEvidenceContext, onRetainedEvent: (event: BuildEventEntity) => void): Promise<Array<{ id: string; class: string; path: string; sha256: string }>> {
  // Active reads retain revision-keyed provisional snapshots. Only a native terminal
  // lifecycle timestamp seals final evidence; earlier reads cannot freeze later state.
  const snapshotKey = context.terminal
    ? `terminal-${canonicalJsonSha256({ recordedAt: context.recordedAt })}`
    : `provisional-${canonicalJsonSha256(context)}`;
  const retained = allBuildEvents(storeContext, context.buildId).filter((event) => event.type === "receipt.evidence_retained" && event.payload.snapshotKey === snapshotKey);
  if (retained.length > 1) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Conflicting retained evidence descriptors", 409);
  const prior = retained[0]?.payload.artifacts;
  const evidenceDirectory = path.join(root, "artifacts");
  const snapshotDirectory = path.join(evidenceDirectory, context.buildId, snapshotKey);
  if (prior === undefined) await mkdir(snapshotDirectory, { recursive: true });
  for (const directory of [evidenceDirectory, path.join(evidenceDirectory, context.buildId), snapshotDirectory]) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== path.resolve(directory)) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Unsafe retained evidence directory", 409);
  }
  const artifacts = await Promise.all(requiredEvidence.map(async (evidenceClass, index) => {
    const id = `evidence-${index + 1}`;
    const relativePath = `artifacts/${context.buildId}/${snapshotKey}/${String(index + 1).padStart(2, "0")}-${evidenceClass.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`;
    const contents = `${JSON.stringify({ schemaVersion: 1, kind: "agentflow/receipt-evidence", id, class: evidenceClass, buildId: context.buildId, handoffId: context.handoffId, buildStatus: context.buildStatus, provisional: !context.terminal, recordedAt: context.recordedAt, tasks: context.tasks }, null, 2)}\n`;
    const target = path.join(root, relativePath);
    if (prior !== undefined) {
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(target) !== path.resolve(target) || await readFile(target, "utf8") !== contents) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Retained receipt evidence differs from native records", 409);
    } else try { await writeFile(target, contents, { encoding: "utf8", flag: "wx" }); }
    catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
      if (await readFile(target, "utf8") !== contents) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Retained receipt evidence differs from native records", 409);
    }
    return { id, class: evidenceClass, path: relativePath, sha256: createHash("sha256").update(contents).digest("hex") };
  }));
  if (prior !== undefined && canonicalJsonSha256(prior) !== canonicalJsonSha256(artifacts)) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Retained receipt descriptors differ", 409);
  if (prior === undefined) storeContext.store.transaction(() => {
    const current = allBuildEvents(storeContext, context.buildId).filter((event) => event.type === "receipt.evidence_retained" && event.payload.snapshotKey === snapshotKey);
    if (current.length === 0) onRetainedEvent(storeContext.store.events.append({ buildId: context.buildId, type: "receipt.evidence_retained", payload: { snapshotKey, provisional: !context.terminal, artifacts } }));
    else if (current.length !== 1 || canonicalJsonSha256(current[0]?.payload.artifacts) !== canonicalJsonSha256(artifacts)) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Conflicting retained evidence descriptors", 409);
  });
  return artifacts;
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

function allBuildEvents(context: AgentFlowContext, buildId: string) {
  const events = []; let cursor = 0;
  for (;;) {
    const page = context.store.events.listForBuild(buildId, { afterSequence: cursor, limit: 10000 });
    events.push(...page);
    if (page.length < 10000) return events;
    const next = page.at(-1)?.sequence ?? cursor;
    if (next <= cursor) throw new Error("Invalid event cursor");
    cursor = next;
  }
}

async function retainGovernorProvenance(context: AgentFlowContext, buildId: string, handoffSha256: string, captured: ReturnType<typeof allBuildEvents>) {
  const events = captured.filter((event) => event.type.startsWith("governor."));
  if (events.length === 0) return undefined;
  // Preserve native event objects and GLOBAL sequence gaps verbatim. Export is
  // a retained projection, not a new Governor decision, acknowledgement or stage.
  const body = { schemaVersion: "1.0.0", kind: "agentflow/governor-provenance", buildId, handoffSha256, sourceEventWatermark: captured.at(-1)?.sequence ?? 0, events };
  const contents = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
  if (contents.length > 64 * 1024 * 1024 || !/^[A-Za-z0-9._-]+$/u.test(buildId) || buildId === "." || buildId === "..") throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Native Governor provenance cannot be retained safely", 409);
  const digest = createHash("sha256").update(contents).digest("hex");
  const root = path.resolve(context.environment.artifactsPath);
  if (await realpath(root) !== root) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Unsafe Governor evidence root", 409);
  let directory = root;
  for (const segment of [buildId, "governor-provenance"]) {
    directory = path.join(directory, segment);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Unsafe Governor evidence directory", 409);
  }
  const sourcePath = path.join(directory, `${digest}.json`);
  try { await writeFile(sourcePath, contents, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
  try {
    if (!(await readManagedNativeEvidenceBytes(root, sourcePath, 64 * 1024 * 1024)).equals(contents)) throw new Error("changed provenance bytes");
  } catch { throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Retained native Governor evidence differs", 409); }
  return { artifact: { id: `governor-${digest}`, class: "agentflow:governor-provenance", path: `artifacts/${buildId}/governor-provenance/${digest}.json`, sha256: digest }, sourcePath };
}

function captureReceiptSource(context: AgentFlowContext, buildId: string) {
  return context.store.transaction(() => {
    const build = context.store.builds.getById(buildId);
    const tasks = context.store.tasks.listForBuild(buildId);
    const validations = context.store.validations.listForBuild(buildId);
    const taskEvidence = tasks.map((task) => {
      const attempts = context.store.tasks.listAttempts(task.id);
      const attemptNumbers = [...new Set([...attempts.map((attempt) => attempt.attempt), task.attempt])];
      return { taskId: task.id, attempts, commands: context.store.tasks.listValidationCommands(task.id), changes: attemptNumbers.map((attempt) => ({ attempt, files: context.store.tasks.listChangedFiles(task.id, attempt) })) };
    });
    return { build, tasks, validations, taskEvidence, artifacts: context.store.artifacts.listForBuild(buildId), manifests: context.store.manifests.listForBuild(buildId), events: allBuildEvents(context, buildId) };
  });
}
