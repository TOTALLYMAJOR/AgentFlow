# Harness Profile enforcement and governed return-loop backlog

## Backlog Coverage

This is the only AgentFlow execution backlog for the initiative. MRI-001 through MRI-008 are completed baseline capabilities and are not executable prerequisites to rerun. The unfinished Proofloom / AgentFlow / Traffic Control work is sequenced first; Harness Profile enforcement cannot start until the real local return loop passes.

AgentFlow retains sole authority over immutable plans, task state, dependency DAGs, worktrees, scheduling, concurrency, retries, backoff, cancellation, remote jobs, leases, idempotency, validation, changed-path ownership, commits, integration, recovery, durable execution records, and multi-repository coordination. Proofloom supplies approved semantic requirements; it does not dispatch work or mutate AgentFlow state. Traffic Control observations and Governor decisions are projections into existing AgentFlow records and coordinator transitions, not a second control plane.

The MVP is trusted-repository-only. Repository validation commands continue to execute as the current Linux user and are not an arbitrary-code sandbox. Profiles that require unavailable filesystem, network, environment, secret, provider, or isolation controls must be denied before dispatch. Untrusted repository execution remains prohibited until HP-005 is complete and its enforcement is independently accepted.

External Proofloom and Traffic Control prerequisites retain their source IDs and digests, but enter AgentFlow only through governed-task-handoff v2 and existing initiative/artifact gates. They are not copied into a parallel backlog.

## AFI-001 - Admit governed-task-handoff v2 and preserve receipt integrity

Classification: **MVP**

```yaml
epic_id: AFI-PREREQUISITE
epic_title: Proofloom and Traffic Control return-loop prerequisites
epic_outcome: AgentFlow admits only an exact approved v2 authority snapshot and emits integrity-bound native execution evidence.
estimate_hours: 8
depends_on: []
owns:
  - apps/server/src/integration/design-intelligence.ts
  - apps/server/src/http/routes/design-intelligence.ts
  - apps/server/src/http/routes/plans.ts
  - apps/server/src/domain/types.ts
  - apps/server/test/design-intelligence-integration.test.ts
  - apps/server/test/planning.test.ts
validate:
  - npm test -- --run apps/server/test/design-intelligence-integration.test.ts apps/server/test/planning.test.ts
  - npm run typecheck
produces:
  - name: governed-handoff-v2-binding
    type: agentflow-admission-contract
    version: 2.0.0
    path: apps/server/src/integration/design-intelligence.ts
  - name: agentflow-receipt-integrity-contract
    type: agentflow-receipt-contract
    version: 2.0.0
    path: apps/server/src/http/routes/design-intelligence.ts
```

Extend the existing additive importer and immutable-plan binding for `governed-task-handoff@2.0.0`. Preserve the exact repository/authority snapshot, canonical digest, source task IDs, dependency DAG, ownership, acceptance criteria, validations, and produces/consumes semantics. Keep v1 behavior available only where explicitly supported outside v2 execution; never downgrade a v2 request.

### Acceptance Criteria

- Admission independently verifies approval authority, repository identity, exact commit and clean state, complete authority-source hashes, governance currency, canonical payload digest, and base ancestry before plan creation.
- The immutable plan stores the exact v2 handoff digest and authority snapshot; later source, task, dependency, ownership, acceptance, validation, or artifact drift invalidates execution.
- The governed build receipt is derived from native AgentFlow task, validation, changed-path, commit, integration, approval, event, and artifact records rather than a worker claim or HandoffManifest alone.

### Refusal and negative tests

- Reject unsupported schema versions, v1-as-v2 fallback, missing fields, non-canonical payloads, stale or dirty bases, source/authority drift, forged or unverified approval references, task substitution, and digest mismatch.
- Reject receipts with omitted changed files, missing required validations, substituted task IDs, altered commits, or tampered evidence references.

### Proof boundary

Passing proves local AgentFlow v2 admission, immutable binding, and receipt construction only. It does not prove Traffic Control parity, runtime dispatch, deployment, provider behavior, production readiness, human acceptance, or outcomes.

