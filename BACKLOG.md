# Multi-repository orchestration closeout

## Backlog Coverage

This packet closes the gap between independent concurrent repository builds and a governed multi-repository initiative. Evidence: `README.md`, ADR-0013, planning/build routes, repository-scoped build persistence, global scheduling, artifact validation, recovery, integration, and managed-worktree code and tests.

Completion means one immutable initiative can bind exact per-repository plans and commits, enforce cross-repository dependencies and artifacts, coordinate failure/recovery, expose one honest program status, and retire only branches proven safe to delete. Remote publication, provider deployment, and automatic rollback of external systems remain explicit exclusions. Whether remote branches should be deleted is an unresolved human policy choice; the default remains local-only cleanup with durable receipts.

## MRI-001 - Define immutable initiative contracts and persistence

```yaml
epic_id: MRI-CONTROL
epic_title: Multi-repository initiative authority
epic_outcome: One immutable reviewed record governs every repository build in an initiative.
estimate_hours: 6
depends_on: []
owns:
  - apps/server/src/domain/multi-repo.ts
  - apps/server/src/db/initiative-repository.ts
  - apps/server/src/db/migrations.ts
  - apps/server/src/db/types.ts
  - apps/server/src/db/repositories.ts
  - apps/server/test/initiative-repository.test.ts
validate:
  - npm test -- --run apps/server/test/initiative-repository.test.ts
  - npm run typecheck
produces:
  - name: initiative-contract
    type: typescript-contract
    version: 1.0.0
    path: apps/server/src/domain/multi-repo.ts
```

Add initiative, repository-plan membership, exact plan/backlog/base-commit digests, cross-repository dependencies, lifecycle states, approvals, and append-only events. Reject duplicate repositories, mutable membership after approval, and cycles.

### Acceptance Criteria

- Persistence round-trips an initiative with two or more repository plans and exact source digests.
- Invalid membership and dependency cycles fail without partial writes.
- Approved initiative membership and digests are immutable.

## MRI-002 - Validate cross-repository dependencies and artifact handoffs

```yaml
epic_id: MRI-CONTROL
epic_title: Multi-repository initiative authority
epic_outcome: One immutable reviewed record governs every repository build in an initiative.
estimate_hours: 6
depends_on:
  - MRI-001
owns:
  - apps/server/src/multi-repo/validation.ts
  - apps/server/test/multi-repo-validation.test.ts
validate:
  - npm test -- --run apps/server/test/multi-repo-validation.test.ts
  - npm run typecheck
consumes:
  - task: MRI-001
    artifact: initiative-contract
    version: 1.0.0
produces:
  - name: initiative-validator
    type: validation-service
    version: 1.0.0
    path: apps/server/src/multi-repo/validation.ts
```

Resolve cross-repository task dependencies and versioned artifacts against immutable member plans. Detect missing producers, version mismatches, cross-repository cycles, and ambiguous producers before any build starts.

### Acceptance Criteria

- Valid provider-consumer chains across repositories produce deterministic execution waves.
- Missing, mismatched, ambiguous, and cyclic handoffs return actionable errors.
- Repository-local dependencies retain their existing behavior.

## MRI-003 - Add reviewed initiative planning and approval APIs

```yaml
epic_id: MRI-CONTROL
epic_title: Multi-repository initiative authority
epic_outcome: One immutable reviewed record governs every repository build in an initiative.
estimate_hours: 6
depends_on:
  - MRI-002
owns:
  - apps/server/src/http/routes/initiatives.ts
  - apps/server/src/http/app.ts
  - apps/server/test/initiative-api.test.ts
validate:
  - npm test -- --run apps/server/test/initiative-api.test.ts
  - npm run typecheck
consumes:
  - task: MRI-002
    artifact: initiative-validator
    version: 1.0.0
```

Provide create, inspect, validate, approve, start, pause, cancel, and replan endpoints. Starting must require an approved immutable digest and clean exact repository commits.

### Acceptance Criteria

- No repository build starts before initiative approval.
- Commit or plan drift invalidates approval and explains recovery.
- API responses distinguish proposed, approved, running, blocked, partial, failed, and completed states.

## MRI-004 - Coordinate repository builds and shared resource locks

```yaml
epic_id: MRI-RUNTIME
epic_title: Coordinated multi-repository execution
epic_outcome: Repository builds advance in dependency order without starving unrelated work or racing shared resources.
estimate_hours: 8
depends_on:
  - MRI-003
owns:
  - apps/server/src/multi-repo/coordinator.ts
  - apps/server/src/multi-repo/resources.ts
  - apps/server/test/multi-repo-coordinator.test.ts
validate:
  - npm test -- --run apps/server/test/multi-repo-coordinator.test.ts
  - npm run typecheck
produces:
  - name: initiative-runtime
    type: orchestration-service
    version: 1.0.0
    path: apps/server/src/multi-repo/coordinator.ts
```

