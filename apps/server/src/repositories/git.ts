import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { RepositoryServiceError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export async function canonicalizeDirectory(
  inputPath: string,
): Promise<string> {
  if (!path.isAbsolute(inputPath)) {
    throw new RepositoryServiceError(
      "REPOSITORY_PATH_NOT_ABSOLUTE",
      "Repository paths must be absolute",
      400,
      { path: inputPath },
    );
  }

  let metadata;
  try {
    metadata = await stat(inputPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new RepositoryServiceError(
        "REPOSITORY_PATH_NOT_FOUND",
        `Repository path ${inputPath} does not exist`,
        404,
      );
    }
    throw accessError(inputPath, error);
  }

  if (!metadata.isDirectory()) {
    throw new RepositoryServiceError(
      "REPOSITORY_PATH_NOT_DIRECTORY",
      `Repository path ${inputPath} is not a directory`,
      400,
    );
  }

  try {
    await access(inputPath, fsConstants.R_OK | fsConstants.X_OK);
    return await realpath(inputPath);
  } catch (error) {
    throw accessError(inputPath, error);
  }
}

/**
 * Accepting an absolute path to any directory inside a working tree is useful
 * at the CLI, but the registry always stores the canonical Git top-level path.
 */
export async function resolveGitRepositoryRoot(
  inputPath: string,
): Promise<string> {
  const inspectedPath = await canonicalizeDirectory(inputPath);

  let topLevel: string;
  try {
    const inside = await runGit(inspectedPath, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    if (inside.stdout.trim() !== "true") {
      throw new RepositoryServiceError(
        "REPOSITORY_NOT_GIT_WORKTREE",
        `${inspectedPath} is not a Git working tree`,
        400,
      );
    }
    topLevel = (
      await runGit(inspectedPath, ["rev-parse", "--show-toplevel"])
    ).stdout.trim();
  } catch (error) {
    if (error instanceof RepositoryServiceError) {
      throw error;
    }
    throw new RepositoryServiceError(
      "REPOSITORY_NOT_GIT_REPOSITORY",
      `${inspectedPath} is not a Git repository`,
      400,
      errorMessage(error),
    );
  }

  const root = await canonicalizeDirectory(
    path.isAbsolute(topLevel) ? topLevel : path.resolve(inspectedPath, topLevel),
  );
  try {
    await runGit(root, ["status", "--porcelain=v1", "--untracked-files=no"]);
  } catch (error) {
    throw new RepositoryServiceError(
      "REPOSITORY_PATH_NOT_ACCESSIBLE",
      `The current user cannot inspect Git state in ${root}`,
      403,
      errorMessage(error),
    );
  }
  return root;
}

export async function assertValidBranchName(
  repositoryRoot: string,
  branch: string,
): Promise<void> {
  try {
    await runGit(repositoryRoot, ["check-ref-format", "--branch", branch]);
  } catch (error) {
    throw new RepositoryServiceError(
      "REPOSITORY_CONFIG_INVALID",
      `Configured base branch ${JSON.stringify(branch)} is not a valid Git branch name`,
      400,
      errorMessage(error),
    );
  }
}

export async function gitBranchExists(
  repositoryRoot: string,
  branch: string,
  remote?: string,
): Promise<boolean> {
  await assertValidBranchName(repositoryRoot, branch);
  if (
    await gitRefExists(repositoryRoot, `refs/heads/${branch}`)
  ) {
    return true;
  }
  return remote === undefined
    ? false
    : gitRefExists(repositoryRoot, `refs/remotes/${remote}/${branch}`);
}

export async function detectDefaultBranch(
  repositoryRoot: string,
): Promise<string> {
  try {
    const current = (
      await runGit(repositoryRoot, ["symbolic-ref", "--short", "HEAD"])
    ).stdout.trim();
    if (current.length > 0) {
      return current;
    }
  } catch {
    // A detached HEAD is valid; use a known local branch below.
  }

  for (const candidate of ["main", "master"]) {
    if (await gitRefExists(repositoryRoot, `refs/heads/${candidate}`)) {
      return candidate;
    }
  }

  const branches = (
    await runGit(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ])
  ).stdout
    .split("\n")
    .map((branch) => branch.trim())
    .filter(Boolean);

  return branches[0] ?? "main";
}

export async function runGit(
  repositoryRoot: string,
  arguments_: string[],
): Promise<GitCommandResult> {
  const result = await execFileAsync(
    "git",
    ["-C", repositoryRoot, ...arguments_],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function gitRefExists(
  repositoryRoot: string,
  reference: string,
): Promise<boolean> {
  try {
    await runGit(repositoryRoot, ["show-ref", "--verify", "--quiet", reference]);
    return true;
  } catch {
    return false;
  }
}

function accessError(
  inputPath: string,
  error: unknown,
): RepositoryServiceError {
  return new RepositoryServiceError(
    "REPOSITORY_PATH_NOT_ACCESSIBLE",
    `The current user cannot inspect ${inputPath}`,
    403,
    errorMessage(error),
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
