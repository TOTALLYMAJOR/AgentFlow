# Harness Profile enforcement and governed return-loop backlog

## Backlog Coverage

This is the only AgentFlow execution backlog for the initiative. MRI-001 through MRI-008 are completed baseline capabilities and are not executable prerequisites to rerun. Wave 0 already exists on `codex/traffic-control-integration`; AFI-001 through AFI-003 converge and verify that implementation against current `main` rather than rebuilding it. Harness Profile enforcement cannot start until the converged real local return loop passes.

AgentFlow retains sole authority over immutable plans, task state, dependency DAGs, worktrees, scheduling, concurrency, retries, backoff, cancellation, remote jobs, leases, idempotency, validation, changed-path ownership, commits, integration, recovery, durable execution records, and multi-repository coordination. Proofloom supplies approved semantic requirements; it does not dispatch work or mutate AgentFlow state. Traffic Control observations and Governor decisions are projections into existing AgentFlow records and coordinator transitions, not a second control plane.

The MVP is trusted-repository-only. Repository validation commands continue to execute as the current Linux user and are not an arbitrary-code sandbox. Profiles that require unavailable filesystem, network, environment, secret, provider, or isolation controls must be denied before dispatch. Untrusted repository execution remains prohibited until HP-005 is complete and its enforcement is independently accepted.

External Proofloom and Traffic Control prerequisites retain their source IDs and digests, but enter AgentFlow only through governed-task-handoff v2 and existing initiative/artifact gates. They are not copied into a parallel backlog.

### Owner-directed full-portfolio branch closure slice

The original G2 path/hunk ceiling based on c5d25181a3e4f7665f38753cf374264bcc2cd69b is preserved as the completed, separately qualified candidate 17c5249c6880c4a59727b0336bf093f2206e5297. For this separate owner-directed branch-reconciliation slice only, the additional exact write authority is the ten-path ADOPTION-SCOPE.proposed.json packet under wale-branch-closure-20261029, bound to base 17c5249c6880c4a59727b0336bf093f2206e5297 and isolated branch codex/wale-branch-closure-20261029. This explicit bounded amendment governs those named hunks instead of treating the prior G2 ceiling as blanket permission. Preserve every original task identity, dependency, acceptance/refusal criterion and human/native execution/final-acceptance gate.

AFI-001 changes only .agentflow.yaml base_branch to bind native preparation to the isolated successor; existing worker, validation, provider and publication restrictions remain. AFI-002 adds only recovered-integration Governor gating, idempotent validated-state recovery and current-attempt failure attribution with their exact focused tests/ownership. Preserve full failure history and all G2 native source/event/certificate/receipt fences; protected Governor policy, control-service, runtime-adapter and governBuild body remain unchanged. AFI-003 requalifies the exact combined successor using existing strict 2.1/1.1 native and frozen-Orbit journeys; stronger multi-task/runtime/private-Task6/provider and production acceptance remain separately governed and unclaimed.

Manual local adoption is authorized by the owner's branch-reconciliation continuation, not a fabricated native execution approval. Adopt this ownership/branch declaration before source implementation. No actual candidate build/dispatch, real provider run, runtime activation, publication, cleanup or task closure is authorized by it. Existing traffic-control-integration.test.ts is not present in this selected tree; do not describe that named historical file as executed. The newly named actual files and full native verification provide the bounded local proof while original semantic criteria remain intact.

## AFI-001 - Converge Wave 0 handoff admission and receipt integrity

Classification: **MVP**

