import type Database from "better-sqlite3";
import {
  decodeJson,
  encodeJson,
  inImmediateTransaction,
  requireEntity,
  systemClock,
  type Clock,
} from "./shared.js";
import type {
  QueueRemoteJobInput,
  RemoteJobEntity,
  RemoteJobStatus,
} from "./types.js";

interface RemoteJobRow {
  id: string;
  build_id: string;
  task_id: string;
  attempt: number;
  provider_id: string;
  runner_id: string | null;
  status: RemoteJobStatus;
  payload_json: string;
  result_json: string | null;
  result_idempotency_key: string | null;
  result_sha256: string | null;
  lease_expires_at: string | null;
  queued_at: string;
  leased_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

const SELECT = `SELECT id, build_id, task_id, attempt, provider_id, runner_id,
  status, payload_json, result_json, result_idempotency_key, result_sha256,
  lease_expires_at, queued_at, leased_at, completed_at, updated_at
  FROM remote_jobs`;

function mapRemoteJob(row: RemoteJobRow): RemoteJobEntity {
  return {
    id: row.id,
    buildId: row.build_id,
    taskId: row.task_id,
    attempt: row.attempt,
    providerId: row.provider_id,
    runnerId: row.runner_id,
    status: row.status,
    payload: decodeJson(row.payload_json, "remote_jobs.payload_json"),
    result:
      row.result_json === null
        ? null
        : decodeJson(row.result_json, "remote_jobs.result_json"),
    leaseExpiresAt: row.lease_expires_at,
    queuedAt: row.queued_at,
    leasedAt: row.leased_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export class RemoteJobRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  queue(input: QueueRemoteJobInput): RemoteJobEntity {
    const queuedAt = input.queuedAt ?? this.clock();
    this.database.prepare(
      `INSERT INTO remote_jobs (
        id, build_id, task_id, attempt, provider_id, status, payload_json,
        queued_at, updated_at
      ) VALUES (
        @id, @buildId, @taskId, @attempt, @providerId, 'queued', @payloadJson,
        @queuedAt, @queuedAt
      )`,
    ).run({ ...input, payloadJson: encodeJson(input.payload), queuedAt });
    return this.getById(input.id);
  }

  getById(id: string): RemoteJobEntity {
    const row = this.database
      .prepare<[string], RemoteJobRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return mapRemoteJob(requireEntity("remote job", id, row));
  }

  list(): RemoteJobEntity[] {
    return this.database
      .prepare<[], RemoteJobRow>(`${SELECT} ORDER BY queued_at, id`)
      .all()
      .map(mapRemoteJob);
  }

  countsByStatus(): Partial<Record<RemoteJobStatus, number>> {
    const rows = this.database
      .prepare<[], { status: RemoteJobStatus; count: number }>(
        `SELECT status, COUNT(*) AS count
         FROM remote_jobs
         GROUP BY status`,
      )
      .all();
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  expireLeases(expiredAt = this.clock()): number {
    return this.database.prepare(
      `UPDATE remote_jobs SET status = 'expired', updated_at = @expiredAt
       WHERE status = 'leased' AND lease_expires_at <= @expiredAt`,
    ).run({ expiredAt }).changes;
  }

  cancelForTask(taskId: string, cancelledAt = this.clock()): number {
    return this.database.prepare(
      `UPDATE remote_jobs SET status = 'cancelled', updated_at = @cancelledAt
       WHERE task_id = @taskId AND status IN ('queued','leased')`,
    ).run({ taskId, cancelledAt }).changes;
  }

  claim(input: {
    runnerId: string;
    providerId: string;
    leaseTokenSha256: string;
    leaseExpiresAt: string;
  }): RemoteJobEntity | undefined {
    return inImmediateTransaction(this.database, () => {
      const now = this.clock();
      const runner = this.database
        .prepare<
          [string],
          {
            provider_id: string;
            status: string;
            capacity: number;
            busy_slots: number;
          }
        >(
          `SELECT provider_id, status, capacity, busy_slots
           FROM runners WHERE id = ?`,
        )
        .get(input.runnerId);
      if (
        runner === undefined ||
        runner.provider_id !== input.providerId ||
        runner.status !== "online"
      ) {
        return undefined;
      }
      const activeLeases =
        this.database
          .prepare<[string, string], { count: number }>(
            `SELECT COUNT(*) AS count
             FROM remote_jobs
             WHERE runner_id = ?
               AND status = 'leased'
               AND lease_expires_at > ?`,
          )
          .get(input.runnerId, now)?.count ?? 0;
      if (Math.max(runner.busy_slots, activeLeases) >= runner.capacity) {
        return undefined;
      }
      const row = this.database
        .prepare<[string], RemoteJobRow>(
          `${SELECT}
           WHERE provider_id = ? AND status = 'queued'
           ORDER BY queued_at, id
           LIMIT 1`,
        )
        .get(input.providerId);
      if (row === undefined) {
        return undefined;
      }
      const leasedAt = now;
      const result = this.database.prepare(
        `UPDATE remote_jobs SET
          runner_id = @runnerId,
          status = 'leased',
          lease_token_sha256 = @leaseTokenSha256,
          lease_expires_at = @leaseExpiresAt,
          leased_at = @leasedAt,
          updated_at = @leasedAt
        WHERE id = @id AND status = 'queued'`,
      ).run({ ...input, id: row.id, leasedAt });
      if (result.changes !== 1) {
        return undefined;
      }
      return this.getById(row.id);
    });
  }

  heartbeat(
    id: string,
    runnerId: string,
    leaseTokenSha256: string,
    leaseExpiresAt: string,
  ): RemoteJobEntity {
    const updatedAt = this.clock();
    const result = this.database.prepare(
      `UPDATE remote_jobs SET
        lease_expires_at = @leaseExpiresAt,
        updated_at = @updatedAt
      WHERE id = @id
        AND runner_id = @runnerId
        AND lease_token_sha256 = @leaseTokenSha256
        AND status = 'leased'
        AND lease_expires_at > @updatedAt`,
    ).run({ id, runnerId, leaseTokenSha256, leaseExpiresAt, updatedAt });
    if (result.changes !== 1) {
      throw new Error(`Remote job ${id} does not have a current lease`);
    }
    return this.getById(id);
  }

  complete(input: {
    id: string;
    runnerId: string;
    leaseTokenSha256: string;
    idempotencyKey: string;
    resultSha256: string;
    status: Extract<RemoteJobStatus, "completed" | "failed">;
    result: Record<string, unknown>;
  }): RemoteJobEntity {
    return inImmediateTransaction(this.database, () => {
      const existing = this.database
        .prepare<[string], RemoteJobRow>(`${SELECT} WHERE id = ?`)
        .get(input.id);
      const job = requireEntity("remote job", input.id, existing);
      if (job.status === "completed" || job.status === "failed") {
        if (
          job.result_idempotency_key === input.idempotencyKey &&
          job.result_sha256 === input.resultSha256
        ) {
          return mapRemoteJob(job);
        }
        throw new Error(`Remote job ${input.id} already has a different result`);
      }
      const completedAt = this.clock();
      const result = this.database.prepare(
        `UPDATE remote_jobs SET
          status = @status,
          result_json = @resultJson,
          result_idempotency_key = @idempotencyKey,
          result_sha256 = @resultSha256,
          completed_at = @completedAt,
          updated_at = @completedAt
        WHERE id = @id
          AND runner_id = @runnerId
          AND lease_token_sha256 = @leaseTokenSha256
          AND status = 'leased'
          AND lease_expires_at > @completedAt`,
      ).run({
        ...input,
        resultJson: encodeJson(input.result),
        completedAt,
      });
      if (result.changes !== 1) {
        throw new Error(`Remote job ${input.id} does not have a current lease`);
      }
      return this.getById(input.id);
    });
  }
}
