# AgentFlow Copilot Instructions

## Commands

- Requires Node.js `>=22.12.0` (Node 24 LTS recommended) and npm.
- Run the local API and dashboard together: `npm run dev`
- Run the server or Vite dashboard independently: `npm run dev:server` or
  `npm run dev:web`
- Lint: `npm run lint`
- Type-check both server and dashboard: `npm run typecheck`
- Run unit tests: `npm test`
- Run one unit test file: `npm test -- apps/server/test/orchestration.test.ts`
- Run integration tests: `npm run test:integration`
- Run one integration test file:
  `npm run test:integration -- tests/server.integration.test.ts`
- Produce the distributable CLI and bundled dashboard: `npm run build`
- Run the release-quality pipeline: `npm run verify`

Unit tests live next to the server in `apps/server/test/`; black-box integration
tests are in `tests/`. Vitest runs with one worker, and integration tests have
longer command timeouts. Tests construct isolated temporary runtime homes and
close Fastify instances explicitly; follow that pattern for tests that create
an app or touch SQLite/Git.

## Architecture

AgentFlow is a loopback-only, local-first control plane for dependency-aware
coding-agent builds across registered Git repositories. The production entry
point is `apps/server/src/index.ts`; the Commander CLI is
`apps/server/src/cli.ts`. The Fastify composition root,
`apps/server/src/http/app.ts`, creates the environment, SQLite repositories,
repository service, artifact service, provider registry, build coordinator, and
recovery service before registering all API routes and serving the built React
application.

The dashboard in `apps/web/` is a Vite/React single-page application using
Primer React and SWR. `App.tsx` owns screen selection and lazy-loads screens;
`api/client.ts` centralizes JSON request and typed error handling. Build
activity is delivered through the build SSE endpoint and consumed by
`hooks/use-build-events.ts`.

Persistent operational state deliberately stays outside managed repositories:
`$AGENTFLOW_HOME` (default `~/.agentflow`) contains the SQLite database, logs,
runtime evidence, managed worktrees, backups, governance policy, and PID file.
Registered repositories contribute only their versioned `.agentflow.yaml` and
backlog. `config/environment.ts` is the single source for runtime paths,
loopback binding, worker limits, retry settings, and environment validation.

The server pipeline is:

```text
repository config + committed Markdown backlog
  -> planning (parse, validate DAG/ownership/epics, persist immutable plan)
  -> build coordinator (schedule eligible tasks and create isolated worktrees)
  -> coding-agent or remote-runner attempt
  -> changed-path and command validation
  -> serialized integration validation and merge
  -> durable artifacts, events, evidence, and handoff manifests
```

- `planning/` parses backlogs, validates task and epic graphs, calculates
  execution waves/estimates, detects ownership conflicts, and produces ADR
  drafts.
- `orchestration/` owns scheduling, explicit build/task state machines, retry
  policy, worker-budget selection, task commits, and the `BuildCoordinator`.
- `workers/` defines provider adapters and executes the local Codex provider
  with a structured result schema, bounded/redacted durable logs, cancellation,
  and timeouts. Remote runners use pull-based lease-fenced jobs and submit
  digest-verified patches through the same validation and integration gates.
- `validation/` runs repository-declared commands and checks actual Git changes
  against task ownership. `integration/` is the per-build mutex-protected lane:
  it merges one validated task, runs integration commands, and rolls back on
  validation or persistence failure.
- `db/` is the durable record of repositories, immutable plans, builds, task
  attempts, validations, events, artifacts, manifests, retries, runners,
  visual evidence, and knowledge snapshots. SQLite is configured with foreign
  keys and WAL mode. `recovery/` reconciles this state with processes and
  worktrees on startup.

### Planning, Scheduling, and Integration Detail

Planning starts from a committed Markdown backlog plus the strict
`.agentflow.yaml` repository contract. The persisted plan retains the backlog
contents and SHA-256, normalized task graph, repository configuration, waves,
estimates, ownership conflicts, epics, and proposed ADR drafts. A plan becomes
immutable when it is used to create a build; create a new plan rather than
mutating its source snapshot.

