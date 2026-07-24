# AgentFlow Codex Implementation Prompts

## Operating Rules for Every Prompt

Use these rules for every milestone:

* Inspect the existing repository before changing code.
* Preserve working functionality unless the prompt explicitly replaces it.
* Use TypeScript with strict typing.
* Prefer small modules with explicit interfaces.
* Add tests for new behavior.
* Run all relevant tests, type checks, and builds.
* Do not claim success unless commands actually pass.
* Do not remove functionality merely to make tests pass.
* Document assumptions and unresolved risks.
* Commit only after the milestone is complete and validated.
* Never operate on a production application repository while developing AgentFlow.

---

# Prompt 1 — Audit and Stabilize the Existing MVP

You are the lead engineer for AgentFlow, a local-first platform that coordinates parallel Codex development workers across Git repositories.

The repository contains an early MVP with:

* a Fastify API;
* a React/Vite dashboard;
* SQLite persistence;
* repository registration;
* Markdown backlog parsing;
* dependency graph validation;
* execution-wave generation;
* critical-path calculation;
* and delivery-time estimates.

Your task is to audit, repair, and stabilize the current codebase before adding features.

## Required Work

1. Inspect the entire repository structure.
2. Identify compilation, runtime, package-management, path-resolution, and API issues.
3. Make the project installable using:

```bash
npm install
```

4. Make development mode work using:

```bash
npm run dev
```

5. Make production build work using:

```bash
npm run build
npm start
```

6. Ensure the production server serves both:

   * the API;
   * the built React application.
7. Ensure the server binds only to `127.0.0.1` by default.
8. Ensure SQLite data is stored under:

   * `$AGENTFLOW_HOME`, when set;
   * otherwise `~/.agentflow`.
9. Add a clear environment configuration module.
10. Add consistent error handling and structured logging.
11. Add unit tests for backlog parsing, cycle detection, execution waves, critical path, and planning estimates.
12. Add an API smoke test for:

* `GET /api/health`;
* repository registration;
* backlog planning.

13. Update the README with verified commands only.

## Constraints

* Keep the current Node.js, TypeScript, Fastify, React, Vite, and SQLite direction.
* Do not implement Codex execution yet.
* Do not add authentication yet.
* Do not expose the server on external network interfaces.

## Definition of Done

The following commands must pass:

```bash
npm install
npm run typecheck
npm test
npm run build
```

Provide:

* files changed;
* defects found;
* commands run;
* test results;
* unresolved risks.

---

# Prompt 2 — Implement the Complete Database and Migration Layer

Implement the AgentFlow persistence layer using SQLite.

## Required Entities

Create migrations and typed repository modules for:

* repositories;
* builds;
* tasks;
* task dependencies;
* task ownership;
* task validation commands;
* workers;
* artifacts;
* validation runs;
* build events.

Use the architecture specification in the repository as the source of truth.

## Required Behavior

1. Enable:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
```

2. Add a migration table that records applied migrations.
3. Make migrations:

   * ordered;
   * idempotent;
   * transactional where SQLite allows.
4. Enforce one active build with a partial unique index for build states:

   * `planning`;
   * `ready`;
   * `running`;
   * `paused`.
5. Add typed data-access modules.
6. Add transaction helpers for:

   * build creation;
   * task state transitions;
   * worker assignment;
   * integration success;
   * integration failure;
   * artifact publication.
7. Append a durable build event for every meaningful state transition.
8. Add database backup support.
9. Add database integrity diagnostics.
10. Add tests for:

    * migrations;
    * foreign keys;
    * the one-active-build invariant;
    * transaction rollback;
    * event persistence.

## API Additions

Add:

```text
GET /api/system/database
POST /api/system/database/backup
```

The backup endpoint must create a consistent local SQLite backup without deleting or modifying the active database.

## Definition of Done

Demonstrate:

* a clean database initializes correctly;
* migrations are not reapplied;
* a second active build is rejected;
* failed transactions leave no partial state;
* backup creation works.

---

# Prompt 3 — Implement Repository Registration and Inspection

Build the repository-management subsystem.

## Required Behavior

A repository may be registered by absolute local path.

AgentFlow must verify:

1. the path exists;
2. it is a directory;
3. it is a Git repository;
4. the configured base branch exists;
5. the repository can be inspected by the current Linux user;
6. `.agentflow.yaml` exists or can be initialized.

## Repository Configuration

Support:

```yaml
version: 1

