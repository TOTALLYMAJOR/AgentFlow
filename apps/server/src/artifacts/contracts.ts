import type { DatabaseRepositories } from "../db/index.js";
import { createId } from "../util/ids.js";

export type ContractChangeLevel = "patch" | "minor" | "major";

export interface ContractChangeClassification {
  level: ContractChangeLevel;
  reasons: string[];
  changedPointers: string[];
}

const documentationKeys = new Set([
  "description",
  "example",
  "examples",
  "externalDocs",
  "summary",
  "title",
]);
const httpMethods = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

export function classifyContractChange(
  previous: unknown,
  current: unknown,
): ContractChangeClassification {
  const reasons: string[] = [];
  const majorPointers = new Set<string>();
  const minorPointers = new Set<string>();
  const patchPointers = new Set<string>();
  compareContractNode(
    previous,
    current,
    "",
    reasons,
    majorPointers,
    minorPointers,
    patchPointers,
  );
  const level: ContractChangeLevel =
    majorPointers.size > 0
      ? "major"
      : minorPointers.size > 0
        ? "minor"
        : "patch";
  return {
    level,
    reasons: [...new Set(reasons)].sort(),
    changedPointers: [
      ...new Set([
        ...majorPointers,
        ...minorPointers,
        ...patchPointers,
      ]),
    ].sort(),
  };
}

export class ContractGovernanceService {
  constructor(private readonly store: DatabaseRepositories) {}

  governMajorChange(input: {
    buildId: string;
    producerTaskId: string;
    artifactName: string;
    previousContract: unknown;
    currentContract: unknown;
  }): {
    classification: ContractChangeClassification;
    approvalId: string | null;
    invalidatedArtifactIds: string[];
    affectedTaskIds: string[];
  } {
    const classification = classifyContractChange(
      input.previousContract,
      input.currentContract,
    );
    if (classification.level !== "major") {
      return {
        classification,
        approvalId: null,
        invalidatedArtifactIds: [],
        affectedTaskIds: [],
      };
    }

    const affectedTaskIds = this.store.tasks
      .listForBuild(input.buildId)
      .filter((task) =>
        this.store.tasks
          .listDependencies(task.id)
          .some(
            (dependency) =>
              dependency.dependencyTaskId === input.producerTaskId &&
              dependency.requiredArtifactName === input.artifactName,
          ),
      )
      .map((task) => task.id)
      .sort();
    const invalidatedArtifactIds = this.store.artifacts
      .listForBuild(input.buildId)
      .filter(
        (artifact) =>
          affectedTaskIds.includes(artifact.producerTaskId) &&
          artifact.status !== "invalidated",
      )
      .map((artifact) => {
        this.store.artifacts.setStatus(artifact.id, "invalidated");
        return artifact.id;
      });
    const existing = this.store.approvals
      .listPending(input.buildId, input.producerTaskId)
      .find((approval) => approval.approvalType === "breaking_contract");
    const approval =
      existing ??
      this.store.approvals.create({
        id: createId("approval"),
        buildId: input.buildId,
        taskId: input.producerTaskId,
        approvalType: "breaking_contract",
        reason: `Major change to ${input.artifactName}: ${classification.reasons.join("; ")}`,
      });
    return {
      classification,
      approvalId: approval.id,
      invalidatedArtifactIds,
      affectedTaskIds,
    };
  }
}

function compareContractNode(
  previous: unknown,
  current: unknown,
  pointer: string,
  reasons: string[],
  majorPointers: Set<string>,
  minorPointers: Set<string>,
  patchPointers: Set<string>,
): void {
  if (Object.is(previous, current)) {
    return;
  }
  const location = pointer || "/";
  if (typeof previous !== typeof current || Array.isArray(previous) !== Array.isArray(current)) {
    majorPointers.add(location);
    reasons.push(`Type changed at ${location}`);
    return;
  }
  if (Array.isArray(previous) && Array.isArray(current)) {
    if (pointer.endsWith("/required")) {
      const before = new Set(previous.map(String));
      const after = new Set(current.map(String));
      for (const value of after) {
        if (!before.has(value)) {
          majorPointers.add(`${location}/${escapePointer(value)}`);
          reasons.push(`New required field ${value} at ${parentPointer(pointer)}`);
        }
      }
      for (const value of before) {
        if (!after.has(value)) {
          minorPointers.add(`${location}/${escapePointer(value)}`);
        }
      }
      return;
    }
    if (pointer.endsWith("/enum")) {
      const before = new Set(previous.map(stableScalar));
      const after = new Set(current.map(stableScalar));
      const removed = [...before].filter((value) => !after.has(value));
      if (removed.length > 0) {
        majorPointers.add(location);
        reasons.push(`Allowed values were removed at ${parentPointer(pointer)}`);
      } else {
        minorPointers.add(location);
      }
      return;
    }
    if (JSON.stringify(previous) !== JSON.stringify(current)) {
      if (isDocumentationPointer(pointer)) {
        patchPointers.add(location);
      } else {
        minorPointers.add(location);
      }
    }
    return;
  }
  if (isRecord(previous) && isRecord(current)) {
    const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
    for (const key of [...keys].sort()) {
      const childPointer = `${pointer}/${escapePointer(key)}`;
      if (!(key in current)) {
        if (isDocumentationPointer(childPointer)) {
          patchPointers.add(childPointer);
        } else if (isOpenApiOperation(pointer, key)) {
          majorPointers.add(childPointer);
          reasons.push(`Endpoint operation removed at ${childPointer}`);
        } else {
          majorPointers.add(childPointer);
          reasons.push(`Field removed at ${childPointer}`);
        }
        continue;
      }
      if (!(key in previous)) {
        if (isDocumentationPointer(childPointer)) {
          patchPointers.add(childPointer);
        } else {
          minorPointers.add(childPointer);
        }
        continue;
      }
      compareContractNode(
        previous[key],
        current[key],
        childPointer,
        reasons,
        majorPointers,
        minorPointers,
        patchPointers,
      );
    }
    return;
  }
  if (isDocumentationPointer(pointer)) {
    patchPointers.add(location);
  } else {
    majorPointers.add(location);
    reasons.push(`Value changed incompatibly at ${location}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDocumentationPointer(pointer: string): boolean {
  const key = pointer.split("/").at(-1) ?? "";
  return documentationKeys.has(key);
}

function isOpenApiOperation(pointer: string, key: string): boolean {
  return pointer.startsWith("/paths/") && httpMethods.has(key.toLowerCase());
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function parentPointer(pointer: string): string {
  return pointer.slice(0, Math.max(0, pointer.lastIndexOf("/"))) || "/";
}

function stableScalar(value: unknown): string {
  return JSON.stringify(value);
}