## AFI-002 - Project native Traffic Control observations and Governor interventions

Classification: **MVP**

```yaml
epic_id: AFI-PREREQUISITE
epic_title: Proofloom and Traffic Control return-loop prerequisites
epic_outcome: AgentFlow admits only an exact approved v2 authority snapshot and emits integrity-bound native execution evidence.
estimate_hours: 8
depends_on:
  - AFI-001
owns:
  - apps/server/src/integration/traffic-control.ts
  - apps/server/src/http/routes/traffic-control.ts
  - apps/server/src/http/app.ts
  - apps/server/src/orchestration/coordinator.ts
  - apps/server/src/orchestration/state-machines.ts
  - apps/server/src/db/governor-repository.ts
  - apps/server/src/db/migrations.ts
  - apps/server/src/db/types.ts
  - apps/server/src/db/repositories.ts
  - apps/server/test/traffic-control-integration.test.ts
validate:
  - npm test -- --run apps/server/test/traffic-control-integration.test.ts apps/server/test/orchestration.test.ts
  - npm run typecheck
consumes:
  - task: AFI-001
    artifact: governed-handoff-v2-binding
    version: 2.0.0
produces:
  - name: native-governor-record
    type: traffic-control-observation-decision-contract
    version: 1.0.0
    path: apps/server/src/integration/traffic-control.ts
```

Implement TCP-002 observations as immutable projections from existing AgentFlow plans, tasks, attempts, validations, events, artifacts, leases, retries, and integration records. Implement TCP-003 decisions and bounded interventions only through existing coordinator transitions. Persist decision provenance and explicit intervention acknowledgement; replay must be idempotent and mutation-free. Reconsideration and replanning remain proposals requiring normal AgentFlow authority.

### Acceptance Criteria

- Every observation names its native source record, build/task attribution, cross-plane correlation ID, source revision, and evidence digest without synthesizing missing data.
- Every allowed intervention maps to an existing guarded coordinator transition and records actor/authority provenance, requested action, decision, acknowledgement, resulting state, and immutable timestamps.
- Feature-disabled operation leaves native scheduling unchanged, and replay never repeats an acknowledged mutation.

### Refusal and negative tests

- Reject observations missing task attribution, source evidence, correlation identity, or approval provenance.
- Reject stale, duplicate-conflicting, out-of-order, unsupported, unacknowledged, or state-invalid interventions; reject direct status writes and retry/replan bypasses.

### Proof boundary

Passing proves local projections and acknowledged use of existing AgentFlow transitions. It does not make Traffic Control authoritative, prove remote transport, or authorize production intervention.

## AFI-003 - Prove the Proofloom to AgentFlow to Traffic Control return loop

Classification: **MVP**

```yaml
epic_id: AFI-PREREQUISITE
epic_title: Proofloom and Traffic Control return-loop prerequisites
epic_outcome: AgentFlow admits only an exact approved v2 authority snapshot and emits integrity-bound native execution evidence.
estimate_hours: 6
depends_on:
  - AFI-001
  - AFI-002
owns:
  - tests/proofloom-agentflow-traffic-control.acceptance.integration.test.ts
  - tests/fixtures/proofloom-agentflow-traffic-control/
validate:
  - npm run test:integration -- tests/proofloom-agentflow-traffic-control.acceptance.integration.test.ts
  - npm run typecheck
consumes:
  - task: AFI-001
    artifact: agentflow-receipt-integrity-contract
    version: 2.0.0
  - task: AFI-002
    artifact: native-governor-record
    version: 1.0.0
produces:
  - name: governed-return-loop-evidence
    type: local-acceptance-evidence
    version: 1.0.0
    path: tests/proofloom-agentflow-traffic-control.acceptance.integration.test.ts
```

