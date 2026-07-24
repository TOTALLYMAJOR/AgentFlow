# Troubleshooting

## Start with diagnostics

```bash
agentflow doctor
```

Git is required. Codex and Docker may be absent until a repository build needs
them.

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
