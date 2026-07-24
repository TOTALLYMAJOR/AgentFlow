import type Database from "better-sqlite3";
import {
  decodeJson,
  encodeJson,
  inImmediateTransaction,
  insertBuildEvent,
  requireEntity,
  systemClock,
  type Clock,
} from "./shared.js";
import type {
  CreateTaskManifestInput,
  TaskManifestEntity,
  TaskManifestStatus,
} from "./types.js";

interface TaskManifestRow {
  id: string;
  build_id: string;
  task_id: string;
  status: TaskManifestStatus;
  schema_version: string;
  manifest_path: string;
  sha256: string;
  manifest_json: string;
  created_at: string;
}

const MANIFEST_SELECT = `
  SELECT
    id, build_id, task_id, status, schema_version, manifest_path, sha256,
    manifest_json, created_at
  FROM task_manifests
`;

function mapManifest(row: TaskManifestRow): TaskManifestEntity {
  return {
    id: row.id,
    buildId: row.build_id,
    taskId: row.task_id,
    status: row.status,
    schemaVersion: row.schema_version,
    manifestPath: row.manifest_path,
    sha256: row.sha256,
    manifest: decodeJson<Record<string, unknown>>(
      row.manifest_json,
      "task_manifests.manifest_json",
    ),
    createdAt: row.created_at,
  };
}

export class TaskManifestRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  create(input: CreateTaskManifestInput): TaskManifestEntity {
    return inImmediateTransaction(this.database, () => {
      const createdAt = input.createdAt ?? this.clock();
      this.database
        .prepare<{
          id: string;
          buildId: string;
          taskId: string;
          status: TaskManifestStatus;
          schemaVersion: string;
          manifestPath: string;
          sha256: string;
          manifestJson: string;
          createdAt: string;
        }>(
          `INSERT INTO task_manifests (
             id, build_id, task_id, status, schema_version, manifest_path,
             sha256, manifest_json, created_at
           ) VALUES (
             @id, @buildId, @taskId, @status, @schemaVersion, @manifestPath,
             @sha256, @manifestJson, @createdAt
           )`,
        )
        .run({
          id: input.id,
          buildId: input.buildId,
          taskId: input.taskId,
          status: input.status,
          schemaVersion: input.schemaVersion,
          manifestPath: input.manifestPath,
          sha256: input.sha256,
          manifestJson: encodeJson(input.manifest),
          createdAt,
        });
      insertBuildEvent(
        this.database,
        {
          buildId: input.buildId,
          taskId: input.taskId,
          type: "manifest.published",
          payload: {
            manifestId: input.id,
            status: input.status,
            sha256: input.sha256,
          },
          occurredAt: createdAt,
        },
        this.clock,
      );
      return this.getById(input.id);
    });
  }

  getById(id: string): TaskManifestEntity {
    const row = this.database
      .prepare<[string], TaskManifestRow>(`${MANIFEST_SELECT} WHERE id = ?`)
      .get(id);
    return mapManifest(requireEntity("task manifest", id, row));
  }

  findForTask(
    taskId: string,
    status: TaskManifestStatus,
  ): TaskManifestEntity | undefined {
    const row = this.database
      .prepare<[string, TaskManifestStatus], TaskManifestRow>(
        `${MANIFEST_SELECT} WHERE task_id = ? AND status = ?`,
      )
      .get(taskId, status);
    return row === undefined ? undefined : mapManifest(row);
  }

  listForBuild(buildId: string): TaskManifestEntity[] {
    return this.database
      .prepare<[string], TaskManifestRow>(
        `${MANIFEST_SELECT}
         WHERE build_id = ?
         ORDER BY created_at, task_id, status`,
      )
      .all(buildId)
      .map(mapManifest);
  }
}
