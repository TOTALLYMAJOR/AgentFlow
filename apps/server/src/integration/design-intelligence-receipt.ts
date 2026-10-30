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
import { GitCommandRunner } from "../git/index.js";
import { checkChangedFileOwnership } from "../orchestration/ownership.js";
import type { GovernedTaskHandoff } from "./design-intelligence.js";
import type { VerifiedNativeValidationCertificate } from "../governor/build-control.js";
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
    const capability = await retainCapabilityEvidence(context, sourceSnapshot, handoff, certificates, repository.localPath);
    const artifacts = certificates.length === 0 ? snapshots : certificates.map((certificate) => ({ id: certificate.id, class: capability.artifacts.length > 0 && ["capability-plan", "capability-observation"].includes(certificate.body.artifact.name) ? `agentflow:native-validation-certificate:${certificate.body.artifact.name}` : certificate.body.artifact.name, path: certificate.relativePath, sha256: certificate.sha256 }));
    artifacts.push(...capability.artifacts);
    if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Conflicting native evidence identifiers", 409);
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
          evidenceId: capability.validationEvidenceIds.get(validation.id) ?? artifacts.find((artifact) => artifact.class === `task:${task.backlogTaskId}:validation-passed`)?.id ?? evidenceIds[0],
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
    return { receipt, sourceEventWatermark, sources: artifacts.map((artifact) => ({ relativePath: artifact.path, sourcePath: capability.sources.get(artifact.id) ?? certificates.find((certificate) => certificate.id === artifact.id)?.sourcePath ?? (governorProvenance?.artifact.id === artifact.id ? governorProvenance.sourcePath : path.join(path.dirname(handoffPath), artifact.path)), sha256: artifact.sha256 })) };
}

const capabilityDigest = z.string().regex(/^[0-9a-f]{64}$/);
const capabilityContext = z.object({ taskId: z.string().min(1), repositoryId: z.string().min(1), revision: z.string().regex(/^[0-9a-f]{40}$/), authorityStateSha256: capabilityDigest }).strict();
const capabilityCheck = z.object({ id: z.string().min(1), covers: z.array(z.string().min(1)).min(1).max(8192) }).strict();
const capabilityObligation = z.object({ id: z.string().min(1), individualCheckIds: z.array(z.string().min(1)).max(8192).optional(), combinedCheckIds: z.array(z.string().min(1)).min(1).max(8192) }).loose();
// These are transport/context checks. Repository-declared checks and the consumer
// auditor retain semantic law/member authority; export performs no activation.
const capabilityPlan = z.object({
  schemaVersion: z.literal(1), kind: z.literal("design-intelligence/capability-activation-plan"), origin: z.literal("WALE_PROPOSED"), status: z.literal("READY_FOR_HANDOFF"), context: capabilityContext,
  bindings: z.object({ compositionSha256: capabilityDigest, lawDecisionSha256: capabilityDigest, lawProfileSha256: capabilityDigest, lawCatalogSha256: capabilityDigest, skillCatalogSha256: capabilityDigest, skillRegistrySha256: capabilityDigest, workflowSha256: capabilityDigest }).strict(),
  bindingSemantics: z.record(z.string(), z.string()), lawEvidence: z.record(z.string(), z.unknown()), lawBinding: z.record(z.string(), z.unknown()),
  selectedMembers: z.array(z.object({ id: z.string().min(1), checks: z.array(capabilityCheck).max(8192) }).loose()).min(1).max(64),
  obligations: z.object({ laws: z.array(capabilityObligation).max(8192), members: z.array(capabilityObligation).max(8192), outputsAndEffects: z.array(capabilityObligation).max(8192), combinedChecks: z.array(capabilityCheck).max(8192) }).strict(),
  issues: z.array(z.unknown()).length(0), activationPerformed: z.literal(false), executionAuthorized: z.literal(false), executable: z.literal(false), claimBoundary: z.string().min(1), planSha256: capabilityDigest,
}).strict();
const capabilityBinding = z.object({
  schemaVersion: z.literal("1.0.0"), kind: z.literal("design-intelligence/capability-handoff-binding"), planSha256: capabilityDigest, repositoryId: z.string().min(1), compositionSha256: capabilityDigest, lawDecisionSha256: capabilityDigest, context: capabilityContext,
  contextSha256: capabilityDigest, obligationsSha256: capabilityDigest, handoff: z.object({ id: z.string().min(1), revision: z.string().regex(/^[0-9a-f]{40}$/), scopeSha256: capabilityDigest }).strict(),
  activationPerformed: z.literal(false), executionAuthorized: z.literal(false), executable: z.literal(false), bindingSha256: capabilityDigest,
}).strict();
type CapabilityArtifact = { id: string; class: string; path: string; sha256: string };

