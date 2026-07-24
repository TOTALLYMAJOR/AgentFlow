import type Database from "better-sqlite3";
import type {
  AppendBuildEventInput,
  BuildEventEntity,
} from "./types.js";

export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

export class EntityNotFoundError extends Error {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "EntityNotFoundError";
    this.entity = entity;
    this.id = id;
  }
}
export class InvalidStateTransitionError extends Error {
  readonly entity: string;
  readonly id: string;
  readonly from: string;
  readonly to: string;

  constructor(entity: string, id: string, from: string, to: string) {
    super(`Illegal ${entity} state transition for ${id}: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
    this.entity = entity;
    this.id = id;
    this.from = from;
    this.to = to;
  }
}

export class ConcurrentStateChangeError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} changed concurrently: ${id}`);
    this.name = "ConcurrentStateChangeError";
  }
}

export function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Value cannot be represented as JSON");
  }
  return encoded;
}

export function decodeJson<T>(encoded: string, field: string): T {
  try {
    return JSON.parse(encoded) as T;
  } catch (error) {
    throw new Error(`Invalid JSON stored in ${field}`, { cause: error });
  }
}

export function requireEntity<T>(
  entity: string,
  id: string,
  value: T | undefined,
): T {
  if (value === undefined) {
    throw new EntityNotFoundError(entity, id);
  }
  return value;
}

export function inImmediateTransaction<T>(
  database: Database.Database,
  operation: () => T,
): T {
  if (database.inTransaction) {
    return operation();
  }
  return database.transaction(operation).immediate();
}

interface BuildEventRow {
  sequence: number;
  build_id: string;
  task_id: string | null;
  event_type: string;
  payload_json: string;
  occurred_at: string;
}

export function mapBuildEvent(row: BuildEventRow): BuildEventEntity {
  return {
    sequence: row.sequence,
    buildId: row.build_id,
    taskId: row.task_id,
    type: row.event_type,
    payload: decodeJson<Record<string, unknown>>(
      row.payload_json,
      "build_events.payload_json",
    ),
    occurredAt: row.occurred_at,
  };
}

export function insertBuildEvent(
  database: Database.Database,
  input: AppendBuildEventInput,
  clock: Clock,
): BuildEventEntity {
  const occurredAt = input.occurredAt ?? clock();
  const result = database
    .prepare<{
      buildId: string;
      taskId: string | null;
      eventType: string;
      payloadJson: string;
      occurredAt: string;
    }>(
      `INSERT INTO build_events (
         build_id, task_id, event_type, payload_json, occurred_at
       ) VALUES (
         @buildId, @taskId, @eventType, @payloadJson, @occurredAt
       )`,
    )
    .run({
      buildId: input.buildId,
      taskId: input.taskId ?? null,
      eventType: input.type,
      payloadJson: encodeJson(input.payload ?? {}),
      occurredAt,
    });

  const row = database
    .prepare<[number | bigint], BuildEventRow>(
      `SELECT sequence, build_id, task_id, event_type, payload_json, occurred_at
       FROM build_events
       WHERE sequence = ?`,
    )
    .get(result.lastInsertRowid);
  return requireEntity(
    "build event",
    String(result.lastInsertRowid),
    row === undefined ? undefined : mapBuildEvent(row),
  );
}
