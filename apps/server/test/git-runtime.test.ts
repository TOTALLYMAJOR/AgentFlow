import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  GitWorktreeManager,
  integrationBranchName,
  taskBranchName,
} from "../src/git/index.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map(async (root) => {
      await rm(root, { recursive: true, force: true });
      temporaryRoots.delete(root);
    }),
  );
});

describe("GitWorktreeManager", () => {
  it("creates an integration worktree and four concurrent task worktrees without changing the normal checkout", async () => {
    const fixture = await createFixture("parallel");
    const manager = await createManager(fixture, "build-001");
    const before = await checkoutSnapshot(fixture.repository);

    const integration = await manager.createIntegrationWorktree({
      baseBranch: "main",
    });
    const tasks = await Promise.all(
      ["BL-101", "BL-102", "BL-103", "BL-104"].map(async (taskId) =>
        manager.createTaskWorktree({
          taskId,
          integrationCommit: integration.headCommit,
        }),
      ),
    );

    expect(integration).toMatchObject({
      branchName: "agent-integration/build-001",
      clean: true,
      reconciled: false,
    });
    expect(tasks.map((task) => task.branchName)).toEqual([
      "agent/build-001/BL-101",
      "agent/build-001/BL-102",
      "agent/build-001/BL-103",
      "agent/build-001/BL-104",
    ]);
    expect(new Set(tasks.map((task) => task.path)).size).toBe(4);

    const worktrees = await manager.listWorktrees();
    expect(worktrees).toHaveLength(6);
    expect(worktrees.map((worktree) => worktree.branchName)).toEqual(
      expect.arrayContaining([
        "main",
        integration.branchName,
        ...tasks.map((task) => task.branchName),
      ]),
    );
    expect(await checkoutSnapshot(fixture.repository)).toEqual(before);
    expect(manager.commandHistory().length).toBeGreaterThan(20);
    expect(
      manager
        .commandHistory()
        .every(
          (record) =>
            Number.isInteger(record.exitCode) &&
            Array.isArray(record.arguments),
        ),
    ).toBe(true);
  });

  it("reconciles only an exact existing path and branch pairing", async () => {
    const fixture = await createFixture("reconcile");
    const manager = await createManager(fixture, "build-reconcile");
    const integration = await manager.createIntegrationWorktree({
      baseBranch: "main",
    });
    const task = await manager.createTaskWorktree({
      taskId: "BL-200",
      integrationCommit: integration.headCommit,
    });
    await writeFile(path.join(task.path, "in-progress.txt"), "preserve me\n");

    const restarted = await createManager(fixture, "build-reconcile");
    const reused = await restarted.createTaskWorktree({
      taskId: "BL-200",
      integrationCommit: integration.headCommit,
    });
    const reconciliation = await restarted.reconcileBuild(
      [{ taskId: "BL-200", baseCommit: integration.headCommit }],
      integration.baseCommit,
    );

    expect(reused).toMatchObject({
      reconciled: true,
      clean: false,
      path: task.path,
    });
    expect(await readFile(path.join(task.path, "in-progress.txt"), "utf8")).toBe(
      "preserve me\n",
    );
    expect(reconciliation.integration).toMatchObject({
      state: "ready",
      safeToReuse: true,
    });
    expect(reconciliation.tasks[0]).toMatchObject({
      state: "dirty",
      safeToReuse: true,
    });
    expect(reconciliation.requiresHumanReview).toBe(false);
  });

  it("fails closed on an existing namespaced branch and never overwrites it", async () => {
    const fixture = await createFixture("branch-collision");
    const manager = await createManager(fixture, "build-collision");
    const branch = integrationBranchName("build-collision");
    await git(fixture.repository, ["branch", branch, "HEAD"]);
    const before = await gitOutput(fixture.repository, [
      "rev-parse",
      `refs/heads/${branch}`,
    ]);

    await expect(
      manager.createIntegrationWorktree({ baseBranch: "main" }),
    ).rejects.toMatchObject({
      code: "GIT_BRANCH_COLLISION",
    });

    expect(
      await gitOutput(fixture.repository, [
        "rev-parse",
        `refs/heads/${branch}`,
      ]),
    ).toBe(before);
    expect(await pathExists(manager.integrationPath())).toBe(false);
  });

  it("requires a clean normal checkout and rejects runtime paths inside the repository", async () => {
    const fixture = await createFixture("preflight");
    const manager = await createManager(fixture, "build-dirty");
    await writeFile(path.join(fixture.repository, "untracked.txt"), "dirty\n");

    await expect(
      manager.createIntegrationWorktree({ baseBranch: "main" }),
    ).rejects.toMatchObject({
      code: "GIT_REPOSITORY_NOT_CLEAN",
    });
    expect(
      await branchExists(
        fixture.repository,
        integrationBranchName("build-dirty"),
      ),
    ).toBe(false);

    await expect(
      GitWorktreeManager.create({
        repositoryRoot: fixture.repository,
        worktreesRoot: path.join(fixture.repository, ".agentflow-worktrees"),
        repositoryId: "repository-1",
        buildId: "build-overlap",
      }),
    ).rejects.toMatchObject({
      code: "GIT_PATH_OVERLAP",
    });
  });

  it("refuses dirty cleanup unless forced and always preserves the task branch", async () => {
    const fixture = await createFixture("cleanup");
    const manager = await createManager(fixture, "build-cleanup");
    const integration = await manager.createIntegrationWorktree({
      baseBranch: "main",
    });
    const task = await manager.createTaskWorktree({
      taskId: "BL-300",
      integrationCommit: integration.headCommit,
    });
    await writeFile(path.join(task.path, "dirty.txt"), "inspection evidence\n");

    await expect(
      manager.removeTaskWorktree("BL-300"),
    ).rejects.toMatchObject({
      code: "GIT_WORKTREE_DIRTY",
    });
    expect(await readFile(path.join(task.path, "dirty.txt"), "utf8")).toBe(
      "inspection evidence\n",
    );

    const removal = await manager.removeTaskWorktree("BL-300", true);
    expect(removal).toEqual({
      path: task.path,
      branchName: task.branchName,
      removed: true,
      branchPreserved: true,
    });
    expect(await pathExists(task.path)).toBe(false);
    expect(await branchExists(fixture.repository, task.branchName)).toBe(true);
  });

  it("inspects committed renames plus tracked and untracked changes relative to the task base", async () => {
    const fixture = await createFixture("changes", {
      "owned/old.txt": "old\n",
      "outside/tracked.txt": "base\n",
    });
    const manager = await createManager(fixture, "build-changes");
    const integration = await manager.createIntegrationWorktree({
      baseBranch: "main",
    });
    const task = await manager.createTaskWorktree({
      taskId: "BL-400",
      integrationCommit: integration.headCommit,
    });

    await git(task.path, ["mv", "owned/old.txt", "owned/new.txt"]);
    await git(task.path, ["add", "owned/new.txt"]);
    await git(task.path, ["commit", "-m", "rename owned file"]);
    await writeFile(
      path.join(task.path, "outside", "tracked.txt"),
      "changed outside\n",
    );
    await writeFile(path.join(task.path, "untracked.txt"), "new\n");

    const inspection = await manager.inspectChanges(
      "BL-400",
      integration.headCommit,
    );
    expect(inspection).toMatchObject({
      branchName: taskBranchName("build-changes", "BL-400"),
      commitCount: 1,
      clean: false,
      resultCommit: inspection.headCommit,
    });
    expect(inspection.changedFiles).toEqual([
      "outside/tracked.txt",
      "owned/new.txt",
      "owned/old.txt",
      "untracked.txt",
    ]);
  });

  it("does not prune stale user worktree metadata outside AgentFlow's runtime", async () => {
    const fixture = await createFixture("prune");
    const manager = await createManager(fixture, "build-prune");
    const externalWorktree = path.join(fixture.root, "user-worktree");
    await git(fixture.repository, [
      "worktree",
      "add",
      "-b",
      "user/keep",
      externalWorktree,
      "HEAD",
    ]);
    await rm(externalWorktree, { recursive: true });

    const preview = await manager.pruneManagedMetadata(false);
    expect(preview.executed).toBe(false);
    expect(preview.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchName: "user/keep",
          prunable: true,
        }),
      ]),
    );
    await expect(manager.pruneManagedMetadata(true)).rejects.toMatchObject({
      code: "GIT_UNSAFE_PRUNE",
    });
    expect(
      (await manager.listWorktrees()).some(
        (worktree) => worktree.branchName === "user/keep",
      ),
    ).toBe(true);
  });

  it("rejects traversal-like identifiers before invoking branch or path mutations", async () => {
    const fixture = await createFixture("identifiers");

    await expect(
      GitWorktreeManager.create({
        repositoryRoot: fixture.repository,
        worktreesRoot: fixture.worktrees,
        repositoryId: "../escape",
        buildId: "build-1",
      }),
    ).rejects.toMatchObject({
      code: "GIT_INVALID_IDENTIFIER",
    });
  });
});