repository:
  name: revenue-operations
  base_branch: main

backlog:
  path: BACKLOG.md

workers:
  maximum: 4

contracts:
  roots:
    - contracts/
    - packages/contracts/

validation:
  task_default:
    - npm run lint
    - npm run typecheck

  integration:
    - npm run lint
    - npm run typecheck
    - npm test
    - npm run build

docker:
  enabled: true
  compose_file: compose.yaml

git:
  remote: origin
  push_task_branches: false
  push_integration_branch: false
```

Validate this configuration using a typed schema.

## Stack Inspection

Detect, where present:

* npm, pnpm, or Yarn;
* `package.json` scripts;
* Docker Compose;
* Vite;
* Next.js;
* React;
* Playwright;
* monorepo configuration;
* likely frontend roots;
* likely backend roots;
* contract directories;
* default validation commands.

## CLI and API

Add:

```bash
agentflow repo add /path/to/repository
agentflow repo list
agentflow repo inspect <repository-id>
agentflow repo init /path/to/repository
```

Add API endpoints:

```text
GET    /api/repositories
POST   /api/repositories
GET    /api/repositories/:id
POST   /api/repositories/:id/inspect
DELETE /api/repositories/:id
```

Repository removal must remove only AgentFlow registry metadata. It must never delete source repositories.

## Definition of Done

Register at least three fixture repositories in tests and verify:

* healthy repository;
* missing path;
* non-Git directory;
* invalid `.agentflow.yaml`;
* missing base branch;
* repository removal safety.

---

# Prompt 4 — Implement the Backlog Planner

Complete the Markdown backlog planning subsystem.

## Task Format

Support task sections like:

````markdown
## BL-103 — Implement checkout frontend

```yaml
estimate_hours: 9

depends_on:
  - BL-100

owns:
  - apps/web/src/features/checkout/
  - apps/web/test/checkout/

validate:
  - npm run test -- checkout
  - npm run typecheck

consumes:
  - task: BL-100
    artifact: checkout-api
    version: 1.0.0

produces:
  - name: checkout-consumer
    type: frontend
    version: 1.0.0
    path: apps/web/src/features/checkout/
````

Implement the checkout UI.

### Acceptance Criteria

* Loading, error, and success states exist.

````

## Required Validation

Reject:

- duplicate IDs;
- missing dependencies;
- self-dependencies;
- dependency cycles;
- missing acceptance criteria;
- invalid estimates;
- empty ownership;
- absolute ownership paths;
- ownership containing `..`;
- ownership of `.git`;
- ownership of AgentFlow runtime directories;
- missing validation commands when no repository defaults exist;
- consumed artifacts with no valid producer dependency;
- duplicate produced artifact names and versions.

## Planning Output

Calculate:

- normalized tasks;
- topological execution waves;
- ownership conflicts;
- total sequential work;
- critical-path duration;
- expected elapsed duration;
- expected savings percentage;
- tasks on the critical path;
- maximum theoretical concurrency.

Use:

\[
T_{parallel} =
\max\left(
C,
\frac{W}{M E}
\right)
+
O
\]

Make efficiency and overhead configurable.

## API and UI

Add:

