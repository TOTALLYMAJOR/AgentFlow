# Installation

## Install a release

Verify the checksum before installing:

```bash
sha256sum --check SHA256SUMS
npm install --global ./agentflow-0.3.0.tgz
agentflow doctor
agentflow serve
```

Open `http://127.0.0.1:4782`. `AGENTFLOW_HOST` accepts only `127.0.0.1`;
AgentFlow rejects external bind addresses.

The npm tarball includes the server, CLI, built dashboard, exported SQL
migrations, examples, installation and troubleshooting guides, the supplied
architecture specification, and the complete supplied implementation prompt
suite. The source ZIP and npm tarball are covered by `SHA256SUMS`.

Locate the installed offline documents with:

```bash
printf '%s\n' "$(npm root --global)/agentflow/docs"
```

## Build release artifacts from source

Use a trusted, clean Git checkout:

```bash
npm install
npm run verify
npm run pack:release
```

This writes a deterministic release set under `release/`:

- `agentflow-<version>.tgz`
- `agentflow-<version>-source.zip`
- `release-manifest.json`
- `SHA256SUMS`

Release creation refuses a dirty source tree by default and verifies that two
npm pack operations produce the same SHA-256 digest. To test installation
without touching the machine-wide npm prefix:

```bash
npm run smoke:install -- ./release/agentflow-0.3.0.tgz
```

The smoke test uses temporary runtime, npm-prefix, and XDG configuration
directories. It verifies `doctor`, loopback serving, dashboard assets, SQL
migrations, supplied-document hashes, atomic user-service generation, explicit
local-tarball reinstallation, fail-closed service removal, and uninstall data
preservation.

## Runtime location

Set a custom state directory before starting AgentFlow:

```bash
export AGENTFLOW_HOME=/absolute/private/path/agentflow
agentflow serve
```

Otherwise AgentFlow uses `~/.agentflow`. The directory contains the SQLite
database, backups, logs, run evidence, artifacts, Git worktrees, and the
installation governance policy.

Key environment settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTFLOW_HOME` | `~/.agentflow` | Runtime and evidence root |
| `AGENTFLOW_HOST` | `127.0.0.1` | Loopback bind; other values are rejected |
| `AGENTFLOW_PORT` | `4782` | API and dashboard port |
| `AGENTFLOW_DEFAULT_AGENT_PROVIDER` | `codex` | Local provider adapter |
| `AGENTFLOW_MAX_CONCURRENT_WORKERS` | `4` | Installation worker budget |
| `AGENTFLOW_WORKER_TIMEOUT_MS` | `1800000` | Per-worker timeout |
| `AGENTFLOW_RETRY_MAX_ATTEMPTS` | `3` | Environment retry ceiling |
| `AGENTFLOW_RETRY_BASE_DELAY_MS` | `5000` | Initial retry delay |
| `AGENTFLOW_RETRY_MAX_DELAY_MS` | `300000` | Maximum retry delay |

Limit coding-worker processes across all concurrently active repositories:

```bash
export AGENTFLOW_MAX_CONCURRENT_WORKERS=4
agentflow serve
```

Repository `workers.maximum` values remain per-build ceilings. The environment
setting is the installation-wide budget shared by every running build.

Select the coding-agent adapter used for new task dispatches:

```bash
export AGENTFLOW_DEFAULT_AGENT_PROVIDER=codex
agentflow serve
```

The current installation includes the local `codex` provider. AgentFlow fails
startup if the selected provider is not configured.

## First repository workflow

Use a clean, committed checkout:

```bash
agentflow repo init /absolute/path/to/repository
agentflow repo add /absolute/path/to/repository
agentflow repo list
agentflow plan <repository-id>
agentflow run <plan-id>
agentflow inspect <build-id>
```

`repo init` never overwrites `.agentflow.yaml`. Review and commit both
`.agentflow.yaml` and `BACKLOG.md` before planning. A plan is immutable; edit the
backlog and create a new plan when requirements change.

## Remote runner registration

A remote machine registers against the control-plane API and receives a
one-time bearer token:

```bash
curl --request POST http://127.0.0.1:4782/api/runners/register \
  --header 'content-type: application/json' \
  --data '{"name":"build-host-1","providerId":"codex","capacity":4,"capabilities":{"os":"linux","browser":true}}'
```

Store the returned token in the remote machine's secret store. AgentFlow stores
only its SHA-256 digest. The runner reports capacity and drain state with:

```bash
curl --request POST http://127.0.0.1:4782/api/runners/heartbeat \
  --header "authorization: Bearer $AGENTFLOW_RUNNER_TOKEN" \
  --header 'content-type: application/json' \
  --data '{"busySlots":0,"status":"online"}'
