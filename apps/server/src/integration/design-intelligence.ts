import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PlannedTask } from "../domain/types.js";
import { GitCommandRunner } from "../git/index.js";

export const GOVERNED_HANDOFF_VERSION = "2.1.0" as const;
export const BUILD_RECEIPT_VERSION = "1.1.0" as const;
export const GOVERNED_HANDOFF_KIND = "design-intelligence/governed-task-handoff" as const;
export const BUILD_RECEIPT_KIND = "agentflow/build-receipt" as const;
export const HANDOFF_MARKER = "agentflow:design-intelligence-handoff";
const PROGRAM_ID_PATTERN = /^program_[a-z0-9][a-z0-9._-]{7,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const AuthoritySource = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256_PATTERN),
}).strict();

const ExecutionApprovalReceipt = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("proofloom/execution-approval-receipt"),
  receiptType: z.literal("EXECUTION_APPROVAL"),
  policyVersion: z.literal("human-authority/v1"),
  receiptId: z.string().regex(/^HAR-[A-F0-9]{20}$/),
  decision: z.literal("APPROVED"),
  sessionId: z.string().min(1),
  authority: z.object({
    actorId: z.string().regex(/^human:.+/),
    role: z.enum(["repository-owner", "execution-owner", "named-delegate"]),
    basis: z.string().min(1),
  }).strict(),
  repositoryRevision: z.string().regex(COMMIT_PATTERN),
  artifact: z.object({
    kind: z.literal("design-intelligence/governed-task-handoff-scope"),
    id: z.string().min(1),
    sha256: z.string().regex(SHA256_PATTERN),
  }).strict(),
  scope: z.object({
    repository: z.literal("."),
    paths: z.array(z.string().min(1)).min(1),
    actions: z.array(z.string().min(1)).min(1),
  }).loose(),
  governingSources: z.array(AuthoritySource).min(1),
  issuedAt: z.iso.datetime(),
  validUntil: z.iso.datetime(),
  supersedes: z.string().regex(/^HAR-[A-F0-9]{20}$/).nullable().optional(),
  transition: z.record(z.string(), z.unknown()),
  constraints: z.object({
    allowedActions: z.array(z.string().min(1)).min(1),
    requiredEvidence: z.array(z.string().min(1)).min(1),
    escalationConditions: z.array(z.string().min(1)).min(1),
    resourceCeilings: z.record(z.string(), z.number().positive()).refine((value) => Object.keys(value).length > 0),
    iterationCeiling: z.number().int().positive(),
    revocationAuthorityRoles: z.array(z.enum(["repository-owner", "execution-owner", "named-delegate"])).min(1),
  }).strict(),
  mutationPerformed: z.literal(false),
}).loose().superRefine((receipt, context) => {
  for (const [index, scopedPath] of receipt.scope.paths.entries()) {
    if (path.isAbsolute(scopedPath) || scopedPath.split(/[\\/]/).includes("..")) {
      context.addIssue({ code: "custom", path: ["scope", "paths", index], message: "Approval scope path escapes the repository" });
    }
  }
});

const ProducedArtifact = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  type: z.string().min(1),
  path: z.string().min(1).optional(),
}).strict();

const ConsumedArtifact = z.object({
  task: z.string().min(1),
  artifact: z.string().min(1),
  version: z.string().min(1),
}).strict();

const GovernedTask = z.object({
  id: z.string().regex(/^[A-Z0-9][A-Z0-9._-]*$/),
  title: z.string().min(1),
  description: z.string().min(1),
  estimateHours: z.number().positive(),
  dependsOn: z.array(z.string()).default([]),
  owns: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  validate: z.array(z.string().min(1)).min(1),
  produces: z.array(ProducedArtifact).default([]),
  consumes: z.array(ConsumedArtifact).default([]),
}).strict();

