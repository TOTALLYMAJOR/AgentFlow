# ADR-0004: Pull-based remote runner identity

## Status

Accepted

## Context

AgentFlow needs worker machines outside the control-plane host without requiring
inbound access to those machines. Runner availability must not be confused with
coding-provider configuration, and credentials must not be stored in plaintext.

## Decision

Remote runners register with a provider, capacity, and typed capability map.
Registration returns a random bearer token once; only its SHA-256 digest is
persisted. Authenticated heartbeats update online or draining status, busy
slots, capacity, capabilities, and last-seen time.

Task worker records persist both provider and runner identity. The eventual job
transport will be pull-based: authenticated runners claim eligible leases and
submit heartbeats and structured outcomes to the control plane.

The API remains loopback-bound and remote access requires an authenticated
private tunnel.

## Consequences

- Operators can distinguish provider support, machine health, and capacity.
- Runner tokens can be handled as machine credentials without entering the
  database in recoverable form.
- Registration does not yet authorize task-state transitions; lease fencing and
  idempotent result submission are required before remote dispatch is enabled.
