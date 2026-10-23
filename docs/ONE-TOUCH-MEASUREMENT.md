# One-Touch measurement projection

Status: program correlation is implemented; the measurement projection below is a design proposal. It does not change AgentFlow scheduling, retries, integration, approvals, or evidence retention.

AgentFlow accepts optional `programId` in governed handoff schema `2.1.0`, retains it in `PlanResult.governedHandoff`, copies the immutable normalized plan into the build record, and returns it on build receipt schema `1.1.0`. Handoffs without this identifier remain subject to the same native authority and execution checks. This does not enable older handoff schema versions.

## Existing-store mapping

No migration or second store is needed to retain the optional correlation identifier:

| Measurement entity | Existing durable source | Join |
| --- | --- | --- |
| repository handoff | normalized plan `governedHandoff` | `programId`, handoff ID/digest |
| plan | `plans` | plan ID; `normalizedPlan.governedHandoff.programId` |
| build | `builds` | build ID and plan ID; immutable normalized-plan copy |
| task | `tasks` | build ID and backlog task ID |
| attempt/retry/repair | task attempts, retry schedules, build events | build ID, task ID, attempt number |
| validation | validation runs | build ID, task ID, validation ID |
| integration | task integration commit, manifests, integration events | build ID, task ID |
| human intervention | approvals and build events | build ID, task ID, approval/event ID |
| artifacts and receipt | artifacts, manifests, Design Intelligence receipt | build ID and handoff binding |

Any future projection must read these records after durable writes. It must not create scheduling input, change state, infer missing evidence, or copy raw logs/prompts into analytics. A correlation identifier is not proof of a successful outcome.

## Proposed measurement rollout

1. Require `programId` in an experiment's admission criteria before collecting program-scoped metrics; records without it cannot establish program attribution. This document does not implement or authorize an experiment.
2. Do not backfill unless an exact governed handoff binding proves the correlation.
3. Query program-scoped data through `normalized_plan.governedHandoff.programId` and current native keys. Add an indexed column only after measured query volume justifies it, using a new immutable SQLite migration.
4. Making `programId` mandatory in the shared contract requires a new schema version and Proofloom/Traffic Control conformance validation.

Future metric consumers must report numerator and denominator for each rate and retain authority and proof failures as guardrails, rather than silently excluding them. The existing receipt remains evidence of local execution only, as described in [the integration guide](DESIGN-INTELLIGENCE-INTEGRATION.md).