const PromptProvenance = z.object({
  prompt: z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    conversationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  }).strict(),
  github: z.object({
    declared: z.object({
      repositoryRef: z.string().regex(/^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
      issueRefs: z.array(z.string().min(1)), branch: z.string().min(1),
      baseCommit: z.string().regex(COMMIT_PATTERN), filesInScope: z.array(z.string().min(1)),
    }).strict(),
    resolved: z.object({
      repositoryRef: z.string().regex(/^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/).optional(),
      issueRefs: z.array(z.string().min(1)).optional(), branch: z.string().min(1).optional(),
      headCommit: z.string().regex(COMMIT_PATTERN).optional(),
    }).strict(),
    verification: z.object({
      status: z.enum(["verified", "partial", "mismatch", "not_found", "unauthorized"]),
      checkedAt: z.iso.datetime(),
    }).strict(),
  }).strict(),
  evidenceSnapshots: z.array(z.object({
    phase: z.literal("START"), capturedAt: z.iso.datetime(),
    headCommit: z.string().regex(COMMIT_PATTERN),
    path: z.string().regex(/^artifacts\/provenance\/.+/).refine((value) => !value.split("/").includes("..")),
    sha256: z.string().regex(SHA256_PATTERN),
  }).strict()).length(1),
}).strict();

const GovernedTaskHandoffBaseSchema = z.object({
  schemaVersion: z.literal(GOVERNED_HANDOFF_VERSION),
  kind: z.literal(GOVERNED_HANDOFF_KIND),
  handoffId: z.string().min(1),
  createdAt: z.iso.datetime(),
  programId: z.string().regex(PROGRAM_ID_PATTERN).optional(),
  repository: z.object({
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    snapshotSha256: z.string().regex(SHA256_PATTERN),
    worktreeState: z.literal("clean"),
    remote: z.string().min(1).optional(),
  }).strict(),
  objective: z.string().min(10),
  authority: z.object({
    status: z.literal("APPROVED"),
    approvedBy: z.string().min(1),
    approvedAt: z.iso.datetime(),
    approvalReceipt: ExecutionApprovalReceipt,
    stateSha256: z.string().regex(SHA256_PATTERN),
    governanceReportSha256: z.string().regex(SHA256_PATTERN),
    sources: z.array(AuthoritySource).min(1),
  }).strict(),
  tasks: z.array(GovernedTask).min(1),
  proof: z.object({
    requiredEvidence: z.array(z.string().min(1)).min(1),
    claimBoundary: z.string().min(1),
  }).strict(),
  provenance: PromptProvenance.optional(),
}).strict().superRefine((handoff, context) => {
  const ids = new Set(handoff.tasks.map((task) => task.id));
  if (ids.size !== handoff.tasks.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Task ids must be unique" });
  }
  for (const [index, task] of handoff.tasks.entries()) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) context.addIssue({ code: "custom", path: ["tasks", index, "dependsOn"], message: `Missing dependency ${dependency}` });
      if (dependency === task.id) context.addIssue({ code: "custom", path: ["tasks", index, "dependsOn"], message: "A task cannot depend on itself" });
    }
  }
    const remote = handoff.repository.remote;
    const githubBacked = remote !== undefined && /^(github:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/.test(remote);
    if (githubBacked && handoff.provenance === undefined) context.addIssue({ code: "custom", path: ["provenance"], message: "GitHub-backed handoffs require provenance" });
    if (githubBacked && handoff.provenance?.github.verification.status !== "verified") context.addIssue({ code: "custom", path: ["provenance", "github", "verification", "status"], message: "GitHub resolution must be verified for execution" });
    if (handoff.provenance !== undefined) {
      if (handoff.provenance.github.declared.baseCommit !== handoff.repository.baseCommit) context.addIssue({ code: "custom", path: ["provenance", "github", "declared", "baseCommit"], message: "Declared GitHub base commit must match the governed base" });
      if (handoff.provenance.evidenceSnapshots[0]?.headCommit !== handoff.repository.baseCommit) context.addIssue({ code: "custom", path: ["provenance", "evidenceSnapshots", 0, "headCommit"], message: "START snapshot must match the governed base" });
      if (handoff.provenance.github.verification.status === "verified") {
        const resolved = handoff.provenance.github.resolved;
        for (const field of ["repositoryRef", "issueRefs", "branch", "headCommit"] as const) if (resolved[field] === undefined) context.addIssue({ code: "custom", path: ["provenance", "github", "resolved", field], message: `Verified GitHub provenance requires ${field}` });
      }
    }
    for (const error of executionApprovalErrors(handoff)) context.addIssue({ code: "custom", path: ["authority", "approvalReceipt"], message: error });
  });

