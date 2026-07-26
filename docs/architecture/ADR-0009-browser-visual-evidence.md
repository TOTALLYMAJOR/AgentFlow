# ADR-0009: Browser screenshot comparison evidence

## Status

Accepted

## Context

Command and DOM tests do not prove that a user-visible route still renders as
expected. Visual comparison must be deterministic, bounded, and auditable
without granting the control plane general web-browsing authority.

## Decision

AgentFlow captures screenshots with Playwright Chromium using a fixed viewport,
reduced motion, disabled animations, blocked service workers, and network-idle
navigation. Control-plane capture is restricted to loopback URLs.

Baselines must be committed PNG files inside the registered repository.
Actual and diff images are stored beneath AgentFlow artifacts. Pixel comparison
records dimensions, changed pixel count, ratio, threshold, status, source URL,
and evidence paths in SQLite. Dimension changes fail explicitly without
fabricating a resized comparison.

## Consequences

- Visual regressions produce durable baseline/current/diff evidence.
- Repository path containment prevents reading arbitrary baselines.
- Loopback restriction avoids turning the local control plane into an SSRF
  primitive.
- Playwright Chromium must be installed on browser-capable runners.
