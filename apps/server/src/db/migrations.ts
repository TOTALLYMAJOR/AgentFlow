import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationResult {
  applied: AppliedMigration[];
  alreadyApplied: AppliedMigration[];
  currentVersion: number;
}

export class MigrationDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationDriftError";
  }
}

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  local_path TEXT NOT NULL UNIQUE,
  config_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  remote_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('ready','invalid','unavailable')),
  detected_stack_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(detected_stack_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  backlog_path TEXT NOT NULL,
  backlog_sha256 TEXT NOT NULL,
  backlog_contents TEXT NOT NULL,
  repository_config_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(repository_config_json)),
  normalized_plan_json TEXT NOT NULL
    CHECK (json_valid(normalized_plan_json)),
  sequential_estimate_hours REAL NOT NULL DEFAULT 0
    CHECK (sequential_estimate_hours >= 0),
  critical_path_hours REAL NOT NULL DEFAULT 0
    CHECK (critical_path_hours >= 0),
  expected_elapsed_hours REAL NOT NULL DEFAULT 0
    CHECK (expected_elapsed_hours >= 0),
  expected_savings_percent REAL NOT NULL DEFAULT 0,
  maximum_theoretical_concurrency INTEGER NOT NULL DEFAULT 1
    CHECK (maximum_theoretical_concurrency >= 1),
  worker_efficiency REAL NOT NULL DEFAULT 0.85
    CHECK (worker_efficiency > 0 AND worker_efficiency <= 1),
  overhead_percent REAL NOT NULL DEFAULT 0
    CHECK (overhead_percent >= 0),
  locked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id)
);

CREATE INDEX IF NOT EXISTS plans_by_repository
ON plans (repository_id, created_at DESC);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  plan_id TEXT,
  backlog_path TEXT NOT NULL,
  backlog_sha256 TEXT,
  base_commit TEXT NOT NULL,
  integration_branch TEXT NOT NULL,
  integration_worktree TEXT,
  repository_config_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(repository_config_json)),
  backlog_contents TEXT NOT NULL DEFAULT '',
  normalized_plan_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(normalized_plan_json)),
  status TEXT NOT NULL CHECK (
    status IN (
      'planning','ready','running','paused','completed','failed','cancelled',
      'interrupted'
    )
  ),
  worker_limit INTEGER NOT NULL DEFAULT 4
    CHECK (worker_limit BETWEEN 1 AND 4),
  sequential_estimate_hours REAL CHECK (
    sequential_estimate_hours IS NULL OR sequential_estimate_hours >= 0
  ),
  critical_path_hours REAL CHECK (
    critical_path_hours IS NULL OR critical_path_hours >= 0
  ),
  expected_elapsed_hours REAL CHECK (
    expected_elapsed_hours IS NULL OR expected_elapsed_hours >= 0
  ),
  expected_savings_percent REAL,
  actual_elapsed_seconds INTEGER CHECK (
    actual_elapsed_seconds IS NULL OR actual_elapsed_seconds >= 0
  ),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id),
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_build
ON builds ((1))
WHERE status IN ('planning','ready','running','paused','interrupted');