Exercise the real local service path with bounded temporary repositories: approved Proofloom handoff, AgentFlow admission and immutable plan, native dispatch/integration, Traffic Control observation, acknowledged Governor decision, AgentFlow build receipt, and Proofloom receipt audit. Use shared canonical fixtures to prove protocol parity across the boundary.

### Acceptance Criteria

- The exact v2 snapshot and digest survive every plane unchanged, and the audited return receipt binds task set, commits, actual changes, validations, Governor records, and correlation IDs.
- The integrated combined tree passes the declared acceptance path; worker completion alone cannot release dependents or satisfy the return loop.
- Success and refusal evidence is durable and reproducible from native records.

### Refusal and negative tests

- Cover canonicalization disagreement, stale approval, digest drift, task/dependency substitution, missing validation, omitted changed files, tampered Governor acknowledgement, interrupted execution, and replay.

### Proof boundary

Passing proves one bounded local return loop. It does not prove deployment, remote/provider operation, a consuming-repository pilot, production use, or human outcome acceptance.

## HP-001 - Admit and immutably bind the Harness Profile

Classification: **MVP**

```yaml
epic_id: HARNESS-PROFILE
epic_title: Digest-bound Harness Profile enforcement
epic_outcome: AgentFlow dispatches only work whose approved semantic execution requirements are enforceable and evidenced by native controls.
estimate_hours: 7
depends_on:
  - AFI-003
owns:
  - apps/server/src/harness/profile.ts
  - apps/server/src/harness/index.ts
  - apps/server/src/http/routes/plans.ts
  - apps/server/src/domain/types.ts
  - apps/server/src/db/plan-repository.ts
  - apps/server/test/harness-profile.test.ts
  - apps/server/test/planning.test.ts
validate:
  - npm test -- --run apps/server/test/harness-profile.test.ts apps/server/test/planning.test.ts
  - npm run typecheck
consumes:
  - task: AFI-003
    artifact: governed-return-loop-evidence
    version: 1.0.0
produces:
  - name: immutable-harness-profile-binding
    type: agentflow-plan-binding
    version: 1.0.0
    path: apps/server/src/harness/profile.ts
```

Add a strict, versioned Harness Profile contract carried by the approved v2 handoff. Canonicalize once, verify the supplied digest, and bind the exact profile bytes/digest, source identity, approval reference, repository snapshot, plan digest, build ID, and cross-plane correlation IDs into immutable plan/build state.

### Acceptance Criteria

- Supported profile versions validate all required filesystem, network, environment/secret, side-effect, provider/runtime, validation-isolation, checkpoint/recovery, evidence, and budget declarations without inventing defaults that weaken policy.
- Plan/build creation persists an immutable binding to the exact approved profile and rejects any later mutation or substitution.
- Correlation IDs are stable, collision-checked, and distinct from authority or approval.

### Refusal and negative tests

- Reject absent profiles where required, unsupported versions, unknown policy values, duplicate/colliding IDs, non-canonical digests, mismatched source snapshots, unapproved profiles, and profile/plan/build drift.

### Proof boundary

Passing proves schema admission and immutable binding only. It does not prove that a declared capability exists or that runtime enforcement occurred.

## HP-002 - Decide runtime compatibility and trusted-repository policy before dispatch

Classification: **MVP**

```yaml
epic_id: HARNESS-PROFILE
epic_title: Digest-bound Harness Profile enforcement
epic_outcome: AgentFlow dispatches only work whose approved semantic execution requirements are enforceable and evidenced by native controls.
estimate_hours: 8
depends_on:
  - HP-001
owns:
  - apps/server/src/harness/capabilities.ts
  - apps/server/src/harness/policy.ts
  - apps/server/src/governance/organization-policy.ts
  - apps/server/src/repositories/config.ts
  - apps/server/src/orchestration/scheduler.ts
  - apps/server/src/validation/types.ts
  - apps/server/src/validation/task-validator.ts
  - apps/server/test/harness-policy.test.ts
  - apps/server/test/governance.test.ts
  - apps/server/test/validation-runtime.test.ts
validate:
  - npm test -- --run apps/server/test/harness-policy.test.ts apps/server/test/governance.test.ts apps/server/test/validation-runtime.test.ts
  - npm run typecheck
consumes:
  - task: HP-001
    artifact: immutable-harness-profile-binding
    version: 1.0.0
produces:
  - name: harness-dispatch-decision
    type: capability-policy-decision
    version: 1.0.0
    path: apps/server/src/harness/policy.ts
```

