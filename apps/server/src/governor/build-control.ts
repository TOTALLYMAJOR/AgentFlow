import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentFlowContext } from "../http/context.js";
import { canonicalJsonSha256, loadGovernedTaskHandoff, backlogHandoffErrors, usesNativeValidationEvidence, nativeValidationEvidenceProfileErrors, NATIVE_VALIDATION_EVIDENCE_TYPE, NATIVE_VALIDATION_EVIDENCE_VERSION, type GovernedTaskHandoff } from "../integration/design-intelligence.js";
import { bindTrafficControlContract, fingerprintFailure, projectAgentFlowObservation, type TrafficControlFailure, type TrafficControlFailureSnapshot } from "../integration/traffic-control.js";
import type { BuildEventEntity } from "../db/index.js";
import { nowIso } from "../util/ids.js";
import { DEFAULT_RETRYABLE_FAILURE_CODES } from "../orchestration/retry-policy.js";
import { GovernorControlService } from "./control-service.js";

import { HANDOFF_MANIFEST_SCHEMA_VERSION } from "../artifacts/index.js";
import { normalizeValidationCommand } from "../validation/index.js";

type GovernorDependencies = Pick<AgentFlowContext, "store" | "repositoryService" | "environment" | "organizationPolicy">;
type Evidence = { items: string[]; satisfied: string[]; contradictory: string[] };
interface FailureSource { buildId: string; taskId: string; attemptId: string; attempt: number; failure: TrafficControlFailure; }
interface FailureBoundary { sequence: number; fingerprint: string; source: FailureSource; }
interface FailureEvidenceContext { baseline: Evidence; boundary: FailureBoundary; frames: FailureBoundary[]; }
const NATIVE_FAILURE_EVENT_TYPES = new Set(["task.remote_worker_failed", "task.worker_failed", "task.execution_pipeline_failed", "task.validation_failed", "integration.failed"]);

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
  const governedTaskIds = new Set(handoff.tasks.map((task) => task.id));
  if (
    tasks.length !== governedTaskIds.size
    || new Set(tasks.map((task) => task.backlogTaskId)).size !== tasks.length
    || new Set(tasks.map((task) => task.id)).size !== tasks.length
    || tasks.some((task) => !task.id || task.buildId !== buildId || !governedTaskIds.has(task.backlogTaskId))
  ) throw new Error("GOVERNED_OBSERVATION_ATTRIBUTION_INVALID: native tasks do not match the governed build task set");
  // Keep the actual attempt/changed-file reads used by the projection. Looking
  // them up again just to describe provenance could name a later native state.
  const readTaskSources = (sourceTasks = dependencies.store.tasks.listForBuild(buildId)) => sourceTasks.map((task) => ({
    task,
    attempts: dependencies.store.tasks.listAttempts(task.id).map((attempt) => ({
      attempt,
      changedFiles: dependencies.store.tasks.listChangedFiles(task.id, attempt.attempt),
    })),
  }));
  const taskSources = readTaskSources(tasks);
  if (taskSources.some(({ task, attempts }) => attempts.some(({ attempt }) => attempt.taskId !== task.id || attempt.buildId !== buildId))) {
    throw new Error("GOVERNED_OBSERVATION_ATTRIBUTION_INVALID: native attempt does not belong to its build task");
  }
  const changes = taskSources.map(({ task, attempts }) => ({
    taskId: task.backlogTaskId,
    paths: attempts.flatMap(({ changedFiles }) => changedFiles.map((file) => file.path)),
  }));
  // Bind historical projection inputs before the first current-verifier await,
  // including facts without an event producer such as changed-file records.
  const historyInputs = usesNativeValidationEvidence(handoff) && tasks.some((task) => dependencies.store.tasks.listAttempts(task.id).some((attempt) => attempt.errorCode !== null)) ? historicalProjectionInputs(dependencies, buildId) : undefined;
  const certificates = usesNativeValidationEvidence(handoff) ? await readVerifiedNativeValidationEvidence(dependencies, buildId, handoff) : [];
  if (usesNativeValidationEvidence(handoff)) {
    const currentBuild = dependencies.store.builds.getById(buildId);
    const currentTasks = dependencies.store.tasks.listForBuild(buildId);
    requireNativeEvidence(equalNativeEvidence({ status: build.status, binding: build.normalizedPlan.governedHandoff, tasks }, { status: currentBuild.status, binding: currentBuild.normalizedPlan.governedHandoff, tasks: currentTasks }));
    // Failed-state/frame capture and attempt-outcome persistence are separate
    // native writes. A crash between them must not look like no active failure.
    if (tasks.some((task) => task.state === "failed" && !dependencies.store.tasks.listAttempts(task.id).some((attempt) => attempt.buildId === buildId && attempt.taskId === task.id && attempt.attempt === task.attempt && attempt.status === "failed" && attempt.errorCode !== null))) throw new Error("GOVERNED_FAILURE_HISTORY_UNAVAILABLE: failed task and current native attempt are inconsistent");
  }
  // Certificate verification awaits private bytes. Capture ordered events
  // after it; all additional historical reads are fenced before projection.
  const events = nativeEvidenceEvents(dependencies, buildId);
  const legacyEvidence = evidenceBefore(events, Infinity);
  const evidence = usesNativeValidationEvidence(handoff)
    ? { items: certificates.map((item) => item.id), satisfied: certificates.map((item) => item.body.artifact.name), contradictory: legacyEvidence.contradictory }
    : legacyEvidence;
  let currentFailure: TrafficControlFailure | null = null;
  const failureSources: FailureSource[] = [];
  const failures: TrafficControlFailure[] = taskSources.flatMap(({ task, attempts }) =>
    attempts
      .filter(({ attempt }) => attempt.errorCode !== null)
      .map(({ attempt, changedFiles }) => {
        const code = attempt.errorCode ?? "UNKNOWN";
        const retryable = DEFAULT_RETRYABLE_FAILURE_CODES.has(code);
        const failure: TrafficControlFailure = {
          code,
          classification: retryable ? "transient" as const : "deterministic" as const,
          retryable,
          signature: attempt.errorMessage ?? code,
          files: changedFiles.map((file) => file.path),
          fingerprint: "",
        };
        failureSources.push({ buildId: attempt.buildId, taskId: task.id, attemptId: attempt.id, attempt: attempt.attempt, failure });
        if (task.state === "failed" && attempt.attempt === task.attempt && attempt.status === "failed") currentFailure = failure;
        return failure;
      }),
  );
  const context = failureEvidenceBaseline(events, buildId, failureSources, currentFailure, usesNativeValidationEvidence(handoff));
  // A successful retry clears the active failure, not the provenance needed
  // to describe older failures. This extra context never revives that failure.
  const historyContext = context ?? (usesNativeValidationEvidence(handoff) && failures.length > 0 ? failureEvidenceBaseline(events, buildId, failureSources, failures.at(-1) ?? null, true) : undefined);
  let previousEvidence = context?.baseline;
  let failureSnapshots: TrafficControlFailureSnapshot[] | undefined;
  let orderedFailures = failures;
  if (usesNativeValidationEvidence(handoff) && historyContext !== undefined) {
    requireHistoricalContext(historyInputs !== undefined);
    orderedFailures = historyContext.frames.map((frame) => frame.source.failure);
    failureSnapshots = [];
    for (const frame of historyContext.frames) {
      const historical = await readHistoricalNativePublicationContext(dependencies, buildId, handoff, events, { ...historyContext, boundary: frame });
      const contradictory = events.filter((event) => event.sequence < frame.sequence && event.type === "evidence.recorded").flatMap((event) => {
        const parsed = z.array(z.string()).safeParse(event.payload.contradictory === undefined ? [] : event.payload.contradictory);
        requireHistoricalContext(parsed.success);
        return parsed.data;
      });
      const snapshot = { fingerprint: frame.fingerprint, evidence: { ...historical, contradictory } };
      failureSnapshots.push(snapshot);
      if (context?.boundary.sequence === frame.sequence) previousEvidence = snapshot.evidence;
    }
    // Historical reads do not relax the current verifier or its async fence.
    const current = await readVerifiedNativeValidationEvidence(dependencies, buildId, handoff);
    requireHistoricalContext(equalNativeEvidence(current.map((item) => item.id), certificates.map((item) => item.id)) && equalNativeEvidence(historyInputs, historicalProjectionInputs(dependencies, buildId)));
    // No await after this full native record/event fence before projection.
  }
  // Repository and certificate reads can yield while build, attempt or
  // changed-file records change without a task-state transition. Do not persist
  // a decision from earlier inputs. No await occurs between this fence and append.
  if (!equalNativeEvidence(build, dependencies.store.builds.getById(buildId)) || !equalNativeEvidence(taskSources, readTaskSources())) throw new Error("GOVERNED_OBSERVATION_SOURCE_CHANGED: native build, task, attempt or changed-file inputs changed during evaluation");
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
    failures: orderedFailures,
    currentFailure,
    ...(failureSnapshots === undefined ? {} : { failureSnapshots }),
    ...(previousEvidence === undefined ? {} : { previousEvidence }),
  });
  const prior = events.filter((event) => event.type === "governor.decision").at(-1)?.payload.recordHash;
  return new GovernorControlService(dependencies.store.events).evaluate({
    contract,
    observation,
    recordedAt: nowIso(),
    previousRecordHash: typeof prior === "string" ? prior : null,
    // Native journal context, not a new authority or a replacement for the
    // governed observation hash. Null native revisions remain null. Hashes
    // identify the sampled records without exporting raw errors or local paths.
    nativeSources: {
      build: { id: build.id, repositoryId: build.repositoryId, planId: build.planId, baseCommit: build.baseCommit, sha256: canonicalJsonSha256(build) },
      handoff: { id: handoff.handoffId, sha256: binding.data.sha256, governedBaseCommit: handoff.repository.baseCommit },
      tasks: taskSources.map(({ task, attempts }) => ({
        id: task.id, buildId: task.buildId, backlogTaskId: task.backlogTaskId,
        baseCommit: task.baseCommit, resultCommit: task.resultCommit, integrationCommit: task.integrationCommit,
        sha256: canonicalJsonSha256(task),
        attempts: attempts.map(({ attempt, changedFiles }) => ({
          id: attempt.id, buildId: attempt.buildId, taskId: attempt.taskId, attempt: attempt.attempt,
          resultCommit: attempt.resultCommit, sha256: canonicalJsonSha256(attempt), changedFilesSha256: canonicalJsonSha256(changedFiles),
        })),
      })),
      events: { throughSequence: events.at(-1)?.sequence ?? 0, count: events.length, sha256: canonicalJsonSha256(events) },
      certificates: certificates.map(({ id, sha256, body }) => ({ id, sha256, ...body.producer })),
    },
  });
}