CREATE INDEX IF NOT EXISTS builds_by_repository
ON builds (repository_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS plans_are_immutable_after_build_update
BEFORE UPDATE ON plans
WHEN EXISTS (SELECT 1 FROM builds WHERE plan_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'plans used by a build are immutable');
END;

CREATE TRIGGER IF NOT EXISTS plans_are_immutable_after_build_delete
BEFORE DELETE ON plans
WHEN EXISTS (SELECT 1 FROM builds WHERE plan_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'plans used by a build are immutable');
END;
`;

const TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  backlog_task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL
    CHECK (json_valid(acceptance_criteria)),
  state TEXT NOT NULL CHECK (
    state IN (
      'pending','blocked','ready','running','validating','validated',
      'integrating','integrated','failed','cancelled','interrupted',
      'blocked_failed'
    )
  ),
  branch_name TEXT,
  worktree_path TEXT,
  base_commit TEXT,
  result_commit TEXT,
  integration_commit TEXT,
  estimate_hours REAL CHECK (estimate_hours IS NULL OR estimate_hours >= 0),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  allow_no_changes INTEGER NOT NULL DEFAULT 0
    CHECK (allow_no_changes IN (0, 1)),
  risk_score REAL NOT NULL DEFAULT 0 CHECK (risk_score >= 0),
  requires_approval INTEGER NOT NULL DEFAULT 0
    CHECK (requires_approval IN (0, 1)),
  ranking_score REAL,
  ranking_explanation TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (build_id, backlog_task_id),
  UNIQUE (id, build_id),
  FOREIGN KEY (build_id) REFERENCES builds(id)
);

CREATE INDEX IF NOT EXISTS tasks_by_build_state
ON tasks (build_id, state);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL,
  dependency_task_id TEXT NOT NULL,
  dependency_type TEXT NOT NULL
    CHECK (dependency_type IN ('hard','contract','artifact','runtime')),
  required_artifact_name TEXT,
  required_artifact_version TEXT,
  PRIMARY KEY (task_id, dependency_task_id, dependency_type),
  CHECK (task_id <> dependency_task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (dependency_task_id) REFERENCES tasks(id)
);

CREATE TRIGGER IF NOT EXISTS task_dependencies_same_build_insert
BEFORE INSERT ON task_dependencies
WHEN (
  SELECT build_id FROM tasks WHERE id = NEW.task_id
) <> (
  SELECT build_id FROM tasks WHERE id = NEW.dependency_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'task dependencies must belong to the same build');
END;

CREATE TRIGGER IF NOT EXISTS task_dependencies_same_build_update
BEFORE UPDATE ON task_dependencies
WHEN (
  SELECT build_id FROM tasks WHERE id = NEW.task_id
) <> (
  SELECT build_id FROM tasks WHERE id = NEW.dependency_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'task dependencies must belong to the same build');
END;

CREATE TABLE IF NOT EXISTS task_ownership (
  task_id TEXT NOT NULL,
  owned_path TEXT NOT NULL,
  PRIMARY KEY (task_id, owned_path),
  CHECK (owned_path <> ''),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS task_validation_commands (
  task_id TEXT NOT NULL,
  command_order INTEGER NOT NULL CHECK (command_order >= 0),
  command TEXT NOT NULL CHECK (command <> ''),
  PRIMARY KEY (task_id, command_order),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
`;

const RUNTIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  task_id TEXT,
  process_id INTEGER,
  status TEXT NOT NULL CHECK (
    status IN ('idle','starting','running','stopping','stopped','failed')
  ),
  started_at TEXT,
  heartbeat_at TEXT,
  stopped_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, build_id),
  FOREIGN KEY (build_id) REFERENCES builds(id),
  FOREIGN KEY (task_id, build_id) REFERENCES tasks(id, build_id)
);

CREATE INDEX IF NOT EXISTS workers_by_build_status
ON workers (build_id, status);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  producer_task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  version TEXT NOT NULL,
  repository_path TEXT,
  storage_path TEXT,
  sha256 TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('produced','validated','integrated','invalidated')
  ),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  integrated_at TEXT,
  UNIQUE (build_id, name, version),
  FOREIGN KEY (build_id) REFERENCES builds(id),
  FOREIGN KEY (producer_task_id, build_id) REFERENCES tasks(id, build_id)
);

CREATE INDEX IF NOT EXISTS artifacts_by_build_status
ON artifacts (build_id, status);

CREATE TABLE IF NOT EXISTS validation_runs (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  task_id TEXT,
  validation_type TEXT NOT NULL CHECK (
    validation_type IN ('task','contract','integration','browser','migration')
  ),
  command TEXT NOT NULL,
  exit_code INTEGER,
  status TEXT NOT NULL CHECK (
    status IN ('queued','running','passed','failed','cancelled','timed_out')
  ),
  log_path TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (build_id) REFERENCES builds(id),
  FOREIGN KEY (task_id, build_id) REFERENCES tasks(id, build_id)
);