```yaml
epic_id: AFI-PREREQUISITE
epic_title: Proofloom and Traffic Control return-loop prerequisites
epic_outcome: AgentFlow admits only an exact approved v2 authority snapshot and emits integrity-bound native execution evidence.
estimate_hours: 8
depends_on: []
owns:
  - .agentflow.yaml
  - apps/server/src/integration/design-intelligence.ts
  - apps/server/src/http/routes/design-intelligence.ts
  - apps/server/src/http/routes/plans.ts
  - apps/server/src/domain/types.ts
  - apps/server/test/design-intelligence-integration.test.ts
  - apps/server/test/planning.test.ts
  - tests/fixtures/proofloom-agentflow-traffic-control/wale-run-lab-contract.json
  - apps/server/src/config/environment.ts
  - apps/server/src/db/event-repository.ts
  - apps/server/src/http/routes/builds.ts
  - apps/server/src/http/routes/wale-run-lab.ts
  - apps/server/src/integration/design-intelligence-receipt.ts
  - apps/server/src/integration/wale-run-lab.ts
  - apps/server/src/integration/wale-run-lab-receipt-bundle.ts
  - apps/server/test/wale-run-lab.test.ts
  - docs/INSTALLATION.md
  - docs/SECURITY.md
validate:
  - npm test -- --run apps/server/test/wale-run-lab.test.ts
  - npm test -- --run apps/server/test/design-intelligence-integration.test.ts apps/server/test/planning.test.ts
  - npm run typecheck
produces:
  - name: design-intelligence-governed-task-handoff
    type: design-intelligence/governed-task-handoff
    version: 2.1.0
    path: apps/server/src/integration/design-intelligence.ts
  - name: agentflow-build-receipt
    type: agentflow/build-receipt
    version: 1.1.0
    path: apps/server/src/http/routes/design-intelligence.ts
```

Converge the existing `codex/traffic-control-integration` implementation with current `main`, retaining the additive importer and immutable-plan binding for `design-intelligence/governed-task-handoff@2.1.0` and the emitted `agentflow/build-receipt@1.1.0`. Preserve the exact repository/authority snapshot, canonical digest, source task IDs, dependency DAG, ownership, acceptance criteria, validations, and produces/consumes semantics. Keep v1 behavior available only where explicitly supported outside v2 execution; never downgrade a v2 request. Resolve integration conflicts through current AgentFlow authorities rather than reimplementing the Wave 0 contracts.

### Acceptance Criteria

- Admission independently verifies approval authority, repository identity, exact commit and clean state, complete authority-source hashes, governance currency, canonical payload digest, and base ancestry before plan creation.
- The immutable plan stores the exact v2 handoff digest and authority snapshot; later source, task, dependency, ownership, acceptance, validation, or artifact drift invalidates execution.
- The governed build receipt is derived from native AgentFlow task, validation, changed-path, commit, integration, approval, event, and artifact records rather than a worker claim or HandoffManifest alone.
- The candidate retains strict handoff `2.1.0` and receipt `1.1.0` as a bounded amendment to the earlier 2.0.0/1.0.0 task declaration. Owner adoption binds G2 contract requirements and pinned source inputs; canonical JSON, digest rules, required fields, compatibility fixtures and refusal behavior must pass on the exact combined revision before qualification. No downgrade, receipt 2.0.0, private-probe or unrelated Harness Profile extension is authorized.

### Refusal and negative tests

- Reject unsupported schema versions, v1-as-v2 fallback, missing fields, non-canonical payloads, stale or dirty bases, source/authority drift, forged or unverified approval references, task substitution, and digest mismatch.
- Reject receipts with omitted changed files, missing required validations, substituted task IDs, altered commits, or tampered evidence references.

### Proof boundary

Passing proves local AgentFlow v2 admission, immutable binding, and receipt construction only. It does not prove Traffic Control parity, runtime dispatch, deployment, provider behavior, production readiness, human acceptance, or outcomes.

### G2 bounded adoption amendment

Preserve this task identity, dependencies and existing acceptance/refusal requirements. Implementation is limited to the exact path/hunk ceiling in the owner-approved G2 packet based on c5d25181a3e4f7665f38753cf374264bcc2cd69b. Scope declarations inherited from earlier work do not expand that ceiling. No task is completed by adoption.
Bind exact experiment/run/snapshot/task/criteria through immutable native plan/build records. Defer recovered runtime verifier and its integration entirely; no public handoff/plan runtime extension or runtime activation. This preserves the recovered historical evidence rather than adding disconnected runtime capability. Own the exact shared public fixture file here before dependent tasks; AFI-003 no longer owns its parent fixture directory. Tasks requiring an unsupported runtime binding must stop for a separate exact contract/owner amendment. Authentication precedes body parsing; duplicate/unknown Start never creates an automatic second dispatch. Keep historical observation separate from current admission. Recovered runtime source is not runtime activation approval.

