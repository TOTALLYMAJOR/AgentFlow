# AgentFlow repository examples

The example files are starting points, not commands to run unchanged.

1. Use a clean, committed, disposable Git repository first.
2. Copy `.agentflow.yaml` and `BACKLOG.md` to its root.
3. Replace the repository name, base branch, ownership roots, validation
   commands, artifacts, and acceptance criteria.
4. Review every command because validation executes as your Linux user.
5. Commit both files before creating an immutable plan.

```bash
cp /path/to/agentflow/examples/.agentflow.yaml /path/to/repository/
cp /path/to/agentflow/examples/BACKLOG.md /path/to/repository/
git -C /path/to/repository add .agentflow.yaml BACKLOG.md
git -C /path/to/repository commit -m "plan: configure AgentFlow"
```

Then:

```bash
agentflow repo add /path/to/repository
agentflow plan <repository-id>
agentflow run <plan-id>
agentflow status
```

The example backlog demonstrates:

- Two outcome-oriented epics
- Cross-epic dependencies
- Exact produced and consumed artifact versions
- Separate provider and consumer ownership
- A proposed architecture decision
- Integration acceptance criteria

Organization policy can reject an otherwise valid example. Adjust the repository
configuration to satisfy the installation policy; do not weaken policy silently.
