import type Database from "better-sqlite3";
import {
  decodeJson,
  encodeJson,
  requireEntity,
  systemClock,
  type Clock,
} from "./shared.js";
import type {
  CreateRunnerInput,
  RunnerEntity,
  RunnerStatus,
  RunnerTransport,
} from "./types.js";

interface RunnerRow {
  id: string;
  name: string;
  provider_id: string;
  transport: RunnerTransport;
  status: RunnerStatus;
  capacity: number;
  busy_slots: number;
  capabilities_json: string;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, name, provider_id, transport, status, capacity,
  busy_slots, capabilities_json, last_heartbeat_at, created_at, updated_at
  FROM runners`;

function mapRunner(row: RunnerRow): RunnerEntity {
  return {
    id: row.id,
    name: row.name,
    providerId: row.provider_id,
    transport: row.transport,
    status: row.status,
    capacity: row.capacity,
    busySlots: row.busy_slots,
    capabilities: decodeJson(row.capabilities_json, "runners.capabilities_json"),
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RunnerRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  create(input: CreateRunnerInput): RunnerEntity {
    const createdAt = input.createdAt ?? this.clock();
    this.database.prepare(
      `INSERT INTO runners (
        id, name, provider_id, transport, status, capacity, busy_slots,
        capabilities_json, token_sha256, last_heartbeat_at, created_at,
        updated_at
      ) VALUES (
        @id, @name, @providerId, @transport, @status, @capacity, @busySlots,
        @capabilitiesJson, @tokenSha256, @lastHeartbeatAt, @createdAt, @updatedAt
      )`,
    ).run({
      id: input.id,
      name: input.name,
      providerId: input.providerId,
      transport: input.transport,
      status: input.status ?? "online",
      capacity: input.capacity,
      busySlots: input.busySlots ?? 0,
      capabilitiesJson: encodeJson(input.capabilities ?? {}),
      tokenSha256: input.tokenSha256 ?? null,
      lastHeartbeatAt: input.status === "offline" ? null : createdAt,
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
    });
    return this.getById(input.id);
  }

  getById(id: string): RunnerEntity {
    const row = this.database
      .prepare<[string], RunnerRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return mapRunner(requireEntity("runner", id, row));
  }

  findByTokenSha256(tokenSha256: string): RunnerEntity | undefined {
    const row = this.database
      .prepare<[string], RunnerRow>(`${SELECT} WHERE token_sha256 = ?`)
      .get(tokenSha256);
    return row === undefined ? undefined : mapRunner(row);
  }

  list(): RunnerEntity[] {
    return this.database
      .prepare<[], RunnerRow>(`${SELECT} ORDER BY name, id`)
      .all()
      .map(mapRunner);
  }

  heartbeat(
    id: string,
    input: {
      busySlots: number;
      capacity?: number;
      status?: Extract<RunnerStatus, "online" | "draining">;
      capabilities?: Record<string, string | number | boolean>;
    },
  ): RunnerEntity {
    const runner = this.getById(id);
    const updatedAt = this.clock();
    const capacity = input.capacity ?? runner.capacity;
    if (input.busySlots > capacity) {
      throw new Error("Runner busy slots cannot exceed capacity");
    }
    const result = this.database.prepare(
      `UPDATE runners SET
        status = @status,
        capacity = @capacity,
        busy_slots = @busySlots,
        capabilities_json = @capabilitiesJson,
        last_heartbeat_at = @updatedAt,
        updated_at = @updatedAt
      WHERE id = @id AND status <> 'disabled'`,
    ).run({
      id,
      status: input.status ?? "online",
      capacity,
      busySlots: input.busySlots,
      capabilitiesJson: encodeJson(input.capabilities ?? runner.capabilities),
      updatedAt,
    });
    if (result.changes !== 1) {
      throw new Error(`Runner ${id} is disabled`);
    }
    return this.getById(id);
  }
}
