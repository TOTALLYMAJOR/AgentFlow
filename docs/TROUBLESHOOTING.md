# Troubleshooting

## Start with diagnostics

```bash
agentflow doctor
```

Git is required. Codex and Docker may be absent until a repository build needs
them. `doctor` also checks that the installed dashboard, migrations, examples,
architecture specification, and implementation prompt suite are present.

## The port is already in use

Choose another loopback port:

```bash
AGENTFLOW_PORT=4783 agentflow serve
```

Do not change `AGENTFLOW_HOST` to an external interface.

## Native SQLite installation fails

Use a current Node.js LTS release with a supported native binary and standard
Ubuntu build tools. Node.js 24 LTS is the production baseline; the source also
supports Node.js 22.12 and newer.

## A release checksum fails

Do not install that artifact. Re-download the complete release set and run:

```bash
sha256sum --check SHA256SUMS
```

If locally building, start from a clean Git checkout and rerun
`npm run pack:release`. Release creation checks npm tarball reproducibility and
required installed content before publishing the output directory.

## Test installation without global changes

```bash
npm run smoke:install -- /absolute/path/agentflow-0.3.0.tgz
```

This uses an isolated npm prefix and removes its temporary files on success or
failure. Pass `--keep` only when the temporary tree is needed for diagnosis.

## The no-argument upgrade command reports publication is required

No registry release is assumed by the packaged CLI. Use a reviewed, checksummed
local tarball or an explicit published package specifier:

```bash
agentflow upgrade /absolute/path/agentflow-0.3.0.tgz
agentflow upgrade agentflow@latest
```

A local AgentFlow tarball does not bundle every npm dependency. npm may still
use its configured registry when dependencies are missing or have changed.

## A repository cannot be registered

Confirm:

- The path is absolute.
- The current user can read and traverse the directory.
- It is a Git working tree.
- The configured base branch exists locally or under the configured remote.
- `.agentflow.yaml` matches the version 1 schema.

Run:

```bash
agentflow repo init /absolute/path/to/repository
agentflow repo add /absolute/path/to/repository
```

Initialization never overwrites an existing configuration.

## Planning fails

The API and dashboard return every structured preflight error together.
Common causes include duplicate task IDs, missing dependencies, cycles,
unsafe ownership paths, missing validation commands, and artifact versions
without a producing dependency.

## Database checks fail

Inspect diagnostics and create a consistent backup:

```bash
agentflow doctor
agentflow backup
```

Do not copy a live SQLite file manually while a build is running.

## Service logs

```bash
journalctl --user -u agentflow.service
```

AgentFlow redacts common authorization, cookie, token, secret, and password
fields from structured HTTP logs.

## The user service cannot be installed

Confirm the user service manager is available:

```bash
systemctl --user status
```

AgentFlow never falls back to a root service. On headless systems, the account
may need a systemd user session configured by the administrator. If
`XDG_CONFIG_HOME` is set, it must be absolute.

After changing runtime environment settings, reinstall and restart the unit:

```bash
agentflow service install
agentflow service stop
agentflow service start
```

The environment file is mode `0600`; the service unit is mode `0644`.
Installation atomically replaces regular files and refuses either destination
when it is a symbolic link.

## Uninstall left runtime data

This is intentional. `agentflow uninstall` removes the executable and
user-service files but preserves `$AGENTFLOW_HOME`, including databases,
worktrees, logs, and artifacts. Delete that directory manually only after
confirming no recovery or audit evidence is needed.

If `agentflow uninstall` cannot stop and disable the user service, it exits
without deleting the service files or npm package. Resolve the reported
`systemctl --user` failure, confirm the service is stopped, and retry.
