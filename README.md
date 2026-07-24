# AgentFlow

AgentFlow is a local-first engineering control plane for planning and running
dependency-aware Codex work across registered Git repositories. It keeps
operational state outside source repositories, binds to loopback, isolates
tasks in Git worktrees, validates ownership and repository commands, and
serializes integration into one build branch.

The architecture specification and the complete implementation prompt suite
are installed under `docs/` so the product contract remains available offline.

## Requirements

- Ubuntu-compatible Linux
- Node.js 22.12 or newer (Node.js 24 LTS is recommended)
- npm
- Git
- Codex CLI for real worker execution
- Docker Compose only when a repository enables Docker validation
- systemd user services only when service installation is requested

AgentFlow does not require a hosted service or application authentication. It
must remain bound to `127.0.0.1`.

## Install from a release tarball

```bash
sha256sum --check SHA256SUMS
npm install --global ./agentflow-0.3.0.tgz
agentflow doctor
agentflow serve
```

Open `http://127.0.0.1:4782`.

Runtime state is written to `$AGENTFLOW_HOME` when it is set. The default is
`~/.agentflow`.

The package installs the built dashboard, exported SQL migrations, examples,
the supplied architecture specification, and the complete supplied
implementation prompt suite. No external download is required to read those
contracts after installation.

## Develop from source

```bash
npm install
npm run dev
```

The API listens at `http://127.0.0.1:4782`. Vite listens at
`http://127.0.0.1:5173` and proxies `/api`.

Verified quality commands:

```bash
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm start
```

Create the deterministic npm tarball, source ZIP, release manifest, and SHA-256
checksums from a clean Git tree:

```bash
npm run pack:release
```

Verify a tarball through a clean isolated npm prefix without changing the
machine-wide installation:

```bash
npm run smoke:install -- ./release/agentflow-0.3.0.tgz
```

## First repository

```bash
agentflow repo init /absolute/path/to/repository
agentflow repo add /absolute/path/to/repository
agentflow repo list
agentflow plan <repository-id>
agentflow run <plan-id>
agentflow status
```

`repo init` creates `.agentflow.yaml` only when it is missing. `repo remove`
deletes registry metadata only. AgentFlow never deletes a registered source
repository.

Managed worktrees can be reconciled or explicitly cleaned without deleting
their branches:

```bash
agentflow worktrees list <build-id>
agentflow worktrees clean <build-id>
```

Cleaning an active build or a dirty managed worktree requires `--force`.

See:

- `docs/INSTALLATION.md`
- `docs/TROUBLESHOOTING.md`
- `docs/SECURITY.md`
- `docs/architecture/SPEC-1-AgentFlow-Local-Agentic-Engineering-Platform.md`
- `docs/implementation/AgentFlow-Codex-Implementation-Prompts.md`
- `examples/.agentflow.yaml`
- `examples/BACKLOG.md`

## Trust boundary

Repository validation commands are executable code supplied by a registered
repository. Review `.agentflow.yaml` and `BACKLOG.md` before starting a build.
Coding workers do not receive authority to commit, push, merge, create
worktrees, mutate AgentFlow state, or control Docker. AgentFlow performs those
operations only after the relevant validation gates pass.
