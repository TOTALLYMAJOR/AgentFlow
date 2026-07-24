import path from "node:path";

import type { OwnershipConflict, PlannedTask } from "../domain/types.js";
import { planningError } from "./errors.js";
import type { PlanningValidationError } from "./types.js";

interface NormalizedOwnershipPath {
  path?: string;
  error?: PlanningValidationError;
}

const FORBIDDEN_REPOSITORY_SEGMENTS = new Set([".git", ".agentflow"]);

export function normalizeOwnershipPath(
  value: string,
  taskId?: string,
): NormalizedOwnershipPath {
  const original = value;
  const candidate = value.trim().replaceAll("\\", "/");
  const details = {
    ...(taskId === undefined ? {} : { taskId }),
    field: "owns",
  };

  if (
    candidate.length === 0 ||
    candidate === "." ||
    candidate.includes("\0")
  ) {
    return {
      error: planningError(
        "INVALID_OWNERSHIP_PATH",
        `Ownership path "${original}" is not a non-empty repository-relative path`,
        details,
      ),
    };
  }

  if (
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(value.trim()) ||
    candidate === "~" ||
    candidate.startsWith("~/")
  ) {
    return {
      error: planningError(
        "INVALID_OWNERSHIP_PATH",
        `Ownership path "${original}" must be repository-relative`,
        details,
      ),
    };
  }

  const rawSegments = candidate.split("/");
  if (rawSegments.includes("..")) {
    return {
      error: planningError(
        "INVALID_OWNERSHIP_PATH",
        `Ownership path "${original}" must not contain ".." segments`,
        details,
      ),
    };
  }

  const segments = rawSegments.filter(
    (segment) => segment.length > 0 && segment !== ".",
  );
  if (segments.length === 0) {
    return {
      error: planningError(
        "INVALID_OWNERSHIP_PATH",
        `Ownership path "${original}" does not identify a repository path`,
        details,
      ),
    };
  }

  const forbiddenSegment = segments.find((segment) =>
    FORBIDDEN_REPOSITORY_SEGMENTS.has(segment.toLowerCase()),
  );
  if (forbiddenSegment !== undefined) {
    return {
      error: planningError(
        "FORBIDDEN_OWNERSHIP_PATH",
        `Ownership path "${original}" targets protected ${forbiddenSegment} state`,
        details,
      ),
    };
  }

  return { path: segments.join("/") };
}

export function normalizeTaskOwnership(
  tasks: readonly PlannedTask[],
): PlanningValidationError[] {
  const errors: PlanningValidationError[] = [];

  for (const task of tasks) {
    const normalized: string[] = [];
    for (const ownedPath of task.owns) {
      const result = normalizeOwnershipPath(ownedPath, task.id);
      if (result.error !== undefined) {
        errors.push(result.error);
      } else if (result.path !== undefined && !normalized.includes(result.path)) {
        normalized.push(result.path);
      }
    }
    task.owns.splice(0, task.owns.length, ...normalized);
  }

  return errors;
}

function canonicalConflictPath(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

export function ownershipPathsConflict(left: string, right: string): boolean {
  const first = canonicalConflictPath(left);
  const second = canonicalConflictPath(right);
  if (first.length === 0 || second.length === 0) {
    return false;
  }
  return (
    first === second ||
    first.startsWith(`${second}/`) ||
    second.startsWith(`${first}/`)
  );
}

export function findOwnershipConflicts(
  tasks: readonly PlannedTask[],
): OwnershipConflict[] {
  const conflicts: OwnershipConflict[] = [];

  for (let firstIndex = 0; firstIndex < tasks.length; firstIndex += 1) {
    const firstTask = tasks[firstIndex];
    if (firstTask === undefined) {
      continue;
    }
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < tasks.length;
      secondIndex += 1
    ) {
      const secondTask = tasks[secondIndex];
      if (secondTask === undefined) {
        continue;
      }
      for (const firstPath of firstTask.owns) {
        for (const secondPath of secondTask.owns) {
          if (ownershipPathsConflict(firstPath, secondPath)) {
            conflicts.push({
              firstTaskId: firstTask.id,
              secondTaskId: secondTask.id,
              firstPath,
              secondPath,
            });
          }
        }
      }
    }
  }

  return conflicts;
}
