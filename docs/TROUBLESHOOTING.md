# Troubleshooting

## Start with current state

```bash
agentflow doctor
curl http://127.0.0.1:4782/api/health
agentflow repo list
agentflow status
```

Git is required. Codex, Playwright Chromium, and Docker are required only when a
selected provider or repository validation needs them.

The health response shows active build IDs, global worker capacity, configured
providers, runner capacity, remote-job counts, and pending retry schedules.

## The service is unavailable

For a user-service installation:

```bash
agentflow service status
agentflow service start
journalctl --user -u agentflow.service
```

For source development, run `npm run dev`. Do not start a second process against
the same port and runtime directory.

## The port is already in use

Choose another loopback port:

```bash
AGENTFLOW_PORT=4783 agentflow serve
```

`AGENTFLOW_HOST` intentionally accepts only `127.0.0.1`.

## A repository cannot be registered

Confirm:

- The path is absolute and accessible to the current user.
- It is a Git working tree.
- The configured base branch exists locally or on the configured remote.
- `.agentflow.yaml` matches version 1.
- The organization policy permits its worker maximum and validation commands.

Then run:

```bash
agentflow repo init /absolute/path/to/repository
agentflow repo add /absolute/path/to/repository
agentflow repo inspect <repository-id>
```

Initialization never overwrites existing configuration.

## Backlog generation refuses to run

Generation requires a clean registered checkout because Codex is allowed to
change only the requested backlog file. Commit or otherwise resolve current
repository work first. Do not hide unrelated work with a destructive reset.

After generation:

```bash
git diff -- BACKLOG.md
git add BACKLOG.md
git commit -m "plan: add AgentFlow backlog"
```

Review the generated objective, dependencies, ownership, validation, epics, and
architecture decisions before committing.

## Planning fails

AgentFlow returns all structured preflight errors together. Common causes:

- Duplicate or missing task IDs
- Missing dependencies or dependency cycles
- Inconsistent epic metadata or epic cycles
- Unsafe or organization-protected ownership paths
- Missing validation commands
- Artifact consumption without a producing dependency
- Repository worker or validation settings that violate organization policy

Fix the committed backlog or configuration, then create a new immutable plan.

## A build is not dispatching

Check:

- The build is `running`, not paused or waiting for retry.
- Dependencies are integrated.
- Another build for the same repository is not active.
- The installation worker budget has capacity.
- The repository and organization worker limits are nonzero and compatible.
- An eligible local provider or online remote runner exists.

The dashboard Overview and Build screens show capacity, ranking, blocked tasks,
runner state, retry schedules, and recent events.

## A remote runner cannot claim work

Verify:

- The bearer token matches the registered runner.
- The runner is `online`, not `draining`.
- Reported busy slots are below capacity.
- Its provider matches the queued job provider.
- Its private tunnel reaches the loopback API.

Send a fresh heartbeat, then claim again. A `204` claim response means no
eligible job is queued.

## A remote result is rejected

Typical causes are:

- Missing or expired lease token
- Result submitted by a different runner
- Reuse of an idempotency key with different content
- Missing `patchBase64` or `patchSha256`
- Digest mismatch or patch larger than 16 MiB
- Patch cannot apply to the exact base commit

Do not bypass the fence. Re-run the task as a new attempt after correcting the
runner.

## Automatic retry is waiting

Transient failures use durable exponential backoff. Inspect build events and the
health response before retrying manually. A service restart does not erase an
accepted retry schedule.

Validation, ownership, malformed output, and worker-reported blockers remain
terminal because repeating them automatically is unlikely to help.

## Screenshot comparison fails

Confirm:

- Playwright Chromium is installed: `npx playwright install chromium`.
- The URL uses `localhost`, `127.0.0.1`, or `::1`.
- The application route is running and reaches network idle.
- The baseline is a PNG inside the registered repository.
- Dimensions match the requested viewport/full-page capture.
- Requested tolerance does not exceed organization policy.

Actual and diff images remain under `$AGENTFLOW_HOME/artifacts`.

## Knowledge impact is empty or incomplete

Create a fresh snapshot after committing relevant code. The graph reads tracked
files at the exact Git `HEAD` and resolves relative imports. Package imports,
generated runtime edges, reflection, and framework conventions may remain
unknown.

## Database checks fail

```bash
agentflow doctor
agentflow backup
```

Do not manually copy a live SQLite file while builds are active.

## Native SQLite installation fails

Use a current Node.js LTS release with a supported native binary and standard
Ubuntu build tools. The project supports Node.js 22.12 and newer; Node.js 24 LTS
is recommended.

## Release or installation checks fail

If `sha256sum --check SHA256SUMS` fails, do not install the artifact. Build
release artifacts only from a clean checkout:

```bash
npm run verify
npm run pack:release
npm run smoke:install -- /absolute/path/agentflow-0.3.0.tgz
```

The isolated smoke install may still contact the configured npm registry for
missing dependencies.

## User service installation fails

Confirm `systemctl --user status` works. AgentFlow never falls back to a root
service. If `XDG_CONFIG_HOME` is set, it must be absolute.

After environment changes:

```bash
agentflow service install
agentflow service stop
agentflow service start
```

The environment file is mode `0600`; the service unit is mode `0644`. Symbolic
link destinations are refused.

## Uninstall preserved runtime data

This is intentional. `agentflow uninstall` removes the executable and user
service files but preserves `$AGENTFLOW_HOME`, including databases, worktrees,
logs, patches, screenshots, and other audit evidence. Remove it manually only
after confirming recovery and audit data are no longer needed.
