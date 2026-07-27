# Security model

AgentFlow is a single-user, local-first control plane. It is not designed for
direct internet exposure, shared untrusted operating-system accounts, or
multi-tenant hosting.

## Enforced boundaries

- API and dashboard bind only to `127.0.0.1`.
- Repository paths are absolute, canonicalized, and checked for containment.
- Runtime state lives outside registered repositories.
- One recoverable build may be active per repository.
- Concurrent repositories share an installation-wide worker budget.
- Organization policy may further cap workers, retries, providers, ownership
  prefixes, required validation, and visual tolerance.
- Task work uses dedicated Git branches and worktrees.
- Actual Git changes are checked against declared ownership.
- Dependencies and exact artifact versions integrate before consumers run.
- Task and integration validation gate commits and merges.
- Integration is serialized per build.
- SQLite foreign keys, WAL, checksummed migrations, durable events, and
  lease-fenced remote jobs are enabled.
- Backups use SQLite's online backup API and pass an integrity check.
- Common credential fields are redacted from structured HTTP logs.

## Trusted repository input

`.agentflow.yaml`, `BACKLOG.md`, repository instructions, and validation commands
are version-controlled input, but validation commands execute as the current
Linux user. Register and run only repositories whose configuration and backlog
you have reviewed.

AgentFlow applies timeouts, cancellation, log capture, redaction, and isolated
Compose project names. Those controls do not turn arbitrary shell commands into
a complete security sandbox.

## Local workers

Generated prompts prohibit coding agents from committing, pushing, merging,
creating worktrees, changing AgentFlow state or backlog files, writing outside
task ownership, or controlling Docker.

Prompt instructions are not the security boundary. AgentFlow independently
checks changed paths, runs configured validation, creates the task commit, and
serializes integration.

## Remote runners

Remote runners:

- Register once and receive a bearer token that must be stored as a machine
  secret.
- Persist only the token's SHA-256 digest in AgentFlow.
- Pull jobs through an authenticated private connection.
- Receive short-lived, single-runner lease tokens.
- Must heartbeat before lease expiry.
- Submit idempotent results tied to the active lease.
- Return a bounded unified patch and SHA-256 digest.

The control plane rejects stale, duplicate-conflicting, expired, oversized, or
digest-mismatched results. A valid digest proves transport integrity, not code
safety; ownership and repository validation remain mandatory.

AgentFlow stays loopback-bound. Connect remote machines through an authenticated
private tunnel or equivalent private transport. Never expose port `4782`
directly to an untrusted network.

## Browser comparison

Control-plane browser captures accept only loopback URLs. Baselines must resolve
inside the registered repository. Captures, diffs, and metrics are stored under
runtime artifacts.

Browser comparison loads application code and content. Treat the target route as
trusted local input and inspect generated evidence before acceptance.

## Credentials and sensitive data

AgentFlow uses the current user's Git and local provider configuration. Do not
put secrets in:

- Backlogs or repository configuration
- Organization policy or templates
- Worker prompts, fixtures, screenshots, or handoff manifests
- Committed environment files
- Remote job payloads or result summaries

Keep runner tokens, Git credentials, provider credentials, and tunnel
credentials in appropriate user or machine secret stores. Runtime data may
contain source paths, logs, patches, and screenshots; protect
`$AGENTFLOW_HOME` accordingly.

## Destructive operations

Repository removal deletes AgentFlow registry metadata only. Worktree cleanup is
limited to AgentFlow-managed paths and requires force for active or dirty state.
Uninstall preserves runtime data for recovery and audit.
