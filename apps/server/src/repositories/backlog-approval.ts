import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { planBacklogMarkdown } from "../planning/index.js";

import type { AgentFlowRepositoryConfig } from "./config.js";
import { loadRepositoryConfig, parseRepositoryConfigSource, readRepositoryInputFile, REPOSITORY_CONFIG_FILENAME } from "./config.js";
import { RepositoryServiceError } from "./errors.js";
import { runGit } from "./git.js";
import type { ReviewedBacklogExpectations, ReviewedBacklogSnapshot, ReviewedConfigurationSnapshot } from "./types.js";

export const REVIEWED_BACKLOG_COMMIT_MESSAGE =
  "chore(agentflow): record reviewed configuration and backlog";

export const REVIEWED_CONFIGURATION_COMMIT_MESSAGE =
  "chore(agentflow): record reviewed repository configuration";

export interface CommitReviewedBacklogEvidence {
  commitSha: string;
  commitMessage: string;
  committedPaths: string[];
  backlogPath: string;
  requiresWorktreeReview: boolean;
}

export async function commitReviewedBacklog(
  repositoryRoot: string, config: AgentFlowRepositoryConfig, expectations: ReviewedBacklogExpectations = {},
): Promise<CommitReviewedBacklogEvidence> {
  return commitReviewedFiles(repositoryRoot, config, expectations, true);
}

export async function commitReviewedConfiguration(
  repositoryRoot: string, config: AgentFlowRepositoryConfig, expectedConfigurationSha256: string,
): Promise<CommitReviewedBacklogEvidence> {
  return commitReviewedFiles(repositoryRoot, config, { expectedConfigurationSha256 }, false);
}

