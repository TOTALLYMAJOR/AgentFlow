# ADR-0002: Enforce an installation-wide worker budget

Status: Accepted
Date: 2026-07-26

## Context

Repository-scoped active builds allow independent repositories to run at the
same time. Without a second-level resource invariant, each build could dispatch
its full repository worker limit and oversubscribe the local machine.

Repository worker limits express how much parallelism a build can use. They do
not express how many coding workers the AgentFlow installation can support
across all builds.

## Decision

AgentFlow enforces `AGENTFLOW_MAX_CONCURRENT_WORKERS` as an installation-wide
worker budget. The default is four and the supported range is one through
sixty-four.

The coordinator counts persisted busy workers and in-flight dispatch
reservations before every scheduling decision. Each scheduler cycle may reserve
one additional worker for its build. Dispatch turns rotate across running build
identifiers so one repository cannot continuously consume newly available
capacity.

When a task operation releases capacity, AgentFlow requests scheduler ticks for
all running builds. Repository-level worker limits continue to apply inside the
installation-wide budget.

Health output exposes configured, busy, and available worker counts. Scheduler
cycle events record the resource snapshot that governed each decision.

## Consequences

- Concurrent repositories cannot exceed the configured local worker budget.
- Dispatch is deterministic and rotates across running repositories.
- A build may use less than its repository worker limit while other builds are
  active.
- CPU, memory, GPU, remote-machine, and provider-specific resource dimensions
  remain follow-up extensions of this budget model.
- Changing the budget for a user service requires reinstalling or regenerating
  its environment configuration and restarting the service.

## Validation

- Pure allocation tests prove capacity accounting and round-robin turns.
- Scheduler tests prove a zero-capacity cycle dispatches no tasks.
- API health tests prove capacity is visible.
- Multi-repository runtime tests must prove the configured budget is never
  exceeded during live worker execution.