```

AgentFlow remains loopback-bound. A remote host must reach it through an
authenticated private tunnel; do not expose the control-plane port directly.
Registration and heartbeat establish machine identity and availability. Remote
jobs are claimed with `POST /api/remote-jobs/claim`. A successful claim returns
a short-lived, one-time lease token alongside the immutable job payload. Use
that token in `X-AgentFlow-Lease-Token` for:

- `POST /api/remote-jobs/:id/heartbeat` to extend the lease.
- `POST /api/remote-jobs/:id/complete` to submit a structured result.

Completion also requires a stable `Idempotency-Key`. Repeating the same key and
result is safe; a different result for a completed job is rejected. Expired
leases and jobs cancelled by their build cannot submit results.

For build execution, an eligible runner receives protocol version 1 with the
repository remote, exact base commit, task, and prompt context. It returns
`patchBase64`, a base64 unified Git patch against that commit, `patchSha256`, the
lowercase SHA-256 digest of the decoded patch, and an optional `summary`.
AgentFlow verifies and stores the patch, applies it only in the task worktree,
and runs the normal ownership, validation, commit, and integration pipeline. If
no remote runner has capacity, the configured local provider runs.

## Automatic retry policy

Transient worker and provider failures retry with deterministic exponential
backoff. The schedule is stored in SQLite and recovered after service restart.

```bash
export AGENTFLOW_RETRY_MAX_ATTEMPTS=3
export AGENTFLOW_RETRY_BASE_DELAY_MS=5000
export AGENTFLOW_RETRY_MAX_DELAY_MS=300000
```

Timeouts, disappeared processes, provider unavailability/rate limits, and
expired remote leases are retryable. Invalid structured output, ownership
violations, validation failures, and worker-reported blockers remain terminal
until an operator retries them. Exact policy decisions and due times are
recorded as build events.

## Historical estimate calibration

After three integrated tasks in a repository, new plans apply the median
actual-to-estimated duration ratio from that repository. The multiplier is
clamped to `0.5`–`3.0`, stored in the immutable plan, and shown with its sample
count and confidence in the planner.

Inspect the evidence summary with:

```bash
curl http://127.0.0.1:4782/api/repositories/REPOSITORY_ID/estimate-calibration
```

## Epic decomposition and ADR drafts

Generated backlogs organize broad objectives into outcome-oriented epics. Each
task records `epic_id`, `epic_title`, and `epic_outcome`; AgentFlow derives
cross-epic dependencies and rejects epic cycles during plan validation.

Tasks that introduce a genuine architecture choice may declare:

```yaml
architecture_decisions:
  - title: Use pull-based execution leases
    context: Remote machines cannot accept inbound connections.
    decision: Runners claim short-lived fenced leases.
    consequences:
      - Late results are rejected.
```

Validated plans render these as proposed ADR drafts in the Planner. Review and
publish them separately; plan creation never writes accepted ADRs into the
repository.

## Browser screenshot comparison

Install the Playwright Chromium runtime on the control-plane host or any runner
that advertises browser capability:

```bash
npx playwright install chromium
```

The Repositories screen can capture a loopback route and compare it with a
repository-relative committed PNG baseline. Captures use a fixed viewport,
reduced motion, disabled animation, blocked service workers, and network-idle
navigation. Actual and diff images are stored under AgentFlow artifacts; the
comparison ratio and evidence paths are persisted in SQLite.

Control-plane captures accept only `localhost`, `127.0.0.1`, or `::1`. Use a
private runner-local tunnel when the application itself runs elsewhere.

## Knowledge graph and impact analysis

Use **Map** beside a registered repository to create an immutable graph snapshot
from tracked source, test, configuration, and Markdown files. AgentFlow records
the exact Git commit, file hashes, and resolved relative import edges.

The impact tool traces a changed file or directory through reverse imports and
reports direct files, transitive dependents, dependency depth, and active tasks
whose ownership intersects the affected files. Package imports that cannot be
resolved inside the repository are left unknown rather than guessed.

## Organization policy and repository templates

AgentFlow creates
`$AGENTFLOW_HOME/governance/organization-policy.yaml` on first startup and never
overwrites it. The policy caps workers and retries, restricts providers, requires
validation commands, protects ownership prefixes, and limits browser comparison
tolerance. Restart AgentFlow after editing it.

The Repositories screen lists reusable templates. Applying one requires explicit
overwrite confirmation, changes only `.agentflow.yaml`, and then instructs the
operator to review and commit the configuration before planning.

The current built-in templates are:

- `safe-generic` — two workers and `git diff --check`.
- `node-service` — lint, typecheck, test, and build validation.
- `node-monorepo` — Node validation with shared contract roots.

Inspect policy and template metadata with:

```bash
curl http://127.0.0.1:4782/api/governance
```

## User service

Install a service for the current Linux user:

```bash
agentflow service install
agentflow service start
agentflow service status
```

This never creates a root or system-wide service. The generated environment
file has user-only permissions and preserves `AGENTFLOW_HOME`, host, port, log
level, Codex executable, default agent provider, worker timeout, and global
worker budget. The unit is written beneath
`$XDG_CONFIG_HOME` when that absolute path is set, otherwise beneath
`~/.config/systemd/user`. Installation enables the unit for the current user;
starting it remains an explicit command.

The service always uses the installed AgentFlow CLI, binds to loopback, and
restarts on failure. A working systemd user session is required; no root access
is used.

## Upgrade

The no-argument command intentionally returns publication guidance until an
AgentFlow registry release exists. After a reviewed registry release is
published, pass its package specifier explicitly:

```bash
agentflow upgrade agentflow@latest
```

Reinstall or upgrade from a reviewed local tarball:

```bash
agentflow upgrade /absolute/path/agentflow-0.3.0.tgz
```

Selecting a local tarball keeps the AgentFlow package payload local, but npm may
still resolve missing or changed dependencies through its configured registry.
It is not an offline-install guarantee. Verify the tarball checksum before
running the command.

## Remove the executable

```bash
agentflow uninstall
```

Uninstall stops and removes the current user's AgentFlow service files, reloads
the user service manager, and removes the global npm package. It preserves
runtime data and worktrees for recovery and audit. Review and remove that data
separately only after confirming no build needs it.

If the user service cannot be stopped and disabled, uninstall fails closed:
the service files and npm package remain installed so a running control plane
is never silently orphaned.
