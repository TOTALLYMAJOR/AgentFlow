import { normalizeOwnedPath } from "../orchestration/ownership.js";
import { normalizeRepositoryPath } from "./git-changes.js";
import type {
  GitChangedFile,
  OwnershipEvaluation,
  OwnershipViolation,
} from "./types.js";

export const DEFAULT_FORBIDDEN_CHANGED_PATHS = [
  ".git",
  ".agentflow",
  ".agentflow.yaml",
  "node_modules",
] as const;

export function evaluateChangedFileOwnership(
  changes: readonly GitChangedFile[],
  ownedPaths: readonly string[],
  forbiddenPaths: readonly string[] = DEFAULT_FORBIDDEN_CHANGED_PATHS,
): OwnershipEvaluation {
  const ownedRoots = ownedPaths.map(normalizeOwnedPath);
  const forbiddenRoots = forbiddenPaths.map(normalizeRepositoryPath);
  const violations: OwnershipViolation[] = [];

  const changedFiles = changes.map((change) => {
    const normalized = normalizeChange(change);
    const paths = [
      normalized.path,
      ...(normalized.previousPath === null
        ? []
        : [normalized.previousPath]),
    ];
    let withinOwnership = true;

    for (const candidate of paths) {
      if (matchesAnyRoot(candidate, forbiddenRoots)) {
        withinOwnership = false;
        violations.push({
          path: candidate,
          changePath: normalized.path,
          previousPath: normalized.previousPath,
          reason: "forbidden_path",
        });
        continue;
      }
      if (!matchesAnyRoot(candidate, ownedRoots)) {
        withinOwnership = false;
        violations.push({
          path: candidate,
          changePath: normalized.path,
          previousPath: normalized.previousPath,
          reason: "outside_ownership",
        });
      }
    }

    return {
      ...normalized,
      withinOwnership,
    };
  });

  return {
    passed: violations.length === 0,
    ownedRoots,
    forbiddenRoots,
    changedFiles,
    violations,
  };
}

function normalizeChange(change: GitChangedFile): GitChangedFile {
  return {
    path: normalizeRepositoryPath(change.path),
    changeType: change.changeType,
    previousPath:
      change.previousPath === null
        ? null
        : normalizeRepositoryPath(change.previousPath),
  };
}

function matchesAnyRoot(candidate: string, roots: readonly string[]): boolean {
  return roots.some(
    (root) => candidate === root || candidate.startsWith(`${root}/`),
  );
}
