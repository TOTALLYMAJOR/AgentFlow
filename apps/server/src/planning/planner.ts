import { readFile } from "node:fs/promises";

import { uniquePlanningErrors } from "./errors.js";
import { calculatePlanEstimates, resolvePlanningOptions } from "./estimates.js";
import { buildExecutionWaves } from "./graph.js";
import { findOwnershipConflicts } from "./ownership.js";
import {
  deriveEpics,
  generateAdrDrafts,
  validateEpicDecomposition,
} from "./epics.js";
import { parseBacklogMarkdown } from "./parser.js";
import {
  BacklogPlanningError,
  type BacklogPlan,
  type BacklogPlanResult,
  type PlanningOptions,
} from "./types.js";
import { validatePlannedTasks } from "./validation.js";

export function planBacklogMarkdown(
  markdown: string,
  options: PlanningOptions = {},
): BacklogPlanResult {
  const resolved = resolvePlanningOptions(options);
  const parsed = parseBacklogMarkdown(markdown, {
    defaultValidation: resolved.options.defaultValidation,
  });
  const errors = uniquePlanningErrors([
    ...resolved.errors,
    ...parsed.errors,
    ...validatePlannedTasks(parsed.tasks),
    ...validateEpicDecomposition(parsed.tasks),
  ]);

  if (errors.length > 0) {
    return {
      valid: false,
      tasks: parsed.tasks,
      errors,
    };
  }

  const waves = buildExecutionWaves(parsed.tasks);
  const plan: BacklogPlan = {
    tasks: parsed.tasks,
    waves,
    ownershipConflicts: findOwnershipConflicts(parsed.tasks),
    estimates: calculatePlanEstimates(parsed.tasks, waves, resolved.options),
    epics: deriveEpics(parsed.tasks),
    adrDrafts: generateAdrDrafts(parsed.tasks),
  };
  return {
    valid: true,
    tasks: parsed.tasks,
    errors: [],
    plan,
  };
}

export async function planBacklogFile(
  backlogPath: string,
  options: PlanningOptions = {},
): Promise<BacklogPlanResult> {
  const markdown = await readFile(backlogPath, "utf8");
  return planBacklogMarkdown(markdown, options);
}

export function planBacklogOrThrow(
  markdown: string,
  options: PlanningOptions = {},
): BacklogPlan {
  const result = planBacklogMarkdown(markdown, options);
  if (!result.valid || result.plan === undefined) {
    throw new BacklogPlanningError(result.errors);
  }
  return result.plan;
}
