import { mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  runMigrations,
  type MigrationResult,
} from "./migrations.js";

export type AgentFlowDatabase = BetterSqlite3.Database;

export interface OpenDatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeoutMs?: number;
  migrate?: boolean;
  now?: () => string;
}

export interface InitializedDatabase {
  database: AgentFlowDatabase;
  migrations: MigrationResult;
}

function isInMemoryDatabase(filename: string): boolean {
  return filename === ":memory:" || filename.startsWith("file::memory:");
}

function ensureDatabaseDirectory(filename: string): void {
  if (isInMemoryDatabase(filename)) {
    return;
  }
  mkdirSync(path.dirname(path.resolve(filename)), {
    recursive: true,
    mode: 0o700,
  });
}

export function configureDatabase(
  database: AgentFlowDatabase,
  options: Pick<OpenDatabaseOptions, "readonly"> = {},
): void {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  if (options.readonly !== true) {
    const journalMode = database.pragma("journal_mode = WAL", {
      simple: true,
    });
    if (!database.memory && journalMode !== "wal") {
      throw new Error("SQLite WAL journal mode could not be enabled");
    }
    database.pragma("synchronous = NORMAL");
  }

  const foreignKeys = database.pragma("foreign_keys", {
    simple: true,
  });
  if (foreignKeys !== 1) {
    throw new Error("SQLite foreign key enforcement could not be enabled");
  }
}

export function openDatabase(
  filename: string,
  options: OpenDatabaseOptions = {},
): AgentFlowDatabase {
  const readonly = options.readonly ?? false;
  const migrate = options.migrate ?? !readonly;
  if (readonly && migrate) {
    throw new Error("A read-only database cannot run migrations");
  }

  if (!readonly) {
    ensureDatabaseDirectory(filename);
  }

  const database = new BetterSqlite3(filename, {
    readonly,
    fileMustExist: options.fileMustExist ?? readonly,
    timeout: options.timeoutMs ?? 5_000,
  });

  try {
    configureDatabase(database, { readonly });
    if (migrate) {
      runMigrations(database, options.now);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function initializeDatabase(
  filename: string,
  options: Omit<OpenDatabaseOptions, "migrate" | "readonly"> = {},
): InitializedDatabase {
  ensureDatabaseDirectory(filename);
  const database = new BetterSqlite3(filename, {
    readonly: false,
    fileMustExist: options.fileMustExist ?? false,
    timeout: options.timeoutMs ?? 5_000,
  });

  try {
    configureDatabase(database);
    const migrations = runMigrations(database, options.now);
    return { database, migrations };
  } catch (error) {
    database.close();
    throw error;
  }
}

export const createDatabase = openDatabase;
