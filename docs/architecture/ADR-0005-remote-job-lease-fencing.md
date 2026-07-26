# ADR-0005: Remote job lease fencing

## Status

Accepted

## Context

Remote runners can disconnect, retry requests, or race for work. Runner bearer
identity alone cannot prove that a machine still owns a particular task, and a
late result must not overwrite a newer attempt.

## Decision

Remote jobs are durable and unique by task attempt. Claiming is an immediate
database transaction that verifies runner provider, online state, reported
capacity, and active leases before selecting the oldest compatible queued job.

Every claim receives a random short-lived lease token whose digest is stored.
Lease heartbeats and completion require both runner identity and the lease
token. Completion also requires an idempotency key and result digest. Exact
replays are accepted; conflicting replays, expired leases, and cancelled jobs
are rejected.

Build cancellation atomically makes queued and leased jobs non-completable.
Expired leases become explicit `expired` records rather than silently returning
to the queue; retry policy decides whether to create a new attempt.

## Consequences

- At most one current runner can submit a result for a task attempt.
- Runner capacity cannot be overbooked by repeated claims between heartbeats.
- Result transport is auditable and replay-safe.
- A completed transport result is not yet a validated task result. Patch
  ingestion, ownership checks, validation, and integration remain authoritative
  coordinator operations.