export const GovernedTaskHandoffSchema = GovernedTaskHandoffBaseSchema;

export type GovernedTaskHandoff = z.infer<typeof GovernedTaskHandoffSchema>;

export interface GovernedHandoffBinding {
  id: string;
  programId?: string;
  sha256: string;
  path: string;
  governedBaseCommit: string;
  executionBaseCommit?: string;
  carrierPaths: string[];
  proofBoundary: string;
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

export async function loadGovernedTaskHandoff(path: string): Promise<GovernedTaskHandoff> {
  return GovernedTaskHandoffSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function verifyHandoffAuthoritySources(repositoryRoot: string, handoff: GovernedTaskHandoff): Promise<string[]> {
  const errors: string[] = [];
  const canonicalRoot = await realpath(repositoryRoot);
    for (const source of handoff.authority.sources) {
    if (path.isAbsolute(source.path)) {
      errors.push(`${source.path}: authority source must be repository-relative`);
      continue;
    }
    const candidate = path.resolve(canonicalRoot, source.path);
    const relative = path.relative(canonicalRoot, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      errors.push(`${source.path}: authority source escapes the repository`);
      continue;
    }
    try {
      const canonical = await realpath(candidate);
      const canonicalRelative = path.relative(canonicalRoot, canonical);
      if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
        errors.push(`${source.path}: authority source symlink escapes the repository`);
        continue;
      }
      const digest = createHash("sha256").update(await readFile(canonical)).digest("hex");
      if (digest !== source.sha256) errors.push(`${source.path}: authority source hash mismatch`);
    } catch {
      errors.push(`${source.path}: authority source is unavailable`);
      }
    }
    if (errors.length === 0) {
      const sources = [...handoff.authority.sources]
        .map((source) => ({ path: source.path, sha256: source.sha256 }))
        .sort((left, right) => left.path.localeCompare(right.path));
      const snapshotSha256 = canonicalJsonSha256({
        baseCommit: handoff.repository.baseCommit,
        worktreeState: "clean",
        authorityStateSha256: handoff.authority.stateSha256,
        governanceReportSha256: handoff.authority.governanceReportSha256,
        sources,
      });
      if (snapshotSha256 !== handoff.repository.snapshotSha256) {
        errors.push("repository snapshot digest mismatch");
      }
    }
    return errors;
}

export async function governedSourceDriftPaths(
  repositoryRoot: string,
  baseCommit: string,
  allowedControlArtifacts: readonly string[],
): Promise<string[]> {
  const changed = await new GitCommandRunner().run(repositoryRoot, [
    "diff",
    "--name-only",
    "--diff-filter=ACDMRTUXB",
    `${baseCommit}..HEAD`,
    "--",
  ]);
  const allowed = new Set(allowedControlArtifacts.map(normalizeOwnershipPath));
  return changed.stdout
    .split("\n")
    .map((value) => normalizeOwnershipPath(value.trim()))
    .filter((value) => value.length > 0 && !allowed.has(value));
}

export function handoffBinding(handoff: GovernedTaskHandoff, path: string, carrierPaths: string[], executionBaseCommit?: string): GovernedHandoffBinding {
  return {
    id: handoff.handoffId,
    ...(handoff.programId === undefined ? {} : { programId: handoff.programId }),
    sha256: canonicalJsonSha256(handoff),
    path,
    governedBaseCommit: handoff.repository.baseCommit,
    ...(executionBaseCommit === undefined ? {} : { executionBaseCommit }),
    carrierPaths,
    proofBoundary: handoff.proof.claimBoundary,
  };
}

export function renderBacklog(handoff: GovernedTaskHandoff, path: string, backlogPath: string): string {
  const binding = handoffBinding(handoff, path, [path, backlogPath]);
  const lines = [
    "# AgentFlow execution packet",
    "",
    `<!-- ${HANDOFF_MARKER} ${JSON.stringify(binding)} -->`,
    "",
    `> Objective: ${handoff.objective}`,
    "> Execution authority remains the reviewed handoff and committed backlog.",
    "",
  ];
  for (const task of handoff.tasks) {
    lines.push(`## ${task.id}: ${task.title}`, "", "```yaml");
    lines.push(`estimate_hours: ${task.estimateHours}`);
    lines.push(`depends_on: ${JSON.stringify(task.dependsOn)}`);
    lines.push("owns:", ...task.owns.map((value) => `  - ${value}`));
    lines.push("validate:", ...task.validate.map((value) => `  - ${value}`));
    if (task.produces.length > 0) {
      lines.push("produces:");
      for (const artifact of task.produces) {
        lines.push(`  - name: ${artifact.name}`, `    type: ${artifact.type}`, `    version: ${artifact.version}`);
        if (artifact.path !== undefined) lines.push(`    path: ${artifact.path}`);
      }
    }
    if (task.consumes.length > 0) {
      lines.push("consumes:");
      for (const artifact of task.consumes) lines.push(`  - task: ${artifact.task}`, `    artifact: ${artifact.artifact}`, `    version: ${artifact.version}`);
    }
    lines.push("```", "", task.description, "", "### Acceptance Criteria", "", ...task.acceptanceCriteria.map((value) => `- ${value}`), "");
  }
  return `${lines.join("\n")}\n`;
}

export function parseHandoffBinding(markdown: string): GovernedHandoffBinding | undefined {
  const escaped = HANDOFF_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`<!--\\s*${escaped}\\s+(\\{[^\\n]+\\})\\s*-->`));
  if (match?.[1] === undefined) return undefined;
  const binding = z.object({
    id: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), path: z.string().min(1),
    programId: z.string().regex(PROGRAM_ID_PATTERN).optional(),
    governedBaseCommit: z.string().regex(COMMIT_PATTERN),
    executionBaseCommit: z.string().regex(COMMIT_PATTERN).optional(),
    carrierPaths: z.array(z.string().min(1)).length(2),
    proofBoundary: z.string().min(1),
  }).strict().parse(JSON.parse(match[1]));
  return {
    id: binding.id,
    ...(binding.programId === undefined ? {} : { programId: binding.programId }),
    sha256: binding.sha256,
    path: binding.path,
    governedBaseCommit: binding.governedBaseCommit,
    ...(binding.executionBaseCommit === undefined ? {} : { executionBaseCommit: binding.executionBaseCommit }),
    carrierPaths: binding.carrierPaths,
    proofBoundary: binding.proofBoundary,
  };
}

