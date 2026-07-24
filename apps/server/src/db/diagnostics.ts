import type Database from "better-sqlite3";
import {
  listAppliedMigrations,
  type AppliedMigration,
} from "./migrations.js";

export interface ForeignKeyViolation {
  table: string;
  rowId: number | null;
  parent: string;
  foreignKeyIndex: number;
}

export interface DatabaseDiagnostics {
  ok: boolean;
  path: string;
  readonly: boolean;
  journalMode: string;
  foreignKeysEnabled: boolean;
  integrityCheck: string[];
  foreignKeyViolations: ForeignKeyViolation[];
  migrations: AppliedMigration[];
  currentMigrationVersion: number;
  pageCount: number;
  pageSize: number;
  databaseSizeBytes: number;
}

interface IntegrityRow {
  integrity_check: string;
}

interface ForeignKeyRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

function readNumericPragma(
  database: Database.Database,
  pragma: string,
): number {
  const value = database.pragma(pragma, { simple: true });
  if (typeof value !== "number") {
    throw new TypeError(`Unexpected result for PRAGMA ${pragma}`);
  }
  return value;
}

export function getDatabaseDiagnostics(
  database: Database.Database,
): DatabaseDiagnostics {
  const journalModeValue = database.pragma("journal_mode", { simple: true });
  if (typeof journalModeValue !== "string") {
    throw new TypeError("Unexpected result for PRAGMA journal_mode");
  }
  const integrityCheck = database
    .prepare<[], IntegrityRow>("PRAGMA integrity_check")
    .all()
    .map((row) => row.integrity_check);
  const foreignKeyViolations = database
    .prepare<[], ForeignKeyRow>("PRAGMA foreign_key_check")
    .all()
    .map(
      (row): ForeignKeyViolation => ({
        table: row.table,
        rowId: row.rowid,
        parent: row.parent,
        foreignKeyIndex: row.fkid,
      }),
    );
  const migrations = listAppliedMigrations(database);
  const pageCount = readNumericPragma(database, "page_count");
  const pageSize = readNumericPragma(database, "page_size");
  const foreignKeysEnabled =
    readNumericPragma(database, "foreign_keys") === 1;

  return {
    ok:
      integrityCheck.length === 1 &&
      integrityCheck[0] === "ok" &&
      foreignKeyViolations.length === 0 &&
      foreignKeysEnabled,
    path: database.name,
    readonly: database.readonly,
    journalMode: journalModeValue,
    foreignKeysEnabled,
    integrityCheck,
    foreignKeyViolations,
    migrations,
    currentMigrationVersion: migrations.at(-1)?.version ?? 0,
    pageCount,
    pageSize,
    databaseSizeBytes: pageCount * pageSize,
  };
}

export const diagnoseDatabase = getDatabaseDiagnostics;
