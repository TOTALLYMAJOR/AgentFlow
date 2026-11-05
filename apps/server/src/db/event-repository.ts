import { canonicalJsonSha256 } from "../integration/design-intelligence.js";
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
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError("Event cursor must be a nonnegative safe integer");
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

  findByExperimentId(experimentId: string): BuildEventEntity | undefined {
    const rows = this.database.prepare<[string], BuildEventRow>(
      `SELECT sequence, build_id, task_id, event_type, payload_json, occurred_at
       FROM build_events WHERE event_type = 'wale.experiment.bound'
       AND json_extract(payload_json, '$.experimentId') = ? ORDER BY sequence LIMIT 2`,
    ).all(experimentId);
    if (rows.length > 1) throw new Error("Conflicting experiment bindings");
    return rows[0] === undefined ? undefined : mapBuildEvent(rows[0]);
  }

  appendExperimentBinding(buildId: string, experiment: Record<string, unknown>): BuildEventEntity {
    return inImmediateTransaction(this.database, () => {
      if (typeof experiment.experimentId !== "string") throw new Error("Invalid experiment identity");
      const existing = this.findByExperimentId(experiment.experimentId);
      if (existing !== undefined) {
        if (existing.buildId === buildId && canonicalJsonSha256(existing.payload) === canonicalJsonSha256(experiment)) return existing;
        throw new Error("Conflicting experiment binding");
      }
      const prior = this.database.prepare<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM build_events WHERE build_id = ? AND event_type = 'wale.experiment.bound'",
      ).get(buildId);
      if ((prior?.count ?? 0) !== 0) throw new Error("Build already has an experiment binding");
      return insertBuildEvent(this.database, { buildId, type: "wale.experiment.bound", payload: experiment }, this.clock);
    });
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
