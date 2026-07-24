import path from "node:path";

import { runValidationProcess } from "./process-runner.js";
import type { GitChangedFile } from "./types.js";

const GIT_OUTPUT_LIMIT_BYTES = 32 * 1_024 * 1_024;
const GIT_TIMEOUT_MS = 30_000;

export class GitChangeInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitChangeInspectionError";
  }
}

export async function collectGitChanges(
  worktreePath: string,
  baseCommit: string,
  signal?: AbortSignal,
): Promise<GitChangedFile[]> {
  if (!/^[0-9a-f]{7,64}$/iu.test(baseCommit)) {
    throw new GitChangeInspectionError(
      "Base commit must be an exact hexadecimal Git object ID",
    );
  }

  const tracked = await runGitForNulOutput(
    worktreePath,
    [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--find-copies",
      "--diff-filter=ACDMRTUXB",
      baseCommit,
      "--",
    ],
    signal,
  );
  const untracked = await runGitForNulOutput(
    worktreePath,
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    signal,
  );

  const changes = parseNameStatusOutput(tracked);
  const trackedPaths = new Set(changes.map((change) => change.path));
  for (const candidate of splitNul(untracked)) {
    const normalized = normalizeRepositoryPath(candidate);
    if (!trackedPaths.has(normalized)) {
      changes.push({
        path: normalized,
        changeType: "untracked",
        previousPath: null,
      });
    }
  }

  return changes.sort(compareChanges);
}

export function parseNameStatusOutput(output: string): GitChangedFile[] {
  const fields = splitNul(output);
  const changes: GitChangedFile[] = [];

  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    index += 1;
    if (status === undefined || !/^[A-Z][0-9]*$/u.test(status)) {
      throw new GitChangeInspectionError(
        `Git returned an invalid name-status field: ${status ?? "<missing>"}`,
      );
    }

    const statusCode = status[0];
    if (statusCode === "R" || statusCode === "C") {
      const previousPath = fields[index];
      const changedPath = fields[index + 1];
      index += 2;
      if (previousPath === undefined || changedPath === undefined) {
        throw new GitChangeInspectionError(
          `Git returned an incomplete ${statusCode === "R" ? "rename" : "copy"} record`,
        );
      }
      changes.push({
        path: normalizeRepositoryPath(changedPath),
        changeType: statusCode === "R" ? "renamed" : "copied",
        previousPath: normalizeRepositoryPath(previousPath),
      });
      continue;
    }

    const changedPath = fields[index];
    index += 1;
    if (changedPath === undefined) {
      throw new GitChangeInspectionError(
        `Git returned an incomplete ${status} record`,
      );
    }
    changes.push({
      path: normalizeRepositoryPath(changedPath),
      changeType: mapChangeType(statusCode),
      previousPath: null,
    });
  }

  return changes;
}

export function normalizeRepositoryPath(candidate: string): string {
  const portable = candidate.replaceAll("\\", "/");
  if (
    portable.length === 0 ||
    portable.includes("\0") ||
    path.posix.isAbsolute(portable)
  ) {
    throw new GitChangeInspectionError(
      `Git reported an unsafe repository path: ${JSON.stringify(candidate)}`,
    );
  }

  const normalized = path.posix.normalize(portable).replace(/^\.\/+/, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new GitChangeInspectionError(
      `Git reported a path outside the repository: ${JSON.stringify(candidate)}`,
    );
  }
  return normalized.replace(/\/+$/u, "");
}

async function runGitForNulOutput(
  worktreePath: string,
  arguments_: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await runValidationProcess({
    argv: ["git", ...arguments_],
    cwd: worktreePath,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
    maxOutputBytes: GIT_OUTPUT_LIMIT_BYTES,
    terminationGraceMs: 250,
  });
  if (result.status !== "passed") {
    const detail =
      result.stderr.trim() ||
      result.error ||
      `git exited with ${result.exitCode ?? "no exit code"}`;
    throw new GitChangeInspectionError(
      `Could not inspect Git changes: ${detail}`,
    );
  }
  if (result.stdoutTruncated) {
    throw new GitChangeInspectionError(
      `Git change output exceeded ${GIT_OUTPUT_LIMIT_BYTES} bytes`,
    );
  }
  return result.stdout;
}

function splitNul(output: string): string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  return fields;
}

function mapChangeType(status: string | undefined): GitChangedFile["changeType"] {
  switch (status) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
    case "T":
    case "U":
    case "X":
    case "B":
      return "modified";
    default:
      throw new GitChangeInspectionError(
        `Git returned an unsupported change status: ${status ?? "<missing>"}`,
      );
  }
}

function compareChanges(first: GitChangedFile, second: GitChangedFile): number {
  return (
    first.path.localeCompare(second.path) ||
    first.changeType.localeCompare(second.changeType) ||
    (first.previousPath ?? "").localeCompare(second.previousPath ?? "")
  );
}