function evidenceBefore(events: BuildEventEntity[], sequence: number): Evidence {
  return events.filter((event) => event.sequence < sequence && event.type === "evidence.recorded").reduce(
    (current, event) => ({ items: [...current.items, ...stringArray(event.payload.items)], satisfied: [...current.satisfied, ...stringArray(event.payload.satisfied)], contradictory: [...current.contradictory, ...stringArray(event.payload.contradictory)] }),
    { items: [] as string[], satisfied: [] as string[], contradictory: [] as string[] },
  );
}

function failureEvidenceBaseline(events: BuildEventEntity[], buildId: string, sources: FailureSource[], current: TrafficControlFailure | null, strictNative: boolean): FailureEvidenceContext | undefined {
  if (current === null) return undefined;
  const unavailable = (): undefined => {
    if (strictNative) throw new Error("GOVERNED_FAILURE_HISTORY_UNAVAILABLE: native failure-relative evidence is not sourced");
    // Preserve supported legacy execution behavior. This fallback is not
    // qualified native/history parity and must not be reported as such.
    return undefined;
  };
  const frames: FailureBoundary[] = [];
  for (const source of sources) {
    const matching = events.filter((event) => {
      const frame = event.payload.governorFailure;
      return typeof frame === "object" && frame !== null && "attemptId" in frame && frame.attemptId === source.attemptId;
    });
    if (matching.length === 0) return unavailable();
    const event = matching[0];
    if (matching.length !== 1 || event === undefined) throw new Error("GOVERNED_FAILURE_HISTORY_UNAVAILABLE: conflicting native failure boundary");
    const frame = event.payload.governorFailure as Record<string, unknown>;
    const fingerprint = fingerprintFailure(source.failure);
    if (!NATIVE_FAILURE_EVENT_TYPES.has(event.type) || source.buildId !== buildId || event.buildId !== buildId || event.taskId !== source.taskId || event.payload.to !== "failed" || frame.attempt !== source.attempt || frame.fingerprint !== fingerprint) throw new Error("GOVERNED_FAILURE_HISTORY_UNAVAILABLE: native failure boundary does not match its supported producer and attempt");
    frames.push({ sequence: event.sequence, fingerprint, source });
  }
  frames.sort((left, right) => left.sequence - right.sequence);
  const active = frames.find((frame) => frame.source.failure === current);
  if (active === undefined) return unavailable();
  const prior = frames.filter((frame) => frame.sequence < active.sequence && frame.fingerprint === active.fingerprint).at(-1) ?? active;
  const baseline = evidenceBefore(events, prior.sequence);
  return { baseline: strictNative ? { items: [], satisfied: [], contradictory: baseline.contradictory } : baseline, boundary: prior, frames };
}

