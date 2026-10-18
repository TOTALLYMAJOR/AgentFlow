# ADR-0013: Separate coordination experience from execution authority

- Status: Accepted
- Date: 2026-09-12

## Context

AgentFlow benefits from the continuity of a project-level orchestrator and the
legibility of a live agent-session board. Those interaction patterns must not
create another way to schedule tasks, mutate lifecycle state, approve plans, or
integrate source. A conversational agent is useful for interpreting goals and
proposing work, but its output is not durable execution authority.

## Decision

AgentFlow presents one continuous project workspace across outcome definition,
planning, active work, and results. The workspace may retain a user's draft and
guide them to the next governed action. Its live board is a read model derived
from persisted task and worker state; cards cannot be dragged into a new state.

The authority chain remains:

```text
objective or orchestration advice
  -> proposed backlog
  -> human-reviewed committed BACKLOG.md
  -> validated immutable plan
  -> explicit build start
  -> AgentFlow coordinator dispatch
  -> ownership and validation gates
  -> serialized integration
  -> durable evidence
```

Only AgentFlow's planner, build API, coordinator, validation service, and
integration manager may advance work through that chain. Workers may report a
proposed scope or architecture decision, but they cannot approve, reject, or
supersede plans or governance decisions. Worker prompts enforce that boundary.

When several builds are active, a successful planning handoff carries the exact
created build identifier into Activity. The UI must not substitute whichever
build happens to sort first.

## Borrowed interaction and governance patterns

- A persistent project-level workspace rather than disconnected task screens.
- One isolated agent session per task, with task identity ahead of slot details.
- A live operational board that makes work, attention, checking, and completion
  visible without inventing state.
- Coordination-only orchestration and implementation-only workers.
- Human decisions remain explicit; CI, review, and execution facts remain
  attached to the work they govern.

## Consequences

- The product becomes easier to supervise without weakening deterministic
  dependency scheduling.
- New backend task states remain visible in an `Unmapped state` attention lane
  until the presentation mapping is updated.
- Failed, interrupted, and approval-gated tasks cannot disappear into a generic
  queue or technical-details drawer.
- Chat persistence, free-form agent commands, card drag-and-drop, and a second
  task state machine are intentionally excluded.
- A later governance change should enforce that the backlog used to create a
  plan is tracked and byte-identical to `HEAD`, and should bind explicit plan
  approval to a durable digest. This ADR does not claim those gates exist yet.

## Alternatives considered

### Add a separate autonomous orchestrator screen

Rejected because it would imply a second execution authority and duplicate the
existing objective-to-plan workflow.

### Persist a chat transcript as project truth

Rejected for this slice. Conversation is useful context, but a transcript must
not outrank committed backlog, plan, approval, or build evidence.

### Keep the technical queue dashboard unchanged

Rejected because several valid lifecycle states were omitted from the visible
queues and only recovered by a duplicate all-tasks list. A complete derived
board is more legible and safer.
