# ADR-0003: Coding-agent provider registry

## Status

Accepted

## Context

AgentFlow directly started Codex processes from the build coordinator. That
coupled scheduling and task lifecycle logic to one agent runtime and prevented a
remote worker transport from sharing the same dispatch contract.

## Decision

The coordinator selects a named provider from an installation-level registry.
Providers receive the existing isolated task execution contract and return the
same cancellable worker handle. The initial `codex` adapter runs locally and
preserves existing behavior. Startup fails if the default provider is missing.

Provider identity and execution mode are exposed in system health.

## Consequences

- Additional agent providers do not require coordinator changes.
- A remote transport can implement the contract while preserving cancellation,
  heartbeats, and structured outcomes.
- Repository-level provider selection requires persisted policy in a later
  migration.