```text
POST /api/plans
GET  /api/plans/:id
````

The planner screen must show:

* validation errors;
* task table;
* dependency graph;
* waves;
* critical path;
* ownership conflicts;
* expected savings.

Use a simple graph rendering library or accessible SVG implementation. Do not make the planning screen dependent on an external hosted service.

## Definition of Done

Add tests covering valid and invalid graphs, ownership conflicts, estimates, and artifact relationships.

---

# Prompt 5 — Implement Build Creation and State Machines

Implement persistent build creation and state transitions.

## Build States

Support:

```text
planning
ready
running
paused
completed
failed
cancelled
interrupted
```

## Task States

Support:

```text
pending
blocked
ready
running
validating
validated
integrating
integrated
failed
cancelled
interrupted
blocked_failed
```

## Required Behavior

1. Creating a build must snapshot:

   * repository configuration;
   * backlog contents;
   * normalized task plan;
   * base commit;
   * estimates;
   * worker limit.
2. Plans used by a build become immutable.
3. Only one active build may exist.
4. Every state transition must be validated.
5. Illegal transitions must fail without changing state.
6. Every transition must append a build event.
7. Add pause, resume, cancel, and retry operations.
8. Cancelling a build must not delete branches, worktrees, logs, or history.
9. Retrying a task must increment its attempt count and preserve prior attempt logs.

## API

Add:

```text
POST /api/builds
GET  /api/builds
GET  /api/builds/:id
POST /api/builds/:id/start
POST /api/builds/:id/pause
POST /api/builds/:id/resume
POST /api/builds/:id/cancel
POST /api/builds/:id/tasks/:taskId/retry
```

## Definition of Done

Provide exhaustive state-machine tests.

---

# Prompt 6 — Implement Git Branch and Worktree Management

Implement safe Git isolation.

## Branch Naming

Use:

```text
agent-integration/<build-id>
agent/<build-id>/<task-id>
```

## Worktree Layout

Use:

```text
~/.agentflow/worktrees/<repository-id>/<build-id>/integration
~/.agentflow/worktrees/<repository-id>/<build-id>/tasks/<task-id>
```

## Required Behavior

1. Resolve and store the build base commit.
2. Create the integration branch from the configured base branch.
3. Create each task branch from the latest validated integration commit.
4. Create worktrees using the system Git CLI.
5. Canonicalize all paths.
6. Never place worktrees inside the managed repository.
7. Detect existing branches and worktrees safely.
8. Support restart reconciliation.
9. Add safe cleanup commands that refuse to remove worktrees with uncommitted changes unless forced.
10. Record every Git command, exit code, and relevant output.
11. Do not use shell string concatenation for Git arguments.
12. Add tests using temporary Git repositories.

## CLI

Add:

```bash
agentflow worktrees list <build-id>
agentflow worktrees clean <build-id>
```

## Definition of Done

Demonstrate concurrent worktrees for four tasks without changing the user’s normal checkout.

---

# Prompt 7 — Implement the Four-Worker Scheduler

Implement the dependency-aware scheduler.

## Eligibility

A task is eligible when:

* all required dependencies are integrated;
* all required artifacts are integrated at compatible versions;
* no active task overlaps its ownership;
* no approval gate is outstanding;
* a worker slot is available.

## Ownership Conflict

Two roots conflict when:

```text
a == b
OR a starts with b/
OR b starts with a/
```

## Priority

Use:

[
S_i = 4B_i + 3C_i + 2A_i - 2R_i
]

Where:

* (B_i): normalized downstream blocked-task count;
* (C_i): critical-path membership;
* (A_i): ready-queue age;
* (R_i): risk score.

Store the ranking explanation so the UI can show why a task was selected.

## Required Behavior

1. Maximum four assigned workers.
2. No duplicate assignment.
3. No conflicting ownership.
4. Failed dependencies produce `blocked_failed`.
5. Paused builds dispatch nothing.
6. Cancelled builds stop scheduling.
7. Worker completion immediately triggers a new scheduling cycle.
8. Scheduler decisions are deterministic for identical state.
9. Scheduler state survives restarts.
10. Add deadlock detection and clear diagnostics.

## Definition of Done

Create simulation tests for:

* four independent tasks;
* long dependency chains;
* mixed independent and dependent tasks;
* ownership conflicts;
* failed dependencies;
* pause and resume;
* scheduler restart;
* deterministic ordering.

---

# Prompt 8 — Implement Codex Worker Execution

Implement the actual Codex worker runtime.

## Command

Use non-interactive Codex execution with JSONL output and workspace-write sandboxing.

Build the command through an argument array, not a shell string.

## Worker Prompt

Include:

* task ID and title;
* task description;
* acceptance criteria;
* owned paths;
* validation commands;
* repository instructions;
* integrated dependency manifests;
* consumed contracts and artifacts;
* example payloads;
* prohibited actions.

Explicitly prohibit Codex from:

* committing;
* pushing;
* merging;
* creating worktrees;
* modifying AgentFlow state;
* modifying the backlog;
* changing files outside ownership;
* controlling Docker directly.

## Required Behavior

1. Spawn Codex as a child process.
2. Record:

   * PID;
   * start time;
   * heartbeat;
   * stdout JSONL;
   * stderr;
   * exit code;
   * final structured result.
3. Add cancellation.
4. Add configurable timeout.
5. Handle malformed JSONL without losing raw logs.
6. Detect process disappearance.
7. Never mark a worker successful solely because exit code is zero.
8. Preserve every attempt separately.
9. Enforce a structured final result schema.
10. Show live events through Server-Sent Events.

## Test Strategy

Create a fake Codex executable for automated tests. It must support scenarios:

* successful change;
* no changes;
* ownership violation;
* malformed events;
* nonzero exit;
* timeout;
* cancellation;
* process disappearance.

Do not require real Codex credentials for the automated test suite.

---

# Prompt 9 — Implement Ownership Enforcement and Task Validation

After a worker exits:

1. Read every modified, added, deleted, and renamed path using Git.
2. Normalize paths.
3. Compare them against declared ownership.
4. Fail the task before validation when any path is outside ownership.
5. Preserve the worktree for inspection.
6. Show violations in the API and UI.

## Validation Runner

Implement a trusted command runner that:

* receives an argument or shell command from the immutable build plan;
* runs from the task worktree;
* captures stdout and stderr;
* records start, completion, exit code, and duration;
* supports timeout and cancellation;
* redacts configured secrets;
* uses a unique `COMPOSE_PROJECT_NAME`;
* cleans up task-specific Compose resources when configured.

## Required Task Outcome

A task becomes `validated` only when:

* Codex completed successfully;
* changed-file ownership passed;
* the task produced changes unless `allow_no_changes` is true;
* all validation commands passed;
* AgentFlow created a task commit;
* a validated handoff manifest was written.

## Definition of Done

Add integration tests for successful and failed validations, Docker project naming, secret redaction, and ownership enforcement.

---

# Prompt 10 — Implement Serialized Integration

Implement the integration manager.

## Required Process

For each validated task:

1. Acquire an integration mutex.
2. Record integration `HEAD`.
3. Merge the task branch using:

```bash
git merge --no-ff --no-edit <task-branch>
```

4. On conflict:

   * abort merge;
   * mark integration failed;
   * preserve the task branch and worktree.
5. Run all configured integration validation commands.
6. On validation failure:

   * reset the integration worktree to the recorded commit;
   * mark the task failed with an integration-validation error.
7. On success:

   * record integration commit;
   * mark task integrated;
   * mark artifacts integrated;
   * release downstream tasks;
   * append events in one database transaction.
8. Release the mutex.

Coding workers must continue while integration is running.

## Push Behavior

Support optional:

```yaml
git:
  push_task_branches: true
  push_integration_branch: true
