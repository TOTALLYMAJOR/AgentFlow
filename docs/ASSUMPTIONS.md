# Implementation assumptions

The source specification leaves several protocol details open. This
implementation makes the following explicit choices:

- `interrupted` is included in the global active-build uniqueness invariant.
- Plans are stored as immutable snapshots once a build references them.
- Task branches start from the current validated integration commit at dispatch.
- Ready-queue age uses persisted scheduling cycles, not wall-clock time, so
  ranking remains deterministic for identical state.
- Scheduler risk is normalized to the inclusive range 0 through 1.
- Artifact versions are exact in the MVP.
- Handoff manifests live under runtime run evidence, not in source branches.
- SSE uses durable build-event sequence numbers and honors `Last-Event-ID`.
- Repository removal is metadata-only.
- Cancellation preserves source branches, worktrees, logs, attempts, and events.
- Optional push failures are publication failures, not validation success.
- Upgrade and uninstall preserve the runtime directory.
- Validation commands are trusted repository input and run with timeout,
  cancellation, output capture, redaction, and an isolated Compose project name.

Process reattachment after a parent crash cannot recover anonymous stdout pipes.
Worker output is therefore written durably while the process is running, and
startup recovery reconciles PID identity, result commits, attempts, logs, and
worktrees before deciding whether to resume, interrupt, or pause for review.
