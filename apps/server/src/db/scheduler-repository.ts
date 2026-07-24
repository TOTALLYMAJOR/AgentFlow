import type Database from "better-sqlite3";
import {
  inImmediateTransaction,
  systemClock,
  type Clock,
} from "./shared.js";

export interface SchedulerCycle {
  buildId: string;
  cycle: number;
  readyAgeCycles: Readonly<Record<string, number>>;
  updatedAt: string;
}

export class SchedulerStateRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  advance(
    buildId: string,
    readyCandidateIds: readonly string[],
  ): SchedulerCycle {
    return inImmediateTransaction(this.database, () => {
      const updatedAt = this.clock();
      this.database
        .prepare<{ buildId: string; updatedAt: string }>(
          `INSERT INTO build_scheduler_state (build_id, cycle, updated_at)
           VALUES (@buildId, 1, @updatedAt)
           ON CONFLICT(build_id) DO UPDATE SET
             cycle = cycle + 1,
             updated_at = excluded.updated_at`,
        )
        .run({ buildId, updatedAt });
      this.database
        .prepare<{ buildId: string; updatedAt: string }>(
          `INSERT INTO task_scheduler_state (
             task_id, build_id, ready_age_cycles, updated_at
           )
           SELECT id, build_id, 0, @updatedAt
           FROM tasks
           WHERE build_id = @buildId
           ON CONFLICT(task_id) DO NOTHING`,
        )
        .run({ buildId, updatedAt });
      const candidateIds = new Set(readyCandidateIds);
      const currentAges = this.database
        .prepare<[string], { task_id: string; ready_age_cycles: number }>(
          `SELECT task_id, ready_age_cycles
           FROM task_scheduler_state
           WHERE build_id = ?`,
        )
        .all(buildId);
      const updateAge = this.database.prepare<{
        buildId: string;
        taskId: string;
        readyAgeCycles: number;
        updatedAt: string;
      }>(
        `UPDATE task_scheduler_state
         SET ready_age_cycles = @readyAgeCycles,
             updated_at = @updatedAt
         WHERE build_id = @buildId AND task_id = @taskId`,
      );
      for (const row of currentAges) {
        updateAge.run({
          buildId,
          taskId: row.task_id,
          readyAgeCycles: candidateIds.has(row.task_id)
            ? row.ready_age_cycles + 1
            : 0,
          updatedAt,
        });
      }
      return this.get(buildId);
    });
  }

  get(buildId: string): SchedulerCycle {
    const state = this.database
      .prepare<
        [string],
        { build_id: string; cycle: number; updated_at: string }
      >(
        `SELECT build_id, cycle, updated_at
         FROM build_scheduler_state
         WHERE build_id = ?`,
      )
      .get(buildId);
    const ages = this.database
      .prepare<[string], { task_id: string; ready_age_cycles: number }>(
        `SELECT task_id, ready_age_cycles
         FROM task_scheduler_state
         WHERE build_id = ?
         ORDER BY task_id`,
      )
      .all(buildId);
    return {
      buildId,
      cycle: state?.cycle ?? 0,
      readyAgeCycles: Object.fromEntries(
        ages.map((row) => [row.task_id, row.ready_age_cycles]),
      ),
      updatedAt: state?.updated_at ?? this.clock(),
    };
  }
}