```

Pushing must occur only after relevant validation succeeds.

## Definition of Done

Test:

* successful merge;
* merge conflict;
* integration test failure;
* reset correctness;
* concurrent integration requests;
* dependent-task release.

---

# Prompt 11 — Implement Handoff Manifests and Artifact Registry

Implement versioned task handoffs.

## Manifest Fields

Include:

```json
{
  "schemaVersion": "1.0.0",
  "buildId": "...",
  "taskId": "BL-103",
  "status": "integrated",
  "baseCommit": "...",
  "resultCommit": "...",
  "integrationCommit": "...",
  "changedFiles": [],
  "consumes": [],
  "produces": [],
  "validation": {
    "task": "passed",
    "integration": "passed"
  }
}
```

## Required Behavior

1. Create manifest after task validation.
2. Publish integrated version after successful merge.
3. Calculate SHA-256 for file artifacts.
4. Store artifact metadata in SQLite.
5. Allow downstream tasks to consume only integrated artifacts.
6. Enforce exact version matches in the MVP.
7. Detect duplicate artifact name/version combinations.
8. Invalidate dependent artifacts after a breaking contract change.
9. Include relevant manifests in downstream prompts.
10. Display artifacts and provenance in the UI.

## Definition of Done

Create a test feature where:

* contract task produces `checkout-api@1.0.0`;
* backend consumes it;
* frontend consumes it;
* integration consumes backend and frontend outputs.

---

# Prompt 12 — Implement Frontend/Backend Contract Workflows

Add first-class support for contract-aware feature streams.

## Contract Locations

Support repository-configured roots such as:

```text
contracts/
packages/contracts/
```

## Required Artifacts

Support:

* OpenAPI files;
* JSON Schema files;
* example payloads;
* generated TypeScript types;
* mock-server fixtures;
* UI state definitions;
* provider verification output;
* consumer verification output.

## Contract Classification

Classify changes as:

* patch;
* minor;
* major.

Treat these as major by default:

* removed field;
* renamed field;
* changed field type;
* new required field;
* removed endpoint;
* incompatible behavior change.

## Required Behavior

1. Contract tasks may unblock frontend and backend concurrently.
2. Frontend prompts receive:

   * API contract;
   * generated types;
   * fixtures;
   * required UI states.
3. Backend prompts receive:

   * API contract;
   * error behavior;
   * provider expectations.
4. Integration requires configured consumer/provider checks.
5. Major changes require approval.
6. Major changes invalidate dependent generated clients.
7. Display contract status and affected tasks in the dashboard.

---

# Prompt 13 — Implement the Active Build Dashboard

Expand the React application.

## Screens

### Repositories

Show:

* name;
* local path;
* base branch;
* health;
* detected stack;
* last build;
* actions.

### Planner

Show:

* validation results;
* dependency graph;
* waves;
* ownership conflicts;
* critical path;
* expected time;
* expected savings;
* start-build action.

### Active Build

Show:

* build status;
* elapsed time;
* critical path;
* four worker slots;
* ready queue;
* blocked tasks;
* integration queue;
* recent events;
* pause, resume, and cancel controls.

### Task Inspector

Show:

* task metadata;
* acceptance criteria;
* dependencies;
* ownership;
* worker prompt;
* live JSONL events;
* raw logs;
* changed files;
* diff;
* validation runs;
* artifacts;
* commits;
* retry action.

### Results

Show:

* integration branch;
* task outcomes;
* failed validations;
* elapsed versus estimated time;
* worker utilization;
* savings;
* push status.

## Requirements

* Use accessible controls.
* Support keyboard navigation.
* Do not require a hosted service.
* Use Server-Sent Events for live updates.
* Handle refresh and reconnection.
* Display explicit error states.
* Avoid optimistic success displays for build state.

---

# Prompt 14 — Implement Recovery and Reconciliation

Implement startup recovery.

## On Startup

Find builds in:

```text
running
paused
interrupted
```

For each task, reconcile:

* recorded PID;
* live process;
* worktree;
* branch;
* result commit;
* validation records;
* integration history;
* Docker Compose project.

## Rules

```text
live process exists:
  reattach monitoring

