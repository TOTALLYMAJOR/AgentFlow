import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentFlowContext } from "../http/context.js";
import { canonicalJsonSha256, loadGovernedTaskHandoff, backlogHandoffErrors, usesNativeValidationEvidence, nativeValidationEvidenceProfileErrors, NATIVE_VALIDATION_EVIDENCE_TYPE, NATIVE_VALIDATION_EVIDENCE_VERSION, type GovernedTaskHandoff } from "../integration/design-intelligence.js";
import { bindTrafficControlContract, projectAgentFlowObservation, type TrafficControlFailure } from "../integration/traffic-control.js";
import { nowIso } from "../util/ids.js";
import { DEFAULT_RETRYABLE_FAILURE_CODES } from "../orchestration/retry-policy.js";
import { GovernorControlService } from "./control-service.js";

import { HANDOFF_MANIFEST_SCHEMA_VERSION } from "../artifacts/index.js";
import { normalizeValidationCommand } from "../validation/index.js";

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
  const changes = tasks.map((task) => ({
    taskId: task.backlogTaskId,
    paths: dependencies.store.tasks.listAttempts(task.id).flatMap((attempt) => dependencies.store.tasks.listChangedFiles(task.id, attempt.attempt).map((file) => file.path)),
  }));
  const certificates = usesNativeValidationEvidence(handoff) ? await readVerifiedNativeValidationEvidence(dependencies, buildId, handoff) : [];
  if (usesNativeValidationEvidence(handoff)) {
    const currentBuild = dependencies.store.builds.getById(buildId);
    const currentTasks = dependencies.store.tasks.listForBuild(buildId);
    requireNativeEvidence(equalNativeEvidence({ status: build.status, binding: build.normalizedPlan.governedHandoff, tasks }, { status: currentBuild.status, binding: currentBuild.normalizedPlan.governedHandoff, tasks: currentTasks }));
  }
  // Certificate verification awaits private bytes. Capture contradictions and
  // chain predecessor only after it, with no further await before evaluation.
  const events = nativeEvidenceEvents(dependencies, buildId);
  const legacyEvidence = events.filter((event) => event.type === "evidence.recorded").reduce(
    (current, event) => ({
      items: [...current.items, ...stringArray(event.payload.items)],
      satisfied: [...current.satisfied, ...stringArray(event.payload.satisfied)],
      contradictory: [...current.contradictory, ...stringArray(event.payload.contradictory)],
    }),
    { items: [] as string[], satisfied: [] as string[], contradictory: [] as string[] },
  );
  const evidence = usesNativeValidationEvidence(handoff)
    ? { items: certificates.map((item) => item.id), satisfied: certificates.map((item) => item.body.artifact.name), contradictory: legacyEvidence.contradictory }
    : legacyEvidence;
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
