# ADR-0010: Persisted codebase knowledge graph

## Status

Accepted

## Context

Path ownership identifies who may edit a file but does not reveal which
consumers can break when that file changes. Impact analysis must be grounded in
the exact repository commit and must not scan ignored dependencies, generated
vendor trees, or arbitrary files outside Git authority.

## Decision

AgentFlow indexes tracked source, test, configuration, and Markdown files from
`git ls-files` at a recorded commit. Nodes store normalized paths, kind, and
SHA-256 digest. Resolved relative ES module, dynamic import, export-from, and
CommonJS dependencies become directed import edges.

Every scan creates an immutable SQLite snapshot. Impact analysis walks reverse
edges from changed files or directories, records dependency distance and root
causes, then maps impacted files to ownership declarations in active builds.

Scans are bounded by file count and individual file size. Unresolved package
imports remain outside the graph rather than being guessed.

## Consequences

- Blast radius is reproducible against an exact commit.
- Active task collisions can be identified beyond direct path overlap.
- The graph remains explainable and repository-local.
- Language-specific semantic analyzers can add edge types later without
  invalidating existing snapshots.