CREATE INDEX IF NOT EXISTS validation_runs_by_build
ON validation_runs (build_id, task_id, created_at);

CREATE TABLE IF NOT EXISTS build_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT NOT NULL,
  task_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (build_id) REFERENCES builds(id),
  FOREIGN KEY (task_id, build_id) REFERENCES tasks(id, build_id)
);

CREATE INDEX IF NOT EXISTS build_events_stream
ON build_events (build_id, sequence);
`;

const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  worker_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'queued','running','succeeded','failed','cancelled','interrupted'
    )
  ),
  prompt_path TEXT,
  jsonl_path TEXT,
  log_path TEXT,
  result_commit TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, attempt),
  FOREIGN KEY (task_id, build_id) REFERENCES tasks(id, build_id),
  FOREIGN KEY (worker_id, build_id) REFERENCES workers(id, build_id)
);

CREATE INDEX IF NOT EXISTS task_attempts_by_build
ON task_attempts (build_id, task_id, attempt);

CREATE TABLE IF NOT EXISTS task_changed_files (
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  path TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (
    change_type IN ('added','modified','deleted','renamed','copied','untracked')
  ),
  previous_path TEXT,
  within_ownership INTEGER NOT NULL
    CHECK (within_ownership IN (0, 1)),
  sha256 TEXT,
  PRIMARY KEY (task_id, attempt, path),
  FOREIGN KEY (task_id, attempt) REFERENCES task_attempts(task_id, attempt)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  task_id TEXT,
  approval_type TEXT NOT NULL CHECK (
    approval_type IN (
      'migration','security','shared_architecture','breaking_contract','manual'
    )
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending','approved','rejected','cancelled')
  ),
  reason TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT,
  FOREIGN KEY (build_id) REFERENCES builds(id),
  FOREIGN KEY (task_id, build_id) REFERENCES tasks(id, build_id)
);

CREATE INDEX IF NOT EXISTS approvals_outstanding
ON approvals (build_id, task_id)
WHERE status = 'pending';
`;

const MANIFEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_manifests (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('validated','integrated')),
  schema_version TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  created_at TEXT NOT NULL,
  UNIQUE (task_id, status),
  UNIQUE (manifest_path),
  FOREIGN KEY (build_id) REFERENCES builds(id),
  FOREIGN KEY (task_id, build_id) REFERENCES tasks(id, build_id)
);

CREATE INDEX IF NOT EXISTS task_manifests_by_build
ON task_manifests (build_id, task_id, status);
`;

const SCHEDULER_SCHEMA = `
CREATE TABLE IF NOT EXISTS build_scheduler_state (
  build_id TEXT PRIMARY KEY,
  cycle INTEGER NOT NULL DEFAULT 0 CHECK (cycle >= 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (build_id) REFERENCES builds(id)
);

CREATE TABLE IF NOT EXISTS task_scheduler_state (
  task_id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  ready_age_cycles INTEGER NOT NULL DEFAULT 0
    CHECK (ready_age_cycles >= 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id, build_id) REFERENCES tasks(id, build_id)
);

CREATE INDEX IF NOT EXISTS task_scheduler_state_by_build
ON task_scheduler_state (build_id, ready_age_cycles DESC);
`;

const ATTEMPT_MANIFEST_SCHEMA = `
DROP INDEX IF EXISTS task_manifests_by_build;
ALTER TABLE task_manifests RENAME TO task_manifests_legacy;

CREATE TABLE task_manifests (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('validated','integrated')),
  schema_version TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  created_at TEXT NOT NULL,
  UNIQUE (task_id, status, attempt),
  UNIQUE (manifest_path),
  FOREIGN KEY (build_id) REFERENCES builds(id),
  FOREIGN KEY (task_id, build_id) REFERENCES tasks(id, build_id)
);

INSERT INTO task_manifests (
  id, build_id, task_id, attempt, status, schema_version, manifest_path,
  sha256, manifest_json, created_at
)
SELECT
  id, build_id, task_id, 1, status, schema_version, manifest_path,
  sha256, manifest_json, created_at