export async function verifyGovernedHandoffForExecution(
  repositoryRoot: string,
  handoff: GovernedTaskHandoff,
  carrierPaths: readonly string[],
): Promise<{ currentHead: string; errors: string[] }> {
  const errors = [...executionApprovalErrors(handoff), ...snapshotErrors(handoff), ...(await verifyHandoffAuthoritySources(repositoryRoot, handoff))];
  const git = new GitCommandRunner();
  const status = await git.run(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.stdout.trim().length > 0) errors.push("repository worktree is not clean");
  const currentHead = (await git.run(repositoryRoot, ["rev-parse", "HEAD^{commit}"])).stdout.trim();
  let changed: string[] = [];
  try {
    await git.run(repositoryRoot, ["merge-base", "--is-ancestor", handoff.repository.baseCommit, currentHead]);
    changed = (await git.run(repositoryRoot, ["diff", "--name-only", `${handoff.repository.baseCommit}..${currentHead}`, "--"])).stdout.split("\n").map(normalizeOwnershipPath).filter((value) => value.length > 0);
  } catch {
    errors.push("governed base commit is not an ancestor of the execution snapshot");
  }
  const allowed = carrierPaths.map(normalizeOwnershipPath);
  for (const changedPath of changed) {
    if (!allowed.includes(changedPath)) errors.push(`${changedPath}: intervening change is outside the authorized handoff carriers`);
  }
  return { currentHead, errors: [...new Set(errors)] };
}

function snapshotErrors(handoff: GovernedTaskHandoff): string[] {
  const payload = {
    baseCommit: handoff.repository.baseCommit,
    worktreeState: handoff.repository.worktreeState,
    authorityStateSha256: handoff.authority.stateSha256,
    governanceReportSha256: handoff.authority.governanceReportSha256,
    sources: [...handoff.authority.sources].sort((left, right) => compareCanonicalStrings(left.path, right.path)),
  };
  return canonicalJsonSha256(payload) === handoff.repository.snapshotSha256 ? [] : ["repository snapshot digest does not match the governed authority snapshot"];
}