### Owner-approved explicit native validation evidence amendment

Adopt only the owner-approved single-task native validation evidence profile described in the evidence contract amendment. Bind exact required-evidence name to declared native profile artifact and this task complete ordered validation set. Unknown/unbound/version/topology mismatches refuse; do not reinterpret the old paused handoff.
### Branch closure slice authority

For the separate owner-directed full-portfolio reconciliation slice, the exact ten-path ADOPTION-SCOPE.proposed.json at base 17c5249c6880c4a59727b0336bf093f2206e5297 extends the earlier c5d25181 G2 ceiling only for its named hunks in isolated codex/wale-branch-closure-20261029. This task permits only its already-owned .agentflow.yaml base_branch rebinding; it does not reopen admission/schema/profile/runtime design. All original task criteria, dependencies and approval/final-acceptance gates remain unchanged. No candidate dispatch, providers, runtime activation, publication or task closure.


## AFI-002 - Converge native observations and Governor interventions

Classification: **MVP**

```yaml
epic_id: AFI-PREREQUISITE
epic_title: Proofloom and Traffic Control return-loop prerequisites
epic_outcome: AgentFlow admits only an exact approved v2 authority snapshot and emits integrity-bound native execution evidence.
estimate_hours: 8
depends_on:
  - AFI-001
owns:
  - apps/server/src/http/routes/design-intelligence.ts
  - apps/server/test/design-intelligence-integration.test.ts
  - apps/server/test/helpers/governed-handoff.ts
  - apps/server/src/recovery/service.ts
  - apps/server/test/coordinator-governed-recovery.test.ts
  - apps/server/test/recovery.test.ts
  - apps/server/test/traffic-control-observation.test.ts
  - apps/server/test/governor-build-control.test.ts
  - apps/server/src/governor/build-control.ts
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
  - apps/server/src/workers/types.ts
  - apps/server/src/workers/prompt.ts
  - apps/server/src/integration/delivery-size.ts
  - apps/server/src/integration/manager.ts
  - apps/server/src/integration/types.ts
  - apps/server/test/database.test.ts
  - apps/server/test/delivery-size.test.ts
  - apps/server/test/integration-runtime.test.ts
  - apps/server/test/worker-runtime.test.ts
validate:
  - npm test -- apps/server/test/design-intelligence-integration.test.ts
  - npm test -- --run apps/server/test/coordinator-governed-recovery.test.ts apps/server/test/recovery.test.ts apps/server/test/traffic-control-observation.test.ts apps/server/test/governor-build-control.test.ts
  - npm test -- --run apps/server/test/database.test.ts apps/server/test/delivery-size.test.ts apps/server/test/integration-runtime.test.ts apps/server/test/worker-runtime.test.ts apps/server/test/governor-control-service.test.ts apps/server/test/traffic-control-observation.test.ts
  - npm test -- --run apps/server/test/traffic-control-integration.test.ts apps/server/test/orchestration.test.ts
  - npm run typecheck
consumes:
  - task: AFI-001
    artifact: design-intelligence-governed-task-handoff
    version: 2.1.0
produces:
  - name: traffic-control-execution-observation
    type: traffic-control/execution-observation
    version: 1.0.0
    path: apps/server/src/integration/traffic-control.ts
  - name: traffic-control-governor-decision-record
    type: traffic-control/governor-decision-record
    version: 1.0.0
    path: apps/server/src/db/governor-repository.ts
```

Converge the existing Wave 0 TCP-002 observations as immutable projections from AgentFlow plans, tasks, attempts, validations, events, artifacts, leases, retries, and integration records. Converge TCP-003 decisions and bounded interventions only through existing coordinator transitions. Preserve decision provenance and explicit intervention acknowledgement; replay must be idempotent and mutation-free. Reconsideration and replanning remain proposals requiring normal AgentFlow authority.


