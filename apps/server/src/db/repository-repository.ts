import type Database from "better-sqlite3";
import type { DetectedStack } from "../domain/types.js";
import {
  decodeJson,
  encodeJson,
  requireEntity,
  systemClock,
  type Clock,
} from "./shared.js";
import type {
  CreateRepositoryInput,
  RepositoryEntity,
  RepositoryStatus,
  UpdateRepositoryInput,
} from "./types.js";

interface RepositoryRow {
  id: string;
  name: string;
  local_path: string;
  config_path: string;
  base_branch: string;
  remote_name: string | null;
  status: RepositoryStatus;
  detected_stack_json: string;
  created_at: string;
  updated_at: string;
}
function mapRepository(row: RepositoryRow): RepositoryEntity {
  return {
    id: row.id,
    name: row.name,
    localPath: row.local_path,
    configPath: row.config_path,
    baseBranch: row.base_branch,
    remoteName: row.remote_name,
    status: row.status,
    detectedStack: decodeJson<DetectedStack>(
      row.detected_stack_json,
      "repositories.detected_stack_json",
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const REPOSITORY_SELECT = `
  SELECT
    id, name, local_path, config_path, base_branch, remote_name, status,
    detected_stack_json, created_at, updated_at
  FROM repositories
`;

export class RepositoryRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  create(input: CreateRepositoryInput): RepositoryEntity {
    const createdAt = input.createdAt ?? this.clock();
    const updatedAt = input.updatedAt ?? createdAt;
    this.database
      .prepare<{
        id: string;
        name: string;
        localPath: string;
        configPath: string;
        baseBranch: string;
        remoteName: string | null;
        status: RepositoryStatus;
        detectedStackJson: string;
        createdAt: string;
        updatedAt: string;
      }>(
        `INSERT INTO repositories (
           id, name, local_path, config_path, base_branch, remote_name, status,
           detected_stack_json, created_at, updated_at
         ) VALUES (
           @id, @name, @localPath, @configPath, @baseBranch, @remoteName,
           @status, @detectedStackJson, @createdAt, @updatedAt
         )`,
      )
      .run({
        id: input.id,
        name: input.name,
        localPath: input.localPath,
        configPath: input.configPath,
        baseBranch: input.baseBranch,
        remoteName: input.remoteName ?? null,
        status: input.status ?? "ready",
        detectedStackJson: encodeJson(input.detectedStack ?? {}),
        createdAt,
        updatedAt,
      });
    return this.getById(input.id);
  }

  getById(id: string): RepositoryEntity {
    const row = this.database
      .prepare<[string], RepositoryRow>(`${REPOSITORY_SELECT} WHERE id = ?`)
      .get(id);
    return mapRepository(requireEntity("repository", id, row));
  }

  findById(id: string): RepositoryEntity | undefined {
    const row = this.database
      .prepare<[string], RepositoryRow>(`${REPOSITORY_SELECT} WHERE id = ?`)
      .get(id);
    return row === undefined ? undefined : mapRepository(row);
  }

  findByLocalPath(localPath: string): RepositoryEntity | undefined {
    const row = this.database
      .prepare<[string], RepositoryRow>(
        `${REPOSITORY_SELECT} WHERE local_path = ?`,
      )
      .get(localPath);
    return row === undefined ? undefined : mapRepository(row);
  }

  list(): RepositoryEntity[] {
    return this.database
      .prepare<[], RepositoryRow>(
        `${REPOSITORY_SELECT} ORDER BY created_at, id`,
      )
      .all()
      .map(mapRepository);
  }

  update(id: string, input: UpdateRepositoryInput): RepositoryEntity {
    const current = this.getById(id);
    this.database
      .prepare<{
        id: string;
        name: string;
        configPath: string;
        baseBranch: string;
        remoteName: string | null;
        status: RepositoryStatus;
        detectedStackJson: string;
        updatedAt: string;
      }>(
        `UPDATE repositories
         SET name = @name,
             config_path = @configPath,
             base_branch = @baseBranch,
             remote_name = @remoteName,
             status = @status,
             detected_stack_json = @detectedStackJson,
             updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        name: input.name ?? current.name,
        configPath: input.configPath ?? current.configPath,
        baseBranch: input.baseBranch ?? current.baseBranch,
        remoteName:
          input.remoteName === undefined ? current.remoteName : input.remoteName,
        status: input.status ?? current.status,
        detectedStackJson: encodeJson(
          input.detectedStack ?? current.detectedStack,
        ),
        updatedAt: input.updatedAt ?? this.clock(),
      });
    return this.getById(id);
  }

  remove(id: string): boolean {
    return (
      this.database.prepare<[string]>("DELETE FROM repositories WHERE id = ?").run(id)
        .changes === 1
    );
  }
}
