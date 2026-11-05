# Design Intelligence integration

AgentFlow consumes an owner-approved `design-intelligence/governed-task-handoff` and emits a hash-bound `agentflow/build-receipt`.

```text
design-intelligence governed handoff
  -> owner approval
  -> agentflow design-intelligence import
  -> review and commit BACKLOG.md
  -> immutable plan bound to the handoff digest
  -> isolated execution and serialized integration
  -> governor.v1 evaluation through AgentFlow runtime controls
  -> agentflow build receipt 1.1.0 with Governor decision provenance
  -> design-intelligence receipt audit and outcome recording
```

Import never overwrites a backlog and defaults to `BACKLOG.design-intelligence.proposed.md`. AgentFlow accepts only handoff schema `2.1.0`, verifies the canonical execution-approval receipt, current authority-source hashes, the governed snapshot digest, and carrier-only continuity from the governed base. Planning reloads and rechecks the handoff before immutable binding; build creation rechecks it again and requires the exact planned execution revision. Governed task retry is currently refused with HTTP 409 `GOVERNED_RECOVERY_NOT_AUTHORIZED`; the handoff contract does not enable retry. The Governor bridge evaluates native AgentFlow records, persists hash-bound `governor.v1` decisions, and applies only bounded runtime actions; reconsideration and replanning remain proposal-only. Receipt schema `1.1.0` distinguishes `governedBaseCommit` from the exact `baseCommit` used by the execution attempt and serializes Governor decision records as strict evidence events. A receipt proves only AgentFlow's local execution and integration evidence; it cannot prove deployment, provider behavior, production readiness, customer acceptance, or business outcomes.


## Current execution-authority readback

`GET /api/builds/:id/execution-authority` runs the existing native
execution-authority checks without starting or changing a build. The response
contains `buildId`, `checkedAt`, and one of these statuses:

- `passed`: the governed build passed the checks at `checkedAt`.
- `blocked`: a native check refused, with a bounded `code` and `message`.
- `not_applicable`: an ordinary plan passed the native checks and has no governed
  handoff.
- `unknown`: the immutable plan or exact governed execution binding is missing.

The response uses `Cache-Control: no-store`. Read or server failures provide no
positive result. This is an as-of observation, not human approval or permission
for a later operation; native execution controls recheck independently. Historical
Governor authority observations describe their recorded time. Neither this
readback, receipt events, SSE delivery nor acknowledgements establish record-chain
verification or final task acceptance.
