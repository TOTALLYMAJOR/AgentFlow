# ADR-0006: Durable automatic retry policy

## Status

Accepted

## Context

Local processes and remote providers can fail transiently, but retrying every
failure can repeat deterministic defects, consume provider quota, or hide a
real blocker. In-memory timers also disappear during service restart.

## Decision

AgentFlow retries only an explicit allowlist of transient failure codes.
Retry count is bounded by an installation policy and delay uses deterministic,
capped exponential backoff.

Every accepted retry is persisted with its failed attempt, next attempt,
failure code, and due time before a timer is armed. Startup re-arms durable
schedules. Manual retries supersede schedules. If scheduler deadlock paused a
build while waiting, an automatic retry resumes that build after the task is
made ready.

Deterministic failures are never automatically retried.

## Consequences

- Restart does not lose an accepted retry.
- Retry behavior is auditable and consistent across local and remote failures.
- Operators can distinguish retry waiting from terminal failure.
- Historical outcome calibration can later tune defaults without changing the
  underlying policy contract.
