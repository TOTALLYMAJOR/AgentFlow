# AgentFlow

AgentFlow is a local-first engineering control plane for running reviewed,
dependency-aware work across multiple Git repositories. It turns a committed
Markdown backlog into an immutable plan, executes tasks in isolated worktrees,
validates declared ownership and repository commands, and serializes accepted
changes into a build integration branch.

The control plane binds to `127.0.0.1`. Operational state, logs, evidence,
managed worktrees, policies, and the SQLite database live outside registered
repositories under `$AGENTFLOW_HOME` (default `~/.agentflow`).

## What AgentFlow now supports

- Concurrent active builds across different registered repositories.
- One active integration lane per repository.
- An installation-wide worker budget with resource-aware scheduling.
- A coding-agent provider registry with local Codex execution.
- Pull-based remote runners with capacity reporting and lease-fenced jobs.
- Digest-verified remote patches that pass through normal ownership,
  validation, commit, handoff, and integration gates.
- Durable automatic retries with bounded exponential backoff.
- Repository-specific historical estimate calibration.
- Repository-grounded automatic backlog generation.
- Epic decomposition, cross-epic dependency validation, and proposed ADR drafts.
- Browser screenshot comparison against committed PNG baselines.
- Persisted codebase knowledge graphs and reverse impact analysis.
- Installation-wide organization policy and explicit repository templates.
- A dashboard for repositories, planning, builds, runners, evidence, and next
  actions.

## Requirements

- Ubuntu-compatible Linux
- Node.js 22.12 or newer; Node.js 24 LTS is recommended
- npm
- Git
- Codex CLI when using the included local `codex` provider
- Playwright Chromium when capturing browser comparison evidence
- Docker Compose only for repositories that enable Docker validation
- systemd user services only when installing the background service

## Install

From a checksummed release:

```bash
sha256sum --check SHA256SUMS
npm install --global ./agentflow-0.3.0.tgz
agentflow doctor
agentflow serve
```

Open `http://127.0.0.1:4782`.

From source:

```bash
npm install
npm run dev
```

For a persistent user service:

```bash
agentflow service install
agentflow service start
agentflow service status
```

## Run a repository

Start with a clean, committed Git checkout:

```bash
agentflow repo init /absolute/path/to/repository
agentflow repo add /absolute/path/to/repository
agentflow repo list
```

Review `.agentflow.yaml`, then create or generate a root `BACKLOG.md`. Generated
backlogs are intentionally review-only: inspect and commit the file before
planning.

```bash
agentflow plan <repository-id>
agentflow run <plan-id>
agentflow status
agentflow inspect <build-id>
```

The operational sequence is:

```text
clean checkout
  -> reviewed .agentflow.yaml
  -> reviewed and committed BACKLOG.md
  -> immutable plan
  -> isolated task execution
  -> ownership and validation gates
  -> serialized integration
  -> evidence and handoff
```

`repo remove` removes registry metadata only. It never deletes source. Managed
worktrees can be inspected or explicitly cleaned:

```bash
agentflow worktrees list <build-id>
agentflow worktrees clean <build-id>
```

## Backlog essentials

Each task needs a unique heading, estimate, dependency list, owned paths, useful
acceptance criteria, and validation commands. Broad programs should also include
epic metadata:

```yaml
epic_id: CHECKOUT
epic_title: Checkout delivery
epic_outcome: Customers can complete a validated checkout.
estimate_hours: 4
depends_on: []
owns:
  - contracts/checkout/
validate:
  - npm run typecheck
```

Use `produces` and `consumes` to make cross-task artifacts explicit. Architecture
choices may include `architecture_decisions`; AgentFlow renders proposed ADRs
but never silently accepts or writes them into the repository.

## Remote runners

Remote execution is pull-based. A runner registers once, stores the returned
token as a secret, sends capacity heartbeats, claims a short-lived job, and
returns a unified patch plus its SHA-256 digest. The control plane verifies the
patch before applying it to the isolated task worktree.

AgentFlow remains loopback-only. Remote machines must reach it through an
authenticated private tunnel or equivalent private transport; do not expose the
API directly to the internet.

See [Installation and operations](docs/INSTALLATION.md#remote-runner-registration)
for the runner protocol.

## Quality and release

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
```

Build reproducible release artifacts from a clean tree:

```bash
npm run pack:release
npm run smoke:install -- ./release/agentflow-0.3.0.tgz
```

## Documentation

- [Documentation map](docs/README.md)
- [Installation and operations](docs/INSTALLATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Security model](docs/SECURITY.md)
- [Implementation assumptions](docs/ASSUMPTIONS.md)
- [Architecture decisions](docs/architecture/)
- [Repository examples](examples/README.md)

The original MVP specification and implementation prompt suite are retained as
historical source contracts. ADR-0001 through ADR-0012 and the current
operational documentation describe the implemented post-MVP behavior.

## Trust boundary

Repository validation commands are executable code run as the current Linux
user. Review `.agentflow.yaml`, `BACKLOG.md`, organization policy, and runner
configuration before starting work.

Coding workers do not receive authority to commit, push, merge, create
worktrees, mutate AgentFlow state, or control Docker. AgentFlow performs those
operations only after its independent gates pass. Remote worker output is
treated as untrusted patch input until digest, path ownership, validation, and
integration checks succeed.
