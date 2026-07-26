import type Database from "better-sqlite3";
import type { PlanEstimates } from "../domain/types.js";

export interface EstimateCalibration {
  repositoryId: string;
  taskSampleCount: number;
  buildSampleCount: number;
  taskMedianActualToEstimateRatio: number | null;
  buildMedianActualToEstimateRatio: number | null;
  appliedMultiplier: number;
  confidence: "insufficient" | "low" | "medium" | "high";
}

export function calculateEstimateCalibration(
  database: Database.Database,
  repositoryId: string,
): EstimateCalibration {
  const taskRatios = database
    .prepare<[string], { ratio: number }>(
      `SELECT
        ((julianday(tasks.completed_at) - julianday(tasks.started_at)) * 24.0)
          / tasks.estimate_hours AS ratio
       FROM tasks
       JOIN builds ON builds.id = tasks.build_id
       WHERE builds.repository_id = ?
         AND tasks.state = 'integrated'
         AND tasks.estimate_hours > 0
         AND tasks.started_at IS NOT NULL
         AND tasks.completed_at IS NOT NULL
         AND tasks.completed_at > tasks.started_at`,
    )
    .all(repositoryId)
    .map((row) => row.ratio)
    .filter(Number.isFinite);
  const buildRatios = database
    .prepare<[string], { ratio: number }>(
      `SELECT
        (actual_elapsed_seconds / 3600.0) / expected_elapsed_hours AS ratio
       FROM builds
       WHERE repository_id = ?
         AND status = 'completed'
         AND actual_elapsed_seconds > 0
         AND expected_elapsed_hours > 0`,
    )
    .all(repositoryId)
    .map((row) => row.ratio)
    .filter(Number.isFinite);
  const taskMedian = median(taskRatios);
  const buildMedian = median(buildRatios);
  const taskSampleCount = taskRatios.length;
  const appliedMultiplier =
    taskMedian === null || taskSampleCount < 3
      ? 1
      : clamp(taskMedian, 0.5, 3);
  return {
    repositoryId,
    taskSampleCount,
    buildSampleCount: buildRatios.length,
    taskMedianActualToEstimateRatio: taskMedian,
    buildMedianActualToEstimateRatio: buildMedian,
    appliedMultiplier,
    confidence:
      taskSampleCount < 3
        ? "insufficient"
        : taskSampleCount < 10
          ? "low"
          : taskSampleCount < 30
            ? "medium"
            : "high",
  };
}

export function applyEstimateCalibration(
  estimates: PlanEstimates,
  calibration: EstimateCalibration,
): PlanEstimates {
  const multiplier = calibration.appliedMultiplier;
  return {
    ...estimates,
    sequentialHours: round(estimates.sequentialHours * multiplier),
    criticalPathHours: round(estimates.criticalPathHours * multiplier),
    expectedElapsedHours: round(estimates.expectedElapsedHours * multiplier),
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return round(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