Local chronology qualification binds failure-relative evidence to actual supported native failed-state frames and event sequence. For the actual integration-failure producer, retained certificate, validated-manifest and validation-log bytes can establish narrowly bound pre-failure publication context for previousEvidence. Independent failure-time base/result/branch, own-attempt identity, hashes and event-prefix joins are required; missing or conflicting context refuses. Historical context never enters current items or satisfaction, and current verification remains unchanged. An asynchronous input fence includes native rows, per-attempt changed files and validation commands, plus the complete event prefix. Complete historical artifact state, unrecorded source revision, older/other producer context and canonical failure-history parity remain unqualified. Existing negative semantic/certification/repair/no-integration assertions remain intact. This is local engineering qualification, separate from native adoption or AFI-002/TCP-002 acceptance.

Local TCP-003 error-receipt qualification links the existing governor.evaluation_failed event to its exact decision hash and action. Handler acknowledgement availability is distinct from later readback or receipt-persistence failure; observed status is catch-time readback, not final-state or effect-causality proof. Existing native transition eligibility prevents an invalid fallback pause without adding state edges or retry authority. Error durability still requires the existing journal append to succeed. Actual route ownership is recorded as local source preparation; exact native path/hunk adoption and task acceptance remain separate.

### Acceptance Criteria

- Every observation names its native source record, build/task attribution, cross-plane correlation ID, source revision, and evidence digest without synthesizing missing data.
- Every allowed intervention maps to an existing guarded coordinator transition and records actor/authority provenance, requested action, decision, acknowledgement, resulting state, and immutable timestamps.
- Feature-disabled operation leaves native scheduling unchanged, and replay never repeats an acknowledged mutation.

### Refusal and negative tests

- Reject observations missing task attribution, source evidence, correlation identity, or approval provenance.
- Reject stale, duplicate-conflicting, out-of-order, unsupported, unacknowledged, or state-invalid interventions; reject direct status writes and retry/replan bypasses.

### Proof boundary

Passing proves local projections and acknowledged use of existing AgentFlow transitions. It does not make Traffic Control authoritative, prove remote transport, or authorize production intervention.

### G2 bounded adoption amendment

Preserve this task identity, dependencies and existing acceptance/refusal requirements. Implementation is limited to the exact path/hunk ceiling in the owner-approved G2 packet based on c5d25181a3e4f7665f38753cf374264bcc2cd69b. Scope declarations inherited from earlier work do not expand that ceiling. No task is completed by adoption.
Keep current-main Traffic Control evaluation, guarded intervention and durable acknowledgement. Enforce the conservative text-churn ceiling without claiming eligible source LOC. Never suppress approvals or validation to satisfy interruption/size parameters. Only append migrations.

### Owner-approved explicit native validation evidence amendment

Project only actual current-attempt native validation/result/validated-manifest/log provenance into evidence satisfaction for the supported profile. Preserve protected Governor decision rules and unknown/missing-evidence refusal. Never auto-satisfy free labels, union stale proof or alter phase/dependencies to unblock integration.
### Branch closure slice authority

For the separate owner-directed full-portfolio reconciliation slice, the exact ten-path ADOPTION-SCOPE.proposed.json at base 17c5249c6880c4a59727b0336bf093f2206e5297 extends the earlier c5d25181 G2 ceiling only for its named hunks in isolated codex/wale-branch-closure-20261029. This task owns the listed recovered-integration gate, validated-state replay guard and current-failure attribution changes and the five newly listed recovery/test paths. Do not replace protected Governor policy/control/runtime or discard existing G2 evidence/cursor fences. All original task criteria, dependencies and approval/final-acceptance gates remain unchanged. No candidate dispatch, providers, runtime activation, publication or task closure.


## AFI-003 - Re-prove the return loop on the converged branch

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
  - apps/server/test/wale-run-lab-bridge.test.ts
validate:
  - npm test -- --run apps/server/test/wale-run-lab-bridge.test.ts
  - npm run verify
  - npm run test:integration -- tests/proofloom-agentflow-traffic-control.acceptance.integration.test.ts
  - npm run typecheck
consumes:
  - task: AFI-001
    artifact: agentflow-build-receipt
    version: 1.1.0
  - task: AFI-002
    artifact: traffic-control-execution-observation
    version: 1.0.0
  - task: AFI-002
    artifact: traffic-control-governor-decision-record
    version: 1.0.0
produces:
  - name: governed-return-loop-evidence
    type: local-acceptance-evidence
    version: 1.0.0
    path: tests/proofloom-agentflow-traffic-control.acceptance.integration.test.ts
