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

Import never overwrites a backlog and defaults to `BACKLOG.design-intelligence.proposed.md`. AgentFlow accepts only handoff schema `2.1.0`, verifies the canonical execution-approval receipt, current authority-source hashes, the governed snapshot digest, and carrier-only continuity from the governed base. Planning reloads and rechecks the handoff before immutable binding; build creation rechecks it again and requires the exact planned execution revision. Governed builds do not retry unless the handoff contract explicitly grants recovery authority. The Governor bridge evaluates native AgentFlow records, persists hash-bound `governor.v1` decisions, and applies only bounded runtime actions; reconsideration and replanning remain proposal-only. Receipt schema `1.1.0` distinguishes `governedBaseCommit` from the exact `baseCommit` used by the execution attempt and serializes Governor decision records as strict evidence events. A receipt proves only AgentFlow's local execution and integration evidence; it cannot prove deployment, provider behavior, production readiness, customer acceptance, or business outcomes.