process missing and no result commit:
  mark interrupted

result commit exists and task validation missing:
  resume validation

task validation passed and integration missing:
  queue integration

integration commit exists:
  mark integrated

ambiguous or unsafe state:
  pause build for human review
```

## Requirements

* Never redispatch while an earlier worker may still be running.
* Never assume a task failed solely because AgentFlow restarted.
* Emit reconciliation events.
* Show recovery decisions in the UI.
* Add forced-termination integration tests.

---

# Prompt 15 — Implement CLI, Packaging, and systemd

Complete the product packaging.

## CLI Commands

Implement:

```bash
agentflow serve
agentflow doctor

agentflow repo add <path>
agentflow repo list
agentflow repo inspect <id>
agentflow repo init <path>

agentflow plan <repository-id>
agentflow run <plan-id>
agentflow status
agentflow inspect <build-id>
agentflow retry <build-id> <task-id>

agentflow service install
agentflow service start
agentflow service stop
agentflow service status

agentflow backup
agentflow upgrade
agentflow uninstall
```

## systemd

Install a user-level service, not a root service.

The service must:

* run as the current user;
* bind to loopback;
* restart on failure;
* use the installed AgentFlow executable;
* preserve environment configuration.

## Packaging

Produce:

* installable npm tarball;
* source ZIP;
* SHA-256 checksums;
* migration files;
* built dashboard assets;
* example `.agentflow.yaml`;
* example `BACKLOG.md`;
* installation guide;
* troubleshooting guide.

## Required Installation Flow

```bash
npm install --global ./agentflow-<version>.tgz
agentflow doctor
agentflow serve
```

## Definition of Done

Verify installation in a clean Ubuntu-compatible environment.

---

# Prompt 16 — End-to-End Acceptance Test

Implement and run a complete acceptance scenario.

## Scenario

```text
BL-100 Define checkout contract
├── BL-101 Create database migration
├── BL-102 Implement backend provider
└── BL-103 Implement frontend consumer

