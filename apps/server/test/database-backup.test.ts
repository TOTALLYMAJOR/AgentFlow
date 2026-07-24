import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDatabaseBackup,
  createDatabaseRepositories,
  getDatabaseDiagnostics,
  openDatabase,
} from "../src/db/index.js";
import {
  createDatabaseFixture,
  type DatabaseFixture,
} from "./helpers/database-fixture.js";

describe("database diagnostics and online backup", () => {
  let fixture: DatabaseFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("reports integrity and creates a consistent non-destructive backup", async () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    store.repositories.create({
      id: "repository_a",
      name: "A",
      localPath: "/tmp/repository-a",
      configPath: "/tmp/repository-a/.agentflow.yaml",
      baseBranch: "main",
    });
    const before = getDatabaseDiagnostics(fixture.database);
    expect(before).toMatchObject({
      ok: true,
      journalMode: "wal",
      foreignKeysEnabled: true,
      integrityCheck: ["ok"],
      foreignKeyViolations: [],
    });

    const result = await createDatabaseBackup(
      fixture.database,
      path.join(fixture.directory, "backups"),
      () => "2026-07-24T12:34:56.000Z",
    );
    expect(existsSync(result.path)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);

    const backup = openDatabase(result.path, {
      readonly: true,
      migrate: false,
    });
    try {
      expect(
        backup
          .prepare<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM repositories",
          )
          .get()?.count,
      ).toBe(1);
      expect(getDatabaseDiagnostics(backup).ok).toBe(true);
    } finally {
      backup.close();
    }

    expect(store.repositories.getById("repository_a").name).toBe("A");
    expect(getDatabaseDiagnostics(fixture.database).ok).toBe(true);
  });
});
