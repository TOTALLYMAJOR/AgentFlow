# Installation

## Global package

Build and pack from a trusted source checkout:

```bash
npm install
npm run verify
npm pack
npm install --global ./agentflow-0.3.0.tgz
```

Verify the local runtime:

```bash
agentflow doctor
agentflow serve
```

The service binds to `127.0.0.1:4782`. `AGENTFLOW_HOST` accepts only
`127.0.0.1`.

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
file has user-only permissions and preserves `AGENTFLOW_HOME`, host, and port.

## Remove the executable

```bash
agentflow service stop
agentflow uninstall
```

Uninstall preserves runtime data and worktrees for recovery and audit. Review
and remove that data separately only after confirming no build needs it.
