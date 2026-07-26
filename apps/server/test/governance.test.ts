import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOrganizationPolicy,
  validateRepositoryAgainstPolicy,
  validateTaskOwnershipAgainstPolicy,
} from "../src/governance/organization-policy.js";
import { repositoryTemplate } from "../src/governance/templates.js";
import {
  loadRepositoryConfig,
  replaceRepositoryConfigFile,
} from "../src/repositories/config.js";

const roots = new Set<string>();
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe("organization governance", () => {
  it("creates the policy without replacing edits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentflow-policy-"));
    roots.add(root);
    const policyPath = path.join(root, "policy.yaml");
    await ensureOrganizationPolicy(policyPath);
    await writeFile(
      policyPath,
      (await readFile(policyPath, "utf8")).replace(
        "maximum_per_repository: 4",
        "maximum_per_repository: 2",
      ),
    );
    expect(
      (await ensureOrganizationPolicy(policyPath)).workers.maximum_per_repository,
    ).toBe(2);
  });

  it("atomically applies a validated repository template", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentflow-template-"));
    roots.add(root);
    const template = repositoryTemplate("safe-generic");
    const config = {
      ...template.config,
      repository: { name: "fixture", base_branch: "main" },
    };
    await replaceRepositoryConfigFile(root, config);
    expect((await loadRepositoryConfig(root)).workers.maximum).toBe(2);
    expect(validateRepositoryAgainstPolicy(config, policy(1))).toContain(
      "workers.maximum 2 exceeds organization maximum 1",
    );
  });

  it("rejects ownership under protected prefixes", () => {
    const task = {
      id: "TASK-1", title: "Unsafe", description: "Unsafe",
      acceptanceCriteria: ["No"], estimateHours: 1, dependsOn: [],
      owns: [".agentflow/private"], validate: ["git diff --check"],
      consumes: [], produces: [], allowNoChanges: false, riskScore: 1,
      requiresApproval: false, epicId: "EPIC-1", epicTitle: "Epic",
      epicOutcome: "Outcome", architectureDecisions: [],
    };
    expect(validateTaskOwnershipAgainstPolicy([task], policy(4))).toEqual([
      "TASK-1 owns organization-protected path .agentflow/private",
    ]);
  });
});

function policy(maximum: number) {
  return {
    version: 1 as const,
    workers: { maximum_per_repository: maximum },
    retries: { maximum_attempts: 3 },
    validation: { required_commands: [] },
    ownership: { forbidden_prefixes: [".agentflow/"] },
    providers: { allowed: ["codex"] },
    visual: { maximum_difference_ratio: 0.001 },
  };
}
