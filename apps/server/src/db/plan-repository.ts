import type Database from "better-sqlite3";
import type { PlanResult } from "../domain/types.js";
import {
  decodeJson,
  encodeJson,
  requireEntity,
  systemClock,
  type Clock,
} from "./shared.js";
import type { CreatePlanInput, PlanEntity } from "./types.js";

interface PlanRow {
  id: string;
  repository_id: string;
  backlog_path: string;
  backlog_sha256: string;
  backlog_contents: string;
  repository_config_json: string;
  normalized_plan_json: string;
  sequential_estimate_hours: number;
  critical_path_hours: number;
  expected_elapsed_hours: number;
  expected_savings_percent: number;
  maximum_theoretical_concurrency: number;
  worker_efficiency: number;
  overhead_percent: number;
  locked_at: string | null;
  created_at: string;
}

function mapPlan(row: PlanRow): PlanEntity {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    backlogPath: row.backlog_path,
    backlogSha256: row.backlog_sha256,
    backlogContents: row.backlog_contents,
    repositoryConfig: decodeJson<Record<string, unknown>>(
      row.repository_config_json,
      "plans.repository_config_json",
    ),
    normalizedPlan: decodeJson<PlanResult>(
      row.normalized_plan_json,
      "plans.normalized_plan_json",
    ),
    sequentialEstimateHours: row.sequential_estimate_hours,
    criticalPathHours: row.critical_path_hours,
    expectedElapsedHours: row.expected_elapsed_hours,
    expectedSavingsPercent: row.expected_savings_percent,
    maximumTheoreticalConcurrency: row.maximum_theoretical_concurrency,
    workerEfficiency: row.worker_efficiency,
    overheadPercent: row.overhead_percent,
    lockedAt: row.locked_at,
    createdAt: row.created_at,
  };
}

const PLAN_SELECT = `
  SELECT
    id, repository_id, backlog_path, backlog_sha256, backlog_contents,
    repository_config_json, normalized_plan_json, sequential_estimate_hours,
    critical_path_hours, expected_elapsed_hours, expected_savings_percent,
    maximum_theoretical_concurrency, worker_efficiency, overhead_percent,
    locked_at, created_at
  FROM plans
`;

export class PlanRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  create(input: CreatePlanInput): PlanEntity {
    const estimates = input.normalizedPlan.estimates;
    this.database
      .prepare<{
        id: string;
        repositoryId: string;
        backlogPath: string;
        backlogSha256: string;
        backlogContents: string;
        repositoryConfigJson: string;
        normalizedPlanJson: string;
        sequentialEstimateHours: number;
        criticalPathHours: number;
        expectedElapsedHours: number;
        expectedSavingsPercent: number;
        maximumTheoreticalConcurrency: number;
        workerEfficiency: number;
        overheadPercent: number;
        createdAt: string;
      }>(
        `INSERT INTO plans (
           id, repository_id, backlog_path, backlog_sha256, backlog_contents,
           repository_config_json, normalized_plan_json,
           sequential_estimate_hours, critical_path_hours,
           expected_elapsed_hours, expected_savings_percent,
           maximum_theoretical_concurrency, worker_efficiency,
           overhead_percent, created_at
         ) VALUES (
           @id, @repositoryId, @backlogPath, @backlogSha256, @backlogContents,
           @repositoryConfigJson, @normalizedPlanJson,
           @sequentialEstimateHours, @criticalPathHours,
           @expectedElapsedHours, @expectedSavingsPercent,
           @maximumTheoreticalConcurrency, @workerEfficiency,
           @overheadPercent, @createdAt
         )`,
      )
      .run({
        id: input.id,
        repositoryId: input.repositoryId,
        backlogPath: input.backlogPath,
        backlogSha256: input.backlogSha256,
        backlogContents: input.backlogContents,
        repositoryConfigJson: encodeJson(input.repositoryConfig ?? {}),
        normalizedPlanJson: encodeJson(input.normalizedPlan),
        sequentialEstimateHours:
          input.sequentialEstimateHours ?? estimates.sequentialHours,
        criticalPathHours:
          input.criticalPathHours ?? estimates.criticalPathHours,
        expectedElapsedHours:
          input.expectedElapsedHours ?? estimates.expectedElapsedHours,
        expectedSavingsPercent:
          input.expectedSavingsPercent ?? estimates.expectedSavingsPercent,
        maximumTheoreticalConcurrency:
          input.maximumTheoreticalConcurrency ??
          estimates.maximumTheoreticalConcurrency,
        workerEfficiency: input.workerEfficiency ?? estimates.workerEfficiency,
        overheadPercent: input.overheadPercent ?? estimates.overheadPercent,
        createdAt: input.createdAt ?? this.clock(),
      });
    return this.getById(input.id);
  }

  getById(id: string): PlanEntity {
    const row = this.database
      .prepare<[string], PlanRow>(`${PLAN_SELECT} WHERE id = ?`)
      .get(id);
    return mapPlan(requireEntity("plan", id, row));
  }

  findById(id: string): PlanEntity | undefined {
    const row = this.database
      .prepare<[string], PlanRow>(`${PLAN_SELECT} WHERE id = ?`)
      .get(id);
    return row === undefined ? undefined : mapPlan(row);
  }

  listForRepository(repositoryId: string): PlanEntity[] {
    return this.database
      .prepare<[string], PlanRow>(
        `${PLAN_SELECT}
         WHERE repository_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(repositoryId)
      .map(mapPlan);
  }

  lock(id: string, lockedAt = this.clock()): PlanEntity {
    const current = this.getById(id);
    if (current.lockedAt !== null) {
      return current;
    }
    const result = this.database
      .prepare<{ id: string; lockedAt: string }>(
        `UPDATE plans
         SET locked_at = COALESCE(locked_at, @lockedAt)
         WHERE id = @id`,
      )
      .run({ id, lockedAt });
    if (result.changes !== 1) {
      requireEntity("plan", id, undefined);
    }
    return this.getById(id);
  }
}
