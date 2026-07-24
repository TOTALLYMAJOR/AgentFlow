import type { PlannedTask } from "../domain/types.js";
import { planningError } from "./errors.js";
import type { PlanningValidationError } from "./types.js";

export interface DependencyGraphValidation {
  errors: PlanningValidationError[];
  tasksById: Map<string, PlannedTask>;
}

export function validateDependencyGraph(
  tasks: readonly PlannedTask[],
): DependencyGraphValidation {
  const errors: PlanningValidationError[] = [];
  const tasksById = new Map<string, PlannedTask>();

  for (const task of tasks) {
    if (tasksById.has(task.id)) {
      errors.push(
        planningError(
          "DUPLICATE_TASK_ID",
          `Duplicate task ID: ${task.id}`,
          { taskId: task.id },
        ),
      );
      continue;
    }
    tasksById.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.id) {
        errors.push(
          planningError(
            "SELF_DEPENDENCY",
            `${task.id} cannot depend on itself`,
            {
              taskId: task.id,
              field: "depends_on",
              relatedTaskId: dependencyId,
            },
          ),
        );
        continue;
      }
      if (!tasksById.has(dependencyId)) {
        errors.push(
          planningError(
            "MISSING_DEPENDENCY",
            `${task.id} references missing dependency ${dependencyId}`,
            {
              taskId: task.id,
              field: "depends_on",
              relatedTaskId: dependencyId,
            },
          ),
        );
      }
    }
  }

  const colors = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const reportedCycles = new Set<string>();

  const visit = (taskId: string): void => {
    const color = colors.get(taskId);
    if (color === "visited") {
      return;
    }
    if (color === "visiting") {
      const cycleStart = stack.indexOf(taskId);
      const cycle = [...stack.slice(Math.max(0, cycleStart)), taskId];
      const key = canonicalCycleKey(cycle);
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        errors.push(
          planningError(
            "DEPENDENCY_CYCLE",
            `Dependency cycle: ${cycle.join(" -> ")}`,
            { taskId, field: "depends_on", cycle },
          ),
        );
      }
      return;
    }

    colors.set(taskId, "visiting");
    stack.push(taskId);
    const task = tasksById.get(taskId);
    for (const dependencyId of task?.dependsOn ?? []) {
      if (
        dependencyId !== taskId &&
        tasksById.has(dependencyId)
      ) {
        visit(dependencyId);
      }
    }
    stack.pop();
    colors.set(taskId, "visited");
  };

  for (const taskId of tasksById.keys()) {
    visit(taskId);
  }

  return { errors, tasksById };
}

function canonicalCycleKey(cycle: readonly string[]): string {
  const members = cycle.slice(0, -1);
  if (members.length === 0) {
    return "";
  }
  const rotations = members.map((_, index) => [
    ...members.slice(index),
    ...members.slice(0, index),
  ]);
  rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return rotations[0]?.join("\0") ?? "";
}

export function buildExecutionWaves(
  tasks: readonly PlannedTask[],
): string[][] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const emitted = new Set<string>();
  const waves: string[][] = [];

  while (emitted.size < tasksById.size) {
    const wave = tasks
      .filter((task) => !emitted.has(task.id))
      .filter((task) =>
        task.dependsOn.every(
          (dependencyId) =>
            tasksById.has(dependencyId) && emitted.has(dependencyId),
        ),
      )
      .map((task) => task.id);

    if (wave.length === 0) {
      throw new Error(
        "Cannot construct execution waves for an invalid dependency graph",
      );
    }
    waves.push(wave);
    for (const taskId of wave) {
      emitted.add(taskId);
    }
  }

  return waves;
}

export function maximumTheoreticalConcurrency(
  waves: readonly (readonly string[])[],
): number {
  return waves.reduce(
    (maximum, wave) => Math.max(maximum, wave.length),
    0,
  );
}
