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

## Wale bridge boundary

The opt-in loopback bridge authenticates in Fastify `onRequest`, before JSON parsing. Its digest-configured bearer token is compared in constant time; all bridge responses use `Cache-Control: no-store`. Errors expose stable public codes, not tokens, arbitrary payloads, or private filesystem paths. Public events project only fixed labels and timestamps.

Admission must independently recheck the native governed plan and current handoff. Identifiers never confer authority. The binding and build are persisted in one immediate transaction; conflicting identity refuses. Duplicate Start observes existing state; interrupted/paused work requires an explicit native resume decision. The bridge does not authorize retries, candidate application, runtime installation, or waived checks.

Receipt exports retain current native Governor provenance. Evidence is bounded to 256 files, 64 MiB each, 256 MiB total and an 8 MiB receipt; relative paths, regular files, symlinks, replacement and SHA-256 are checked. Missing or changed evidence refuses. Terminal evidence is created once and never silently overwritten. Trusted repository commands still execute as the operator; this bridge is not a sandbox.

## Native validation certificate authority

The opt-in `agentflow/native-task-validation-evidence@1.0.0` profile derives satisfaction only from current native records and verified bytes. Historical bare `evidence.recorded.satisfied` labels are ignored for this profile; required classes, Governor phase, decisions and native acknowledgement rules remain unchanged. Missing proof retains the original missing-evidence refusal. No certificate grants approval or makes stale authority current.

A native certificate binds exact handoff/build/native task/backlog task/attempt/base/result, current validated manifest ID and content hash, and every ordered declared validation ID/index/normalized argv/required/pass/exit-code/log-byte hash. Cleanup or optional-only passes cannot replace the full set. Pathless artifact registry rows prove declaration identity only: retry may reuse a row with older metadata, while proof must resolve the exact current-attempt manifest and logs.

Storage locators are derived from native IDs, never supplied by worker events. Managed directory containment, component symlink rejection, no-follow file opens, bounded reads, inode/device/size/time checks and actual SHA-256 protect current verification. Missing/tampered/replaced/cross-task/stale proof contributes no satisfaction; receipt export refuses unavailable current proof after validation. Native publication is idempotent for identical bytes and refuses same-identity conflicts. Only certificate bytes/provenance are exported, not raw private logs. Runtime activation, real providers and final acceptance remain separate authorities.

Governor provenance artifact exports preserve original native event payloads and global sequence gaps, including decision-hash to acknowledgement links. They are bounded immutable managed files with byte-tamper refusal, not new decisions or fabricated timeline stages. Bundle event watermarks still cover the latest native build event. Exporting them appends no native event, preventing watermark recursion.