Start eligible repository builds by cross-repository wave, propagate blockers, retain fair global worker allocation, and serialize declared shared environments, schemas, provider accounts, or release lanes.

### Acceptance Criteria

- A downstream repository cannot start before required upstream evidence is integrated.
- Independent repositories continue without starvation.
- Shared-resource conflicts serialize deterministically and appear as visible blocked reasons.

## MRI-005 - Implement partial-failure recovery and governed replanning

```yaml
epic_id: MRI-RUNTIME
epic_title: Coordinated multi-repository execution
epic_outcome: Repository builds advance in dependency order without starving unrelated work or racing shared resources.
estimate_hours: 6
depends_on:
  - MRI-004
owns:
  - apps/server/src/multi-repo/recovery.ts
  - apps/server/test/multi-repo-recovery.test.ts
validate:
  - npm test -- --run apps/server/test/multi-repo-recovery.test.ts
  - npm run typecheck
consumes:
  - task: MRI-004
    artifact: initiative-runtime
    version: 1.0.0
```

Recover after process restart, distinguish retryable repository failure from initiative failure, invalidate downstream evidence after upstream change, and require a new reviewed digest for replanning.

### Acceptance Criteria

- Restart reconstructs initiative status without duplicate build starts.
- Partial success remains visible and recoverable.
- Replanning never mutates the previously approved initiative snapshot.

## MRI-006 - Complete safe terminal branch retirement with receipts

```yaml
epic_id: MRI-GIT
epic_title: Terminal Git lifecycle
epic_outcome: Managed worktrees and branches are retired safely without destroying recoverable or unpublished work.
estimate_hours: 5
depends_on:
  - MRI-005
owns:
  - apps/server/src/git/worktree-manager.ts
  - apps/server/src/git/types.ts
  - apps/server/src/git/index.ts
  - apps/server/src/cli.ts
  - apps/server/test/git-runtime.test.ts
  - apps/server/test/branch-retirement.test.ts
validate:
  - npm test -- --run apps/server/test/git-runtime.test.ts apps/server/test/branch-retirement.test.ts
  - npm run typecheck
```

Build on the local merged-branch retirement slice by adding terminal-state policy, retention windows, durable cleanup receipts, idempotency, and an explicit separately approved remote-deletion policy.

### Acceptance Criteria

- Active, dirty, unmerged, unpublished, failed, and interrupted branches are preserved with reasons.
- Eligible local task and integration branches are deleted idempotently after their worktrees are removed.
- Every removal or preservation decision has a durable receipt; remote deletion is disabled by default.

## MRI-007 - Present one initiative workspace with honest proof boundaries

```yaml
epic_id: MRI-UX
epic_title: Multi-repository supervision
epic_outcome: A consumer can understand and safely control the whole initiative without terminal-only knowledge.
estimate_hours: 7
depends_on:
  - MRI-004
  - MRI-005
owns:
  - apps/web/src/screens/InitiativeScreen.tsx
  - apps/web/src/components/InitiativeGraph.tsx
  - apps/web/src/api/multi-repo-types.ts
  - apps/web/test/InitiativeScreen.test.tsx
validate:
  - npm test -- --run apps/web/test/InitiativeScreen.test.tsx
  - npm run typecheck
consumes:
  - task: MRI-004
    artifact: initiative-runtime
    version: 1.0.0
```

Show repository waves, cross-repository handoffs, shared locks, approvals, partial failures, release readiness, retained branches, cleanup eligibility, and the next recovery action.

### Acceptance Criteria

- The interface never equates integrated, published, deployed, or externally operational states.
- Every blocked or partial state names its cause and recovery action.
- Desktop and mobile flows remain keyboard accessible without horizontal overflow.

## MRI-008 - Prove the complete multi-repository lifecycle

```yaml
epic_id: MRI-PROOF
epic_title: Multi-repository acceptance evidence
epic_outcome: The shipped control plane proves successful and adverse multi-repository journeys end to end.
estimate_hours: 8
depends_on:
  - MRI-006
  - MRI-007
owns:
  - tests/multi-repo.acceptance.test.ts
  - tests/fixtures/multi-repo/
validate:
  - npm run test:integration
  - npm run build
```

Exercise at least three fixture repositories through success, cross-repository artifact mismatch, shared-resource contention, worker starvation pressure, restart, partial failure, replan, cancellation, dirty cleanup refusal, merged-branch retirement, and retained-unmerged recovery.

### Acceptance Criteria

- The full success journey completes from approved initiative through cleanup receipts.
- Every adverse scenario fails closed without source loss or false completion.
- Evidence identifies local integration separately from publication and deployment.
