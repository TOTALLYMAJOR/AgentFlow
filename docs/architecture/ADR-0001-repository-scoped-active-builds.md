# ADR-0001: Scope active builds by repository

Status: Accepted
Date: 2026-07-26

## Context

AgentFlow's MVP enforced one active build across the entire installation. That
constraint simplified recovery and scheduling, but it also made unrelated
repositories block one another even though their Git worktrees, integration
branches, tasks, workers, artifacts, and coordinator operations are already
keyed by build and repository identifiers.

The post-MVP control plane needs to run independent repositories concurrently
without permitting two active builds to contend for the same repository.

## Decision

AgentFlow permits multiple active builds when each build belongs to a different
registered repository.

The database enforces one build in `planning`, `ready`, `running`, `paused`, or
`interrupted` state per repository. Build creation and failed-build retry apply
the same repository-scoped check before mutation.

Startup recovery enumerates every active build and resumes scheduler ticks for
each running build. The health response exposes all active build identifiers
while retaining the first `activeBuildId` field for compatibility.

The dashboard presents active builds as a repository build rail and keeps one
selected build in detailed supervision at a time.

## Consequences

- Unrelated repositories no longer block one another.
- A repository still has exactly one integration branch and serialized
  integration lane for its active build.
- Coordinator maps must remain keyed by build or task identifier.
- Installation-wide resource limits are not introduced by this decision;
  resource-aware concurrency is a separate follow-up.
- Remote workers and multiple coding-agent providers remain separate
  follow-up decisions.

## Validation

- Migration tests prove the partial unique index accepts active builds for
  different repositories and rejects a second active build for the same
  repository.
- API tests prove build creation follows the same invariant.
- Recovery tests must continue to prove build-keyed reconciliation.
- Dashboard type, build, and browser checks cover multiple-build selection.