Build the pre-dispatch decision from independently detected provider/runtime capabilities plus repository and organization policy. Classify filesystem reads/writes, network egress, environment and secret exposure, command/process execution, external mutations, durable writes, and irreversible effects. Return `allow`, `deny`, or `approval_required` with stable reason codes. For MVP validation, require an explicitly trusted reviewed repository snapshot; do not describe current-user command execution as sandboxed.

### Acceptance Criteria

- Dispatch cannot occur until every required capability has a compatible enforced runtime and every side effect has a deterministic decision.
- Secret/environment exposure is deny-by-default and allowlisted by identifier, never by secret value; decision records are redacted and digest-bound.
- Profiles requiring unavailable filesystem read isolation, network restriction, provider behavior, secret controls, or sandboxing are denied rather than approximated.
- Approval-required decisions bind the exact profile, plan, build, repository snapshot, capability set, actor authority, and expiration.

### Refusal and negative tests

- Reject unknown capabilities, unsupported providers, capability drift, overbroad path/network/secret requests, forged/expired approvals, policy conflicts, unclassified side effects, and untrusted validation mode.

### Proof boundary

Passing proves deterministic admission decisions and trusted-repository-only validation policy. It does not isolate arbitrary repository commands or make post-execution detection equivalent to preventive containment.

## HP-003 - Enforce the Harness Profile through native lifecycle transitions

Classification: **MVP**

```yaml
epic_id: HARNESS-PROFILE
epic_title: Digest-bound Harness Profile enforcement
epic_outcome: AgentFlow dispatches only work whose approved semantic execution requirements are enforceable and evidenced by native controls.
estimate_hours: 10
depends_on:
  - HP-002
owns:
  - apps/server/src/orchestration/coordinator.ts
  - apps/server/src/orchestration/state-machines.ts
  - apps/server/src/orchestration/retry-policy.ts
  - apps/server/src/recovery/service.ts
  - apps/server/src/workers/types.ts
  - apps/server/src/workers/providers.ts
  - apps/server/src/validation/environment.ts
  - apps/server/src/db/migrations.ts
  - apps/server/src/db/types.ts
  - apps/server/src/db/repositories.ts
  - apps/server/test/harness-lifecycle.test.ts
  - apps/server/test/orchestration.test.ts
  - apps/server/test/recovery.test.ts
  - apps/server/test/retry-policy.test.ts
validate:
  - npm test -- --run apps/server/test/harness-lifecycle.test.ts apps/server/test/orchestration.test.ts apps/server/test/recovery.test.ts apps/server/test/retry-policy.test.ts
  - npm run typecheck
consumes:
  - task: HP-002
    artifact: harness-dispatch-decision
    version: 1.0.0
produces:
  - name: harness-lifecycle-evidence
    type: native-lifecycle-enforcement-record
    version: 1.0.0
    path: apps/server/src/orchestration/coordinator.ts
```

Gate existing plan start, task dispatch, retry, resume, validation, integration, cancellation, and recovery transitions with the immutable profile binding and current capability decision. Reuse native state machines, leases, idempotency, retry/backoff, cancellation, worktrees, ownership checks, and recovery. Persist checkpoints through existing durable records. Enforce only justified profile budgets: elapsed time, attempts, output bytes, worker concurrency, validation limits, and declared resource limits that the selected runtime can measure and stop.

### Acceptance Criteria