async function commitReviewedFiles(
  repositoryRoot: string, config: AgentFlowRepositoryConfig, expectations: ReviewedBacklogExpectations, includeBacklog: boolean,
): Promise<CommitReviewedBacklogEvidence> {
  const captured = await captureReviewedFiles(repositoryRoot, config, includeBacklog);
  const { backlogPath, configurationBytes, backlogBytes } = captured;
  const commitPaths = includeBacklog ? [REPOSITORY_CONFIG_FILENAME, backlogPath] : [REPOSITORY_CONFIG_FILENAME];
  const allowedPaths = new Set(commitPaths);
  if ((expectations.expectedBacklogPath !== undefined && normalizeGitPath(expectations.expectedBacklogPath) !== backlogPath) ||
      (expectations.expectedConfigurationSha256 !== undefined && expectations.expectedConfigurationSha256 !== sha256(configurationBytes)) ||
      (expectations.expectedBacklogSha256 !== undefined && (backlogBytes === undefined || expectations.expectedBacklogSha256 !== sha256(backlogBytes)))) {
    throw reviewedInputChanged(includeBacklog);
  }
  if (backlogBytes !== undefined) requireValidBacklog(backlogBytes.toString("utf8"), config);
  requireCommitStatus(await readRepositoryStatus(repositoryRoot), allowedPaths);
  const commitMessage = includeBacklog ? REVIEWED_BACKLOG_COMMIT_MESSAGE : REVIEWED_CONFIGURATION_COMMIT_MESSAGE;

  const temporary = await mkdtemp(path.join(tmpdir(), "agentflow-reviewed-commit-"));
  const snapshotRoot = path.join(temporary, "reviewed-inputs");
  const privateIndex = path.join(temporary, "index");
  const environment = { GIT_INDEX_FILE: privateIndex, GIT_OPTIONAL_LOCKS: "0" };
  const frozenConfigPath = path.join(snapshotRoot, REPOSITORY_CONFIG_FILENAME);
  const frozenBacklogPath = path.join(snapshotRoot, backlogPath);
  let indexLock: FileHandle | undefined;
  let lockPath: string | undefined;
  let lockIdentity: { dev: number; ino: number } | undefined;
  let commitSha: string | undefined;
  try {
    await mkdir(snapshotRoot, { recursive: true });
    await writeFile(frozenConfigPath, configurationBytes);
    if (backlogBytes !== undefined) {
      await mkdir(path.dirname(frozenBacklogPath), { recursive: true });
      await writeFile(frozenBacklogPath, backlogBytes);
    }
    const capturedConfig = await loadRepositoryConfig(snapshotRoot);
    if (JSON.stringify(capturedConfig) !== JSON.stringify(config)) throw reviewedInputChanged(includeBacklog);
    if (backlogBytes !== undefined) requireValidBacklog(backlogBytes.toString("utf8"), capturedConfig);

    const indexName = (await runGit(repositoryRoot, ["rev-parse", "--git-path", "index"])).stdout.trim();
    const indexPath = path.resolve(repositoryRoot, indexName);
    const existingIndex = await lstat(indexPath);
    if (!existingIndex.isFile()) throw new Error("The repository index is not a regular file");
    lockPath = indexPath + ".lock";
    try {
      indexLock = await open(lockPath, "wx", existingIndex.mode & 0o777);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        throw new RepositoryServiceError("REPOSITORY_GIT_BUSY",
          "Another Git operation is in progress. Wait for it to finish, then retry.", 409);
      }
      throw error;
    }
    lockIdentity = await indexLock.stat();
    // Serialize ordinary Git writers while leaving the user's real index
    // unchanged until native commit and verification have succeeded.
    requireCommitStatus(await readRepositoryStatus(repositoryRoot), allowedPaths);
    const baseCommit = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
    await copyFile(indexPath, privateIndex);
    await runGit(repositoryRoot, ["add", "--", ...commitPaths], { environment });
    const stagedPaths = nulSeparated((await runGit(repositoryRoot,
      ["diff", "--cached", "--name-only", "-z"], { environment })).stdout).map(normalizeGitPath);
    if (!stagedPaths.length) throw new RepositoryServiceError("REVIEWED_BACKLOG_NOT_CHANGED",
      "There are no reviewed configuration or backlog changes to commit.", 409);
    if (stagedPaths.some((entry) => !allowedPaths.has(entry))) throw unrelatedChangesError(stagedPaths.filter((entry) => !allowedPaths.has(entry)));

    const frozenPaths = [[REPOSITORY_CONFIG_FILENAME, frozenConfigPath], ...(includeBacklog ? [[backlogPath, frozenBacklogPath]] : [])];
    for (const [logicalPath, frozenPath] of frozenPaths) {
      if (logicalPath === undefined || frozenPath === undefined) throw new Error("Reviewed path binding is incomplete");
      const stage = (await runGit(repositoryRoot, ["ls-files", "--stage", "-z", "--", logicalPath], { environment })).stdout;
      if (!stage.startsWith("100644 ") && !stage.startsWith("100755 ")) throw reviewedInputChanged(includeBacklog);
      const expected = (await runGit(repositoryRoot, ["hash-object", "--path", logicalPath, frozenPath])).stdout.trim();
      const actual = (await runGit(repositoryRoot, ["rev-parse", ":" + logicalPath], { environment })).stdout.trim();
      if (actual !== expected) throw reviewedInputChanged(includeBacklog);
    }
    // Reuse native parsing on the exact prospective Git blobs, including any
    // repository-declared clean-filter or line-ending transformation.
    const stagedConfiguration = (await runGit(repositoryRoot, ["show", ":" + REPOSITORY_CONFIG_FILENAME], { environment })).stdout;
    const stagedBacklog = includeBacklog ? (await runGit(repositoryRoot, ["show", ":" + backlogPath], { environment })).stdout : undefined;
    await writeFile(frozenConfigPath, stagedConfiguration);
    const stagedConfig = await loadRepositoryConfig(snapshotRoot);
    if (JSON.stringify(stagedConfig) !== JSON.stringify(config)) throw reviewedInputChanged(includeBacklog);
    if (stagedBacklog !== undefined) requireValidBacklog(stagedBacklog, stagedConfig);
    const expectedTree = (await runGit(repositoryRoot, ["write-tree"], { environment })).stdout.trim();
    if ((await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim() !== baseCommit) throw reviewedInputChanged(includeBacklog);
    const latestStatus = await readRepositoryStatus(repositoryRoot);
    const unexpected = changedPaths(latestStatus).filter((entry) => !allowedPaths.has(entry));
    if (unexpected.length) throw unrelatedChangesError(unexpected);

    // No path arguments: native Git commits the validated private index,
    // rather than rereading a concurrently edited working-tree file.
    // Existing repository hooks and native Git's ref transaction still run.
    await runGit(repositoryRoot, ["commit", "-m", commitMessage], { environment });
    commitSha = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const actualTree = (await runGit(repositoryRoot, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const parent = (await runGit(repositoryRoot, ["rev-parse", "HEAD^"])).stdout.trim();
    const committedPaths = nulSeparated((await runGit(repositoryRoot,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commitSha])).stdout).map(normalizeGitPath);

    const currentLock = await lstat(lockPath);
    if (currentLock.dev !== lockIdentity.dev || currentLock.ino !== lockIdentity.ino) {
      throw new Error("Git index lock ownership changed; retained index was not replaced");
    }
    await indexLock.writeFile(await readFile(privateIndex));
    await indexLock.sync();
    await indexLock.close();
    await rename(lockPath, indexPath);
    lockIdentity = undefined;
    if (parent !== baseCommit || actualTree !== expectedTree || committedPaths.some((entry) => !allowedPaths.has(entry))) {
      throw new RepositoryServiceError("REVIEWED_BACKLOG_COMMIT_REQUIRES_REVIEW",
        "A repository hook or concurrent reference change altered the committed snapshot. Review the retained commit before planning.",
        409, { commitSha, committedPaths });
    }
    return { commitSha, commitMessage, committedPaths, backlogPath,
      requiresWorktreeReview: (await readRepositoryStatus(repositoryRoot)).length > 0 };
  } catch (error) {
    if (error instanceof RepositoryServiceError) throw error;
    throw new RepositoryServiceError("REVIEWED_BACKLOG_COMMIT_FAILED",
      commitSha === undefined
        ? "Git could not complete the reviewed commit. Staging was retained; review the Git error, hook output and current file changes before retrying."
        : "A commit was created, but staging needs review. Inspect the saved commit and current changes before planning.",
      409, { ...(commitSha === undefined ? {} : { commitSha }), nextAction: "Review the local Git result and retained files before retrying." });
  } finally {
    await indexLock?.close().catch(() => undefined);
    if (lockPath !== undefined && lockIdentity !== undefined) {
      const current = await lstat(lockPath).catch(() => undefined);
      if (current?.dev === lockIdentity.dev && current.ino === lockIdentity.ino) await unlink(lockPath);
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function readReviewedConfiguration(
  repositoryRoot: string, config: AgentFlowRepositoryConfig,
): Promise<Omit<ReviewedConfigurationSnapshot, "repositoryId">> {
  const captured = await captureReviewedFiles(repositoryRoot, config, false);
  return { configurationPath: REPOSITORY_CONFIG_FILENAME,
    configurationContents: captured.configurationBytes.toString("utf8"),
    configurationSha256: sha256(captured.configurationBytes), valid: true,
    nextAction: "Review the exact setup file, then explicitly save it before generating a backlog." };
}

export async function readReviewedBacklog(
  repositoryRoot: string, config: AgentFlowRepositoryConfig,
): Promise<Omit<ReviewedBacklogSnapshot, "repositoryId">> {
  const captured = await captureReviewedFiles(repositoryRoot, config, true);
  if (captured.backlogBytes === undefined || captured.absoluteBacklogPath === undefined) throw new Error("Reviewed backlog input is missing");
  const backlogContents = captured.backlogBytes.toString("utf8");
  const planning = planBacklogMarkdown(backlogContents, {
    defaultValidation: config.validation.task_default, workerMaximum: config.workers.maximum,
  });
  return { backlogPath: captured.backlogPath, absoluteBacklogPath: captured.absoluteBacklogPath,
    configurationPath: REPOSITORY_CONFIG_FILENAME, configurationContents: captured.configurationBytes.toString("utf8"),
    configurationSha256: sha256(captured.configurationBytes), backlogContents,
    backlogSha256: sha256(captured.backlogBytes), valid: planning.valid,
    validationErrors: planning.errors.map((issue) => issue.message),
    nextAction: planning.valid ? "Review these exact files, then explicitly save the reviewed plan."
      : "Resolve the listed backlog issues and refresh the file review before saving." };
}

async function captureReviewedFiles(repositoryRoot: string, config: AgentFlowRepositoryConfig, includeBacklog: boolean) {
  const backlogPath = normalizeGitPath(config.backlog.path);
  const configurationPath = await resolveRepositoryFile(repositoryRoot, REPOSITORY_CONFIG_FILENAME);
  const configurationBytes = await readRepositoryInputFile(configurationPath);
  const capturedConfig = parseRepositoryConfigSource(configurationBytes.toString("utf8"), configurationPath);
  if (JSON.stringify(capturedConfig) !== JSON.stringify(config)) throw reviewedInputChanged(includeBacklog);
  const absoluteBacklogPath = includeBacklog ? await resolveRepositoryFile(repositoryRoot, backlogPath) : undefined;
  const backlogBytes = absoluteBacklogPath === undefined ? undefined : await readRepositoryInputFile(absoluteBacklogPath);
  return { backlogPath, configurationBytes, absoluteBacklogPath, backlogBytes };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireValidBacklog(markdown: string, config: AgentFlowRepositoryConfig): void {
  const planning = planBacklogMarkdown(markdown, {
    defaultValidation: config.validation.task_default, workerMaximum: config.workers.maximum,
  });
  if (!planning.valid) throw new RepositoryServiceError("BACKLOG_INVALID",
    "The reviewed backlog is not valid. Fix the listed issues, review it again, and retry.", 422,
    { errors: planning.errors, nextAction: "Fix the backlog issues, review the updated file, and retry the commit." });
}

function requireCommitStatus(status: GitStatusEntry[], allowed: Set<string>): void {
  const unexpected = changedPaths(status).filter((entry) => !allowed.has(entry));
  if (unexpected.length) throw unrelatedChangesError(unexpected);
  if (!status.length) throw new RepositoryServiceError("REVIEWED_BACKLOG_NOT_CHANGED",
    "There are no reviewed configuration or backlog changes to commit.", 409);
  if (status.some((entry) => entry.status[0] !== " " && entry.status[0] !== "?" && entry.status[1] !== " ")) {
    throw new RepositoryServiceError("REVIEWED_BACKLOG_PARTIAL_STAGING",
      "A reviewed file has different staged and unstaged versions. Review and finish staging that file, then retry.", 409);
  }
}

function reviewedInputChanged(includeBacklog: boolean): RepositoryServiceError {
  return new RepositoryServiceError(includeBacklog ? "REVIEWED_BACKLOG_CHANGED" : "REVIEWED_CONFIGURATION_CHANGED",
    includeBacklog
      ? "The reviewed inputs changed during saving. Review the current configuration and backlog, then retry."
      : "The reviewed setup changed during saving. Review the current configuration, then retry.", 409);
}

interface GitStatusEntry {
  status: string;
  paths: string[];
}

async function readRepositoryStatus(
  repositoryRoot: string,
): Promise<GitStatusEntry[]> {
  const output = (
    await runGit(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ])
  ).stdout;
  const records = nulSeparated(output);
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    const paths = [normalizeGitPath(record.slice(3))];
    if (status.includes("R") || status.includes("C")) {
      const sourcePath = records[index + 1];
      if (sourcePath !== undefined) {
        paths.push(normalizeGitPath(sourcePath));
        index += 1;
      }
    }
    entries.push({ status, paths });
  }
  return entries;
}

function changedPaths(entries: GitStatusEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.paths))];
}

