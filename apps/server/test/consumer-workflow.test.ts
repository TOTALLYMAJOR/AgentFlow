import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as repositoryGit from "../src/repositories/git.js";

import {
  MemoryRepositoryPersistence,
  repositoryConfigPath,
  RepositoryService,
  REVIEWED_BACKLOG_COMMIT_MESSAGE,
} from "../src/repositories/index.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...temporaryRoots].map(async (root) => {
      temporaryRoots.delete(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("guided consumer repository workflow", () => {
  it("preflights an unconfigured repository without writing to it", async () => {
    const repository = await createRepository("read-only-preflight");
    const service = new RepositoryService(
      new MemoryRepositoryPersistence(),
    );
    const before = await snapshot(repository);

    const preflight = await service.preflight(repository);

    expect(preflight).toMatchObject({
      canConnect: false,
      requiresInitialization: true,
      proposedChanges: [".agentflow.yaml"],
      checks: {
        gitRepository: true,
        configPresent: false,
      },
    });
    expect(await snapshot(repository)).toEqual(before);
    await expect(access(repositoryConfigPath(repository))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires explicit initialization, then connects without rewriting configuration", async () => {
    const repository = await createRepository("explicit-initialization");
    const service = new RepositoryService(
      new MemoryRepositoryPersistence(),
    );

    await expect(service.register(repository)).rejects.toMatchObject({
      code: "REPOSITORY_CONFIG_MISSING",
    });
    await expect(access(repositoryConfigPath(repository))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const initialized = await service.initialize(repository);
    const source = await readFile(initialized.configPath, "utf8");
    const modifiedAt = (await stat(initialized.configPath)).mtimeMs;
    const connected = await service.register(repository);

    expect(initialized.created).toBe(true);
    expect(connected.localPath).toBe(repository);
    expect(await readFile(initialized.configPath, "utf8")).toBe(source);
    expect((await stat(initialized.configPath)).mtimeMs).toBe(modifiedAt);
  });

  it("reviews first-run configuration read-only while no backlog exists", async () => {
    const repository = await createRepository("read-only-configuration-review");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    const configPath = repositoryConfigPath(repository);
    const configurationContents = await readFile(configPath, "utf8");
    const connected = await service.register(repository);
    const before = await snapshot(repository);
    const index = await readFile(path.join(repository, ".git/index"));
    await expect(access(path.join(repository, "BACKLOG.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const review = await service.reviewConfiguration(connected.id);

    expect(review).toMatchObject({
      repositoryId: connected.id,
      configurationPath: ".agentflow.yaml",
      configurationContents,
      configurationSha256: sha256(configurationContents),
      valid: true,
    });
    expect(review.nextAction.trim().length).toBeGreaterThan(0);
    expect(await readFile(configPath, "utf8")).toBe(configurationContents);
    expect(await readFile(path.join(repository, ".git/index"))).toEqual(index);
    expect(await snapshot(repository)).toEqual(before);
    await expect(access(path.join(repository, "BACKLOG.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("commits only the reviewed first-run configuration without creating a backlog", async () => {
    const repository = await createRepository("configuration-only-bootstrap");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    const connected = await service.register(repository);
    const review = await service.reviewConfiguration(connected.id);

    const result = await service.commitReviewedConfiguration(connected.id, {
      expectedConfigurationSha256: review.configurationSha256,
    });

    expect(result.committedPaths).toEqual([".agentflow.yaml"]);
    expect(result.requiresWorktreeReview).toBe(false);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(result.commitSha);
    expect(await git(repository, ["show", "--format=", "--name-only", result.commitSha])).toBe(".agentflow.yaml");
    expect(await git(repository, ["show", `${result.commitSha}:.agentflow.yaml`])).toBe(review.configurationContents.trim());
    expect(await readFile(repositoryConfigPath(repository), "utf8")).toBe(review.configurationContents);
    expect(await git(repository, ["status", "--porcelain=v1"])).toBe("");
    await expect(access(path.join(repository, "BACKLOG.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a stale configuration-only review without changing updated source or its staged snapshot", async () => {
    const repository = await createRepository("stale-configuration-only-review");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    const connected = await service.register(repository);
    const review = await service.reviewConfiguration(connected.id);
    const configPath = repositoryConfigPath(repository);
    const configurationContents = review.configurationContents + "\n# This update still needs review.\n";
    await writeFile(configPath, configurationContents);
    await git(repository, ["add", ".agentflow.yaml"]);
    const before = await snapshot(repository);
    const index = await readFile(path.join(repository, ".git/index"));
    const stagedConfiguration = await git(repository, ["show", ":.agentflow.yaml"]);

    await expect(service.commitReviewedConfiguration(connected.id, {
      expectedConfigurationSha256: review.configurationSha256,
    })).rejects.toMatchObject({
      code: "REVIEWED_CONFIGURATION_CHANGED",
      statusCode: 409,
    });

    expect(await readFile(configPath, "utf8")).toBe(configurationContents);
    expect(await readFile(path.join(repository, ".git/index"))).toEqual(index);
    expect(await git(repository, ["show", ":.agentflow.yaml"])).toBe(stagedConfiguration);
    expect(await snapshot(repository)).toEqual(before);
    await expect(access(path.join(repository, "BACKLOG.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["BACKLOG.md", "README.md"])(
    "refuses a configuration-only commit when unrelated %s changes are present", async (filename) => {
      const repository = await createRepository("configuration-only-unrelated-changes");
      const service = new RepositoryService(new MemoryRepositoryPersistence());
      await service.initialize(repository);
      const connected = await service.register(repository);
      const review = await service.reviewConfiguration(connected.id);
      await git(repository, ["add", ".agentflow.yaml"]);
      const unrelatedContents = "# Existing unreviewed work\n";
      const unrelatedPath = path.join(repository, filename);
      await writeFile(unrelatedPath, unrelatedContents);
      const before = await snapshot(repository);
      const index = await readFile(path.join(repository, ".git/index"));
      const stagedConfiguration = await git(repository, ["show", ":.agentflow.yaml"]);

      await expect(service.commitReviewedConfiguration(connected.id, {
        expectedConfigurationSha256: review.configurationSha256,
      })).rejects.toMatchObject({
        code: "REPOSITORY_HAS_UNRELATED_CHANGES",
        statusCode: 409,
        details: { unexpectedPaths: [filename] },
      });

      expect(await readFile(unrelatedPath, "utf8")).toBe(unrelatedContents);
      expect(await readFile(repositoryConfigPath(repository), "utf8")).toBe(review.configurationContents);
      expect(await readFile(path.join(repository, ".git/index"))).toEqual(index);
      expect(await git(repository, ["show", ":.agentflow.yaml"])).toBe(stagedConfiguration);
      expect(await snapshot(repository)).toEqual(before);
    },
  );

  it("reads the exact configured review files and hashes without changing source or Git state", async () => {
    const repository = await createRepository("read-only-backlog-review");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    const configPath = repositoryConfigPath(repository);
    const originalConfig = await readFile(configPath, "utf8");
    const configurationContents = originalConfig.replace("BACKLOG.md", "plans/REVIEWED.md");
    expect(configurationContents).not.toBe(originalConfig);
    await writeFile(configPath, configurationContents);
    await mkdir(path.join(repository, "plans"));
    const absoluteBacklogPath = path.join(repository, "plans/REVIEWED.md");
    const backlogContents = validBacklog() + "\n\n";
    await writeFile(absoluteBacklogPath, backlogContents);
    const connected = await service.register(repository);
    const readmeContents = "# unrelated staged work stays untouched\n";
    await writeFile(path.join(repository, "README.md"), readmeContents);
    await git(repository, ["add", "README.md"]);
    const before = await snapshot(repository);
    const index = await readFile(path.join(repository, ".git/index"));

    const review = await service.reviewBacklog(connected.id);

    expect(review).toMatchObject({
      backlogPath: "plans/REVIEWED.md",
      absoluteBacklogPath,
      backlogContents,
      configurationContents,
      backlogSha256: sha256(backlogContents),
      configurationSha256: sha256(configurationContents),
      valid: true,
      validationErrors: [],
    });
    expect(review.nextAction).toMatch(/review|commit/iu);
    expect(await readFile(configPath, "utf8")).toBe(configurationContents);
    expect(await readFile(absoluteBacklogPath, "utf8")).toBe(backlogContents);
    expect(await readFile(path.join(repository, "README.md"), "utf8")).toBe(readmeContents);
    expect(await readFile(path.join(repository, ".git/index"))).toEqual(index);
    expect(await snapshot(repository)).toEqual(before);
  });

  it("returns useful validation errors while retaining an invalid backlog for review", async () => {
    const repository = await createRepository("invalid-backlog-review");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    const backlogPath = path.join(repository, "BACKLOG.md");
    const backlogContents = "# Not a native task backlog\n";
    await writeFile(backlogPath, backlogContents);
    const connected = await service.register(repository);
    const before = await snapshot(repository);
    const index = await readFile(path.join(repository, ".git/index"));

    const review = await service.reviewBacklog(connected.id);

    expect(review.valid).toBe(false);
    expect(review.backlogContents).toBe(backlogContents);
    expect(review.backlogSha256).toBe(sha256(backlogContents));
    expect(review.validationErrors.length).toBeGreaterThan(0);
    expect(JSON.stringify(review.validationErrors)).toMatch(/backlog|task|estimate|acceptance|format|parse/iu);
    expect(review.nextAction.trim().length).toBeGreaterThan(0);
    expect(await readFile(backlogPath, "utf8")).toBe(backlogContents);
    expect(await readFile(path.join(repository, ".git/index"))).toEqual(index);
    expect(await snapshot(repository)).toEqual(before);
  });

  it.each(["BACKLOG.md", ".agentflow.yaml"])(
    "refuses a stale review digest for %s without losing updated source or staging", async (filename) => {
      const repository = await createRepository("stale-review-digest");
      const service = new RepositoryService(new MemoryRepositoryPersistence());
      await service.initialize(repository);
      await writeFile(path.join(repository, "BACKLOG.md"), validBacklog());
      const connected = await service.register(repository);
      const review = await service.reviewBacklog(connected.id);
      const changedPath = path.join(repository, filename);
      const originalContents = await readFile(changedPath, "utf8");
      const changedContents = filename === "BACKLOG.md"
        ? originalContents.replace("Implement the reviewed outcome.", "Implement the revised reviewed outcome.")
        : originalContents + "\n# Later configuration review is required.\n";
      expect(changedContents).not.toBe(originalContents);
      await writeFile(changedPath, changedContents);
      await git(repository, ["add", ".agentflow.yaml", "BACKLOG.md"]);
      const before = await snapshot(repository);
      const index = await readFile(path.join(repository, ".git/index"));
      const stagedConfiguration = await git(repository, ["show", ":.agentflow.yaml"]);
      const stagedBacklog = await git(repository, ["show", ":BACKLOG.md"]);

      await expect(service.commitReviewedBacklog(connected.id, {
        expectedBacklogPath: review.backlogPath,
        expectedBacklogSha256: review.backlogSha256,
        expectedConfigurationSha256: review.configurationSha256,
      })).rejects.toMatchObject({
        code: "REVIEWED_BACKLOG_CHANGED",
        statusCode: 409,
      });

      expect(await readFile(changedPath, "utf8")).toBe(changedContents);
      expect(await readFile(path.join(repository, ".git/index"))).toEqual(index);
      expect(await git(repository, ["show", ":.agentflow.yaml"])).toBe(stagedConfiguration);
      expect(await git(repository, ["show", ":BACKLOG.md"])).toBe(stagedBacklog);
      expect(await snapshot(repository)).toEqual(before);
    },
  );

  it("refuses a different expected configured backlog path without changing staging", async () => {
    const repository = await createRepository("wrong-reviewed-path");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    const backlogContents = validBacklog();
    await writeFile(path.join(repository, "BACKLOG.md"), backlogContents);
    const connected = await service.register(repository);
    const review = await service.reviewBacklog(connected.id);
    await git(repository, ["add", ".agentflow.yaml", "BACKLOG.md"]);
    const before = await snapshot(repository);
    const index = await readFile(path.join(repository, ".git/index"));

    await expect(service.commitReviewedBacklog(connected.id, {
      expectedBacklogPath: "OTHER.md",
      expectedBacklogSha256: review.backlogSha256,
      expectedConfigurationSha256: review.configurationSha256,
    })).rejects.toMatchObject({
      code: "REVIEWED_BACKLOG_CHANGED",
      statusCode: 409,
    });

    expect(await readFile(path.join(repository, "BACKLOG.md"), "utf8")).toBe(backlogContents);
    expect(await readFile(repositoryConfigPath(repository), "utf8")).toBe(review.configurationContents);
    expect(await readFile(path.join(repository, ".git/index"))).toEqual(index);
    expect(await snapshot(repository)).toEqual(before);
  });

  it("commits when the expected review path and both exact-source digests still match", async () => {
    const repository = await createRepository("matching-reviewed-source");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    await writeFile(path.join(repository, "BACKLOG.md"), validBacklog());
    const connected = await service.register(repository);
    const review = await service.reviewBacklog(connected.id);

    const result = await service.commitReviewedBacklog(connected.id, {
      expectedBacklogPath: review.backlogPath,
      expectedBacklogSha256: review.backlogSha256,
      expectedConfigurationSha256: review.configurationSha256,
    });

    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(result.commitSha);
    expect(result.committedPaths).toEqual([".agentflow.yaml", "BACKLOG.md"]);
    expect(await git(repository, ["show", `${result.commitSha}:BACKLOG.md`])).toBe(review.backlogContents.trim());
    expect(await git(repository, ["show", `${result.commitSha}:.agentflow.yaml`])).toBe(review.configurationContents.trim());
    expect(await git(repository, ["status", "--porcelain=v1"])).toBe("");
  });

  it("validates and commits only the reviewed configuration and backlog", async () => {
    const repository = await createRepository("safe-reviewed-commit");
    const service = new RepositoryService(
      new MemoryRepositoryPersistence(),
    );
    await service.initialize(repository);
    await writeFile(path.join(repository, "BACKLOG.md"), validBacklog());
    const connected = await service.register(repository);

    const result = await service.commitReviewedBacklog(connected.id);

    expect(result).toMatchObject({
      repositoryId: connected.id,
      commitMessage: REVIEWED_BACKLOG_COMMIT_MESSAGE,
      committedPaths: [".agentflow.yaml", "BACKLOG.md"],
      backlogPath: "BACKLOG.md",
    });
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(
      result.commitSha,
    );
    expect(await git(repository, ["show", "-s", "--format=%s", "HEAD"])).toBe(
      REVIEWED_BACKLOG_COMMIT_MESSAGE,
    );
    expect(await git(repository, ["status", "--porcelain=v1"])).toBe("");
    expect(result.nextAction).not.toMatch(
      /publish|deploy|provider|push/iu,
    );
  });

  it("refuses an invalid backlog before changing Git state", async () => {
    const repository = await createRepository("invalid-backlog");
    const service = new RepositoryService(
      new MemoryRepositoryPersistence(),
    );
    await service.initialize(repository);
    await writeFile(path.join(repository, "BACKLOG.md"), "# Not a backlog\n");
    const connected = await service.register(repository);
    const before = await snapshot(repository);

    await expect(
      service.commitReviewedBacklog(connected.id),
    ).rejects.toMatchObject({
      code: "BACKLOG_INVALID",
      statusCode: 422,
    });
    expect(await snapshot(repository)).toEqual(before);
  });

  it.each([
    {
      name: "tracked",
      prepare: async (repository: string) => {
        await writeFile(path.join(repository, "README.md"), "# changed\n");
      },
      expectedPath: "README.md",
    },
    {
      name: "untracked",
      prepare: async (repository: string) => {
        await writeFile(path.join(repository, "notes.txt"), "unrelated\n");
      },
      expectedPath: "notes.txt",
    },
    {
      name: "staged",
      prepare: async (repository: string) => {
        await writeFile(path.join(repository, "README.md"), "# staged\n");
        await git(repository, ["add", "README.md"]);
      },
      expectedPath: "README.md",
    },
  ])(
    "refuses unrelated $name changes without altering them",
    async ({ prepare, expectedPath }) => {
      const repository = await createRepository(`unrelated-${expectedPath}`);
      const service = new RepositoryService(
        new MemoryRepositoryPersistence(),
      );
      await service.initialize(repository);
      await writeFile(path.join(repository, "BACKLOG.md"), validBacklog());
      const connected = await service.register(repository);
      await prepare(repository);
      const before = await snapshot(repository);

      const attempt = service.commitReviewedBacklog(connected.id);
      await expect(attempt).rejects.toMatchObject({
        code: "REPOSITORY_HAS_UNRELATED_CHANGES",
        statusCode: 409,
        details: {
          unexpectedPaths: [expectedPath],
        },
      });
      await expect(attempt).rejects.toHaveProperty(
        "details.nextAction", expect.stringMatching(/commit or stash/iu),
      );
      expect(await snapshot(repository)).toEqual(before);
    },
  );

  it("refuses partial staging without losing its reviewed index snapshot", async () => {
    const repository = await createRepository("partial-staging");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    await writeFile(path.join(repository, "BACKLOG.md"), validBacklog());
    await git(repository, ["add", "BACKLOG.md"]);
    await writeFile(path.join(repository, "BACKLOG.md"), validBacklog() + "\nLater edit\n");
    const connected = await service.register(repository);
    await failingCommitHook(repository);
    const staged = await git(repository, ["show", ":BACKLOG.md"]);
    const before = await snapshot(repository);

    await expect(service.commitReviewedBacklog(connected.id)).rejects.toMatchObject({
      code: "REVIEWED_BACKLOG_PARTIAL_STAGING", statusCode: 409,
    });

    expect(await git(repository, ["show", ":BACKLOG.md"])).toBe(staged);
    expect(await snapshot(repository)).toEqual(before);
  });

  it("preserves fully staged files when a repository commit hook refuses", async () => {
    const repository = await createRepository("hook-refusal");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    await writeFile(path.join(repository, "BACKLOG.md"), validBacklog());
    await git(repository, ["add", ".agentflow.yaml", "BACKLOG.md"]);
    const connected = await service.register(repository);
    await failingCommitHook(repository);
    const staged = await git(repository, ["write-tree"]);
    const before = await snapshot(repository);

    await expect(service.commitReviewedBacklog(connected.id)).rejects.toMatchObject({
      code: "REVIEWED_BACKLOG_COMMIT_FAILED",
    });

    expect(await git(repository, ["write-tree"])).toBe(staged);
    expect(await snapshot(repository)).toEqual(before);
  });

  it("refuses a backlog symlink rather than committing an unvalidated link", async () => {
    const repository = await createRepository("symlink-backlog");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    await writeFile(path.join(repository, "reviewed.md"), validBacklog());
    await git(repository, ["add", ".agentflow.yaml", "reviewed.md"]);
    await git(repository, ["commit", "-m", "prepare reviewed source"]);
    await symlink("reviewed.md", path.join(repository, "BACKLOG.md"));
    const connected = await service.register(repository);
    const before = await snapshot(repository);

    await expect(service.commitReviewedBacklog(connected.id)).rejects.toMatchObject({
      code: "BACKLOG_PATH_INVALID",
    });
    expect(await snapshot(repository)).toEqual(before);
  });

  it("refuses a symlinked backlog parent without changing source or Git state", async () => {
    const repository = await createRepository("symlink-backlog-parent");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    const configPath = repositoryConfigPath(repository);
    const originalConfig = await readFile(configPath, "utf8");
    const config = originalConfig.replace("BACKLOG.md", "plans/BACKLOG.md");
    expect(config).not.toBe(originalConfig);
    await writeFile(configPath, config);
    await mkdir(path.join(repository, "reviewed-plans"));
    const backlogPath = path.join(repository, "reviewed-plans/BACKLOG.md");
    const backlog = validBacklog();
    await writeFile(backlogPath, backlog);
    await git(repository, ["add", ".agentflow.yaml", "reviewed-plans/BACKLOG.md"]);
    await git(repository, ["commit", "-m", "prepare reviewed source"]);
    const parentPath = path.join(repository, "plans");
    await symlink("reviewed-plans", parentPath);
    const connected = await service.register(repository);
    const before = await snapshot(repository);
    const index = await readFile(path.join(repository, ".git/index"));

    await expect(service.commitReviewedBacklog(connected.id)).rejects.toMatchObject({
      code: "BACKLOG_PATH_INVALID",
    });

    expect(await readFile(configPath, "utf8")).toBe(config);
    expect(await readFile(backlogPath, "utf8")).toBe(backlog);
    expect(await readlink(parentPath)).toBe("reviewed-plans");
    expect(await readFile(path.join(repository, ".git/index"))).toEqual(index);
    expect(await snapshot(repository)).toEqual(before);
  });

  it("preserves a preexisting index lock and refuses the reviewed commit", async () => {
    const repository = await createRepository("preexisting-index-lock");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    const configPath = repositoryConfigPath(repository);
    const config = await readFile(configPath, "utf8");
    const backlogPath = path.join(repository, "BACKLOG.md");
    const backlog = validBacklog();
    await writeFile(backlogPath, backlog);
    const connected = await service.register(repository);
    const before = await snapshot(repository);
    const index = await readFile(path.join(repository, ".git/index"));
    const lockPath = path.join(repository, ".git/index.lock");
    const lock = "existing Git operation owns this lock\n";
    await writeFile(lockPath, lock, { flag: "wx" });

    await expect(service.commitReviewedBacklog(connected.id)).rejects.toMatchObject({
      code: "REPOSITORY_GIT_BUSY",
      statusCode: 409,
    });

    expect(await readFile(lockPath, "utf8")).toBe(lock);
    expect(await readFile(configPath, "utf8")).toBe(config);
    expect(await readFile(backlogPath, "utf8")).toBe(backlog);
    expect(await readFile(path.join(repository, ".git/index"))).toEqual(index);
    expect(await snapshot(repository)).toEqual(before);
  });

  it("runs the configured native pre-commit hook for a successful reviewed commit", async () => {
    const repository = await createRepository("configured-commit-hook");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    await writeFile(path.join(repository, "BACKLOG.md"), validBacklog());
    const connected = await service.register(repository);
    const hooksPath = path.join(repository, ".git/reviewed hooks");
    await mkdir(hooksPath);
    await git(repository, ["config", "core.hooksPath", hooksPath]);
    const hookPath = path.join(hooksPath, "pre-commit");
    await writeFile(
      hookPath,
      "#!/bin/sh\nprintf '%s\\n' ran > .git/reviewed-hook-ran\n",
    );
    await chmod(hookPath, 0o700);

    const result = await service.commitReviewedBacklog(connected.id);

    expect(await readFile(path.join(repository, ".git/reviewed-hook-ran"), "utf8")).toBe("ran\n");
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(result.commitSha);
    expect(await git(repository, ["status", "--porcelain=v1"])).toBe("");
  });

  it("preserves an unrelated file's assume-unchanged index flag after success", async () => {
    const repository = await createRepository("assume-unchanged-index-flag");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    await writeFile(path.join(repository, "BACKLOG.md"), validBacklog());
    await git(repository, ["update-index", "--assume-unchanged", "README.md"]);
    const before = await git(repository, ["ls-files", "-v", "--", "README.md"]);
    expect(before).toBe("h README.md");
    const connected = await service.register(repository);

    const result = await service.commitReviewedBacklog(connected.id);

    expect(await git(repository, ["ls-files", "-v", "--", "README.md"])).toBe(before);
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(result.commitSha);
    expect(await git(repository, ["status", "--porcelain=v1"])).toBe("");
  });

  it("reports the durable commit for review when a native hook adds a committed file", async () => {
    const repository = await createRepository("hook-expanded-commit");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    const config = await readFile(repositoryConfigPath(repository), "utf8");
    const backlog = validBacklog();
    await writeFile(path.join(repository, "BACKLOG.md"), backlog);
    const connected = await service.register(repository);
    const beforeHead = await git(repository, ["rev-parse", "HEAD"]);
    const hookPath = path.join(repository, ".git/hooks/pre-commit");
    await writeFile(
      hookPath,
      "#!/bin/sh\nset -eu\nprintf '%s\\n' 'native hook addition' > hook-owned.txt\ngit add -- hook-owned.txt\n",
    );
    await chmod(hookPath, 0o700);

    const attempt = service.commitReviewedBacklog(connected.id);
    await expect(attempt).rejects.toMatchObject({
      code: "REVIEWED_BACKLOG_COMMIT_REQUIRES_REVIEW",
      statusCode: 409,
    });

    const commitSha = await git(repository, ["rev-parse", "HEAD"]);
    expect(commitSha).not.toBe(beforeHead);
    await expect(attempt).rejects.toHaveProperty("details.commitSha", commitSha);
    expect(await git(repository, ["show", `${commitSha}:hook-owned.txt`])).toBe("native hook addition");
    expect(await git(repository, ["show", `${commitSha}:.agentflow.yaml`])).toBe(config.trim());
    expect(await git(repository, ["show", `${commitSha}:BACKLOG.md`])).toBe(backlog.trim());
    expect(await readFile(repositoryConfigPath(repository), "utf8")).toBe(config);
    expect(await readFile(path.join(repository, "BACKLOG.md"), "utf8")).toBe(backlog);
    expect(await readFile(path.join(repository, "hook-owned.txt"), "utf8")).toBe("native hook addition\n");
  });

  it("preserves a foreign index lock and reports the durable commit after publication ownership is lost", async () => {
    const repository = await createRepository("lost-index-lock-ownership");
    const service = new RepositoryService(new MemoryRepositoryPersistence());
    await service.initialize(repository);
    const config = await readFile(repositoryConfigPath(repository), "utf8");
    const backlog = validBacklog();
    await writeFile(path.join(repository, "BACKLOG.md"), backlog);
    const connected = await service.register(repository);
    const beforeHead = await git(repository, ["rev-parse", "HEAD"]);
    const indexPath = path.join(repository, ".git/index");
    const beforeIndex = await readFile(indexPath);
    const hookPath = path.join(repository, ".git/hooks/pre-commit");
    await writeFile(
      hookPath,
      "#!/bin/sh\nset -eu\nmv .git/index.lock .git/retained-owned-lock\nprintf '%s\\n' 'foreign lock sentinel' > .git/index.lock\n",
    );
    await chmod(hookPath, 0o700);

    const attempt = service.commitReviewedBacklog(connected.id);
    await expect(attempt).rejects.toMatchObject({
      code: "REVIEWED_BACKLOG_COMMIT_FAILED",
      statusCode: 409,
    });

    const commitSha = await git(repository, ["rev-parse", "HEAD"]);
    expect(commitSha).not.toBe(beforeHead);
    await expect(attempt).rejects.toHaveProperty("details.commitSha", commitSha);
    expect(await readFile(path.join(repository, ".git/index.lock"), "utf8")).toBe("foreign lock sentinel\n");
    await expect(access(path.join(repository, ".git/retained-owned-lock"))).resolves.toBeUndefined();
    expect(await readFile(indexPath)).toEqual(beforeIndex);
    expect(await git(repository, ["show", `${commitSha}:.agentflow.yaml`])).toBe(config.trim());
    expect(await git(repository, ["show", `${commitSha}:BACKLOG.md`])).toBe(backlog.trim());
    expect(await readFile(repositoryConfigPath(repository), "utf8")).toBe(config);
    expect(await readFile(path.join(repository, "BACKLOG.md"), "utf8")).toBe(backlog);
  });

  it.each(["BACKLOG.md", ".agentflow.yaml"])(
    "commits the validated snapshot while preserving a concurrent edit to %s", async (filename) => {
      const repository = await createRepository("concurrent-edit");
      const service = new RepositoryService(new MemoryRepositoryPersistence());
      await service.initialize(repository);
      await writeFile(path.join(repository, "BACKLOG.md"), validBacklog());
      const connected = await service.register(repository);
      const reviewed = await readFile(path.join(repository, filename), "utf8");
      const later = "not a valid reviewed configuration or backlog\n";
      const original = repositoryGit.runGit;
      let edited = false;
      vi.spyOn(repositoryGit, "runGit").mockImplementation(async (...args) => {
        if (!edited && args[0] === repository && args[1][0] === "commit") {
          edited = true;
          await writeFile(path.join(repository, filename), later);
        }
        return original(...args);
      });

      const result = await service.commitReviewedBacklog(connected.id);

      expect(edited).toBe(true);
      expect(await git(repository, ["show", `${result.commitSha}:${filename}`])).toBe(reviewed.trim());
      expect(await readFile(path.join(repository, filename), "utf8")).toBe(later);
    },
  );
});

async function failingCommitHook(repository: string): Promise<void> {
  const hook = path.join(repository, ".git/hooks/pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n");
  await chmod(hook, 0o700);
}

async function createRepository(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `agentflow-${name}-`));
  temporaryRoots.add(root);
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "AgentFlow Test"]);
  await git(
    repository,
    ["config", "user.email", "agentflow@example.invalid"],
  );
  await writeFile(path.join(repository, "README.md"), `# ${name}\n`);
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "test fixture"]);
  return repository;
}

async function snapshot(repository: string): Promise<{
  head: string;
  status: string;
  files: string[];
}> {
  return {
    head: await git(repository, ["rev-parse", "HEAD"]),
    status: await git(repository, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    files: (
      await git(repository, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
      ])
    )
      .split("\n")
      .filter(Boolean)
      .sort(),
  };
}

async function git(
  repository: string,
  arguments_: string[],
): Promise<string> {
  const result = await execFileAsync(
    "git",
    ["-C", repository, ...arguments_],
    { encoding: "utf8" },
  );
  return result.stdout.trim();
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function validBacklog(): string {
  return [
    "# Reviewed backlog",
    "",
    "## TEST-001 - Deliver the reviewed outcome",
    "",
    "```yaml",
    "estimate_hours: 1",
    "depends_on: []",
    "owns:",
    "  - src/",
    "validate:",
    "  - git diff --check",
    "```",
    "",
    "Implement the reviewed outcome.",
    "",
    "### Acceptance Criteria",
    "",
    "- The reviewed outcome is complete.",
    "",
  ].join("\n");
}
