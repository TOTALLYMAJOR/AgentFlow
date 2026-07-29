# AgentFlow documentation

This directory contains the current operating contract and the historical
source documents used to build AgentFlow.

## Start here

- [../README.md](../README.md) — product overview and first repository.
- [FEATURE_MATRIX.md](FEATURE_MATRIX.md) — implemented capabilities at a glance.
- [INSTALLATION.md](INSTALLATION.md) — install, configure, run, upgrade, and
  remove AgentFlow.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — failure diagnosis and recovery.
- [SECURITY.md](SECURITY.md) — trust boundaries, credentials, remote runners,
  and repository command execution.
- [ASSUMPTIONS.md](ASSUMPTIONS.md) — explicit implementation choices.
- [../examples/README.md](../examples/README.md) — configuration and backlog
  templates.

## Architecture

`architecture/SPEC-1-AgentFlow-Local-Agentic-Engineering-Platform.md` is the
original MVP specification. It intentionally retains historical constraints
such as one installation-wide active build.

The implemented post-MVP decisions are authoritative where they differ:

| ADR | Decision |
| --- | --- |
| ADR-0001 | Repository-scoped active builds |
| ADR-0002 | Installation-wide worker budget |
| ADR-0003 | Coding-agent provider registry |
| ADR-0004 | Pull-based remote runner identity |
| ADR-0005 | Lease-fenced remote jobs |
| ADR-0006 | Durable automatic retry policy |
| ADR-0007 | Repository estimate calibration |
| ADR-0008 | Governed epic decomposition and ADR drafts |
| ADR-0009 | Browser screenshot comparison evidence |
| ADR-0010 | Persisted codebase knowledge graph |
| ADR-0011 | Organization policy and repository templates |
| ADR-0012 | Remote patch execution |

`implementation/AgentFlow-Codex-Implementation-Prompts.md` is also retained as
historical implementation provenance. It is not a current operations manual.

## Installed artifacts

Release packages include:

- Built API, CLI, and dashboard under `dist/`.
- Checksummed SQL migrations under `dist/migrations/`.
- Offline documentation under `docs/`.
- Repository examples under `examples/`.

Runtime-generated policies and evidence are not package assets. They live under
`$AGENTFLOW_HOME`.
