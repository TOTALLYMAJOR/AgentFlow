# Implementation assumptions

These choices resolve protocol details not fully specified by the original MVP
contract. ADRs supersede an assumption when a later architectural decision is
more specific.

## Planning and scheduling

- Plans are immutable snapshots once persisted.
- Generated backlogs are review artifacts and must be committed before planning.
- Missing epic metadata is normalized into one compatibility epic.
- Epic metadata must be consistent and both task and epic graphs must be acyclic.
- Ready-queue age uses persisted scheduling cycles so ranking remains
  deterministic for identical state.
- Scheduler risk is normalized to the inclusive range 0 through 1.
- Each repository may have one recoverable active build; different repositories
  may run concurrently.
- Repository worker limits are per-build ceilings. The installation budget and
  organization policy may reduce effective concurrency.

## Execution and integration

- Task branches begin at the validated integration commit available at dispatch.
- Integration remains serialized inside each build.
- Local workers use the selected provider adapter; an eligible remote runner may
  take the task instead.
- A remote result is a bounded, digest-verified unified patch against the exact
  base commit. It receives no direct integration authority.
- Actual changed paths, not prompt claims, determine ownership compliance.
- Artifact versions are exact.
- Handoff manifests and browser evidence live in runtime evidence, not source
  branches.
- Proposed ADR drafts remain `Proposed` until a human publishes them.

## Recovery and durability

- SSE uses durable build-event sequence numbers and honors `Last-Event-ID`.
- Cancellation preserves source branches, worktrees, logs, attempts, and events.
- Automatic retry decisions and due times are durable across service restarts.
- Process reattachment cannot recover anonymous stdout pipes. Worker output is
  written durably while the process runs, and startup reconciles PID identity,
  attempts, result commits, logs, remote leases, and worktrees.
- Repository removal is metadata-only.
- Upgrade and uninstall preserve the runtime directory.

## Policy and evidence

- The organization policy is created once and loaded at startup; edits require a
  restart.
- Repository template application is explicit and replaces only
  `.agentflow.yaml`.
- The knowledge graph is evidence derived from tracked files and relative imports;
  it is not a language-server or compiler-complete graph.
- Screenshot comparison is deterministic evidence, not semantic UI approval.
- Optional push failures are publication failures, not validation failures.

## Trusted execution

Validation commands are trusted repository input. They run as the current user
with timeout, cancellation, output capture, redaction, and an isolated Compose
project name. AgentFlow does not claim to sandbox arbitrary repository commands.
