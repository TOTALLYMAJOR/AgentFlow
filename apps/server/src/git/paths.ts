import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { GitRuntimeError } from "./errors.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeIdentifier(
  label: "repository ID" | "build ID" | "task ID",
  value: string,
): void {
  if (
    !SAFE_IDENTIFIER.test(value) ||
    value === "." ||
    value === ".." ||
    value.endsWith(".lock")
  ) {
    throw new GitRuntimeError(
      "GIT_INVALID_IDENTIFIER",
      `${label} ${JSON.stringify(value)} is not safe for branch and worktree paths`,
      { label, value },
    );
  }
}
export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right || isPathInside(left, right) || isPathInside(right, left)
  );
}

export async function canonicalExistingDirectory(
  input: string,
  label: string,
): Promise<string> {
  if (!path.isAbsolute(input)) {
    throw new GitRuntimeError(
      "GIT_PATH_OUTSIDE_RUNTIME",
      `${label} must be an absolute path`,
      { path: input },
    );
  }
  const canonical = await realpath(input);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory()) {
    throw new GitRuntimeError(
      "GIT_PATH_COLLISION",
      `${label} is not a directory`,
      { path: canonical },
    );
  }
  return canonical;
}

export async function ensureCanonicalRoot(
  input: string,
  label: string,
): Promise<string> {
  if (!path.isAbsolute(input)) {
    throw new GitRuntimeError(
      "GIT_PATH_OUTSIDE_RUNTIME",
      `${label} must be an absolute path`,
      { path: input },
    );
  }
  await mkdir(input, { recursive: true, mode: 0o700 });
  return canonicalExistingDirectory(input, label);
}

/**
 * Creates a path one component at a time and refuses symlinks before following
 * them. Identifiers have already been validated, so each segment is a literal
 * directory name rather than user-controlled path syntax.
 */
export async function ensureManagedDirectory(
  canonicalRoot: string,
  segments: readonly string[],
): Promise<string> {
  let current = canonicalRoot;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
      await mkdir(candidate, { mode: 0o700 });
      metadata = await lstat(candidate);
    }
    if (metadata.isSymbolicLink()) {
      throw new GitRuntimeError(
        "GIT_SYMLINK_NOT_ALLOWED",
        `Managed worktree path component ${candidate} is a symbolic link`,
        { path: candidate },
      );
    }
    if (!metadata.isDirectory()) {
      throw new GitRuntimeError(
        "GIT_PATH_COLLISION",
        `Managed worktree path component ${candidate} is not a directory`,
        { path: candidate },
      );
    }
    current = await realpath(candidate);
    if (!isPathInside(canonicalRoot, current)) {
      throw new GitRuntimeError(
        "GIT_PATH_OUTSIDE_RUNTIME",
        `Managed worktree directory escaped ${canonicalRoot}`,
        { path: current },
      );
    }
  }
  return current;
}

export async function pathKind(
  candidate: string,
): Promise<"missing" | "directory" | "symlink" | "other"> {
  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      return "symlink";
    }
    return metadata.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (isMissingPath(error)) {
      return "missing";
    }
    throw error;
  }
}

export function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
