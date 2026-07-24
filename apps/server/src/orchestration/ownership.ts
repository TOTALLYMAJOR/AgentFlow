import path from "node:path";
import { AgentFlowError } from "../http/errors.js";

const forbiddenRoots = [
  ".git",
  ".agentflow",
  "node_modules",
] as const;

export function normalizeOwnedPath(candidate: string): string {
  const portable = candidate.replaceAll("\\", "/").trim();
  if (portable.length === 0 || path.posix.isAbsolute(portable)) {
    throw new AgentFlowError(
      "INVALID_OWNERSHIP_PATH",
      `Ownership path must be repository-relative: ${candidate}`,
    );
  }

  const normalized = path.posix.normalize(portable).replace(/^\.\/+/, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new AgentFlowError(
      "INVALID_OWNERSHIP_PATH",
      `Ownership path escapes the repository: ${candidate}`,
    );
  }

  const firstSegment = normalized.split("/")[0]?.toLowerCase();
  if (
    firstSegment !== undefined &&
    forbiddenRoots.some((root) => firstSegment === root)
  ) {
    throw new AgentFlowError(
      "FORBIDDEN_OWNERSHIP_PATH",
      `Ownership path targets an AgentFlow or repository runtime root: ${candidate}`,
    );
  }

  return normalized.replace(/\/+$/, "");
}

export function ownershipRootsConflict(first: string, second: string): boolean {
  const a = normalizeOwnedPath(first);
  const b = normalizeOwnedPath(second);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function tasksOwnershipConflict(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return first.some((a) =>
    second.some((b) => ownershipRootsConflict(a, b)),
  );
}

export interface OwnershipCheck {
  valid: boolean;
  normalizedChangedFiles: string[];
  violations: string[];
}

export function checkChangedFileOwnership(
  changedFiles: readonly string[],
  ownedRoots: readonly string[],
): OwnershipCheck {
  const normalizedRoots = ownedRoots.map(normalizeOwnedPath);
  const normalizedChangedFiles = changedFiles.map((candidate) =>
    normalizeChangedPath(candidate),
  );
  const violations = normalizedChangedFiles.filter(
    (changed) =>
      !normalizedRoots.some(
        (root) => changed === root || changed.startsWith(`${root}/`),
      ),
  );

  return {
    valid: violations.length === 0,
    normalizedChangedFiles,
    violations,
  };
}

function normalizeChangedPath(candidate: string): string {
  const normalized = path.posix
    .normalize(candidate.replaceAll("\\", "/").trim())
    .replace(/^\.\/+/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new AgentFlowError(
      "INVALID_CHANGED_PATH",
      `Git reported an unsafe changed path: ${candidate}`,
    );
  }
  return normalized;
}
