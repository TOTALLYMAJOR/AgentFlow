import type { PlannedTask, ProducedArtifact } from "../domain/types.js";
import { planningError, uniquePlanningErrors } from "./errors.js";
import { validateDependencyGraph } from "./graph.js";
import { normalizeTaskOwnership } from "./ownership.js";
import type { PlanningValidationError } from "./types.js";

const NON_EXACT_VERSION = /(?:\s|\*|\^|~|<|>|\|\||\bx\b)/i;

export function isExactArtifactVersion(version: string): boolean {
  return version.trim().length > 0 && !NON_EXACT_VERSION.test(version);
}

function validateTaskBasics(
  tasks: readonly PlannedTask[],
): PlanningValidationError[] {
  const errors: PlanningValidationError[] = [];

  for (const task of tasks) {
    if (
      !Number.isFinite(task.estimateHours) ||
      task.estimateHours <= 0
    ) {
      errors.push(
        planningError(
          "INVALID_ESTIMATE",
          `${task.id}.estimate_hours must be a finite number greater than zero`,
          { taskId: task.id, field: "estimate_hours" },
        ),
      );
    }
    if (
      task.acceptanceCriteria.length === 0 ||
      task.acceptanceCriteria.every((criterion) => criterion.trim().length === 0)
    ) {
      errors.push(
        planningError(
          "MISSING_ACCEPTANCE_CRITERIA",
          `${task.id} must contain non-empty Acceptance Criteria`,
          { taskId: task.id, field: "acceptanceCriteria" },
        ),
      );
    }
    if (task.owns.length === 0) {
      errors.push(
        planningError(
          "EMPTY_OWNERSHIP",
          `${task.id}.owns must declare at least one repository-relative path`,
          { taskId: task.id, field: "owns" },
        ),
      );
    }
    if (task.validate.length === 0) {
      errors.push(
        planningError(
          "MISSING_VALIDATION",
          `${task.id} has no task validation commands and no repository defaults`,
          { taskId: task.id, field: "validate" },
        ),
      );
    }
    task.validate.forEach((command, index) => {
      if (command.trim().length === 0) {
        errors.push(
          planningError(
            "INVALID_VALIDATION_COMMAND",
            `${task.id}.validate[${index}] must be a non-empty command`,
            { taskId: task.id, field: `validate[${index}]` },
          ),
        );
      }
    });
  }

  return errors;
}

function artifactKey(artifact: ProducedArtifact): string {
  return `${artifact.name}\0${artifact.version}`;
}

function validateProducedArtifacts(
  tasks: readonly PlannedTask[],
): PlanningValidationError[] {
  const errors: PlanningValidationError[] = [];
  const producers = new Map<
    string,
    { taskId: string; artifact: ProducedArtifact }
  >();

  for (const task of tasks) {
    task.produces.forEach((artifact, index) => {
      if (
        artifact.name.trim().length === 0 ||
        artifact.type.trim().length === 0
      ) {
        errors.push(
          planningError(
            "INVALID_ARTIFACT",
            `${task.id}.produces[${index}] requires non-empty name and type`,
            { taskId: task.id, field: `produces[${index}]` },
          ),
        );
      }
      if (artifact.version.trim().length === 0) {
        errors.push(
          planningError(
            "ARTIFACT_VERSION_REQUIRED",
            `${task.id}.produces[${index}].version is required`,
            { taskId: task.id, field: `produces[${index}].version` },
          ),
        );
      } else if (!isExactArtifactVersion(artifact.version)) {
        errors.push(
          planningError(
            "ARTIFACT_VERSION_NOT_EXACT",
            `${task.id}.produces[${index}].version must be an exact version`,
            { taskId: task.id, field: `produces[${index}].version` },
          ),
        );
      }

      if (
        artifact.name.trim().length === 0 ||
        artifact.version.trim().length === 0
      ) {
        return;
      }
      const key = artifactKey(artifact);
      const existing = producers.get(key);
      if (existing !== undefined) {
        errors.push(
          planningError(
            "DUPLICATE_PRODUCED_ARTIFACT",
            `${task.id} and ${existing.taskId} both produce ${artifact.name}@${artifact.version}`,
            {
              taskId: task.id,
              field: `produces[${index}]`,
              relatedTaskId: existing.taskId,
            },
          ),
        );
      } else {
        producers.set(key, { taskId: task.id, artifact });
      }
    });
  }

  return errors;
}