function executionApprovalErrors(handoff: z.infer<typeof GovernedTaskHandoffBaseSchema>): string[] {
  const receipt = handoff.authority.approvalReceipt;
  const proposed = JSON.parse(JSON.stringify(handoff)) as Record<string, unknown>;
  const authority = proposed.authority as Record<string, unknown>;
  authority.status = "PROPOSED";
  delete authority.approvedBy;
  delete authority.approvedAt;
  delete authority.approvalReceipt;
  const expectedArtifact = { kind: "design-intelligence/governed-task-handoff-scope", id: handoff.handoffId, sha256: canonicalJsonSha256(proposed) };
  const errors: string[] = [];
  if (canonicalJsonSha256(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptId"))).slice(0, 20).toUpperCase() !== receipt.receiptId.slice(4)) errors.push("approval receipt id does not match its canonical content");
  if (JSON.stringify(sortJson(receipt.artifact)) !== JSON.stringify(sortJson(expectedArtifact))) errors.push("approval receipt does not bind the governed handoff scope");
  if (receipt.repositoryRevision !== handoff.repository.baseCommit) errors.push("approval receipt repository revision does not match the governed base commit");
  if (receipt.authority.actorId !== handoff.authority.approvedBy || receipt.issuedAt !== handoff.authority.approvedAt) errors.push("approved authority identity does not match the approval receipt");
  if (JSON.stringify(sortJson(receipt.governingSources)) !== JSON.stringify(sortJson(handoff.authority.sources))) errors.push("approval receipt governing sources do not match the handoff authority sources");
  if (!receipt.constraints.allowedActions.includes("execute-governed-handoff")) errors.push("approval receipt does not authorize governed handoff execution");
  const issued = Date.parse(receipt.issuedAt);
  const validUntil = Date.parse(receipt.validUntil);
  const now = Date.now();
  if (now < issued || now > validUntil) errors.push("approval receipt is not currently valid");
  for (const task of handoff.tasks) for (const owned of task.owns) if (!receipt.scope.paths.some((scope) => scopeCoversPath(scope, owned))) errors.push(`${owned}: approval receipt scope does not cover task ownership`);
  return errors;
}

function scopeCoversPath(scope: string, owned: string): boolean {
  const normalizedScope = scope.replace(/\*$/, "").replace(/\/+$/, "");
  const normalizedOwned = owned.replace(/\/+$/, "");
  return normalizedOwned === normalizedScope || normalizedOwned.startsWith(`${normalizedScope}/`);
}

export function backlogHandoffErrors(tasks: readonly PlannedTask[], handoff: GovernedTaskHandoff): string[] {
  const errors: string[] = [];
  if (tasks.length !== handoff.tasks.length) errors.push("Backlog task count differs from the governed handoff");
  const planned = new Map(tasks.map((task) => [task.id, task]));
  for (const governed of handoff.tasks) {
    const task = planned.get(governed.id);
    if (task === undefined) {
      errors.push(`Backlog is missing governed task ${governed.id}`);
      continue;
    }
    const comparisons: Array<[string, unknown, unknown]> = [
      ["title", task.title, governed.title], ["description", task.description, governed.description],
      ["estimateHours", task.estimateHours, governed.estimateHours], ["dependsOn", task.dependsOn, governed.dependsOn],
      ["owns", task.owns.map(normalizeOwnershipPath), governed.owns.map(normalizeOwnershipPath)], ["acceptanceCriteria", task.acceptanceCriteria, governed.acceptanceCriteria],
      ["validate", task.validate, governed.validate], ["produces", task.produces, governed.produces], ["consumes", task.consumes, governed.consumes],
    ];
    for (const [field, actual, expected] of comparisons) {
      if (JSON.stringify(sortJson(actual)) !== JSON.stringify(sortJson(expected))) errors.push(`${governed.id}.${field} differs from the governed handoff`);
    }
  }
  for (const task of tasks) if (!handoff.tasks.some((governed) => governed.id === task.id)) errors.push(`Backlog adds task ${task.id} outside the governed handoff`);
  return errors;
}

function normalizeOwnershipPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function compareCanonicalStrings(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftCodePoints[index] ?? 0) - (rightCodePoints[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return leftCodePoints.length - rightCodePoints.length;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareCanonicalStrings(left, right)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}
