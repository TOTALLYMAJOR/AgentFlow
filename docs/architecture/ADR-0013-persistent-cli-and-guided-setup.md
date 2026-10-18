# ADR-0013: Persistent CLI execution and guided repository setup

Status: Proposed

## Context

Each API-backed CLI command previously constructed a Fastify application,
reconciled active builds, then closed the coordinator. Status queries therefore
entered recovery, and starting work did not leave a persistent coordinator to
own it. Setup also required operators to assemble registration and backlog
generation manually; the shell helper assumed a particular developer's repo.

## Decision

API-backed CLI commands use the existing loopback server. A health request
checks its runtime home before the operation. There is no fallback coordinator
and no automatic mutation retry. The server/service owns worker lifetime.

Local `setup` reuses repository inspection, configuration creation, and backlog
planning code. It can create missing configuration or a non-executable worksheet
without running agents. It reports dirty/unborn repositories, untracked inputs,
invalid configuration/backlogs, and mismatched local bases with next actions.

`start` reuses registration, surfaces existing active builds, and either invokes
the existing backlog generator for an explicit objective/auto request or creates
a plan. Generated work still requires review and commit. `run` remains explicit;
`launch`, `pause`, `resume`, `retry`, and `cancel` reuse existing lifecycle routes.
The legacy helper delegates backlog generation to the same API-backed command.

## Consequences

- Operators must keep the server running for API-backed CLI commands. Local
  setup and installation diagnostics remain available independently.
- Existing state machines, task validation, integration gates, provider
  contracts, and database schema are unchanged.
- Repeated setup preserves files; repeated start reuses registration and an
  active build, but may produce multiple immutable plans before a build exists.
- Readiness is a planning prerequisite, not a promise that a provider, external
  dependency, or repository test will succeed. Failures retain existing evidence
  and require the appropriate inspection/recovery action.
- Backlog generation still relies on the existing provider and its timeout and
  scope checks. This change does not add automatic repair or worker execution
  to onboarding, or redesign dashboard onboarding.