The coordinator creates a build-specific integration branch and one worktree
per dispatched task. It only dispatches ready tasks whose dependencies have
integrated, required artifacts meet their exact version/status requirements,
manual approvals are resolved, and ownership roots do not conflict with tasks
in the selected batch. Scheduling is deterministic and ranks eligible work by
downstream impact, critical-path membership, persisted ready-queue age, and
risk while respecting both the build worker ceiling and the installation-wide
worker budget.

A task progresses through `ready -> running -> validating -> validated ->
integrating -> integrated`; dependents unlock only after successful
integration, not merely after a worker completes or task validation passes.
Failed upstream tasks block their dependents. Integration is intentionally
serialized: merge the validated task branch into the current integration
worktree, run the repository-wide integration commands, record durable
evidence, and roll back to the prior validated commit if merging, validation,
or result persistence fails. Retried tasks are new attempts and retain prior
attempt evidence.

### Operator Workflow

AgentFlow operates on a clean, committed checkout. Initialize or register a
repository with `agentflow repo init /absolute/path` and
`agentflow repo add /absolute/path`, then review the generated
`.agentflow.yaml`. The configuration declares the base branch, committed
backlog location, worker ceiling, contract roots, task/integration validation
commands, Docker policy, and Git publication behavior.

Create or generate a root `BACKLOG.md`, inspect it, and commit it before
planning. Each task needs a unique heading plus estimate, dependencies,
ownership roots, acceptance criteria, and validation commands; use
`produces`/`consumes` for versioned cross-task artifacts. Plan and execute
with:

```bash
agentflow plan <repository-id>
agentflow run <plan-id>
agentflow status
agentflow inspect <build-id>
```

The dashboard and API expose task attempts, worker logs, diffs, validations,
events, handoff manifests, and integration results. Pause, resume, cancel, or
retry through the corresponding build controls/CLI commands; cancellation and
recovery preserve branches, worktrees, logs, attempts, and durable events.
`agentflow worktrees clean <build-id>` only removes AgentFlow-managed
worktrees and preserves branches. `agentflow repo remove` removes registry
metadata only, never source files.

Review repository-declared validation commands, backlog content, organization
policy, and runner configuration before execution: validation runs as the
current Linux user, and remote results remain untrusted patches until they pass
the normal digest, ownership, validation, commit, handoff, and integration
gates.

The accepted ADRs in `docs/architecture/` describe current behavior and
supersede `docs/ASSUMPTIONS.md`; the `SPEC-1` document is historical MVP
provenance. The README documents the operator workflow and trust boundary.

## Repository-Specific Conventions

- TypeScript is strict with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and NodeNext module resolution. Use `.js` in
  relative TypeScript import specifiers. Keep `import type` separate where it
  is type-only.
- Treat build and task states as guarded transitions. Add or change lifecycle
  behavior through `orchestration/state-machines.ts`, the corresponding
  repository transition methods, durable events, and recovery behavior; do not
  assign status fields ad hoc.
- Preserve the gates between worker execution, task validation, and
  integration. A worker's claim, prompt, or remote patch is untrusted until
  AgentFlow has checked actual changed paths, run declared validation, recorded
  evidence, and completed serialized integration validation.
- The application allows active builds concurrently only across different
  repositories. A repository has one active build and one serialized
  integration lane; coordinator maps, events, worktrees, and recovery logic
  must remain keyed by build/task IDs rather than global state.
- Validate external input at boundaries with Zod, as routes and
  `.agentflow.yaml` parsing do. Repository-relative paths must not escape the
  registered repository, and repository configuration schemas are strict.
- Add SQLite schema changes as a new, ordered entry in the immutable
  `MIGRATIONS` array in `apps/server/src/db/migrations.ts`. Do not rewrite an
  already-applied migration: checksums detect migration drift.
- API routes are registered in `http/app.ts` and receive the shared
  `AgentFlowContext`; keep route handlers thin and place durable domain logic
  in their owning service/module. Route failures use `AgentFlowError` for
  stable error codes and HTTP status mapping.
- Runtime files, logs, manifests, and browser evidence belong under
  `$AGENTFLOW_HOME`, not in a managed source repository or task branch.
  Repository validation commands are trusted operator-reviewed input executed
  as the current user, not sandboxed input.
