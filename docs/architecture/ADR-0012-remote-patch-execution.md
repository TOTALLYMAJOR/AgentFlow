# ADR-0012: Remote patch execution

Status: accepted

## Context

Lease-fenced remote jobs were durable, but build execution still invoked only a
local coding-agent process.

## Decision

When an online remote runner has provider capacity, the coordinator queues
protocol version 1 work with the repository remote, exact base commit, normalized
task, and prompt context. The runner returns a base64 unified Git patch and its
SHA-256 digest through the fenced, idempotent completion endpoint.

The control plane verifies and stores the patch, applies it to the isolated task
worktree, and uses the same ownership, validation, commit, handoff, and
integration pipeline as local work. Without an eligible runner, it falls back to
the configured local provider.

## Consequences

Remote machines require no inbound control-plane connection. They must fetch the
repository remote and implement protocol version 1. The control plane remains
the validation and Git authority.
