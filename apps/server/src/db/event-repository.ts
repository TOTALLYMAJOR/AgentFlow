import type Database from "better-sqlite3";
import {
  inImmediateTransaction,
  insertBuildEvent,
  mapBuildEvent,
  systemClock,
  type Clock,
} from "./shared.js";
import type {
  AppendBuildEventInput,
  BuildEventEntity,
} from "./types.js";

interface BuildEventRow {
  sequence: number;
  build_id: string;
  task_id: string | null;
  event_type: string;
  payload_json: string;
  occurred_at: string;
}
export class BuildEventRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  append(input: AppendBuildEventInput): BuildEventEntity {
    return inImmediateTransaction(this.database, () =>
      insertBuildEvent(this.database, input, this.clock),
    );
  }

  listForBuild(
    buildId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): BuildEventEntity[] {
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("Event limit must be an integer from 1 to 10000");
    }

    return this.database
      .prepare<
        { buildId: string; afterSequence: number; limit: number },
        BuildEventRow
      >(
        `SELECT
           sequence, build_id, task_id, event_type, payload_json, occurred_at
         FROM build_events
         WHERE build_id = @buildId AND sequence > @afterSequence
         ORDER BY sequence
         LIMIT @limit`,
      )
      .all({ buildId, afterSequence, limit })
      .map(mapBuildEvent);
  }

  getLatestSequence(buildId: string): number {
    const row = this.database
      .prepare<[string], { sequence: number }>(
        `SELECT COALESCE(MAX(sequence), 0) AS sequence
         FROM build_events
         WHERE build_id = ?`,
      )
      .get(buildId);
    return row?.sequence ?? 0;
  }
}
