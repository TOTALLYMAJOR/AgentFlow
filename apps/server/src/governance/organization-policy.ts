import { open, readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { AgentFlowRepositoryConfig } from "../repositories/config.js";
import type { PlannedTask } from "../domain/types.js";

export const OrganizationPolicySchema = z.object({
  version: z.literal(1),
  workers: z.object({
    maximum_per_repository: z.number().int().min(1).max(64),
  }).strict(),
  retries: z.object({
    maximum_attempts: z.number().int().min(1).max(10),
  }).strict(),
  validation: z.object({
    required_commands: z.array(z.string().trim().min(1).max(4_096)).max(32),
  }).strict(),
  ownership: z.object({
    forbidden_prefixes: z.array(z.string().trim().min(1).max(1_024)).max(64),
  }).strict(),
  providers: z.object({
    allowed: z.array(z.string().trim().min(1)).min(1).max(32),
  }).strict(),
  visual: z.object({
    maximum_difference_ratio: z.number().min(0).max(1),
  }).strict(),
}).strict();

export type OrganizationPolicy = z.infer<typeof OrganizationPolicySchema>;

export const DEFAULT_ORGANIZATION_POLICY: OrganizationPolicy = {
  version: 1,
  workers: { maximum_per_repository: 4 },
  retries: { maximum_attempts: 3 },
  validation: { required_commands: [] },
  ownership: { forbidden_prefixes: [".git/", ".agentflow/"] },
  providers: { allowed: ["codex"] },
  visual: { maximum_difference_ratio: 0.001 },
};

export async function ensureOrganizationPolicy(
  policyPath: string,
): Promise<OrganizationPolicy> {
  try {
    const handle = await open(policyPath, "wx", 0o600);
    try {
      await handle.writeFile(stringify(DEFAULT_ORGANIZATION_POLICY), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  return loadOrganizationPolicy(policyPath);
}

export async function loadOrganizationPolicy(
  policyPath: string,
): Promise<OrganizationPolicy> {
  const source = await readFile(policyPath, "utf8");
  return OrganizationPolicySchema.parse(parse(source, {
    merge: false,
    strict: true,
    uniqueKeys: true,
  }));
}

export function validateRepositoryAgainstPolicy(
  config: AgentFlowRepositoryConfig,
  policy: OrganizationPolicy,
): string[] {
  const errors: string[] = [];
  if (config.workers.maximum > policy.workers.maximum_per_repository) {
    errors.push(
      `workers.maximum ${config.workers.maximum} exceeds organization maximum ${policy.workers.maximum_per_repository}`,
    );
  }
  for (const required of policy.validation.required_commands) {
    if (!config.validation.task_default.includes(required)) {
      errors.push(`task validation is missing required command: ${required}`);
    }
    if (!config.validation.integration.includes(required)) {
      errors.push(`integration validation is missing required command: ${required}`);
    }
  }
  return errors;
}

export function validateTaskOwnershipAgainstPolicy(
  tasks: PlannedTask[],
  policy: OrganizationPolicy,
): string[] {
  const forbidden = policy.ownership.forbidden_prefixes.map(normalizePrefix);
  return tasks.flatMap((task) =>
    task.owns
      .filter((ownedPath) => {
        const normalized = normalizePrefix(ownedPath);
        return forbidden.some(
          (prefix) =>
            normalized === prefix.slice(0, -1) ||
            normalized.startsWith(prefix),
        );
      })
      .map((ownedPath) => `${task.id} owns organization-protected path ${ownedPath}`),
  );
}

function normalizePrefix(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
