import type {
  AdrDraft,
  ArchitectureDecisionProposal,
  PlannedEpic,
  PlannedTask,
} from "../domain/types.js";
import { planningError } from "./errors.js";
import type { PlanningValidationError } from "./types.js";

export function validateEpicDecomposition(
  tasks: readonly PlannedTask[],
): PlanningValidationError[] {
  const errors: PlanningValidationError[] = [];
  const metadata = new Map<string, { title: string; outcome: string }>();
  for (const task of tasks) {
    const existing = metadata.get(task.epicId);
    if (
      existing !== undefined &&
      (existing.title !== task.epicTitle ||
        existing.outcome !== task.epicOutcome)
    ) {
      errors.push(
        planningError(
          "EPIC_METADATA_CONFLICT",
          `${task.epicId} must use one title and outcome across all tasks`,
          { taskId: task.id, field: "epic_id" },
        ),
      );
    } else {
      metadata.set(task.epicId, {
        title: task.epicTitle,
        outcome: task.epicOutcome,
      });
    }
  }
  const epicByTask = new Map(tasks.map((task) => [task.id, task.epicId]));
  const dependencies = new Map<string, Set<string>>();
  for (const task of tasks) {
    const epicDependencies = dependencies.get(task.epicId) ?? new Set<string>();
    for (const dependencyId of task.dependsOn) {
      const dependencyEpic = epicByTask.get(dependencyId);
      if (dependencyEpic !== undefined && dependencyEpic !== task.epicId) {
        epicDependencies.add(dependencyEpic);
      }
    }
    dependencies.set(task.epicId, epicDependencies);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (epicId: string, path: string[]): void => {
    if (visiting.has(epicId)) {
      errors.push(
        planningError(
          "EPIC_DEPENDENCY_CYCLE",
          `Epic dependency cycle: ${[...path, epicId].join(" -> ")}`,
          { field: "epic_id", cycle: [...path, epicId] },
        ),
      );
      return;
    }
    if (visited.has(epicId)) {
      return;
    }
    visiting.add(epicId);
    for (const dependency of dependencies.get(epicId) ?? []) {
      visit(dependency, [...path, epicId]);
    }
    visiting.delete(epicId);
    visited.add(epicId);
  };
  for (const epicId of dependencies.keys()) {
    visit(epicId, []);
  }
  return errors;
}

export function deriveEpics(tasks: readonly PlannedTask[]): PlannedEpic[] {
  const byId = new Map<string, PlannedEpic>();
  const taskEpic = new Map(tasks.map((task) => [task.id, task.epicId]));
  for (const task of tasks) {
    const existing = byId.get(task.epicId);
    if (existing === undefined) {
      byId.set(task.epicId, {
        id: task.epicId,
        title: task.epicTitle,
        outcome: task.epicOutcome,
        taskIds: [task.id],
        dependsOnEpicIds: [],
        estimateHours: task.estimateHours,
      });
      continue;
    }
    existing.taskIds.push(task.id);
    existing.estimateHours += task.estimateHours;
  }
  for (const task of tasks) {
    const epic = byId.get(task.epicId);
    if (epic === undefined) {
      continue;
    }
    for (const dependencyId of task.dependsOn) {
      const dependencyEpic = taskEpic.get(dependencyId);
      if (
        dependencyEpic !== undefined &&
        dependencyEpic !== task.epicId &&
        !epic.dependsOnEpicIds.includes(dependencyEpic)
      ) {
        epic.dependsOnEpicIds.push(dependencyEpic);
      }
    }
  }
  return [...byId.values()]
    .map((epic) => ({
      ...epic,
      estimateHours: Number(epic.estimateHours.toFixed(4)),
      dependsOnEpicIds: epic.dependsOnEpicIds.sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function generateAdrDrafts(tasks: readonly PlannedTask[]): AdrDraft[] {
  const decisions = new Map<
    string,
    {
      proposal: ArchitectureDecisionProposal;
      sourceTaskIds: string[];
    }
  >();
  for (const task of tasks) {
    for (const proposal of task.architectureDecisions) {
      const key = proposal.title.trim().toLocaleLowerCase();
      const existing = decisions.get(key);
      if (existing === undefined) {
        decisions.set(key, { proposal, sourceTaskIds: [task.id] });
      } else if (!existing.sourceTaskIds.includes(task.id)) {
        existing.sourceTaskIds.push(task.id);
      }
    }
  }
  return [...decisions.values()]
    .sort((left, right) =>
      left.proposal.title.localeCompare(right.proposal.title),
    )
    .map(({ proposal, sourceTaskIds }, index) => {
      const id = `ADR-DRAFT-${String(index + 1).padStart(3, "0")}`;
      return {
        id,
        title: proposal.title,
        status: "proposed" as const,
        sourceTaskIds,
        markdown: [
          `# ${id}: ${proposal.title}`,
          "",
          "## Status",
          "",
          "Proposed",
          "",
          "## Context",
          "",
          proposal.context,
          "",
          "## Decision",
          "",
          proposal.decision,
          "",
          "## Consequences",
          "",
          ...proposal.consequences.map((consequence) => `- ${consequence}`),
          "",
          "## Source tasks",
          "",
          ...sourceTaskIds.map((taskId) => `- ${taskId}`),
          "",
        ].join("\n"),
      };
    });
}
