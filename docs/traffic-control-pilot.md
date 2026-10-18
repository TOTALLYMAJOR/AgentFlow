# Traffic Control pilot runs

Status: draft cross-repository run contract. This document does not enable a live adapter, approve a run, or change AgentFlow's current state machine. AgentFlow's native backlog, immutable plan, coordinator, validation, integration, retry, recovery, and receipt gates remain authoritative. The accepted [coordination ADR](architecture/ADR-0013-coordination-and-execution-authority.md) still governs execution ownership.

## Admission and bypass

Traffic Control participates only when an AgentFlow run is explicitly selected for the pilot and all of the following are verified against current native records:

1. A human or permitted repository authority approved the exact objective and governed task scope; the bound handoff, repository identity, base revision, and authority sources are current.
2. The run has an immutable approved scope reference, including the handoff identity and digest, AgentFlow run identity, and a digest of the scope used for decisions.
3. AgentFlow has a compatible, working adapter and a supported Traffic Control policy version. Version negotiation is explicit; `governor.v1` decisions are not silently interpreted as draft `governor.v2` actions.
4. AgentFlow can supply trusted observations for task state, changed paths, validation, impact, prior attempts, repair depth, and external effects relevant to the requested intervention.

If the run was never admitted, AgentFlow follows its existing native execution path without the pilot. After admission, a missing decision, adapter failure, stale binding, unsupported policy, or incomplete required observation pauses the run. AgentFlow must not treat pilot failure as ineligibility and bypass it.

## Scope and intervention

The approved scope includes objective, governed task IDs and dependency edges, repository identity and owned surfaces, validation and proof obligations, limits, and explicitly authorized external/provider effects. No provider mutation is permitted by the pilot when that authorization and trusted monitoring are absent. The current handoff v2 shape does not by itself prove a provider-effect allowlist; this remains an implementation blocker for any stronger claim.

Traffic Control may recommend `CONTINUE`, `COMPACT`, `REPLAN`, `SPLIT`, `RESTART`, or `ESCALATE` under a separately adopted draft `governor.v2` policy. AgentFlow validates the decision against its immutable plan and native state before applying it. `COMPACT` may change agent context, `REPLAN` may change steps or order, `SPLIT` may create subordinate execution units under an existing task, and `RESTART` may create a new attempt through AgentFlow recovery. None creates a new governed task ID, backlog item, dependency edge, repository surface, proof relaxation, provider effect, or approval. Subordinate units are execution detail, not new canonical tasks.

If a safe continuation requires any of those additions, a changed approval, or a non-idempotent external replay, the only pilot disposition is `ESCALATE`: AgentFlow pauses mutation and integration and presents the reason and proposed delta to the governing authority. A new approved handoff or native equivalent must bind any added scope before a later run resumes. The pilot cannot self-authorize that transition.

## Evidence and receipts

The decision record must bind the policy version, run and handoff identities, scope digest, trusted observation digest, reason, and scope-preservation result. AgentFlow owns durable run state and applies the intervention; Traffic Control owns deterministic decision and replay history. If the pilot participated, its decision evidence attaches to that same AgentFlow run and existing build receipt. It is not a new authorization receipt or proof of deployment, provider delivery, customer acceptance, or outcome.

The six-action contract is a target specification. Current `governor.v1` uses a different action set, with `PROPOSE_REPLAN` proposal-only. Versioned implementation, deterministic scope-preservation tests, replay, live adapter evidence, and a consuming-repository pilot are required before claiming v2 behavior works.
