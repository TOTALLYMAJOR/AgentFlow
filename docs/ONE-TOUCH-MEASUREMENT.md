# One-Touch measurement projection

Status: experimental read-only projection. It does not change AgentFlow scheduling, retries, integration, approvals, or evidence retention.

AgentFlow receives optional `programId` from the approved governed handoff, retains it in `PlanResult.governedHandoff`, copies the immutable normalized plan into the build record, and returns it on the Design Intelligence receipt. New experiment runs require the identifier; legacy runs without it remain executable under their existing contract but are excluded from One-Touch metrics.

## Existing-store mapping

No migration or second store is required for the additive phase:

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

Projection code must read these records and emit measurement events after durable writes. It must not create scheduling input, change state, infer missing evidence, or copy raw logs/prompts into analytics.

## Migration

1. Dual-read optional `programId`; require it only for the 30-run experiment.
2. Do not backfill unless an exact governed handoff binding proves the correlation.
3. Query program-scoped data by extracting `normalized_plan.governedHandoff.programId` and joining through current native keys. Add a generated/indexed column only after measured query volume justifies it; use a new immutable SQLite migration if that happens.
4. Promote `programId` to a required field only in a new governed-handoff and receipt schema version after Proofloom and Traffic Control conformance tests pass.

Dashboard consumers should show a program summary and native plan/build/task drill-down, with numerator/denominator for every rate. Authority and proof failures remain first-class guardrails rather than success-metric exclusions.