interface Fixture {
  root: string;
  repository: string;
  worktrees: string;
}

async function createFixture(
  label: string,
  files: Readonly<Record<string, string>> = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `agentflow-git-${label}-`));
  temporaryRoots.add(root);
  const repository = path.join(root, "repository");
  const worktrees = path.join(root, "runtime", "worktrees");
  await mkdir(repository, { recursive: true });
  await git(root, ["init", "--initial-branch=main", repository]);
  await git(repository, ["config", "user.name", "AgentFlow Test"]);
  await git(repository, ["config", "user.email", "agentflow@example.test"]);
  await writeFile(path.join(repository, "README.md"), "# fixture\n");
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(repository, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial fixture"]);
  return { root, repository, worktrees };
}

async function createManager(
  fixture: Fixture,
  buildId: string,
): Promise<GitWorktreeManager> {
  return GitWorktreeManager.create({
    repositoryRoot: fixture.repository,
    worktreesRoot: fixture.worktrees,
    repositoryId: "repository-1",
    buildId,
  });
}

async function checkoutSnapshot(repository: string): Promise<{
  branch: string;
  head: string;
  status: string;
}> {
  const [branch, head, status] = await Promise.all([
    gitOutput(repository, ["branch", "--show-current"]),
    gitOutput(repository, ["rev-parse", "HEAD"]),
    gitOutput(repository, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
  ]);
  return { branch, head, status };
}

async function git(cwd: string, arguments_: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
  });
}

async function gitOutput(
  cwd: string,
  arguments_: string[],
): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function branchExists(
  repository: string,
  branch: string,
): Promise<boolean> {
  try {
    await git(repository, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await readFile(candidate);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EISDIR"
    ) {
      return true;
    }
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
