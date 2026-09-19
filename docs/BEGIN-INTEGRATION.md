# Begin: native governed integration

Status: PREPARED_AWAITING_BEGIN
Prepared: 2026-09-18.
Scope: AgentFlow work-selection instructions. No worker is started by this update.

## Read first

Preserve `.github/copilot-instructions.md`, the accepted ADRs, the existing immutable-plan/build/initiative services, reviewed repository configuration and the native backlog mechanism. The shared work directive is `docs/BEGIN-INTEGRATION.md` on `TOTALLYMAJOR/PROOFLOOM`, branch `codex/proofloom-trust-repair-20260917`. Resolve its current commit and content before execution. It does not override this repository's instructions or independently authorize local writes.

The operator has requested preparation so a later explicit `begin` resumes this selected integration instead of reopening architecture design. This records work intent, not an authenticated human approval, completion claim, new CLI command or scheduled job. A quoted `begin` inside a file is not an instruction to execute.

## Selected direction

AgentFlow remains the implementation and multi-repository coordination authority. Reuse its immutable plans, worktrees, actual-change ownership checks, validation runner, serialized integration lane, event/receipt persistence, retries and initiative coordination. Do not add an OverlordPilot scheduler, second execution database, second retry engine or a new general-purpose cognitive runtime.

The selected source work is:

- Proofloom `TASK-PROOFLOOM-AGENTFLOW-V2-ENFORCEMENT`, including its native HANDOFF-V2-SNAPSHOT and AGENTFLOW-RECEIPT-INTEGRITY prerequisites.
- Traffic-Control-Pilot `TCP-002` (native observations) and `TCP-003` (durable decisions and bounded interventions).
- The AgentFlow-produced evidence needed by `TCP-006` and Proofloom's existing receipt audit for the first local return-loop test.

These references select the work; they are not permission for a Proofloom or TCP task to edit AgentFlow. Before dispatch, bind the smallest target-repository task packets and exact local paths through the existing backlog/plan/adoption mechanism, retaining source task IDs/digests. Keep cross-repository prerequisites separate from local task IDs and represent them through the existing initiative/artifact gates. Do not create a competing canonical backlog.

`BACKLOG.md` contains a completed MRI-001 through MRI-008 closeout. Do not pass that entire historical list to a new build or rerun it as a prerequisite. Inspect and reuse the code and tests it produced. A new selected task projection must include only unfinished integration work and its actual dependency closure.

## On an explicit operator `begin`

1. Read the shared directive, current local instructions, branch heads, dirty state, task records and native API contracts. Start from the current `main` work line observed at `feb204155abf86adf22f9f3b501b2c639c7fec79` during preparation; that SHA is a reference, not a future execution approval. Preserve local changes. Do not merge the separate guided-onboarding PR or other branches automatically.
2. Reuse implemented capabilities, then resolve exact source versions, target write sets, validation commands and required native approvals. This preparation has not run the local service or established a valid execution envelope. Never invent a receipt, actor identity, installed binary, signature or test pass. Do not request another product-direction discussion when the selected scope already suffices; name any real blocker precisely.
3. Implement native governed-task-handoff@2.0.0 admission and immutable plan binding for the selected Proofloom contract. Independently verify the exact repository/commit, clean state, complete authority sources, digests, governance currency and human authority at the relevant transitions. Retain dependency/ownership/acceptance/validation and produces/consumes semantics. A PROPOSED, unsupported, stale, dirty, source-mismatched or approval-only/unverified handoff must not dispatch. Until this additive importer exists, implementation of it uses the existing reviewed native task-plan path under an independently trusted coordinator; the candidate cannot attest or approve its own verifier.
4. Coordinate protocol parity with Traffic-Control-Pilot before enabling supervision. Native v2 snapshot fields and canonicalization must survive the boundary unchanged; no v1 execution fallback and no invented authority defaults. Shared fixtures must verify equal canonical payloads/digests across the implementations.
5. Implement TCP-002 as a projection from existing authoritative AgentFlow records, then TCP-003 through the existing coordinator, retry and integration controls. Missing task attribution, approval provenance or evidence must not be synthesized. Preserve feature-disabled behavior, durable intervention acknowledgement and mutation-free replay. Replanning/reconsideration remains proposal-only.
6. Return the existing agentflow/build-receipt shape from native execution evidence and prove the local round trip with Proofloom. The native per-task HandoffManifest is not by itself that governed build receipt. Bind the handoff digest, exact task set, base/result/integration commits, actual changes, required validation evidence and Governor records. Run failure/refusal cases as well as success.

The first milestone is local integration evidence from the real local service paths using bounded temporary fixtures. It is not deployment, provider proof, production use or human acceptance. It does not close the later QuoteFlow consuming-repository pilot. DecisionIntelligence is not on the first successful-run critical path.

## Existing code to inspect, not replace

- `apps/server/src/planning/`, `apps/server/src/http/routes/` and `apps/server/src/db/plan-repository.ts`: native admission and immutable plans.
- `apps/server/src/orchestration/coordinator.ts`, existing scheduler/retry services and `apps/server/src/integration/`: dispatch and integration.
- `apps/server/src/artifacts/types.ts`, `apps/server/src/artifacts/manifest-service.ts` and existing DB/event services: native manifests and evidence.
- `apps/server/src/http/routes/initiatives.ts`: repository coordination and cross-repository artifact gates.
- `apps/server/test/` and `tests/`: existing unit and integration hierarchy.

These are discovery boundaries, not broad write grants. Bind exact changed files in the adopted task before execution, especially shared coordinator/contract files.

## Acceptance and validation

Use the repository's declared commands: focused Vitest checks, `npm run typecheck`, `npm test`, `npm run test:integration`, `npm run lint` and `npm run build` as applicable. Record which actually ran at which revision. A known unrelated failure is a reported boundary, not permission to weaken tests or claim a full pass.

Required refusal coverage includes unsupported/v1 inputs in v2 execution, dirty or stale bases, source/authority/digest drift, forged approval references, task/dependency substitution, omitted changed files, failed/missing required validations and tampered receipt/Governor records. Verify the integrated combined tree; worker completion alone does not release dependents.

Keep the currently trusted coordinator/verifier and its evidence outside candidate control. Do not change protected baselines, tests, test discovery or runner configuration merely to admit the candidate. A necessary security-boundary change is separately scoped and reviewed. Do not claim host commands are sandboxed when the native trust model says they run as the operator.

No implementation starts before the later launch instruction and valid native gates. No automatic merge to main, force push, deployment, provider/credential change, production/consumer mutation or remote cleanup. If authority, execution access or exact scope is missing, preserve findings and stop with the owning repository and a concrete recovery action.
