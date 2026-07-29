# AgentFlow feature matrix (current state)

This matrix captures the currently implemented product behavior in the
`0.3.0` release line.

| Capability area | Current state |
| --- | --- |
| Local-first control plane | **Implemented** (loopback API on `127.0.0.1`, runtime state in `$AGENTFLOW_HOME`) |
| Repository registration and isolation | **Implemented** (`repo init/add/list/inspect/remove`, isolated task worktrees) |
| Immutable planning from backlog | **Implemented** (`plan` compiles committed `BACKLOG.md` into executable plan) |
| Build execution lifecycle | **Implemented** (`run`, `status`, `inspect`, `retry`) |
| Concurrent builds model | **Implemented** (concurrent builds across repositories, one active integration lane per repository) |
| Worker scheduling | **Implemented** (installation-wide worker budget and resource-aware dispatch) |
| Coding agent providers | **Implemented** (provider registry with local Codex support) |
| Remote runner protocol | **Implemented** (pull-based registration, capacity heartbeat, lease-fenced claim, signed result flow) |
| Remote patch safety | **Implemented** (digest verification plus normal ownership, validation, handoff, and integration gates) |
| Durable retries | **Implemented** (bounded exponential backoff with persisted retry state) |
| Historical estimate calibration | **Implemented** (repository-scoped estimate history and calibration guidance) |
| Repository-grounded backlog generation | **Implemented** (generation pipeline requiring manual review/commit before planning) |
| Epic decomposition and ADR drafting | **Implemented** (cross-epic dependency checks and proposed ADR output for review) |
| Browser visual evidence | **Implemented** (Playwright screenshot capture and `pixelmatch` comparison against committed PNG baselines) |
| Persisted knowledge graph and impact analysis | **Implemented** (symbol/link persistence and reverse impact queries) |
| Installation governance and templates | **Implemented** (organization policy and explicit repository templates) |
| Operations dashboard | **Implemented** (repositories, plans, builds, runners, evidence, and next actions) |
| Packaging and install flow | **Implemented** (`pack:release`, checksummed install, smoke install path) |
| User service lifecycle | **Implemented** (`service install/start/stop/restart/status/logs`, `upgrade`, `uninstall`) |
