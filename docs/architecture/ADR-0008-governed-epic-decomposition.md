# ADR-0008: Governed epic decomposition and ADR drafts

## Status

Accepted

## Context

Large objectives need decomposition above individual tasks, but a prose epic
summary can drift from the executable task graph. Automatically creating
accepted architecture decisions would also grant a planning agent authority it
does not have.

## Decision

Epic identity, title, and outcome are task metadata in the authoritative
backlog. Plans derive epic membership, estimates, and cross-epic dependencies
from those tasks. Metadata must be consistent within an epic, and the derived
epic dependency graph must be acyclic in addition to the task graph.

Backlog generation prompts require outcome-oriented epic decomposition for broad
programs. Existing backlogs without epic metadata remain compatible as one
default delivery epic.

Architecture decisions must be explicitly declared with context, decision, and
consequences. AgentFlow deterministically renders those declarations as
`Proposed` ADR drafts in the immutable plan. It never writes or accepts an ADR
in the repository automatically.

## Consequences

- Epic status and dependencies cannot diverge from executable tasks.
- Operators can review decomposition before committing or starting a build.
- Architecture choices have a traceable source task.
- Human review remains the authority for accepting and publishing ADRs.
