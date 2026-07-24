import type { BuildStatus, TaskStatus } from "../domain/types.js";
import { AgentFlowError } from "../http/errors.js";

const buildTransitions: Readonly<Record<BuildStatus, readonly BuildStatus[]>> = {
  planning: ["ready", "failed", "cancelled"],
  ready: ["running", "failed", "cancelled"],
  running: ["paused", "completed", "failed", "cancelled", "interrupted"],
  paused: ["running", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: ["running", "paused", "failed", "cancelled"],
};

const taskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["blocked", "ready", "failed", "cancelled", "blocked_failed"],
  blocked: ["ready", "failed", "cancelled", "blocked_failed"],
  ready: ["running", "failed", "cancelled"],
  running: ["validating", "failed", "cancelled", "interrupted"],
  validating: ["validated", "failed", "cancelled", "interrupted"],
  validated: ["integrating", "failed", "cancelled"],
  integrating: ["integrated", "failed", "interrupted"],
  integrated: [],
  failed: ["ready"],
  cancelled: [],
  interrupted: ["ready", "validating", "integrating", "failed", "cancelled"],
  blocked_failed: ["ready", "cancelled"],
};

export function canTransitionBuild(
  from: BuildStatus,
  to: BuildStatus,
): boolean {
  return buildTransitions[from].includes(to);
}

export function assertBuildTransition(
  from: BuildStatus,
  to: BuildStatus,
): void {
  if (!canTransitionBuild(from, to)) {
    throw new AgentFlowError(
      "ILLEGAL_BUILD_TRANSITION",
      `Build cannot transition from ${from} to ${to}`,
      409,
      { from, to, allowed: buildTransitions[from] },
    );
  }
}

export function canTransitionTask(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return taskTransitions[from].includes(to);
}

export function assertTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
): void {
  if (!canTransitionTask(from, to)) {
    throw new AgentFlowError(
      "ILLEGAL_TASK_TRANSITION",
      `Task cannot transition from ${from} to ${to}`,
      409,
      { from, to, allowed: taskTransitions[from] },
    );
  }
}

export function getAllowedBuildTransitions(
  status: BuildStatus,
): readonly BuildStatus[] {
  return buildTransitions[status];
}

export function getAllowedTaskTransitions(
  status: TaskStatus,
): readonly TaskStatus[] {
  return taskTransitions[status];
}