- Every transition revalidates the immutable binding and relevant capability decision; retries and recovery cannot shed profile restrictions or approvals.
- Filesystem write limits route through worktree/ownership enforcement, environment/secrets through explicit allowlists, network through provider/runtime capability, and side effects through the prior allow/deny/approval decision.
- Checkpoint requirements, budget consumption, correlation IDs, cancellation, retry/backoff, leases, and recovery results are durable and idempotent.
- Unsupported or unmeasurable budgets fail closed; no generic hook runtime or parallel lifecycle is introduced.

### Refusal and negative tests

- Reject dispatch after profile/capability/approval drift, retry with expanded access, recovery without required checkpoint, exhausted budgets, correlation mismatch, missing acknowledgement, lease loss, or state-invalid transition.
- Prove cancellation and failure preserve evidence without committing or integrating unauthorized changes.

### Proof boundary

Passing proves enforcement through AgentFlow's existing lifecycle for capabilities the runtime actually supplies. It does not prove unavailable isolation, remote-runner parity, deployment, or successful external side effects.

## HP-004 - Emit profile-required evidence and prove trusted-repository execution

Classification: **MVP**

```yaml
epic_id: HARNESS-PROFILE
epic_title: Digest-bound Harness Profile enforcement
epic_outcome: AgentFlow dispatches only work whose approved semantic execution requirements are enforceable and evidenced by native controls.
estimate_hours: 8
depends_on:
  - HP-003
owns:
  - apps/server/src/artifacts/contracts.ts
  - apps/server/src/artifacts/types.ts
  - apps/server/src/artifacts/manifest-service.ts
  - apps/server/src/http/routes/harness.ts
  - apps/server/src/http/app.ts
  - apps/server/test/harness-evidence.test.ts
  - tests/harness-profile.acceptance.integration.test.ts
  - tests/fixtures/harness-profile/
validate:
  - npm test -- --run apps/server/test/harness-evidence.test.ts
  - npm run test:integration -- tests/harness-profile.acceptance.integration.test.ts
  - npm run typecheck
consumes:
  - task: HP-003
    artifact: harness-lifecycle-evidence
    version: 1.0.0
produces:
  - name: harness-profile-execution-receipt
    type: agentflow-evidence-envelope
    version: 1.0.0
    path: apps/server/src/artifacts/contracts.ts
```

Emit the evidence explicitly required by the profile from native immutable plan/build/task, changed-path, validation, commit, integration, approval, capability-decision, budget, checkpoint, recovery, Traffic Control, and Governor records. Prove success and refusals through the real local API/coordinator path using a reviewed trusted fixture repository.

### Acceptance Criteria

- The receipt binds profile/handoff/plan/build digests, repository snapshot, task set, correlation IDs, capability decisions, approvals, side-effect classifications, budget/checkpoint results, actual changes, validations, commits, Governor acknowledgements, and terminal state.
- Missing required evidence makes the receipt incomplete and prevents a compliant-success claim.
- The trusted-repository fixture completes through native dispatch and integration; all declared refusal cases fail before unauthorized execution or integration.

### Refusal and negative tests

- Cover missing/tampered evidence, correlation mismatch, forged approval, capability drift, undeclared side effect, budget overrun, checkpoint loss, omitted changed files, failed validation, receipt replay, and interrupted recovery.

### Proof boundary

Passing proves local trusted-repository enforcement and receipt integrity. Validation commands still run as the current Linux user; this is not proof of arbitrary-code sandboxing, untrusted repository safety, remote/provider parity, deployment, or human acceptance.

## HP-005 - Add enforceable isolated execution and validation profiles

Classification: **required before untrusted repository execution**

