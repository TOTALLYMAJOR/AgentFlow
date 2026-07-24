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
database, backups, logs, run evidence, artifacts, and Git worktrees.

## User service

Install a service for the current Linux user:

```bash
agentflow service install
agentflow service start
agentflow service status
```

This never creates a root or system-wide service. The generated environment
file has user-only permissions and preserves `AGENTFLOW_HOME`, host, port, log
level, Codex executable, and worker timeout. The unit is written beneath
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