```

Re-run the real local service path from the converged AgentFlow branch with bounded temporary repositories: approved Proofloom handoff, AgentFlow admission and immutable plan, native dispatch/integration, Traffic Control observation, acknowledged Governor decision, AgentFlow build receipt, and Proofloom receipt audit. Use shared canonical fixtures to prove protocol parity across the boundary; prior branch-local evidence is input, not acceptance of the converged revision.

### Acceptance Criteria

- The exact v2 snapshot and digest survive every plane unchanged, and the audited return receipt binds task set, commits, actual changes, validations, Governor records, and correlation IDs.
- The integrated combined tree passes the declared acceptance path; worker completion alone cannot release dependents or satisfy the return loop.
- Success and refusal evidence is durable and reproducible from native records.

### Refusal and negative tests

- Cover canonicalization disagreement, stale approval, digest drift, task/dependency substitution, missing validation, omitted changed files, tampered Governor acknowledgement, interrupted execution, and replay.

### Proof boundary

Passing proves one bounded local return loop. It does not prove deployment, remote/provider operation, a consuming-repository pilot, production use, or human outcome acceptance.

### G2 bounded adoption amendment

Preserve this task identity, dependencies and existing acceptance/refusal requirements. Implementation is limited to the exact path/hunk ceiling in the owner-approved G2 packet based on c5d25181a3e4f7665f38753cf374264bcc2cd69b. Scope declarations inherited from earlier work do not expand that ceiling. No task is completed by adoption.
Retain the existing full local return-loop obligation and add Run Lab/Orbit exact-ID interoperability, current admission, crash/replay/evidence refusal cases. Real provider execution and consuming-repository production mutation remain excluded. Fixture-only passes must not be called real-provider qualification.

### Owner-approved explicit native validation evidence amendment

Rebuild a fresh single-task fixture with the explicit artifact binding before its first unchanged native approval; retain the original undeclared-evidence pause as negative proof. General multi-task evidence lifecycle remains deferred. Complete required real local return-loop and frozen Orbit qualification before final implementation commit.
### Branch closure slice authority

For the separate owner-directed full-portfolio reconciliation slice, the exact ten-path ADOPTION-SCOPE.proposed.json at base 17c5249c6880c4a59727b0336bf093f2206e5297 extends the earlier c5d25181 G2 ceiling only for its named hunks in isolated codex/wale-branch-closure-20261029. Requalify the exact corrected successor and frozen Orbit with the existing native acceptance/refusal journey; no new task implementation, multi-task/profile expansion or extra native acceptance is implied. All original task criteria, dependencies and approval/final-acceptance gates remain unchanged. No candidate dispatch, providers, runtime activation, publication or task closure.


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

External gate: `TASK-PROOFLOOM-HARNESS-PROFILE-SCHEMA` must publish an accepted,
digest-bound Harness Profile contract and compatibility fixtures. Its proposed
handoff extension version remains unratified until canonical JSON, digest
rules, required fields, compatibility fixtures, and unsupported-version
behavior are frozen.

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

<!-- Retained original task restored from 319aad4524aa39dd680c1b23f88fcd0c31d42c0a BACKLOG.md; execution/adoption and acceptance remain separate. -->

## AF-RELEASE-001 - Automate clean release qualification


```yaml
estimate_hours: 6
depends_on: []
owns:
  - apps/server/src/cli.ts
  - scripts/create-release.mjs
  - scripts/smoke-install.mjs
  - BACKLOG.md
  - vitest.config.ts
  - .github/workflows/quality-and-release.yml
  - package.json
  - scripts/verify-release.mjs
  - tests/release-qualification.test.ts
validate:
  - npx vitest run --config vitest.config.ts tests/release-qualification.test.ts
  - npm run typecheck
produces:
  - name: qualified-release-pipeline
    type: release-capability
    version: 1.0.0
