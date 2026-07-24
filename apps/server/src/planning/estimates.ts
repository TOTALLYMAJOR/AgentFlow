import type { PlanEstimates, PlannedTask } from "../domain/types.js";
import { planningError } from "./errors.js";
import { maximumTheoreticalConcurrency } from "./graph.js";
import {
  DEFAULT_PLANNING_OPTIONS,
  type PlanningOptions,
  type PlanningValidationError,
  type ResolvedPlanningOptions,
} from "./types.js";

export function resolvePlanningOptions(
  options: PlanningOptions = {},
): {
  options: ResolvedPlanningOptions;
  errors: PlanningValidationError[];
} {
  const resolved: ResolvedPlanningOptions = {
    defaultValidation: [...(options.defaultValidation ?? [])],
    workerMaximum:
      options.workerMaximum ?? DEFAULT_PLANNING_OPTIONS.workerMaximum,
    workerEfficiency:
      options.workerEfficiency ?? DEFAULT_PLANNING_OPTIONS.workerEfficiency,
    overheadPercent:
      options.overheadPercent ?? DEFAULT_PLANNING_OPTIONS.overheadPercent,
  };
  const errors: PlanningValidationError[] = [];

  if (
    !Number.isInteger(resolved.workerMaximum) ||
    resolved.workerMaximum < 1 ||
    resolved.workerMaximum > 4
  ) {
    errors.push(
      planningError(
        "INVALID_WORKER_MAXIMUM",
        "workers.maximum must be an integer from 1 through 4",
        { field: "workers.maximum" },
      ),
    );
  }
  if (
    !Number.isFinite(resolved.workerEfficiency) ||
    resolved.workerEfficiency <= 0 ||
    resolved.workerEfficiency > 1
  ) {
    errors.push(
      planningError(
        "INVALID_WORKER_EFFICIENCY",
        "planning_defaults.worker_efficiency must be greater than 0 and at most 1",
        { field: "planning_defaults.worker_efficiency" },
      ),
    );
  }
  if (
    !Number.isFinite(resolved.overheadPercent) ||
    resolved.overheadPercent < 0 ||
    resolved.overheadPercent > 100
  ) {
    errors.push(
      planningError(
        "INVALID_OVERHEAD_PERCENT",
        "planning_defaults.overhead_percent must be between 0 and 100",
        { field: "planning_defaults.overhead_percent" },
      ),
    );
  }

  resolved.defaultValidation.forEach((command, index) => {
    if (typeof command !== "string" || command.trim().length === 0) {
      errors.push(
        planningError(
          "INVALID_VALIDATION_COMMAND",
          `validation.task_default[${index}] must be a non-empty command`,
          { field: `validation.task_default[${index}]` },
        ),
      );
    }
  });
  resolved.defaultValidation = resolved.defaultValidation
    .map((command) => command.trim())
    .filter((command) => command.length > 0);

  return { options: resolved, errors };
}

interface CriticalPath {
  duration: number;
  taskIds: string[];
}

function calculateCriticalPath(
  tasks: readonly PlannedTask[],
  waves: readonly (readonly string[])[],
): CriticalPath {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const topologicalOrder = waves.flat();
  const earliestFinish = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    dependents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      dependents.get(dependencyId)?.push(task.id);
    }
  }

  for (const taskId of topologicalOrder) {
    const task = tasksById.get(taskId);
    if (task === undefined) {
      continue;
    }
    const longestDependencyDuration = task.dependsOn.reduce(
      (longest, dependencyId) =>
        Math.max(longest, earliestFinish.get(dependencyId) ?? 0),
      0,
    );
    earliestFinish.set(
      task.id,
      longestDependencyDuration + task.estimateHours,
    );
  }

  const duration = Math.max(0, ...earliestFinish.values());
  const latestFinish = new Map<string, number>();
  for (const taskId of [...topologicalOrder].reverse()) {
    const taskDependents = dependents.get(taskId) ?? [];
    const finish =
      taskDependents.length === 0
        ? duration
        : Math.min(
            ...taskDependents.map((dependentId) => {
              const dependent = tasksById.get(dependentId);
              return (
                (latestFinish.get(dependentId) ?? duration) -
                (dependent?.estimateHours ?? 0)
              );
            }),
          );
    latestFinish.set(taskId, finish);
  }

  const epsilon = 1e-9;
  const taskIds = topologicalOrder.filter((taskId) => {
    const task = tasksById.get(taskId);
    if (task === undefined) {
      return false;
    }
    const earliestStart =
      (earliestFinish.get(taskId) ?? task.estimateHours) -
      task.estimateHours;
    const latestStart =
      (latestFinish.get(taskId) ?? duration) - task.estimateHours;
    return Math.abs(earliestStart - latestStart) <= epsilon;
  });

  return { duration, taskIds };
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculatePlanEstimates(
  tasks: readonly PlannedTask[],
  waves: readonly (readonly string[])[],
  options: Pick<
    ResolvedPlanningOptions,
    "workerMaximum" | "workerEfficiency" | "overheadPercent"
  >,
): PlanEstimates {
  const sequentialHours = tasks.reduce(
    (total, task) => total + task.estimateHours,
    0,
  );
  const criticalPath = calculateCriticalPath(tasks, waves);
  const capacityBound =
    sequentialHours / (options.workerMaximum * options.workerEfficiency);
  const parallelCore = Math.max(criticalPath.duration, capacityBound);
  const overheadHours = parallelCore * (options.overheadPercent / 100);
  const expectedElapsedHours = parallelCore + overheadHours;
  const expectedSavingsPercent =
    sequentialHours === 0
      ? 0
      : (1 - expectedElapsedHours / sequentialHours) * 100;

  return {
    sequentialHours: rounded(sequentialHours),
    criticalPathHours: rounded(criticalPath.duration),
    expectedElapsedHours: rounded(expectedElapsedHours),
    expectedSavingsPercent: rounded(expectedSavingsPercent),
    maximumTheoreticalConcurrency: maximumTheoreticalConcurrency(waves),
    criticalPathTaskIds: criticalPath.taskIds,
    workerEfficiency: options.workerEfficiency,
    overheadPercent: options.overheadPercent,
  };
}