```yaml
epic_id: HARNESS-ISOLATION
epic_title: Optional isolation for untrusted repository execution
epic_outcome: AgentFlow can enforce an approved isolation profile before any untrusted repository code or validation command runs.
estimate_hours: 12
depends_on:
  - HP-004
owns:
  - apps/server/src/harness/isolation.ts
  - apps/server/src/workers/runtime.ts
  - apps/server/src/validation/process-runner.ts
  - apps/server/src/validation/command.ts
  - apps/server/src/config/environment.ts
  - apps/server/test/harness-isolation.test.ts
  - apps/server/test/worker-runtime.test.ts
  - apps/server/test/validation-runtime.test.ts
  - tests/harness-isolation.acceptance.integration.test.ts
  - tests/fixtures/harness-isolation/
validate:
  - npm test -- --run apps/server/test/harness-isolation.test.ts apps/server/test/worker-runtime.test.ts apps/server/test/validation-runtime.test.ts
  - npm run test:integration -- tests/harness-isolation.acceptance.integration.test.ts
  - npm run typecheck
consumes:
  - task: HP-004
    artifact: harness-profile-execution-receipt
    version: 1.0.0
produces:
  - name: isolated-harness-runtime
    type: enforced-execution-capability
    version: 1.0.0
    path: apps/server/src/harness/isolation.ts
```

Add an optional, explicit isolation profile for both worker execution and repository validation. Use a pinned runtime/image and enforce mount scope, read-only inputs, writable worktree/output paths, network mode/egress policy, environment and secret allowlists, process/resource limits, timeouts, cancellation, and artifact extraction. Do not expose the host Docker socket or inherit undeclared host credentials. Keep trusted-current-user mode separate and honestly labeled.

### Acceptance Criteria

- Untrusted mode cannot start unless the selected runtime can enforce every required filesystem, network, environment/secret, process, and resource control and can report its exact capability/version digest.
- Worker and validation processes run inside the same approved isolation boundary or separately declared compatible boundaries; outputs return through existing ownership, validation, commit, and integration gates.
- Escape, path traversal, undeclared mount/write, network egress, secret access, resource exhaustion, cancellation, and restart cases are independently tested with bounded fixtures.
- Failure to initialize or attest isolation denies execution; there is no fallback to current-user host commands.

### Refusal and negative tests

- Reject missing runtime/image digest, mutable image reference, unavailable network enforcement, path escape, host socket/device mount, inherited credential, secret leakage, incompatible provider, unsupported resource budget, tampered attestation, and fallback after isolation failure.

### Proof boundary

Passing proves only the tested isolation profile on the tested host/runtime version. It does not establish a general multi-tenant security boundary, protect against host/kernel compromise, prove remote-runner parity, or make all repositories safe.

## Rejected duplicate complexity

These are classifications, not executable tasks:

- **rejected duplicate complexity** - generic hook runtime beside the coordinator; native transitions already provide the enforcement points.
- **rejected duplicate complexity** - second scheduler, retry/backoff engine, execution database, lease service, recovery service, coordinator, or backlog.
- **rejected duplicate complexity** - model-prompt compliance as a security boundary; prompts remain advisory and independently checked.
- **rejected duplicate complexity** - automatic v1 fallback, invented approval defaults, synthesized evidence, or self-attestation by the candidate verifier.

No separate **later** task is admitted now. Remote-runner Harness Profile execution remains denied unless a future measured need justifies a digest-bound runner capability/attestation task; local MVP work must not speculate that layer into existence.

## Completion Evidence

| Task | Completion evidence required |
| --- | --- |
| AFI-001 | Focused v2 admission/receipt tests and typecheck at the exact integrated revision |
| AFI-002 | Native observation/intervention tests, durable acknowledgement evidence, and typecheck |
| AFI-003 | Real bounded local Proofloom -> AgentFlow -> Traffic Control -> Proofloom acceptance and refusals |
| HP-001 | Profile schema/digest/immutable-binding tests and typecheck |
| HP-002 | Capability, policy, trusted-validation, approval, and refusal tests |
| HP-003 | Native lifecycle, retry, recovery, checkpoint, budget, and correlation tests |
| HP-004 | Evidence contract tests plus trusted-repository local integration acceptance |
| HP-005 | Isolated worker/validation unit and integration acceptance on a named runtime/version |

Backlog completion proves only the evidence named above. Publication, deployment, provider operation, production use, consuming-repository adoption, and human outcome acceptance require separate authority and evidence.