function unrelatedChangesError(
  unexpectedPaths: string[],
): RepositoryServiceError {
  return new RepositoryServiceError(
    "REPOSITORY_HAS_UNRELATED_CHANGES",
    "AgentFlow found other repository changes. Commit or stash them, then retry the reviewed-plan commit.",
    409,
    {
      unexpectedPaths: [...new Set(unexpectedPaths)].sort(),
      nextAction:
        "Commit or stash the other changes, then retry the reviewed-plan commit.",
    },
  );
}

async function resolveRepositoryFile(
  repositoryRoot: string,
  relativePath: string,
): Promise<string> {
  const candidate = path.resolve(repositoryRoot, relativePath);
  let component = repositoryRoot;
  for (const part of relativePath.split("/")) {
    component = path.join(component, part);
    const metadata = await lstat(component).catch(() => undefined);
    if (metadata?.isSymbolicLink()) throw new RepositoryServiceError("BACKLOG_PATH_INVALID",
      "Reviewed configuration and backlog paths must not be symbolic links.", 400);
  }
  const canonical = await realpath(candidate).catch((error: unknown) => {
    throw new RepositoryServiceError(
      "BACKLOG_NOT_FOUND",
      `The configured backlog ${relativePath} does not exist.`,
      400,
      error instanceof Error ? error.message : String(error),
    );
  });
  const relative = path.relative(repositoryRoot, canonical);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new RepositoryServiceError(
      "BACKLOG_PATH_INVALID",
      "The configured backlog must be a file inside the repository.",
      400,
    );
  }
  if (!(await lstat(canonical)).isFile()) {
    throw new RepositoryServiceError(
      "BACKLOG_PATH_INVALID",
      "The configured backlog must be a regular file.",
      400,
    );
  }
  return canonical;
}

function normalizeGitPath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

function nulSeparated(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}
