import type Database from "better-sqlite3";
import { systemClock, type Clock } from "./shared.js";
import type { RetryScheduleEntity } from "./types.js";

interface RetryScheduleRow {
  task_id: string;
  build_id: string;
  failed_attempt: number;
  next_attempt: number;
  failure_code: string;
  due_at: string;
  created_at: string;
}

function mapSchedule(row: RetryScheduleRow): RetryScheduleEntity {
  return {
    taskId: row.task_id,
    buildId: row.build_id,
    failedAttempt: row.failed_attempt,
    nextAttempt: row.next_attempt,
    failureCode: row.failure_code,
    dueAt: row.due_at,
    createdAt: row.created_at,
  };
}

export class RetryScheduleRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  upsert(input: Omit<RetryScheduleEntity, "createdAt">): RetryScheduleEntity {
    const createdAt = this.clock();
    this.database.prepare(
      `INSERT INTO retry_schedules (
        task_id, build_id, failed_attempt, next_attempt, failure_code, due_at,
        created_at
      ) VALUES (
        @taskId, @buildId, @failedAttempt, @nextAttempt, @failureCode, @dueAt,
        @createdAt
      )
      ON CONFLICT(task_id) DO UPDATE SET
        failed_attempt = excluded.failed_attempt,
        next_attempt = excluded.next_attempt,
        failure_code = excluded.failure_code,
        due_at = excluded.due_at,
        created_at = excluded.created_at`,
    ).run({ ...input, createdAt });
    return this.get(input.taskId) as RetryScheduleEntity;
  }

  get(taskId: string): RetryScheduleEntity | undefined {
    const row = this.database
      .prepare<[string], RetryScheduleRow>(
        `SELECT task_id, build_id, failed_attempt, next_attempt, failure_code,
          due_at, created_at
         FROM retry_schedules WHERE task_id = ?`,
      )
      .get(taskId);
    return row === undefined ? undefined : mapSchedule(row);
  }

  list(): RetryScheduleEntity[] {
    return this.database
      .prepare<[], RetryScheduleRow>(
        `SELECT task_id, build_id, failed_attempt, next_attempt, failure_code,
          due_at, created_at
         FROM retry_schedules ORDER BY due_at, task_id`,
      )
      .all()
      .map(mapSchedule);
  }

  delete(taskId: string): boolean {
    return (
      this.database
        .prepare<[string]>("DELETE FROM retry_schedules WHERE task_id = ?")
        .run(taskId).changes === 1
    );
  }
}
