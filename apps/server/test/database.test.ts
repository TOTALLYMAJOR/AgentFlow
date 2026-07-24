import { afterEach, describe, expect, it } from "vitest";
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
});