FROM task_manifests_legacy;

DROP TABLE task_manifests_legacy;

CREATE INDEX task_manifests_by_build
ON task_manifests (build_id, task_id, status, attempt DESC);
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "initial_repository_plan_build_schema",
    sql: INITIAL_SCHEMA,
  },
  {
    version: 2,
    name: "task_plan_schema",
    sql: TASK_SCHEMA,
  },
  {
    version: 3,
    name: "runtime_artifact_validation_event_schema",
    sql: RUNTIME_SCHEMA,
  },
  {
    version: 4,
    name: "attempt_approval_changed_file_audit_schema",
    sql: AUDIT_SCHEMA,
  },
  {
    version: 5,
    name: "immutable_task_handoff_manifests",
    sql: MANIFEST_SCHEMA,
  },
  {
    version: 6,
    name: "durable_scheduler_cycles",
    sql: SCHEDULER_SCHEMA,
  },
  {
    version: 7,
    name: "attempt_scoped_validated_manifests",
    sql: ATTEMPT_MANIFEST_SCHEMA,
  },
]);

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

function checksumFor(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest("hex");
}

function toAppliedMigration(row: MigrationRow): AppliedMigration {
  return {
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  };
}

function assertMigrationSetIsOrdered(): void {
  let previousVersion = 0;
  const names = new Set<string>();
  for (const migration of MIGRATIONS) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
      throw new MigrationDriftError(
        "Migrations must have strictly increasing positive integer versions",
      );
    }
    if (names.has(migration.name)) {
      throw new MigrationDriftError(
        `Duplicate migration name: ${migration.name}`,
      );
    }
    names.add(migration.name);
    previousVersion = migration.version;
  }
}

export function listAppliedMigrations(
  database: Database.Database,
): AppliedMigration[] {
  const tableExists = database
    .prepare<[], { present: number }>(
      `SELECT 1 AS present
       FROM sqlite_master
       WHERE type = 'table' AND name = 'schema_migrations'`,
    )
    .get();
  if (tableExists === undefined) {
    return [];
  }

  return database
    .prepare<[], MigrationRow>(
      `SELECT version, name, checksum, applied_at
       FROM schema_migrations
       ORDER BY version`,
    )
    .all()
    .map(toAppliedMigration);
}

export function runMigrations(
  database: Database.Database,
  now: () => string = () => new Date().toISOString(),
): MigrationResult {
  assertMigrationSetIsOrdered();
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const existing = listAppliedMigrations(database);
  const byVersion = new Map(existing.map((migration) => [migration.version, migration]));
  const knownVersions = new Set(MIGRATIONS.map((migration) => migration.version));

  for (const applied of existing) {
    if (!knownVersions.has(applied.version)) {
      throw new MigrationDriftError(
        `Database contains unknown migration version ${applied.version}`,
      );
    }
  }

  const newlyApplied: AppliedMigration[] = [];
  for (const migration of MIGRATIONS) {
    const checksum = checksumFor(migration);
    const applied = byVersion.get(migration.version);
    if (applied !== undefined) {
      if (applied.name !== migration.name || applied.checksum !== checksum) {
        throw new MigrationDriftError(
          `Applied migration ${migration.version} does not match this binary`,
        );
      }
      continue;
    }

    const appliedAt = now();
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare<{
          version: number;
          name: string;
          checksum: string;
          appliedAt: string;
        }>(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (@version, @name, @checksum, @appliedAt)`,
        )
        .run({
          version: migration.version,
          name: migration.name,
          checksum,
          appliedAt,
        });
    });
    apply.immediate();
    newlyApplied.push({
      version: migration.version,
      name: migration.name,
      checksum,
      appliedAt,
    });
  }

  const allApplied = listAppliedMigrations(database);
  return {
    applied: newlyApplied,
    alreadyApplied: allApplied.filter(
      ({ version }) => !newlyApplied.some((migration) => migration.version === version),
    ),
    currentVersion: allApplied.at(-1)?.version ?? 0,
  };
}