```

Add a deterministic release-qualification command and a GitHub Actions
workflow. Pull requests and main-branch updates must run the complete repository
verification gate. Version tags must build the release from the exact clean
commit, verify checksums, smoke-install the generated tarball in an isolated
environment, retain the evidence as an artifact, and only then create the
GitHub release.

The local qualification command must locate the tarball from the generated
manifest rather than hard-coding the current version. It must fail closed on a
dirty worktree for final qualification, support an explicit diagnostic mode
that never claims release readiness, and print a machine-readable evidence
summary.

Implementation qualification note: release evidence uses a fresh destination. Existing evidence, symlinked destinations and internal evidence names that could replace release assets are refused before commands run. An output directory retaining an earlier qualification report requires a fresh `--output`. Fresh external `--evidence` is supported without deleting earlier reports. The native packer retains its own guards for replacing recognized release directories. Current cross-repository integration tests require their explicit isolated fixture settings; missing settings fail closed and are not skipped by this task. Local qualification does not establish hosted CI, publication or native integration acceptance.

Integrity-pin reconciliation binds the current tracked source documents: the specification retains its original body plus the provenance banner from 8117b0a27bfe1488959b1e181ae5bb7fa0669760; implementation prompts match their first tracked LF bytes (the old pin described CRLF bytes). Source documents and authority wording are unchanged. Packaging, installed doctor and install smoke keep exact-byte checksum refusal, and smoke qualification also tests tampered installed copies.

### Acceptance Criteria

- `npm run release:verify` runs full verification, deterministic packaging,
  checksum verification, and isolated install smoke proof in that order.
- The release workflow uses the supported Node version and npm's lockfile.
- A tag cannot create a GitHub release unless all qualification steps pass.
- The published asset set contains the tarball, source archive, manifest, and
  checksums from the same commit.
- Diagnostic dirty-tree execution is clearly labeled non-final in output and
  cannot be used by the tag release job.
- Tests verify step ordering, manifest-based artifact discovery, dirty-tree
  refusal, and failure propagation without running a live publication.

## AF-CONSUMER-001 - Complete the guided consumer journey


```yaml
estimate_hours: 8
depends_on: []
owns:
  - tests/multi-repo.acceptance.test.ts
  - apps/server/src/repositories/config.ts
  - apps/server/src/repositories/git.ts
  - apps/server/src/http/routes/repositories.ts
  - apps/server/src/http/errors.ts
  - apps/server/src/repositories/backlog-approval.ts
  - apps/server/src/repositories/index.ts
  - apps/server/src/repositories/service.ts
  - apps/server/src/repositories/types.ts
  - apps/server/test/consumer-workflow.test.ts
  - apps/server/test/repository-review-inputs.test.ts
  - apps/server/test/repository-review-http.test.ts
  - apps/server/test/http-errors.test.ts
validate:
  - npx vitest run --config vitest.config.ts apps/server/test/consumer-workflow.test.ts
  - npm test -- apps/server/test/http-errors.test.ts
  - npm run typecheck
produces:
  - name: guided-consumer-api
    type: api-contract
    version: 1.0.0
