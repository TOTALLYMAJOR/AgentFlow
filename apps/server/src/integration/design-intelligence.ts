import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PlannedTask } from "../domain/types.js";

export const GOVERNED_HANDOFF_VERSION = "1.0.0" as const;
export const GOVERNED_HANDOFF_KIND = "design-intelligence/governed-task-handoff" as const;
export const BUILD_RECEIPT_KIND = "agentflow/build-receipt" as const;
export const HANDOFF_MARKER = "agentflow:design-intelligence-handoff";

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

export const GovernedTaskHandoffSchema = z.object({
  schemaVersion: z.literal(GOVERNED_HANDOFF_VERSION),
  kind: z.literal(GOVERNED_HANDOFF_KIND),
  handoffId: z.string().min(1),
  createdAt: z.iso.datetime(),
  repository: z.object({
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    remote: z.string().min(1).optional(),
  }).strict(),
  objective: z.string().min(10),
  authority: z.object({
    status: z.literal("APPROVED"),
    approvedBy: z.string().min(1),
    approvedAt: z.iso.datetime(),
    sources: z.array(z.object({
      path: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict()).min(1),
  }).strict(),
  tasks: z.array(GovernedTask).min(1),
  proof: z.object({
    requiredEvidence: z.array(z.string().min(1)).min(1),
    claimBoundary: z.string().min(1),
  }).strict(),
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
});

export type GovernedTaskHandoff = z.infer<typeof GovernedTaskHandoffSchema>;

export interface GovernedHandoffBinding {
  id: string;
  sha256: string;
  path: string;
  baseCommit: string;
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
  return errors;
}

export function handoffBinding(handoff: GovernedTaskHandoff, path: string): GovernedHandoffBinding {
  return {
    id: handoff.handoffId,
    sha256: canonicalJsonSha256(handoff),
    path,
    baseCommit: handoff.repository.baseCommit,
    proofBoundary: handoff.proof.claimBoundary,
  };
}

export function renderBacklog(handoff: GovernedTaskHandoff, path: string): string {
  const binding = handoffBinding(handoff, path);
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
  return z.object({
    id: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), path: z.string().min(1),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/), proofBoundary: z.string().min(1),
  }).strict().parse(JSON.parse(match[1]));
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

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}