function requireCapability(condition: boolean): asserts condition {
  if (!condition) throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Current declared capability evidence is unavailable or inconsistent", 409);
}

function capabilityJson(bytes: Buffer): unknown {
  requireCapability(bytes.length <= 2 * 1024 * 1024);
  const document: unknown = JSON.parse(bytes.toString("utf8"));
  const pending: Array<{ value: unknown; depth: number }> = [{ value: document, depth: 0 }]; let count = 0;
  while (pending.length > 0) {
    const item = pending.pop(); if (item === undefined) break;
    requireCapability(++count <= 10000 && item.depth <= 32);
    if (typeof item.value === "string") requireCapability(item.value.length <= 4096);
    if (typeof item.value === "object" && item.value !== null) for (const value of Object.values(item.value)) pending.push({ value, depth: item.depth + 1 });
  }
  return document;
}

async function retainCapabilityEvidence(context: AgentFlowContext, snapshot: ReturnType<typeof captureReceiptSource>, handoff: GovernedTaskHandoff, certificates: VerifiedNativeValidationCertificate[], repositoryPath: string) {
  const result = { artifacts: [] as CapabilityArtifact[], sources: new Map<string, string>(), validationEvidenceIds: new Map<string, string>() };
  const kinds = ["design-intelligence/capability-activation-plan", "design-intelligence/capability-handoff-binding"];
  const requested = handoff.proof.requiredEvidence.some((label) => ["capability-plan", "capability-observation"].includes(label)) || handoff.tasks.some((task) => task.produces.some((artifact) => kinds.includes(artifact.type)));
  if (!requested) return result;
  try {
    requireCapability(handoff.proof.requiredEvidence.includes("capability-plan") && handoff.proof.requiredEvidence.includes("capability-observation") && certificates.length > 0 && snapshot.tasks.length === 1);
    const task = snapshot.tasks[0]; const declared = handoff.tasks[0]; const certificate = certificates[0];
    requireCapability(task !== undefined && declared !== undefined && certificate !== undefined && task.backlogTaskId === declared.id && task.resultCommit !== null);
    const manifests = snapshot.manifests.filter((item) => item.taskId === task.id && item.attempt === task.attempt && item.status === "validated");
    const manifest = manifests[0]; requireCapability(manifests.length === 1 && manifest !== undefined && manifest.id === certificate.body.manifest.id && manifest.sha256 === certificate.body.manifest.sha256);
    const references = z.array(z.object({ name: z.string(), type: z.string(), version: z.string(), path: z.string().optional(), sha256: z.string().optional() }).strict()).parse(manifest.manifest.produces);
    const retain = async (id: string, evidenceClass: string, bytes: Buffer) => {
      const retained = await retainCapabilityBytes(context, snapshot.build.id, bytes);
      result.artifacts.push({ id, class: evidenceClass, path: retained.relativePath, sha256: retained.sha256 }); result.sources.set(id, retained.sourcePath);
    };
    const readDocument = async (kind: string, evidenceClass: string) => {
      const declarations = declared.produces.filter((item) => item.type === kind); const declaration = declarations[0];
      const records = snapshot.artifacts.filter((item) => item.artifactType === kind); const record = records[0];
      requireCapability(declarations.length === 1 && declaration !== undefined && declaration.version === "1.0.0" && declaration.path !== undefined && records.length === 1 && record !== undefined);
      const relative = declaration.path;
      requireCapability(relative === path.posix.normalize(relative) && !relative.includes("\\") && !relative.includes("\0") && !path.posix.isAbsolute(relative) && !relative.split("/").includes("..") && checkChangedFileOwnership([relative], declared.owns).valid);
      const matches = references.filter((item) => item.name === declaration.name);
      requireCapability(matches.length === 1 && matches[0]?.type === kind && matches[0].version === declaration.version && matches[0].path === relative && matches[0].sha256 === record.sha256);
      requireCapability(record.buildId === snapshot.build.id && record.producerTaskId === task.id && record.name === declaration.name && record.version === declaration.version && record.repositoryPath === relative && ["validated", "integrated"].includes(record.status));
      // Native artifact registration is reused across retries when payloads match.
      // Prove that historical registration, then use the CURRENT certified manifest
      // and result blob above/below for currentness; metadata is not current proof.
      const registeredAttempt = record.metadata.attempt;
      requireCapability(typeof registeredAttempt === "number" && Number.isInteger(registeredAttempt) && registeredAttempt >= 1 && registeredAttempt <= task.attempt && record.metadata.manifestStatus === "validated");
      const registrations = snapshot.manifests.filter((item) => item.taskId === task.id && item.attempt === registeredAttempt && item.status === "validated"); const registration = registrations[0];
      requireCapability(registrations.length === 1 && registration !== undefined && registration.buildId === snapshot.build.id && registration.schemaVersion === manifest.schemaVersion && record.storagePath === registration.manifestPath && record.metadata.manifestPath === registration.manifestPath && path.resolve(registration.manifestPath) === path.resolve(context.environment.artifactsPath, snapshot.build.id, task.id, `attempt-${registeredAttempt}.validated.manifest.json`));
      const registrationBytes = await readManagedNativeEvidenceBytes(context.environment.artifactsPath, registration.manifestPath);
      const registrationBody = z.object({ buildId: z.string(), taskId: z.string(), backlogTaskId: z.string(), attempt: z.number(), status: z.literal("validated"), schemaVersion: z.string(), produces: z.array(z.object({ name: z.string(), type: z.string(), version: z.string(), path: z.string().optional(), sha256: z.string().optional() }).strict()) }).loose().parse(JSON.parse(registrationBytes.toString("utf8")));
      requireCapability(createHash("sha256").update(registrationBytes).digest("hex") === registration.sha256 && canonicalJsonSha256(registrationBody) === canonicalJsonSha256(registration.manifest) && registrationBody.buildId === snapshot.build.id && registrationBody.taskId === task.id && registrationBody.backlogTaskId === task.backlogTaskId && registrationBody.attempt === registeredAttempt && registrationBody.schemaVersion === registration.schemaVersion);
      const registeredReferences = registrationBody.produces.filter((item) => item.name === declaration.name);
      requireCapability(registeredReferences.length === 1 && registeredReferences[0]?.type === kind && registeredReferences[0].version === declaration.version && registeredReferences[0].path === relative && registeredReferences[0].sha256 === record.sha256);
      const runner = new GitCommandRunner();
      const listed = await runner.run(repositoryPath, ["--literal-pathspecs", "ls-tree", "-z", task.resultCommit ?? "", "--", relative]);
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(listed.stdout);
      requireCapability(match !== null && match[3] === relative && match[2] !== undefined);
      const blob = await runner.run(repositoryPath, ["cat-file", "blob", match[2]]); const bytes = Buffer.from(blob.stdout, "utf8");
      requireCapability(createHash("sha256").update(bytes).digest("hex") === record.sha256);
      const document = capabilityJson(bytes); await retain(`${evidenceClass}-${createHash("sha256").update(bytes).digest("hex")}`, evidenceClass, bytes); return document;
    };
    const plan = capabilityPlan.parse(await readDocument(kinds[0] ?? "", "capability-plan"));
    const binding = capabilityBinding.parse(await readDocument(kinds[1] ?? "", "capability-binding"));
    const { planSha256, ...planBody } = plan; const { bindingSha256, ...bindingBody } = binding;
    requireCapability(canonicalJsonSha256(planBody) === planSha256 && canonicalJsonSha256(bindingBody) === bindingSha256 && binding.planSha256 === planSha256);
    const expectedContext = { taskId: task.backlogTaskId, repositoryId: snapshot.build.repositoryId, revision: handoff.repository.baseCommit, authorityStateSha256: handoff.authority.stateSha256 };
    const proposedScope = { ...handoff, authority: { status: "PROPOSED", stateSha256: handoff.authority.stateSha256, governanceReportSha256: handoff.authority.governanceReportSha256, sources: handoff.authority.sources } };
    requireCapability(canonicalJsonSha256(plan.context) === canonicalJsonSha256(expectedContext) && canonicalJsonSha256(binding.context) === canonicalJsonSha256(expectedContext) && binding.contextSha256 === canonicalJsonSha256(expectedContext) && binding.repositoryId === snapshot.build.repositoryId);
    requireCapability(binding.handoff.id === handoff.handoffId && binding.handoff.revision === handoff.repository.baseCommit && binding.handoff.scopeSha256 === canonicalJsonSha256(proposedScope) && binding.obligationsSha256 === canonicalJsonSha256(plan.obligations) && binding.compositionSha256 === plan.bindings.compositionSha256 && binding.lawDecisionSha256 === plan.bindings.lawDecisionSha256);
    const individual = plan.selectedMembers.flatMap((member) => member.checks); const combined = plan.obligations.combinedChecks; const definitions = [...individual, ...combined];
    const obligations = [...plan.obligations.laws, ...plan.obligations.members, ...plan.obligations.outputsAndEffects];
    requireCapability(obligations.length > 0 && new Set(obligations.map((item) => item.id)).size === obligations.length && new Set(definitions.map((item) => item.id)).size === definitions.length && new Set(declared.validate).size === declared.validate.length);
    const logs = new Map<string, string>();
    for (const check of certificate.body.validations) {
      const matches = snapshot.validations.filter((row) => row.id === check.id && row.taskId === task.id && row.buildId === snapshot.build.id && row.validationType === "task"); const row = matches[0];
      requireCapability(matches.length === 1 && row !== undefined && row.command === declared.validate[check.index] && row.status === "passed" && row.exitCode === 0 && row.logPath !== null && !logs.has(row.command));
      const bytes = await readManagedNativeEvidenceBytes(context.environment.runsPath, row.logPath);
      requireCapability(createHash("sha256").update(bytes).digest("hex") === check.logSha256);
      await retain(row.id, "agentflow:native-task-validation-log", bytes); logs.set(row.command, row.id); result.validationEvidenceIds.set(row.id, row.id);
    }
    requireCapability(logs.size === declared.validate.length && definitions.every((check) => logs.has(check.id) && check.covers.every((subject) => obligations.some((item) => item.id === subject))));
    const observations: Array<{ subject: string; checkId: string; evidenceId: string }> = [];
    for (const obligation of obligations) {
      const expectedIndividual = individual.filter((check) => check.covers.includes(obligation.id)).map((check) => check.id); const expectedCombined = combined.filter((check) => check.covers.includes(obligation.id)).map((check) => check.id);
      const checks = [...(obligation.individualCheckIds ?? []), ...obligation.combinedCheckIds];
      requireCapability(canonicalJsonSha256(obligation.individualCheckIds ?? []) === canonicalJsonSha256(expectedIndividual) && canonicalJsonSha256(obligation.combinedCheckIds) === canonicalJsonSha256(expectedCombined) && new Set(checks).size === checks.length);
      for (const checkId of checks) { const evidenceId = logs.get(checkId); requireCapability(evidenceId !== undefined); observations.push({ subject: obligation.id, checkId, evidenceId }); }
    }
    requireCapability(observations.length <= 8192);
    const observation = { schemaVersion: "1.0.0", kind: "design-intelligence/capability-observation", planSha256, bindingSha256, handoff: { id: handoff.handoffId, sha256: canonicalJsonSha256(handoff) }, observations };
    const bytes = Buffer.from(`${JSON.stringify(observation, null, 2)}\n`, "utf8"); await retain(`capability-observation-${createHash("sha256").update(bytes).digest("hex")}`, "capability-observation", bytes);
    return result;
  } catch { throw new AgentFlowError("RECEIPT_EVIDENCE_CHANGED", "Current declared capability evidence is unavailable or inconsistent", 409); }
}

async function retainCapabilityBytes(context: AgentFlowContext, buildId: string, bytes: Buffer) {
  requireCapability(bytes.length <= 2 * 1024 * 1024 && /^[A-Za-z0-9._-]{1,128}$/u.test(buildId) && buildId !== "." && buildId !== "..");
  const root = path.resolve(context.environment.artifactsPath); requireCapability(await realpath(root) === root);
  let directory = root;
  for (const segment of [buildId, "capability-export"]) {
    directory = path.join(directory, segment);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
    const metadata = await lstat(directory); requireCapability(metadata.isDirectory() && !metadata.isSymbolicLink() && await realpath(directory) === directory);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex"); const sourcePath = path.join(directory, `${sha256}.json`);
  try { await writeFile(sourcePath, bytes, { flag: "wx", mode: 0o600 }); } catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
  requireCapability((await readManagedNativeEvidenceBytes(root, sourcePath, 2 * 1024 * 1024)).equals(bytes));
  return { sha256, sourcePath, relativePath: `artifacts/${buildId}/capability-export/${sha256}.json` };
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