function requireHistoricalContext(condition: boolean): asserts condition {
  if (!condition) throw new Error("GOVERNED_FAILURE_HISTORY_UNAVAILABLE: historical native certificate snapshot is not qualified");
}

function historicalProjectionInputs(dependencies: GovernorDependencies, buildId: string) {
  const build = dependencies.store.builds.getById(buildId);
  const tasks = dependencies.store.tasks.listForBuild(buildId);
  return { build, repository: dependencies.store.repositories.getById(build.repositoryId), tasks, attempts: tasks.map((task) => dependencies.store.tasks.listAttempts(task.id).map((attempt) => ({ attempt, changedFiles: dependencies.store.tasks.listChangedFiles(task.id, attempt.attempt) }))), validationCommands: tasks.map((task) => dependencies.store.tasks.listValidationCommands(task.id)), artifacts: dependencies.store.artifacts.listForBuild(buildId), validations: dependencies.store.validations.listForBuild(buildId), manifests: dependencies.store.manifests.listForBuild(buildId), events: nativeEvidenceEvents(dependencies, buildId) };
}

const historicalCertificateSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/), kind: z.literal(NATIVE_VALIDATION_EVIDENCE_TYPE), schemaVersion: z.literal(NATIVE_VALIDATION_EVIDENCE_VERSION), handoffSha256: z.string().regex(/^[0-9a-f]{64}$/),
  producer: z.object({ buildId: z.string(), taskId: z.string(), backlogTaskId: z.string(), attempt: z.number().int().positive(), baseCommit: z.string().regex(/^[0-9a-f]{40}$/), resultCommit: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
  artifact: z.object({ name: z.string(), type: z.literal(NATIVE_VALIDATION_EVIDENCE_TYPE), version: z.literal(NATIVE_VALIDATION_EVIDENCE_VERSION) }).strict(),
  manifest: z.object({ id: z.string(), kind: z.literal("validated"), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  validations: z.array(z.object({ id: z.string(), index: z.number().int().nonnegative(), argv: z.array(z.string()), required: z.literal(true), status: z.literal("passed"), exitCode: z.literal(0), logSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
}).strict();

// Verify publication context from retained exact bytes and native sequence.
// This supplies historical snapshots and comparison baselines, never current
// proof or omitted historical artifact fields or complete state.
async function readHistoricalNativePublicationContext(dependencies: GovernorDependencies, buildId: string, handoff: GovernedTaskHandoff, events: BuildEventEntity[], context: FailureEvidenceContext): Promise<Evidence> {
  try {
    requireHistoricalContext(usesNativeValidationEvidence(handoff) && nativeValidationEvidenceProfileErrors(handoff).length === 0);
    const cutoff = context.boundary.sequence;
    const prefix = events.filter((event) => event.sequence < cutoff);
    const publications = prefix.filter((event) => event.type === CERTIFICATE_EVENT);
    requireHistoricalContext(!events.some((event) => event.type === CERTIFICATE_EVENT && event.sequence >= cutoff && event.taskId === context.boundary.source.taskId && event.payload.attempt === context.boundary.source.attempt));
    const seen = new Set<string>();
    const selected: Array<{ id: string; name: string }> = [];
    for (const publication of publications) {
      const certificateId = z.string().regex(/^[0-9a-f]{64}$/).parse(publication.payload.certificateId);
      const attemptNumber = z.number().int().positive().parse(publication.payload.attempt);
      const taskId = nativeEvidenceSegment(publication.taskId ?? "");
      const directory = path.join(dependencies.environment.runsPath, nativeEvidenceSegment(buildId), taskId, `attempt-${attemptNumber}`);
      const bytes = await readManagedNativeEvidenceBytes(dependencies.environment.runsPath, path.join(directory, `native-validation-${certificateId}.json`));
      const certificate = historicalCertificateSchema.parse(JSON.parse(bytes.toString("utf8")));
      const { id, ...body } = certificate;
      const producer = body.producer;
      const declared = handoff.tasks.find((task) => task.id === producer.backlogTaskId);
      const task = dependencies.store.tasks.getById(taskId);
      const attempt = dependencies.store.tasks.getAttempt(taskId, attemptNumber);
      const source = context.frames.find((frame) => frame.source.taskId === taskId && frame.source.attempt === attemptNumber);
      requireHistoricalContext(id === certificateId && canonicalJsonSha256(body) === id && bytes.equals(Buffer.from(`${JSON.stringify(certificate, null, 2)}\n`, "utf8")) && body.handoffSha256 === canonicalJsonSha256(handoff) && publication.buildId === buildId && publication.payload.handoffSha256 === body.handoffSha256 && publication.payload.artifactName === body.artifact.name && producer.buildId === buildId && producer.taskId === taskId && producer.attempt === attemptNumber && task.buildId === buildId && task.backlogTaskId === producer.backlogTaskId && attempt.buildId === buildId && attempt.taskId === taskId && attempt.attempt === attemptNumber && source !== undefined && source.source.attemptId === attempt.id && publication.sequence < source.sequence && declared !== undefined && handoff.proof.requiredEvidence.includes(body.artifact.name));
      const key = JSON.stringify([taskId, attemptNumber, body.artifact.name]);
      requireHistoricalContext(!seen.has(key)); seen.add(key);
      const declaration = declared.produces.filter((item) => item.name === body.artifact.name);
      requireHistoricalContext(declaration.length === 1 && declaration[0]?.type === body.artifact.type && declaration[0].version === body.artifact.version && declaration[0].path === undefined);
      const manifest = dependencies.store.manifests.findForTask(taskId, "validated", attemptNumber);
      requireHistoricalContext(manifest !== undefined && manifest.id === body.manifest.id && manifest.sha256 === body.manifest.sha256 && manifest.buildId === buildId && manifest.taskId === taskId && manifest.attempt === attemptNumber && manifest.status === "validated" && manifest.schemaVersion === HANDOFF_MANIFEST_SCHEMA_VERSION);
      const manifestPath = path.join(dependencies.environment.artifactsPath, nativeEvidenceSegment(buildId), taskId, `attempt-${attemptNumber}.validated.manifest.json`);
      requireHistoricalContext(path.resolve(manifest.manifestPath) === path.resolve(manifestPath));
      const manifestBytes = await readManagedNativeEvidenceBytes(dependencies.environment.artifactsPath, manifestPath);
      const parsed = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
      requireHistoricalContext(byteSha256(manifestBytes) === body.manifest.sha256 && equalNativeEvidence(parsed, manifest.manifest) && parsed.buildId === buildId && parsed.taskId === taskId && parsed.backlogTaskId === producer.backlogTaskId && parsed.attempt === attemptNumber && parsed.status === "validated" && parsed.schemaVersion === HANDOFF_MANIFEST_SCHEMA_VERSION && parsed.baseCommit === producer.baseCommit && parsed.resultCommit === producer.resultCommit && parsed.integrationCommit === null && equalNativeEvidence(parsed.validation, { task: "passed", integration: "pending" }));
      // Failure-time native context is a separate source join. Older/other
      // producers without this retained context remain unavailable; current
      // task state cannot reconstruct their past base/result/branch values.
      const failureEvent = events.find((event) => event.sequence === source.sequence);
      const nativeContext = z.object({ baseCommit: z.string().regex(/^[0-9a-f]{40}$/), resultCommit: z.string().regex(/^[0-9a-f]{40}$/), branch: z.string().min(1) }).loose().parse(failureEvent?.payload.governorFailure);
      requireHistoricalContext(failureEvent?.type === "integration.failed" && nativeContext.baseCommit === producer.baseCommit && nativeContext.resultCommit === producer.resultCommit && nativeContext.branch === parsed.branch);
      const manifestEvents = prefix.filter((event) => event.type === "manifest.published" && event.payload.manifestId === manifest.id);
      requireHistoricalContext(manifestEvents.length === 1 && manifestEvents[0]?.buildId === buildId && manifestEvents[0].taskId === taskId && manifestEvents[0].payload.attempt === attemptNumber && manifestEvents[0].payload.status === "validated" && manifestEvents[0].payload.sha256 === manifest.sha256 && manifestEvents[0].sequence < publication.sequence);
      const references = z.array(z.object({ name: z.string(), type: z.string(), version: z.string(), path: z.string().optional() }).loose()).parse(parsed.produces).filter((item) => item.name === body.artifact.name);
      requireHistoricalContext(references.length === 1 && references[0]?.type === body.artifact.type && references[0].version === body.artifact.version && references[0].path === undefined);
      // Publication events support identity/ambiguity checks only: omitted
      // historical type/path/metadata never come from mutable current rows.
      const artifacts = prefix.filter((event) => event.type === "artifact.published" && event.taskId === taskId && event.payload.name === body.artifact.name && event.payload.version === body.artifact.version);
      const artifact = artifacts[0];
      requireHistoricalContext(artifacts.length === 1 && artifact !== undefined && artifact.buildId === buildId && typeof artifact.payload.artifactId === "string" && artifact.payload.status === "validated" && artifact.sequence < publication.sequence && !prefix.some((event) => ["artifact.republished", "artifact.status_changed"].includes(event.type) && event.payload.artifactId === artifact.payload.artifactId));
      requireHistoricalContext(body.validations.length === declared.validate.length && body.validations.length > 0 && new Set(body.validations.map((item) => item.id)).size === body.validations.length);
      const rows = dependencies.store.validations.listForBuild(buildId);
      for (const [index, validation] of body.validations.entries()) {
        const command = declared.validate[index];
        const row = rows.find((item) => item.id === validation.id);
        requireHistoricalContext(command !== undefined && validation.index === index && equalNativeEvidence(validation.argv, normalizeValidationCommand(command).argv) && row !== undefined && row.buildId === buildId && row.taskId === taskId && row.validationType === "task");
        const logBytes = await readManagedNativeEvidenceBytes(dependencies.environment.runsPath, path.join(directory, `${nativeEvidenceSegment(validation.id)}.json`));
        const outcome = z.object({ index: z.number().int().nonnegative(), argv: z.array(z.string()), command: z.string(), required: z.literal(true), status: z.literal("passed"), exitCode: z.literal(0) }).loose().parse(JSON.parse(logBytes.toString("utf8")));
        requireHistoricalContext(byteSha256(logBytes) === validation.logSha256 && outcome.index === index && outcome.command === command && equalNativeEvidence(outcome.argv, validation.argv));
      }
      if (taskId === context.boundary.source.taskId && attemptNumber === context.boundary.source.attempt) selected.push({ id, name: body.artifact.name });
    }
    const integrationFailure = events.some((event) => event.sequence === cutoff && event.type === "integration.failed");
    requireHistoricalContext((!integrationFailure && selected.length === 0) || equalNativeEvidence(selected.map((item) => item.name).sort(), [...handoff.proof.requiredEvidence].sort()));
    return { items: selected.map((item) => item.id), satisfied: selected.map((item) => item.name), contradictory: [] };
  } catch { throw new Error("GOVERNED_FAILURE_HISTORY_UNAVAILABLE: historical native certificate snapshot is not qualified"); }
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

const CERTIFICATE_EVENT = "evidence.native_validation_certified";
type NativeEvidenceDependencies = Pick<AgentFlowContext, "store" | "environment">;
interface NativeValidationCertificateBody {
  kind: typeof NATIVE_VALIDATION_EVIDENCE_TYPE;
  schemaVersion: typeof NATIVE_VALIDATION_EVIDENCE_VERSION;
  handoffSha256: string;
  producer: { buildId: string; taskId: string; backlogTaskId: string; attempt: number; baseCommit: string; resultCommit: string };
  artifact: { name: string; type: typeof NATIVE_VALIDATION_EVIDENCE_TYPE; version: typeof NATIVE_VALIDATION_EVIDENCE_VERSION };
  manifest: { id: string; kind: "validated"; sha256: string };
  validations: Array<{ id: string; index: number; argv: string[]; required: true; status: "passed"; exitCode: 0; logSha256: string }>;
}
export interface VerifiedNativeValidationCertificate {
  id: string;
  body: NativeValidationCertificateBody;
  sourcePath: string;
  relativePath: string;
  sha256: string;
}

function requireNativeEvidence(condition: boolean): asserts condition {
  if (!condition) throw new Error("NATIVE_VALIDATION_EVIDENCE_INVALID: current native provenance does not match");
}
function equalNativeEvidence(left: unknown, right: unknown): boolean {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}
function nativeEvidenceEvents(dependencies: NativeEvidenceDependencies, buildId: string) {
  const events = []; let afterSequence = 0;
  for (;;) {
    const page = dependencies.store.events.listForBuild(buildId, { afterSequence, limit: 10000 });
    events.push(...page);
    if (page.length < 10000) return events;
    const next = page.at(-1)?.sequence ?? afterSequence;
    requireNativeEvidence(next > afterSequence);
    afterSequence = next;
  }
}
function nativeEvidenceSegment(value: string): string {
  requireNativeEvidence(/^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== ".." && value.length <= 128);
  return value;
}

// Locators are reconstructed from native IDs, never accepted from certificate events.
export async function readManagedNativeEvidenceBytes(root: string, filePath: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  const canonicalRoot = await realpath(root);
  const absolute = path.resolve(filePath);
  const relative = path.relative(canonicalRoot, absolute);
  requireNativeEvidence(relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  let current = canonicalRoot;
  for (const segment of relative.split(path.sep)) {
    requireNativeEvidence(segment !== "." && segment !== ".." && segment.length > 0);
    current = path.join(current, segment);
    const metadata = await lstat(current);
    requireNativeEvidence(!metadata.isSymbolicLink());
  }
  requireNativeEvidence(await realpath(absolute) === absolute);
  const before = await lstat(absolute);
  requireNativeEvidence(before.isFile() && before.size <= maxBytes);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    requireNativeEvidence(opened.isFile() && opened.size === before.size && opened.ino === before.ino && opened.dev === before.dev);
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(absolute);
    requireNativeEvidence(count === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && named.ino === before.ino && named.dev === before.dev && !named.isSymbolicLink() && await realpath(absolute) === absolute);
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
const byteSha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function deriveNativeValidationCertificates(dependencies: NativeEvidenceDependencies, buildId: string, handoff: GovernedTaskHandoff) {
  requireNativeEvidence(usesNativeValidationEvidence(handoff) && nativeValidationEvidenceProfileErrors(handoff).length === 0);
  const build = dependencies.store.builds.getById(buildId);
  const binding = z.object({ id: z.string(), sha256: z.string(), governedBaseCommit: z.string(), executionBaseCommit: z.string() }).loose().parse(build.normalizedPlan.governedHandoff);
  requireNativeEvidence(binding.id === handoff.handoffId && binding.sha256 === canonicalJsonSha256(handoff) && binding.governedBaseCommit === handoff.repository.baseCommit && binding.executionBaseCommit === build.baseCommit);
  const planned = z.object({ tasks: z.array(z.unknown()).length(1) }).loose().parse(build.normalizedPlan);
  const tasks = dependencies.store.tasks.listForBuild(buildId);
  const task = tasks[0];
  const declared = handoff.tasks[0];
  requireNativeEvidence(tasks.length === 1 && task !== undefined && declared !== undefined && task.backlogTaskId === declared.id && ["validated", "integrating", "integrated"].includes(task.state) && task.resultCommit !== null && task.baseCommit !== null);
  const plannedTask = planned.tasks[0] as { id?: unknown; validate?: unknown; produces?: unknown };
  requireNativeEvidence(plannedTask.id === declared.id && equalNativeEvidence(plannedTask.validate, declared.validate) && equalNativeEvidence(plannedTask.produces, declared.produces));
  const attempt = dependencies.store.tasks.getAttempt(task.id, task.attempt);
  requireNativeEvidence(attempt.buildId === buildId && attempt.taskId === task.id && attempt.status === "succeeded" && attempt.resultCommit === task.resultCommit && attempt.startedAt !== null && attempt.completedAt !== null);
  const manifest = dependencies.store.manifests.findForTask(task.id, "validated", task.attempt);
  requireNativeEvidence(manifest !== undefined && manifest.buildId === buildId && manifest.taskId === task.id && manifest.attempt === task.attempt && manifest.status === "validated" && manifest.schemaVersion === HANDOFF_MANIFEST_SCHEMA_VERSION);
  const manifestPath = path.join(dependencies.environment.artifactsPath, nativeEvidenceSegment(buildId), nativeEvidenceSegment(task.id), `attempt-${task.attempt}.validated.manifest.json`);
  requireNativeEvidence(path.resolve(manifest.manifestPath) === path.resolve(manifestPath));
  const manifestBytes = await readManagedNativeEvidenceBytes(dependencies.environment.artifactsPath, manifestPath);
  requireNativeEvidence(byteSha256(manifestBytes) === manifest.sha256);
  const parsedManifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  requireNativeEvidence(equalNativeEvidence(parsedManifest, manifest.manifest) && parsedManifest.buildId === buildId && parsedManifest.taskId === task.id && parsedManifest.backlogTaskId === task.backlogTaskId && parsedManifest.attempt === task.attempt && parsedManifest.status === "validated" && parsedManifest.schemaVersion === HANDOFF_MANIFEST_SCHEMA_VERSION && parsedManifest.baseCommit === task.baseCommit && parsedManifest.resultCommit === task.resultCommit && parsedManifest.branch === task.branchName);
  const changed = dependencies.store.tasks.listChangedFiles(task.id, task.attempt);
  requireNativeEvidence(changed.every((file) => file.withinOwnership) && equalNativeEvidence([...new Set(changed.map((file) => file.path))].sort(), parsedManifest.changedFiles));
  requireNativeEvidence(equalNativeEvidence(dependencies.store.tasks.listValidationCommands(task.id).map((item) => item.command), declared.validate));
  const directory = path.join(dependencies.environment.runsPath, nativeEvidenceSegment(buildId), nativeEvidenceSegment(task.id), `attempt-${task.attempt}`);
  const rows = dependencies.store.validations.listForBuild(buildId).filter((item) => item.taskId === task.id && item.validationType === "task" && item.logPath !== null && path.dirname(path.resolve(item.logPath)) === path.resolve(directory));
  const actual = [];
  for (const row of rows) {
    requireNativeEvidence(row.buildId === buildId && row.taskId === task.id && row.validationType === "task" && row.logPath !== null && path.resolve(row.logPath) === path.join(path.resolve(directory), `${nativeEvidenceSegment(row.id)}.json`));
    const bytes = await readManagedNativeEvidenceBytes(dependencies.environment.runsPath, row.logPath);
    const outcome = z.object({ index: z.number().int().nonnegative(), argv: z.array(z.string()), command: z.string(), required: z.boolean(), label: z.string().nullable(), status: z.string(), exitCode: z.number().nullable(), startedAt: z.string(), completedAt: z.string() }).loose().parse(JSON.parse(bytes.toString("utf8")));
    requireNativeEvidence(outcome.command === row.command && outcome.status === row.status && outcome.exitCode === row.exitCode && outcome.startedAt === row.startedAt && outcome.completedAt === row.completedAt && Date.parse(outcome.startedAt) >= Date.parse(attempt.startedAt) && Date.parse(outcome.completedAt) <= Date.parse(attempt.completedAt));
    // Native Compose cleanup is not a declared check and cannot stand in for one.
    if (outcome.index >= declared.validate.length) {
      requireNativeEvidence(outcome.index === declared.validate.length && outcome.label === "Compose cleanup" && outcome.argv[0] === "docker" && outcome.argv[1] === "compose" && outcome.argv.includes("down") && outcome.required && outcome.status === "passed" && outcome.exitCode === 0);
      continue;
    }
    actual.push({ row, outcome, sha256: byteSha256(bytes) });
  }
  actual.sort((left, right) => left.outcome.index - right.outcome.index);
  requireNativeEvidence(actual.length === declared.validate.length && actual.length > 0);
  const validations = actual.map(({ row, outcome, sha256 }, index) => {
    const command = declared.validate[index];
    requireNativeEvidence(command !== undefined && outcome.index === index && outcome.required && outcome.status === "passed" && outcome.exitCode === 0 && equalNativeEvidence(outcome.argv, normalizeValidationCommand(command).argv));
    return { id: row.id, index, argv: outcome.argv, required: true as const, status: "passed" as const, exitCode: 0 as const, logSha256: sha256 };
  });
  const artifacts = dependencies.store.artifacts.listForBuild(buildId);
  const references = z.array(z.object({ name: z.string(), type: z.string(), version: z.string(), path: z.string().optional() }).loose()).parse(parsedManifest.produces);
  const certificates: Array<Omit<VerifiedNativeValidationCertificate, "sha256">> = [];
  for (const name of handoff.proof.requiredEvidence) {
    const matches = artifacts.filter((item) => item.name === name);
    const reference = references.filter((item) => item.name === name);
    requireNativeEvidence(matches.length === 1 && matches[0]?.producerTaskId === task.id && matches[0].artifactType === NATIVE_VALIDATION_EVIDENCE_TYPE && matches[0].version === NATIVE_VALIDATION_EVIDENCE_VERSION && matches[0].repositoryPath === null && matches[0].sha256 === null && ["validated", "integrated"].includes(matches[0].status));
    requireNativeEvidence(reference.length === 1 && reference[0]?.type === NATIVE_VALIDATION_EVIDENCE_TYPE && reference[0].version === NATIVE_VALIDATION_EVIDENCE_VERSION && reference[0].path === undefined);
    const body: NativeValidationCertificateBody = { kind: NATIVE_VALIDATION_EVIDENCE_TYPE, schemaVersion: NATIVE_VALIDATION_EVIDENCE_VERSION, handoffSha256: binding.sha256, producer: { buildId, taskId: task.id, backlogTaskId: task.backlogTaskId, attempt: task.attempt, baseCommit: task.baseCommit, resultCommit: task.resultCommit }, artifact: { name, type: NATIVE_VALIDATION_EVIDENCE_TYPE, version: NATIVE_VALIDATION_EVIDENCE_VERSION }, manifest: { id: manifest.id, kind: "validated", sha256: manifest.sha256 }, validations };
    const id = canonicalJsonSha256(body);
    certificates.push({ id, body, sourcePath: path.join(directory, `native-validation-${id}.json`), relativePath: `artifacts/${buildId}/${task.id}/attempt-${task.attempt}/native-validation-${id}.json` });
  }
  return certificates;
}

export async function publishNativeValidationEvidence(dependencies: NativeEvidenceDependencies, buildId: string, handoff: GovernedTaskHandoff): Promise<void> {
  if (!usesNativeValidationEvidence(handoff)) return;
  const certificates = await deriveNativeValidationCertificates(dependencies, buildId, handoff);
  for (const certificate of certificates) {
    const contents = Buffer.from(`${JSON.stringify({ id: certificate.id, ...certificate.body }, null, 2)}\n`, "utf8");
    const existing = nativeEvidenceEvents(dependencies, buildId).filter((event) => event.type === CERTIFICATE_EVENT && event.taskId === certificate.body.producer.taskId && event.payload.attempt === certificate.body.producer.attempt && event.payload.artifactName === certificate.body.artifact.name);
    requireNativeEvidence(existing.length <= 1 && (existing.length === 0 || existing[0]?.payload.certificateId === certificate.id));
    // The current run directory already exists because actual validations wrote it.
    if (existing.length === 0) {
      try { await writeFile(certificate.sourcePath, contents, { flag: "wx", mode: 0o600 }); }
      catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
    }
    requireNativeEvidence((await readManagedNativeEvidenceBytes(dependencies.environment.runsPath, certificate.sourcePath)).equals(contents));
    const current = await deriveNativeValidationCertificates(dependencies, buildId, handoff);
    requireNativeEvidence(current.some((item) => item.id === certificate.id));
    dependencies.store.transaction(() => {
      requireNativeCertificateStillCurrent(dependencies, buildId, { ...certificate, sha256: byteSha256(contents) }, handoff);
      const task = dependencies.store.tasks.getById(certificate.body.producer.taskId);
      requireNativeEvidence(task.attempt === certificate.body.producer.attempt && task.resultCommit === certificate.body.producer.resultCommit && ["validated", "integrating", "integrated"].includes(task.state));
      const retained = nativeEvidenceEvents(dependencies, buildId).filter((event) => event.type === CERTIFICATE_EVENT && event.taskId === task.id && event.payload.attempt === task.attempt && event.payload.artifactName === certificate.body.artifact.name);
      requireNativeEvidence(retained.length <= 1 && (retained.length === 0 || retained[0]?.payload.certificateId === certificate.id));
      if (retained.length === 0) dependencies.store.events.append({ buildId, taskId: task.id, type: CERTIFICATE_EVENT, payload: { certificateId: certificate.id, handoffSha256: certificate.body.handoffSha256, artifactName: certificate.body.artifact.name, attempt: task.attempt } });
    });
  }
}

export async function readVerifiedNativeValidationEvidence(dependencies: NativeEvidenceDependencies, buildId: string, handoff: GovernedTaskHandoff): Promise<VerifiedNativeValidationCertificate[]> {
  if (!usesNativeValidationEvidence(handoff)) return [];
  try {
    const certificates = await deriveNativeValidationCertificates(dependencies, buildId, handoff);
    const events = nativeEvidenceEvents(dependencies, buildId);
    const verified = [];
    for (const certificate of certificates) {
      const retained = events.filter((event) => event.type === CERTIFICATE_EVENT && event.taskId === certificate.body.producer.taskId && event.payload.attempt === certificate.body.producer.attempt && event.payload.artifactName === certificate.body.artifact.name);
      requireNativeEvidence(retained.length === 1 && retained[0]?.payload.certificateId === certificate.id && retained[0].payload.handoffSha256 === certificate.body.handoffSha256);
      const bytes = await readManagedNativeEvidenceBytes(dependencies.environment.runsPath, certificate.sourcePath);
      requireNativeEvidence(bytes.equals(Buffer.from(`${JSON.stringify({ id: certificate.id, ...certificate.body }, null, 2)}\n`, "utf8")));
      verified.push({ ...certificate, sha256: byteSha256(bytes) });
    }
    const current = await deriveNativeValidationCertificates(dependencies, buildId, handoff);
    requireNativeEvidence(equalNativeEvidence(current.map((item) => item.id), verified.map((item) => item.id)));
    // No await after this record fence: an async file read cannot authorize a
    // task that was cancelled/retried or rebound while that read was in flight.
    for (const certificate of verified) requireNativeCertificateStillCurrent(dependencies, buildId, certificate, handoff);
    return verified;
  } catch { return []; }
}

function requireNativeCertificateStillCurrent(dependencies: NativeEvidenceDependencies, buildId: string, certificate: VerifiedNativeValidationCertificate, handoff: GovernedTaskHandoff): void {
  const build = dependencies.store.builds.getById(buildId);
  const producer = certificate.body.producer;
  const task = dependencies.store.tasks.getById(producer.taskId);
  const attempt = dependencies.store.tasks.getAttempt(task.id, task.attempt);
  const binding = z.object({ id: z.string(), sha256: z.string(), governedBaseCommit: z.string(), executionBaseCommit: z.string() }).loose().parse(build.normalizedPlan.governedHandoff);
  const manifest = dependencies.store.manifests.findForTask(task.id, "validated", task.attempt);
  const planned = z.object({ tasks: z.array(z.unknown()) }).loose().parse(build.normalizedPlan);
  requireNativeEvidence(backlogHandoffErrors(planned.tasks as Parameters<typeof backlogHandoffErrors>[0], handoff).length === 0);
  requireNativeEvidence(binding.id === handoff.handoffId && binding.governedBaseCommit === handoff.repository.baseCommit && binding.sha256 === certificate.body.handoffSha256 && binding.executionBaseCommit === build.baseCommit && producer.buildId === buildId && task.buildId === buildId && task.backlogTaskId === producer.backlogTaskId && task.attempt === producer.attempt && task.baseCommit === producer.baseCommit && task.resultCommit === producer.resultCommit && ["validated", "integrating", "integrated"].includes(task.state) && attempt.taskId === task.id && attempt.buildId === buildId && attempt.attempt === producer.attempt && attempt.status === "succeeded" && attempt.resultCommit === producer.resultCommit && manifest !== undefined && manifest.id === certificate.body.manifest.id && manifest.sha256 === certificate.body.manifest.sha256);
  const rows = dependencies.store.validations.listForBuild(buildId);
  for (const validation of certificate.body.validations) {
    const row = rows.find((item) => item.id === validation.id);
    requireNativeEvidence(row !== undefined && row.buildId === buildId && row.taskId === producer.taskId && row.validationType === "task" && row.status === "passed" && row.exitCode === 0 && equalNativeEvidence(normalizeValidationCommand(row.command).argv, validation.argv) && row.logPath !== null && path.resolve(row.logPath) === path.resolve(dependencies.environment.runsPath, buildId, producer.taskId, `attempt-${producer.attempt}`, `${validation.id}.json`));
  }
}
