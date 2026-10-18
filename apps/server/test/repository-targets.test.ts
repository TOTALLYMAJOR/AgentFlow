import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import type { RepositoryRecord } from "../src/domain/types.js";
import { inspectRepositoryTarget } from "../src/repositories/target-catalog.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repository target catalog", () => {
  it("marks a clean configured repository eligible without requiring a backlog", async () => {
    const { repository } = await fixture(false);
    const target = await inspectRepositoryTarget(repository, undefined, "2026-09-12T20:00:00.000Z");
    expect(target).toMatchObject({ eligible: true, clean: true, backlog: { present: false }, designIntelligence: { configured: true } });
    expect(target.warnings.map((warning) => warning.code)).toContain("BACKLOG_MISSING");
  });

  it("keeps dirty and active repositories visible with recovery reasons", async () => {
    const { repository, root } = await fixture(true);
    await writeFile(path.join(root, "untracked.txt"), "work in progress\n");
    const target = await inspectRepositoryTarget(repository, { id: "build-1", status: "running" } as never);
    expect(target.eligible).toBe(false);
    expect(target.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining(["WORKTREE_DIRTY", "ACTIVE_BUILD_EXISTS"]));
  });
});

async function fixture(withBacklog: boolean): Promise<{ repository: RepositoryRecord; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "agentflow-target-"));
  roots.push(root);
  await execFileAsync("git", ["init", "--initial-branch=main", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "AgentFlow Test"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "agentflow@example.test"]);
  await mkdir(path.join(root, ".design"));
  await writeFile(path.join(root, ".design", ".keep"), "");
  await writeFile(path.join(root, ".agentflow.yaml"), `version: 1\nrepository:\n  name: target-fixture\n  base_branch: main\nbacklog:\n  path: BACKLOG.md\nworkers:\n  maximum: 1\ncontracts:\n  roots:\n    - contracts/\nvalidation:\n  task_default:\n    - git diff --check\n  integration:\n    - git diff --check\ndocker:\n  enabled: false\n  compose_file: compose.yaml\ngit:\n  remote: origin\n  push_task_branches: false\n  push_integration_branch: false\n  open_integration_pull_request: false\n`);
  if (withBacklog) await writeFile(path.join(root, "BACKLOG.md"), "# Reviewed backlog\n");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "fixture"]);
  return {
    root,
    repository: { id: "repo-target", name: "Target fixture", localPath: root, configPath: path.join(root, ".agentflow.yaml"), baseBranch: "main", remoteName: "origin", status: "ready", detectedStack: { scripts: [], frameworks: [], monorepo: false, frontendRoots: [], backendRoots: [], contractRoots: [], suggestedValidation: [] }, createdAt: "2026-09-12T20:00:00.000Z", updatedAt: "2026-09-12T20:00:00.000Z" },
  };
}
