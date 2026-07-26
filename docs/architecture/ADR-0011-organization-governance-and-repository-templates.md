# ADR-0011: Organization governance and repository templates

Status: accepted

## Context

Repository-local configuration cannot establish installation-wide limits, while
copying configuration between repositories causes standards to drift.

## Decision

AgentFlow creates a versioned, user-editable policy at
`$AGENTFLOW_HOME/governance/organization-policy.yaml` without overwriting an
existing file. Planning enforces worker limits, validation commands, and protected
ownership. Retry and visual tolerances use organization caps, and startup rejects
a disallowed default provider.

Named repository templates are exposed in the API and UI. Application requires
explicit overwrite confirmation, validates policy, and atomically replaces only
`.agentflow.yaml`. The operator must review and commit that change before planning.

## Consequences

Organization standards are enforced at execution boundaries while repository
configuration remains versioned locally. Policy edits require a restart.
