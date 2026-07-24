import type { BuildStatus, TaskStatus } from "../domain/types.js";
import { tasksOwnershipConflict } from "./ownership.js";

export interface SchedulingArtifactRequirement {
  name: string;
  version: string;
  status: "produced" | "validated" | "integrated" | "invalidated" | "missing";
}

export interface SchedulingTask {
  id: string;
  state: TaskStatus;
  dependencyIds: string[];
  owns: string[];
  artifactRequirements: SchedulingArtifactRequirement[];
  criticalPath: boolean;
  readyAgeCycles: number;
  riskScore: number;
  approvalOutstanding: boolean;
}

export interface RankingExplanation {
  downstreamImpact: number;
  criticalPath: number;
  queueAge: number;
  risk: number;
  score: number;
  summary: string;
}

export interface DispatchDecision {
  selectedTaskIds: string[];
  rankings: Array<{
    taskId: string;
    eligible: boolean;
    reason: string;
    explanation: RankingExplanation;
  }>;
  blockedFailedTaskIds: string[];
  deadlock: string | null;
}

const runnableBuildStates: readonly BuildStatus[] = ["running"];
const failedTaskStates: readonly TaskStatus[] = [
  "failed",
  "blocked_failed",
  "cancelled",
];

export function scheduleTasks(
  buildStatus: BuildStatus,
  tasks: readonly SchedulingTask[],
  activeTaskIds: readonly string[],
  requestedWorkerLimit: number,
  assignedWorkerCount = activeTaskIds.length,
): DispatchDecision {
  const workerLimit = Math.min(4, Math.max(1, requestedWorkerLimit));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const active = activeTaskIds
    .map((id) => byId.get(id))
    .filter((task): task is SchedulingTask => task !== undefined);
  const blockedFailedTaskIds = tasks
    .filter(
      (task) =>
        ["pending", "blocked", "ready"].includes(task.state) &&
        task.dependencyIds.some((id) => {
          const dependency = byId.get(id);
          return (
            dependency !== undefined &&
            failedTaskStates.includes(dependency.state)
          );
        }),
    )
    .map((task) => task.id)
    .sort();

  const impactCounts = new Map(
    tasks.map((task) => [task.id, countDownstream(task.id, tasks)]),
  );
  const maxImpact = Math.max(1, ...impactCounts.values());
  const maxAge = Math.max(1, ...tasks.map((task) => task.readyAgeCycles));
  const candidates = tasks
    .filter((task) => ["pending", "blocked", "ready"].includes(task.state))
    .map((task) => {
      const downstreamImpact = (impactCounts.get(task.id) ?? 0) / maxImpact;
      const criticalPath = task.criticalPath ? 1 : 0;
      const queueAge = Math.max(0, task.readyAgeCycles) / maxAge;
      const risk = Math.min(1, Math.max(0, task.riskScore));
      const score =
        4 * downstreamImpact +
        3 * criticalPath +
        2 * queueAge -
        2 * risk;
      const explanation: RankingExplanation = {
        downstreamImpact,
        criticalPath,
        queueAge,
        risk,
        score,
        summary: `impact ${downstreamImpact.toFixed(2)}, critical ${criticalPath}, age ${queueAge.toFixed(2)}, risk ${risk.toFixed(2)}`,
      };
      const eligibility = explainEligibility(
        task,
        buildStatus,
        byId,
        active,
        blockedFailedTaskIds,
      );
      return {
        task,
        eligible: eligibility.eligible,
        reason: eligibility.reason,
        explanation,
      };
    })
    .sort(
      (first, second) =>
        second.explanation.score - first.explanation.score ||
        first.task.id.localeCompare(second.task.id),
    );

  const capacity = runnableBuildStates.includes(buildStatus)
    ? Math.max(0, workerLimit - Math.max(0, assignedWorkerCount))
    : 0;
  const selected: SchedulingTask[] = [];
  for (const candidate of candidates) {
    if (
      selected.length >= capacity ||
      !candidate.eligible ||
      selected.some((chosen) =>
        tasksOwnershipConflict(candidate.task.owns, chosen.owns),
      )
    ) {
      continue;
    }
    selected.push(candidate.task);
  }

  const unfinished = tasks.filter(
    (task) =>
      !["integrated", "failed", "cancelled", "blocked_failed"].includes(
        task.state,
      ),
  );
  const deadlock =
    buildStatus === "running" &&
    active.length === 0 &&
    selected.length === 0 &&
    unfinished.length > 0
      ? describeDeadlock(unfinished, byId)
      : null;

  return {
    selectedTaskIds: selected.map((task) => task.id),
    rankings: candidates.map(({ task, eligible, reason, explanation }) => ({
      taskId: task.id,
      eligible,
      reason,
      explanation,
    })),
    blockedFailedTaskIds,
    deadlock,
  };
}

function explainEligibility(
  task: SchedulingTask,
  buildStatus: BuildStatus,
  byId: ReadonlyMap<string, SchedulingTask>,
  active: readonly SchedulingTask[],
  blockedFailedTaskIds: readonly string[],
): { eligible: boolean; reason: string } {
  if (!runnableBuildStates.includes(buildStatus)) {
    return { eligible: false, reason: `build is ${buildStatus}` };
  }
  if (blockedFailedTaskIds.includes(task.id)) {
    return { eligible: false, reason: "a dependency failed" };
  }
  const missingDependencies = task.dependencyIds.filter(
    (id) => byId.get(id)?.state !== "integrated",
  );
  if (missingDependencies.length > 0) {
    return {
      eligible: false,
      reason: `dependencies not integrated: ${missingDependencies.join(", ")}`,
    };
  }
  const unavailableArtifacts = task.artifactRequirements.filter(
    (artifact) => artifact.status !== "integrated",
  );
  if (unavailableArtifacts.length > 0) {
    return {
      eligible: false,
      reason: `artifacts not integrated: ${unavailableArtifacts
        .map((artifact) => `${artifact.name}@${artifact.version}`)
        .join(", ")}`,
    };
  }
  if (task.approvalOutstanding) {
    return { eligible: false, reason: "approval is outstanding" };
  }
  if (
    active.some((activeTask) =>
      tasksOwnershipConflict(task.owns, activeTask.owns),
    )
  ) {
    return { eligible: false, reason: "ownership conflicts with active task" };
  }
  return { eligible: true, reason: "all dispatch gates passed" };
}

function countDownstream(
  taskId: string,
  tasks: readonly SchedulingTask[],
): number {
  const seen = new Set<string>();
  const visit = (id: string): void => {
    for (const task of tasks) {
      if (task.dependencyIds.includes(id) && !seen.has(task.id)) {
        seen.add(task.id);
        visit(task.id);
      }
    }
  };
  visit(taskId);
  return seen.size;
}

function describeDeadlock(
  unfinished: readonly SchedulingTask[],
  byId: ReadonlyMap<string, SchedulingTask>,
): string {
  const reasons = unfinished.map((task) => {
    const waiting = task.dependencyIds.filter(
      (dependencyId) => byId.get(dependencyId)?.state !== "integrated",
    );
    if (task.approvalOutstanding) {
      return `${task.id}: approval outstanding`;
    }
    if (waiting.length > 0) {
      return `${task.id}: waiting for ${waiting.join(", ")}`;
    }
    const artifacts = task.artifactRequirements.filter(
      (artifact) => artifact.status !== "integrated",
    );
    if (artifacts.length > 0) {
      return `${task.id}: missing integrated artifacts`;
    }
    return `${task.id}: no eligible worker path`;
  });
  return `Scheduler deadlock. ${reasons.join("; ")}`;
}
