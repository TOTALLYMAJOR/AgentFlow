import type Database from "better-sqlite3";
import { canTransitionBuild } from "../orchestration/state-machines.js";
import {
  ConcurrentStateChangeError,
  InvalidStateTransitionError,
  decodeJson,
  encodeJson,
  inImmediateTransaction,
  insertBuildEvent,
  requireEntity,
  systemClock,
  type Clock,
} from "./shared.js";
import {
  insertTaskRecord,
  insertTaskRelations,
} from "./task-repository.js";
import type {
  BuildEntity,
  BuildStatus,
  CreateBuildInput,
} from "./types.js";

interface BuildRow {
  id: string;
  repository_id: string;
  plan_id: string | null;
  backlog_path: string;
  backlog_sha256: string | null;
  base_commit: string;
  integration_branch: string;
  integration_worktree: string | null;
  repository_config_json: string;
  backlog_contents: string;
  normalized_plan_json: string;
  status: BuildStatus;
  worker_limit: number;
  sequential_estimate_hours: number | null;
  critical_path_hours: number | null;
  expected_elapsed_hours: number | null;
  expected_savings_percent: number | null;
  actual_elapsed_seconds: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface PlanSnapshotRow {
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
  locked_at: string | null;
}

function mapBuild(row: BuildRow): BuildEntity {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    planId: row.plan_id,
    backlogPath: row.backlog_path,
    backlogSha256: row.backlog_sha256,
    baseCommit: row.base_commit,
    integrationBranch: row.integration_branch,
    integrationWorktree: row.integration_worktree,
    repositoryConfig: decodeJson<Record<string, unknown>>(
      row.repository_config_json,
      "builds.repository_config_json",
    ),
    backlogContents: row.backlog_contents,
    normalizedPlan: decodeJson<Record<string, unknown>>(
      row.normalized_plan_json,
      "builds.normalized_plan_json",
    ),
    status: row.status,
    workerLimit: row.worker_limit,
    sequentialEstimateHours: row.sequential_estimate_hours,
    criticalPathHours: row.critical_path_hours,
    expectedElapsedHours: row.expected_elapsed_hours,
    expectedSavingsPercent: row.expected_savings_percent,
    actualElapsedSeconds: row.actual_elapsed_seconds,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

const BUILD_SELECT = `
  SELECT
    id, repository_id, plan_id, backlog_path, backlog_sha256, base_commit,
    integration_branch, integration_worktree, repository_config_json,
    backlog_contents, normalized_plan_json, status, worker_limit,
    sequential_estimate_hours, critical_path_hours, expected_elapsed_hours,
    expected_savings_percent, actual_elapsed_seconds, started_at, completed_at,
    created_at
  FROM builds
`;

export interface BuildTransitionOptions {
  eventType?: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  actualElapsedSeconds?: number | null;
}

export class BuildRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  create(input: CreateBuildInput): BuildEntity {
    return inImmediateTransaction(this.database, () => {
      const createdAt = input.createdAt ?? this.clock();
      const plan =
        input.planId === undefined || input.planId === null
          ? undefined
          : this.database
              .prepare<[string], PlanSnapshotRow>(
                `SELECT
                   repository_id, backlog_path, backlog_sha256,
                   backlog_contents, repository_config_json,
                   normalized_plan_json, sequential_estimate_hours,
                   critical_path_hours, expected_elapsed_hours,
                   expected_savings_percent, locked_at
                 FROM plans
                 WHERE id = ?`,
              )
              .get(input.planId);

      if (input.planId !== undefined && input.planId !== null) {
        requireEntity("plan", input.planId, plan);
      }
      if (plan !== undefined && plan.repository_id !== input.repositoryId) {
        throw new Error(
          `Plan ${input.planId ?? ""} belongs to a different repository`,
        );
      }
      if (
        plan !== undefined &&
        plan.locked_at === null &&
        input.planId !== undefined &&
        input.planId !== null
      ) {
        this.database
          .prepare<{ id: string; lockedAt: string }>(
            `UPDATE plans SET locked_at = @lockedAt WHERE id = @id`,
          )
          .run({ id: input.planId, lockedAt: createdAt });
      }

      this.database
        .prepare<{
          id: string;
          repositoryId: string;
          planId: string | null;
          backlogPath: string;
          backlogSha256: string | null;
          baseCommit: string;
          integrationBranch: string;
          integrationWorktree: string | null;
          repositoryConfigJson: string;
          backlogContents: string;
          normalizedPlanJson: string;
          status: BuildStatus;
          workerLimit: number;
          sequentialEstimateHours: number | null;
          criticalPathHours: number | null;
          expectedElapsedHours: number | null;
          expectedSavingsPercent: number | null;
          actualElapsedSeconds: number | null;
          startedAt: string | null;
          completedAt: string | null;
          createdAt: string;
        }>(
          `INSERT INTO builds (
             id, repository_id, plan_id, backlog_path, backlog_sha256,
             base_commit, integration_branch, integration_worktree,
             repository_config_json, backlog_contents, normalized_plan_json,
             status, worker_limit, sequential_estimate_hours,
             critical_path_hours, expected_elapsed_hours,
             expected_savings_percent, actual_elapsed_seconds, started_at,
             completed_at, created_at
           ) VALUES (
             @id, @repositoryId, @planId, @backlogPath, @backlogSha256,
             @baseCommit, @integrationBranch, @integrationWorktree,
             @repositoryConfigJson, @backlogContents, @normalizedPlanJson,
             @status, @workerLimit, @sequentialEstimateHours,
             @criticalPathHours, @expectedElapsedHours,
             @expectedSavingsPercent, @actualElapsedSeconds, @startedAt,
             @completedAt, @createdAt
           )`,
        )
        .run({
          id: input.id,
          repositoryId: input.repositoryId,
          planId: input.planId ?? null,
          backlogPath: plan?.backlog_path ?? input.backlogPath,
          backlogSha256:
            plan?.backlog_sha256 ?? input.backlogSha256 ?? null,
          baseCommit: input.baseCommit,
          integrationBranch: input.integrationBranch,
          integrationWorktree: input.integrationWorktree ?? null,
          repositoryConfigJson:
            plan?.repository_config_json ??
            encodeJson(input.repositoryConfig ?? {}),
          backlogContents:
            plan?.backlog_contents ?? input.backlogContents ?? "",
          normalizedPlanJson:
            plan?.normalized_plan_json ?? encodeJson(input.normalizedPlan ?? {}),
          status: input.status ?? "planning",
          workerLimit: input.workerLimit ?? 4,
          sequentialEstimateHours:
            plan?.sequential_estimate_hours ??
            input.sequentialEstimateHours ??
            null,
          criticalPathHours:
            plan?.critical_path_hours ?? input.criticalPathHours ?? null,
          expectedElapsedHours:
            plan?.expected_elapsed_hours ?? input.expectedElapsedHours ?? null,
          expectedSavingsPercent:
            plan?.expected_savings_percent ??
            input.expectedSavingsPercent ??
            null,
          actualElapsedSeconds: input.actualElapsedSeconds ?? null,
          startedAt: input.startedAt ?? null,
          completedAt: input.completedAt ?? null,
          createdAt,
        });

      for (const task of input.tasks ?? []) {
        insertTaskRecord(this.database, input.id, task, this.clock);
      }
      for (const task of input.tasks ?? []) {
        insertTaskRelations(this.database, task);
      }

      insertBuildEvent(
        this.database,
        {
          buildId: input.id,
          type: "build.created",
          payload: {
            status: input.status ?? "planning",
            planId: input.planId ?? null,
            taskCount: input.tasks?.length ?? 0,
          },
          occurredAt: createdAt,
        },
        this.clock,
      );
      return this.getById(input.id);
    });
  }

  getById(id: string): BuildEntity {
    const row = this.database
      .prepare<[string], BuildRow>(`${BUILD_SELECT} WHERE id = ?`)
      .get(id);
    return mapBuild(requireEntity("build", id, row));
  }

  findById(id: string): BuildEntity | undefined {
    const row = this.database
      .prepare<[string], BuildRow>(`${BUILD_SELECT} WHERE id = ?`)
      .get(id);
    return row === undefined ? undefined : mapBuild(row);
  }

  list(repositoryId?: string): BuildEntity[] {
    if (repositoryId === undefined) {
      return this.database
        .prepare<[], BuildRow>(
          `${BUILD_SELECT} ORDER BY created_at DESC, id DESC`,
        )
        .all()
        .map(mapBuild);
    }
    return this.database
      .prepare<[string], BuildRow>(
        `${BUILD_SELECT}
         WHERE repository_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(repositoryId)
      .map(mapBuild);
  }

  findActive(repositoryId?: string): BuildEntity | undefined {
    const row =
      repositoryId === undefined
        ? this.database
            .prepare<[], BuildRow>(
              `${BUILD_SELECT}
               WHERE status IN ('planning','ready','running','paused','interrupted')
               ORDER BY created_at DESC, id DESC
               LIMIT 1`,
            )
            .get()
        : this.database
            .prepare<[string], BuildRow>(
              `${BUILD_SELECT}
               WHERE repository_id = ?
                 AND status IN ('planning','ready','running','paused','interrupted')
               ORDER BY created_at DESC, id DESC
               LIMIT 1`,
            )
            .get(repositoryId);
    return row === undefined ? undefined : mapBuild(row);
  }

  listActive(): BuildEntity[] {
    return this.database
      .prepare<[], BuildRow>(
        `${BUILD_SELECT}
         WHERE status IN ('planning','ready','running','paused','interrupted')
         ORDER BY created_at DESC, id DESC`,
      )
      .all()
      .map(mapBuild);
  }

  transition(
    id: string,
    to: BuildStatus,
    options: BuildTransitionOptions = {},
  ): BuildEntity {
    return inImmediateTransaction(this.database, () => {
      const build = this.getById(id);
      if (!canTransitionBuild(build.status, to)) {
        throw new InvalidStateTransitionError("build", id, build.status, to);
      }
      const occurredAt = options.occurredAt ?? this.clock();
      const startedAt =
        to === "running" && build.startedAt === null
          ? occurredAt
          : build.startedAt;
      const completedAt = ["completed", "failed", "cancelled"].includes(to)
        ? occurredAt
        : null;

      const result = this.database
        .prepare<{
          id: string;
          expectedStatus: BuildStatus;
          status: BuildStatus;
          startedAt: string | null;
          completedAt: string | null;
          actualElapsedSeconds: number | null;
        }>(
          `UPDATE builds
           SET status = @status,
               started_at = @startedAt,
               completed_at = @completedAt,
               actual_elapsed_seconds = @actualElapsedSeconds
           WHERE id = @id AND status = @expectedStatus`,
        )
        .run({
          id,
          expectedStatus: build.status,
          status: to,
          startedAt,
          completedAt,
          actualElapsedSeconds:
            options.actualElapsedSeconds === undefined
              ? build.actualElapsedSeconds
              : options.actualElapsedSeconds,
        });
      if (result.changes !== 1) {
        throw new ConcurrentStateChangeError("build", id);
      }

      insertBuildEvent(
        this.database,
        {
          buildId: id,
          type: options.eventType ?? "build.status_changed",
          payload: {
            from: build.status,
            to,
            ...(options.payload ?? {}),
          },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }

  setIntegrationWorktree(
    id: string,
    integrationWorktree: string,
  ): BuildEntity {
    const result = this.database
      .prepare<{ id: string; integrationWorktree: string }>(
        `UPDATE builds
         SET integration_worktree = @integrationWorktree
         WHERE id = @id`,
      )
      .run({ id, integrationWorktree });
    if (result.changes !== 1) {
      requireEntity("build", id, undefined);
    }
    return this.getById(id);
  }
}
