# ADR-0007: Repository-local estimate calibration

## Status

Accepted

## Context

Backlog estimates vary by repository, stack, validation cost, and team
conventions. Applying one organization-wide correction factor would hide those
differences, while adjusting from one unusual task would overfit.

## Decision

AgentFlow calculates actual-to-estimated duration ratios only from integrated
tasks in the same repository. The median becomes eligible after three samples
and is clamped between 0.5 and 3.0. Before that threshold the multiplier is
exactly 1.0 and confidence is `insufficient`.

New immutable plans record sample counts, multiplier, and confidence alongside
their calibrated sequential, critical-path, and elapsed estimates. Raw build
and task evidence remains authoritative.

## Consequences

- Estimates improve without cross-project data leakage.
- Outliers have limited influence and small samples do not alter a plan.
- The UI can explain exactly why an estimate changed.
- Future calibration may segment by task class after the knowledge graph
  provides enough trustworthy samples.
