import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import {
  MIGRATIONS,
  createDatabaseRepositories,
  listAppliedMigrations,
  runMigrations,
} from "../src/db/index.js";
import {
  createDatabaseFixture,
  type DatabaseFixture,
} from "./helpers/database-fixture.js";

describe("SQLite database foundation", () => {
  let fixture: DatabaseFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("initializes a clean database with WAL, foreign keys, and ordered migrations", () => {
    fixture = createDatabaseFixture();

    expect(
      fixture.database.pragma("journal_mode", { simple: true }),
    ).toBe("wal");
    expect(
      fixture.database.pragma("foreign_keys", { simple: true }),
    ).toBe(1);
    expect(listAppliedMigrations(fixture.database)).toHaveLength(
      MIGRATIONS.length,
    );
    expect(
      listAppliedMigrations(fixture.database).map(({ version }) => version),
    ).toEqual(MIGRATIONS.map(({ version }) => version));
  });

  it("does not reapply migrations", () => {
    fixture = createDatabaseFixture();
    const before = listAppliedMigrations(fixture.database);

    const result = runMigrations(fixture.database, () => {
      throw new Error("the clock must not be read when nothing is applied");
    });

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(before);
    expect(listAppliedMigrations(fixture.database)).toEqual(before);
  });

  it("enforces foreign keys", () => {
    fixture = createDatabaseFixture();

    expect(() =>
      fixture?.database
        .prepare(
          `INSERT INTO builds (
             id, repository_id, backlog_path, base_commit,
             integration_branch, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "build_missing_repository",
          "repository_missing",
          "BACKLOG.md",
          "abc123",
          "agentflow/test",
          "planning",
          "2026-07-24T00:00:00.000Z",
        ),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("enforces one active or interrupted build globally", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    store.repositories.create({
      id: "repository_a",
      name: "A",
      localPath: "/tmp/repository-a",
      configPath: "/tmp/repository-a/.agentflow.yaml",
      baseBranch: "main",
    });

    store.builds.create({
      id: "build_1",
      repositoryId: "repository_a",
      backlogPath: "BACKLOG.md",
      baseCommit: "abc123",
      integrationBranch: "agentflow/build-1",
      status: "planning",
    });
    expect(() =>
      store.builds.create({
        id: "build_2",
        repositoryId: "repository_a",
        backlogPath: "BACKLOG.md",
        baseCommit: "abc123",
        integrationBranch: "agentflow/build-2",
        status: "ready",
      }),
    ).toThrow(/UNIQUE constraint failed/i);

    store.builds.transition("build_1", "cancelled");
    store.builds.create({
      id: "build_interrupted",
      repositoryId: "repository_a",
      backlogPath: "BACKLOG.md",
      baseCommit: "abc123",
      integrationBranch: "agentflow/interrupted",
      status: "interrupted",
    });
    expect(() =>
      store.builds.create({
        id: "build_3",
        repositoryId: "repository_a",
        backlogPath: "BACKLOG.md",
        baseCommit: "abc123",
        integrationBranch: "agentflow/build-3",
        status: "planning",
      }),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("migrates legacy manifests to the attempt that produced their result commit", () => {
    const database = new BetterSqlite3(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      for (const migration of MIGRATIONS.filter(
        (candidate) => candidate.version <= 6,
      )) {
        database.exec(migration.sql);
      }
      const createdAt = "2026-07-24T00:00:00.000Z";
      database
        .prepare(
          `INSERT INTO repositories (
             id, name, local_path, config_path, base_branch, status,
             detected_stack_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "repository_migration",
          "Migration fixture",
          "/tmp/agentflow-migration-repository",
          "/tmp/agentflow-migration-repository/.agentflow.yaml",
          "main",
          "ready",
          "{}",
          createdAt,
          createdAt,
        );
      database
        .prepare(
          `INSERT INTO builds (
             id, repository_id, backlog_path, base_commit,
             integration_branch, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "build_migration",
          "repository_migration",
          "BACKLOG.md",
          "base",
          "agent-integration/build_migration",
          "running",
          createdAt,
        );
      database
        .prepare(
          `INSERT INTO tasks (
             id, build_id, backlog_task_id, title, description,
             acceptance_criteria, state, attempt, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "task_migration",
          "build_migration",
          "BL-MIGRATION",
          "Migration fixture",
          "Verify migration provenance.",
          "[]",
          "validated",
          3,
          createdAt,
        );
      const insertAttempt = database.prepare(
        `INSERT INTO task_attempts (
           id, task_id, build_id, attempt, status, result_commit, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insertAttempt.run(
        "attempt_old",
        "task_migration",
        "build_migration",
        1,
        "succeeded",
        "result-old",
        createdAt,
      );
      insertAttempt.run(
        "attempt_current",
        "task_migration",
        "build_migration",
        3,
        "succeeded",
        "result-current",
        createdAt,
      );
      database
        .prepare(
          `INSERT INTO task_manifests (
             id, build_id, task_id, status, schema_version, manifest_path,
             sha256, manifest_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "manifest_legacy",
          "build_migration",
          "task_migration",
          "validated",
          "1.0.0",
          "/tmp/task-manifest.json",
          "sha256",
          JSON.stringify({
            taskId: "task_migration",
            resultCommit: "result-current",
          }),
          createdAt,
        );

      const migration = MIGRATIONS.find((candidate) => candidate.version === 7);
      expect(migration).toBeDefined();
      database.exec(migration?.sql ?? "");

      const migrated = database
        .prepare(
          `SELECT attempt, manifest_json
           FROM task_manifests
           WHERE id = ?`,
        )
        .get("manifest_legacy") as
        | { attempt: number; manifest_json: string }
        | undefined;
      expect(migrated?.attempt).toBe(3);
      expect(JSON.parse(migrated?.manifest_json ?? "{}")).toMatchObject({
        taskId: "task_migration",
        attempt: 3,
        resultCommit: "result-current",
      });
    } finally {
      database.close();
    }
  });
});
