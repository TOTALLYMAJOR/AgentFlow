# Security model

AgentFlow is a single-user local application. It is not designed for internet
exposure or shared untrusted accounts.

## Enforced boundaries

- API and dashboard bind to `127.0.0.1`.
- Repository paths are absolute and canonicalized.
- Runtime data lives outside managed repositories.
- At most one recoverable build is active installation-wide.
- Worker limit is four.
- Task work uses dedicated branches and worktrees.
- Actual Git changes are checked against declared ownership.
- Dependencies and exact artifact versions must integrate before consumers run.
- Task and integration validation gate commits and merges.
- Integration merges are serialized.
- SQLite foreign keys, WAL, checksummed migrations, and durable events are on.
- Backups use SQLite's online backup API and pass an integrity check.
- Common credential fields are redacted from HTTP logs.

## Trusted input

`.agentflow.yaml` and `BACKLOG.md` are version-controlled but their validation
commands execute as the current Linux user. Register only repositories whose
configuration you have reviewed.

## Worker restrictions

Generated worker prompts prohibit Codex from committing, pushing, merging,
creating worktrees, changing AgentFlow state or backlog files, writing outside
task ownership, or controlling Docker. AgentFlow independently verifies Git
changes after execution; prompt instructions alone are not a security control.

## Credentials

AgentFlow uses the current user's local Codex and Git configuration. It does not
store application credentials in SQLite. Never put secrets in backlogs,
repository configuration, prompts, fixtures, or committed environment files.
