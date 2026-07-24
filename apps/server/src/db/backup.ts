import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";

export interface DatabaseBackupResult {
  path: string;
  createdAt: string;
  sizeBytes: number;
  totalPages: number;
}
function assertBackupIntegrity(filename: string): void {
  const backup = new BetterSqlite3(filename, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = backup
      .prepare<[], { quick_check: string }>("PRAGMA quick_check")
      .all();
    if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
      throw new Error(
        `SQLite backup integrity check failed: ${rows
          .map((row) => row.quick_check)
          .join(", ")}`,
      );
    }
  } finally {
    backup.close();
  }
}

export async function backupDatabase(
  database: Database.Database,
  destinationPath: string,
  createdAt = new Date().toISOString(),
): Promise<DatabaseBackupResult> {
  if (!database.open) {
    throw new Error("Cannot back up a closed database");
  }
  if (database.memory) {
    throw new Error("Online backup requires a file-backed database");
  }

  const source = path.resolve(database.name);
  const destination = path.resolve(destinationPath);
  if (source === destination) {
    throw new Error("Backup destination cannot be the active database");
  }
  if (existsSync(destination)) {
    throw new Error(`Backup destination already exists: ${destination}`);
  }

  const destinationDirectory = path.dirname(destination);
  mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    destinationDirectory,
    `.${path.basename(destination)}.${randomUUID()}.partial`,
  );

  try {
    const metadata = await database.backup(temporary);
    chmodSync(temporary, 0o600);
    assertBackupIntegrity(temporary);
    renameSync(temporary, destination);
    const sizeBytes = statSync(destination).size;
    return {
      path: destination,
      createdAt,
      sizeBytes,
      totalPages: metadata.totalPages,
    };
  } catch (error) {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
    throw error;
  }
}

function backupFilename(timestamp: string): string {
  return `agentflow-${timestamp.replaceAll(/[^0-9A-Za-z]/g, "-")}.db`;
}

export async function createDatabaseBackup(
  database: Database.Database,
  backupDirectory: string,
  now: () => string = () => new Date().toISOString(),
): Promise<DatabaseBackupResult> {
  const createdAt = now();
  let destination = path.join(
    path.resolve(backupDirectory),
    backupFilename(createdAt),
  );
  if (existsSync(destination)) {
    destination = path.join(
      path.resolve(backupDirectory),
      `agentflow-${createdAt.replaceAll(/[^0-9A-Za-z]/g, "-")}-${randomUUID()}.db`,
    );
  }
  return backupDatabase(database, destination, createdAt);
}