BL-101 + BL-102 + BL-103
             ↓
BL-104 Verify provider/consumer integration
             ↓
BL-105 Run browser smoke tests
```

## Required Test Behavior

1. Register a temporary Git repository.
2. Create the backlog and `.agentflow.yaml`.
3. Start a build.
4. Use fake Codex workers for deterministic automation.
5. Run database, backend, and frontend concurrently where allowed.
6. Produce and consume contract artifacts.
7. Intentionally introduce an incompatible backend response.
8. Confirm integration validation fails.
9. Retry with the corrected implementation.
10. Confirm all tasks integrate.
11. Terminate AgentFlow during the build.
12. Restart and confirm recovery.
13. Produce a final integration branch.
14. Confirm every event, prompt, log, validation, commit, and manifest is visible.
15. Calculate actual elapsed-time metrics.

## Final Quality Gates

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
```

Generate a final implementation report containing:

* architecture delivered;
* files and packages;
* commands;
* tests;
* known limitations;
* security considerations;
* installation procedure;
* next recommended improvements.

---

# Optional Master Prompt

Use this only after the repository has reliable tests and source control checkpoints.

You are the lead engineer responsible for completing AgentFlow according to the architecture specification in this repository.

AgentFlow is a local-first platform that registers multiple Git repositories, plans Markdown backlogs, and runs one active build with up to four isolated Codex workers. It must support dependency scheduling, Git worktrees, ownership enforcement, task validation, serialized integration, frontend/backend contracts, versioned handoff artifacts, crash recovery, a localhost API, and a React dashboard.

Work milestone by milestone. Do not attempt a broad rewrite without preserving working checkpoints.

Required order:

1. stabilize the existing project;
2. complete database migrations and repositories;
3. complete repository registration and inspection;
4. complete backlog planning;
5. implement build and task state machines;
6. implement Git worktrees;
7. implement the four-worker scheduler;
8. implement Codex execution;
9. implement ownership and validation;
10. implement serialized integration;
11. implement artifacts and manifests;
12. implement frontend/backend contracts;
13. implement the dashboard;
14. implement recovery;
15. implement packaging and systemd;
16. run the end-to-end acceptance test.

At the end of each milestone:

* run type checks;
* run relevant tests;
* run the production build;
* report exact results;
* commit the milestone;
* stop when validation fails and fix it before proceeding.

Never state that a milestone is complete unless its tests and build pass.
