# Design Intelligence integration

AgentFlow consumes an owner-approved `design-intelligence/governed-task-handoff` and emits a hash-bound `agentflow/build-receipt`.

```text
design-intelligence governed handoff
  -> owner approval
  -> agentflow design-intelligence import
  -> review and commit BACKLOG.md
  -> immutable plan bound to the handoff digest
  -> isolated execution and serialized integration
  -> agentflow design-intelligence receipt
  -> design-intelligence receipt audit and outcome recording
```

Import never overwrites a backlog and defaults to `BACKLOG.design-intelligence.proposed.md`. Planning reloads the handoff, verifies its digest, rejects task-scope drift, and requires its base commit to be an ancestor of the committed execution packet. A receipt proves only AgentFlow's local execution and integration evidence; it cannot prove deployment, provider behavior, production readiness, customer acceptance, or business outcomes.