function validateConsumedArtifacts(
  tasks: readonly PlannedTask[],
): PlanningValidationError[] {
  const errors: PlanningValidationError[] = [];
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  for (const task of tasks) {
    task.consumes.forEach((consumption, index) => {
      const field = `consumes[${index}]`;
      if (
        consumption.task.trim().length === 0 ||
        consumption.artifact.trim().length === 0
      ) {
        errors.push(
          planningError(
            "INVALID_ARTIFACT",
            `${task.id}.${field} requires non-empty task and artifact`,
            { taskId: task.id, field },
          ),
        );
        return;
      }
      if (consumption.version.trim().length === 0) {
        errors.push(
          planningError(
            "ARTIFACT_VERSION_REQUIRED",
            `${task.id}.${field}.version is required`,
            { taskId: task.id, field: `${field}.version` },
          ),
        );
      } else if (!isExactArtifactVersion(consumption.version)) {
        errors.push(
          planningError(
            "ARTIFACT_VERSION_NOT_EXACT",
            `${task.id}.${field}.version must be an exact version`,
            { taskId: task.id, field: `${field}.version` },
          ),
        );
      }

      const producer = tasksById.get(consumption.task);
      if (producer === undefined) {
        errors.push(
          planningError(
            "ARTIFACT_PRODUCER_MISSING",
            `${task.id} consumes ${consumption.artifact} from missing task ${consumption.task}`,
            {
              taskId: task.id,
              field,
              relatedTaskId: consumption.task,
            },
          ),
        );
        return;
      }
      if (!task.dependsOn.includes(consumption.task)) {
        errors.push(
          planningError(
            "ARTIFACT_PRODUCER_NOT_DEPENDENCY",
            `${task.id} consumes ${consumption.artifact} from ${consumption.task}, but that producer is not a direct dependency`,
            {
              taskId: task.id,
              field,
              relatedTaskId: consumption.task,
            },
          ),
        );
        return;
      }

      const matchingName = producer.produces.filter(
        (artifact) => artifact.name === consumption.artifact,
      );
      if (matchingName.length === 0) {
        errors.push(
          planningError(
            "ARTIFACT_NOT_PRODUCED",
            `${task.id} consumes ${consumption.artifact} from ${producer.id}, but that task does not produce it`,
            {
              taskId: task.id,
              field,
              relatedTaskId: producer.id,
            },
          ),
        );
        return;
      }
      if (
        !matchingName.some(
          (artifact) => artifact.version === consumption.version,
        )
      ) {
        const availableVersions = matchingName
          .map((artifact) => artifact.version)
          .join(", ");
        errors.push(
          planningError(
            "ARTIFACT_VERSION_MISMATCH",
            `${task.id} requires ${consumption.artifact}@${consumption.version} from ${producer.id}; available: ${availableVersions}`,
            {
              taskId: task.id,
              field: `${field}.version`,
              relatedTaskId: producer.id,
            },
          ),
        );
      }
    });
  }

  return errors;
}

export function validatePlannedTasks(
  tasks: readonly PlannedTask[],
): PlanningValidationError[] {
  const graph = validateDependencyGraph(tasks);
  return uniquePlanningErrors([
    ...validateTaskBasics(tasks),
    ...normalizeTaskOwnership(tasks),
    ...graph.errors,
    ...validateProducedArtifacts(tasks),
    ...validateConsumedArtifacts(tasks),
  ]);
}