```

Make the goal-first API truthful and complete for a non-developer. Add a
read-only repository preflight before connection and require explicit approval
before AgentFlow creates `.agentflow.yaml`. A repository that is already
configured must connect without source mutation.

After backlog generation and review, add an explicit action that safely commits
only the repository configuration and reviewed backlog. Refuse the action when
unrelated tracked, untracked, or staged changes exist. Validate the backlog
before committing it, use a fixed truthful commit message, return the commit
SHA, and preserve all unrelated work on every failure path.

Fixture adaptation: multi-repository lifecycle tests now explicitly consent to initializing their own disposable repositories, retaining all lifecycle assertions and adding registration/plan status checks.

Implementation qualification: a private native Git index binds the validated configuration/backlog snapshot while the normal index lock serializes ordinary Git writers. Existing hooks remain active. Refuse partial staging, preexisting locks and symbolic-link paths. A failed commit preserves staging; later working edits remain for review. A hook or reference change detected after commit returns the actual retained SHA and requires review, without resetting user work. No provider, publication, execution or semantic task acceptance is implied. BACKLOG.md restoration is coordinator source preparation, separate from runtime worker ownership.

Read-only review returns the actual configuration/backlog bytes and SHA-256 digests. Guided callers bind their save to those digests and the configured backlog path. A distinct setup-only review/save permits the first configuration commit before clean-tree backlog generation, without reading, creating or validating a nonexistent backlog. Both explicit saves refuse active builds at the HTTP boundary. UTF-8 input reads are capped before YAML parsing using the existing native 10 MiB validation budget. No generation or build starts as a side effect.

Technical completion (2026-11-03): all five original criteria are satisfied in candidate `a733e183db81f57360ffb06eefbf660fa6cfcc24`. Full canonical local qualification passes 504 unit tests and eight integration checks, with one existing optional export audit skipped; lint, types, builds, deterministic packaging, checksums and isolated installation also pass. Retained native API/browser setup proof at `dd6ff6ab` covers explicit setup and both reviewed commit modes; focused native tests cover safe refusals. Its seven relevant consumer source files are unchanged in this candidate. Independent criterion review found no remaining technical requirement. This records technical engineering completion of the guided consumer API task only; it does not transition a persisted AgentFlow task/build or change planning eligibility. It makes no runtime-adoption, provider, publication, deployment or human-outcome claim. The criteria, dependencies, ownership and validations below remain unchanged.

### Acceptance Criteria

- The first connection check performs no write to the target repository.
- Configured repositories connect without rewriting `.agentflow.yaml`.
- The commit endpoint permits only `.agentflow.yaml` and the configured backlog
  path, rejects unrelated changes with a plain-language next action, validates
  the backlog before Git mutation, and returns durable commit evidence.
- Tests prove read-only preflight, explicit initialization, safe reviewed-plan
  commit, invalid backlog refusal, and unrelated-change refusal.
- The endpoint contract never claims publication, deployment, or external
  provider success.

## AF-UI-001 - Deliver the modern guided interface

```yaml
estimate_hours: 8
depends_on:
  - AF-CONSUMER-001
owns:
  - apps/web/index.html
  - apps/web/src/api/client.ts
  - apps/web/test/api-client.test.ts
  - apps/web/test/ResultBuildCard.test.tsx
  - apps/web/src/api/types.ts
  - apps/web/src/components/AppNavigation.tsx
  - apps/web/src/components/ResultBuildCard.tsx
  - apps/web/src/screens/BuildScreen.tsx
  - apps/web/src/screens/PlannerScreen.tsx
  - apps/web/src/screens/ResultsScreen.tsx
  - apps/web/src/screens/StartScreen.tsx
  - apps/web/src/styles.css
validate:
  - npm run typecheck
  - npm run build:web
  - npm test -- apps/web/test/api-client.test.ts
  - npm test -- apps/web/test/ResultBuildCard.test.tsx
produces:
  - name: modern-consumer-interface
    type: product-capability
    version: 1.0.0
consumes:
  - task: AF-CONSUMER-001
    artifact: guided-consumer-api
    version: 1.0.0
```

Apply the installed `design-taste-frontend` guidance as a redesign-preserve
pass. Keep Primer and Phosphor as the single product design system. Use a calm,
confident devtool language with `DESIGN_VARIANCE 5`, `MOTION_INTENSITY 4`, and
`VISUAL_DENSITY 5`.

Turn the connection experience into a clear preflight and explicit setup
decision. Turn reviewed backlog approval into a complete in-product action.
Modernize navigation, typography, spacing, surface hierarchy, progress, and
completed-work reporting without hiding operational truth.

### Acceptance Criteria

- Project connection first shows a read-only readiness result.
- If setup is missing, the UI names `.agentflow.yaml` and requires explicit
  consent before creating it.
- The planner explains that backlog generation changes a review file but does
  not start coding work.
- A reviewed valid backlog can be committed from the UI without a terminal.
- Unrelated-change and invalid-backlog failures show a safe next action.
- Advanced IDs and logs remain available through progressive disclosure.
- Loading, empty, error, blocked, and success states remain complete.
- The interface uses one accent, one radius system, readable CTA contrast,
  visible keyboard focus, and no wrapped desktop CTA labels.
- Motion communicates hierarchy or action feedback, honors reduced motion, and
  does not use scroll listeners.
- The dashboard has no visible em dash or en dash characters.
- Layouts have no horizontal overflow at 1440px, 1024px, 768px, and 390px.
- Result copy distinguishes integration, quality checks, publication,
  deployment, and external operation.
