#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  agentflow-repo-run.sh [options] [source-repository]

Prepare a clean repository checkout, register it with AgentFlow, create an
immutable backlog plan, and optionally start the build.

Options:
  --worktree PATH   Clean sibling checkout to create or reuse when source is dirty
  --branch NAME     Branch for a newly created sibling checkout
  --backlog PATH    Repository-relative backlog path (default: config value)
  --generate-backlog OBJECTIVE
                    Ask Codex to create the backlog, then stop for review
  --generate-backlog-auto
                    Let Codex choose an evidence-backed program from the repo
  --run             Start the build after creating the plan
  --help            Show this help

Defaults:
  source-repository  /home/administrator/SportPilot
  worktree           <source-repository>-AgentFlow

Examples:
  ./scripts/agentflow-repo-run.sh
  ./scripts/agentflow-repo-run.sh --run
  ./scripts/agentflow-repo-run.sh --generate-backlog "Build athlete reporting"
  ./scripts/agentflow-repo-run.sh --generate-backlog-auto
  ./scripts/agentflow-repo-run.sh --backlog docs/implementation/BACKLOG.md --run
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '==> %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

json_id() {
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (!value || typeof value.id !== "string") {
        process.exit(2);
      }
      process.stdout.write(value.id);
    });
  '
}

registered_repository_id() {
  local repository_path=$1
  node -e '
    let input = "";
    const expectedPath = process.argv[1];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const repositories = JSON.parse(input);
      const match = repositories.find(
        (repository) => repository.localPath === expectedPath,
      );
      if (match) {
        process.stdout.write(match.id);
      }
    });
  ' "$repository_path"
}

source_repository=/home/administrator/SportPilot
clean_worktree=
worktree_branch=
backlog_path=
backlog_objective=
backlog_auto=false
start_build=false

while (($# > 0)); do
  case "$1" in
    --worktree)
      (($# >= 2)) || die "--worktree requires a path"
      clean_worktree=$2
      shift 2
      ;;
    --branch)
      (($# >= 2)) || die "--branch requires a name"
      worktree_branch=$2
      shift 2
      ;;
    --backlog)
      (($# >= 2)) || die "--backlog requires a repository-relative path"
      backlog_path=$2
      shift 2
      ;;
    --generate-backlog)
      (($# >= 2)) || die "--generate-backlog requires an objective"
      [[ $backlog_auto == false ]] ||
        die "--generate-backlog cannot be combined with --generate-backlog-auto"
      backlog_objective=$2
      shift 2
      ;;
    --generate-backlog-auto)
      [[ -z $backlog_objective ]] ||
        die "--generate-backlog-auto cannot be combined with --generate-backlog"
      backlog_auto=true
      shift
      ;;
    --run)
      start_build=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      source_repository=$1
      shift
      (($# == 0)) || die "only one source repository may be supplied"
      ;;
  esac
done

require_command agentflow
require_command git
require_command node

if [[ -n $backlog_objective || $backlog_auto == true ]]; then
  require_command codex
  [[ $start_build == false ]] ||
    die "backlog generation and --run cannot be combined; review and commit first"
fi

source_repository=$(git -C "$source_repository" rev-parse --show-toplevel 2>/dev/null) ||
  die "not a Git repository: $source_repository"
clean_worktree=${clean_worktree:-"${source_repository}-AgentFlow"}

source_head=$(git -C "$source_repository" rev-parse HEAD)
target_repository=$source_repository

if [[ -n $(git -C "$source_repository" status --porcelain) ]]; then
  info "Source checkout is dirty; using isolated checkout $clean_worktree"

  if git -C "$clean_worktree" rev-parse --show-toplevel >/dev/null 2>&1; then
    target_repository=$(git -C "$clean_worktree" rev-parse --show-toplevel)
    [[ -z $(git -C "$target_repository" status --porcelain) ]] ||
      die "existing AgentFlow checkout is also dirty: $target_repository"
  else
    [[ ! -e $clean_worktree ]] ||
      die "worktree path exists but is not a Git checkout: $clean_worktree"

    if [[ -z $worktree_branch ]]; then
      worktree_branch="agentflow/$(basename "$source_repository" | tr '[:upper:]' '[:lower:]')-$(date -u +%Y%m%dT%H%M%SZ)"
    fi

    git -C "$source_repository" show-ref --verify --quiet "refs/heads/$worktree_branch" &&
      die "branch already exists: $worktree_branch"

    git -C "$source_repository" worktree add -b "$worktree_branch" "$clean_worktree" "$source_head"
    target_repository=$(git -C "$clean_worktree" rev-parse --show-toplevel)
  fi
fi

[[ -f "$target_repository/.agentflow.yaml" ]] ||
  die "missing $target_repository/.agentflow.yaml"

if [[ -n $backlog_objective || $backlog_auto == true ]]; then
  backlog_path=${backlog_path:-BACKLOG.md}
  [[ $backlog_path != /* ]] || die "--backlog must be repository-relative"

  if [[ $backlog_auto == true ]]; then
    objective_instructions="Choose the highest-value next program using repository evidence. Inspect product documentation, architecture, existing backlogs and work queues, tests, TODOs, incomplete flows, and recent Git history. Consider at least three candidates internally, then select one based on user impact, explicit repository intent, dependency-unblocking value, implementation readiness, and risk. Do not assume market demand, invent a new product direction, repeat completed work, or prioritize cosmetic cleanup over documented capability gaps. In your final summary, name the selected program, the alternatives considered, and the repository evidence supporting the choice."
  else
    objective_instructions="Objective: $backlog_objective"
  fi

  printf -v backlog_prompt '%s\n' \
    "Create or replace $backlog_path for AgentFlow." \
    "" \
    "$objective_instructions" \
    "" \
    "Inspect this repository before designing the work. Edit only $backlog_path." \
    "Do not implement tasks, change source code, commit, push, or start AgentFlow." \
    "" \
    "Use AgentFlow's exact Markdown grammar for every task:" \
    "" \
    "## TASK-ID - Imperative task title" \
    "" \
    '```yaml' \
    "estimate_hours: 4" \
    "depends_on: []" \
    "owns:" \
    "  - exact/repository/path/" \
    "validate:" \
    "  - repository validation command" \
    "produces:" \
    "  - name: artifact-name" \
    "    type: artifact-type" \
    "    version: 1.0.0" \
    "    path: optional/exact/path" \
    "consumes:" \
    "  - task: UPSTREAM-TASK-ID" \
    "    artifact: artifact-name" \
    "    version: 1.0.0" \
    '```' \
    "" \
    "Write a concrete task description." \
    "" \
    "### Acceptance Criteria" \
    "" \
    "- Add measurable completion criteria." \
    "" \
    "Rules:" \
    "- depends_on must name only task IDs present in this backlog." \
    "- Keep the graph acyclic and expose safe parallel work." \
    "- Assign non-overlapping owns paths to parallel tasks." \
    "- Contract/schema tasks must precede their providers and consumers." \
    "- Every consumed artifact must match an upstream produced artifact and version." \
    "- Use commands that actually exist in this repository." \
    "- Include all keys required by the grammar; omit produces or consumes only when unused." \
    "- Prefer small, independently verifiable tasks with explicit acceptance criteria." \
    "- Return a short summary after writing the file."

  if [[ $backlog_auto == true ]]; then
    info "Asking Codex to discover and backlog the highest-value repository-grounded program"
  else
    info "Asking Codex to generate $backlog_path"
  fi
  codex exec \
    --cd "$target_repository" \
    --sandbox workspace-write \
    "$backlog_prompt"

  [[ -f "$target_repository/$backlog_path" ]] ||
    die "Codex completed without creating $backlog_path"
  git -C "$target_repository" diff --check -- "$backlog_path"

  printf '\nBacklog generated at %s\n' "$target_repository/$backlog_path"
  printf 'Review it, commit it, then rerun this script without --generate-backlog.\n\n'
  git -C "$target_repository" status --short -- "$backlog_path"
  exit 0
fi

if [[ -n $backlog_path ]]; then
  [[ $backlog_path != /* ]] || die "--backlog must be repository-relative"
  [[ -f "$target_repository/$backlog_path" ]] ||
    die "backlog does not exist in target checkout: $backlog_path"
fi

[[ -z $(git -C "$target_repository" status --porcelain) ]] ||
  die "AgentFlow target must be clean: $target_repository"

info "AgentFlow target: $target_repository"

repository_list=$(agentflow repo list)
repository_id=$(printf '%s' "$repository_list" | registered_repository_id "$target_repository")

if [[ -z $repository_id ]]; then
  info "Registering target repository"
  registration=$(agentflow repo add --no-init "$target_repository")
  repository_id=$(printf '%s' "$registration" | json_id) ||
    die "AgentFlow registration did not return a repository ID"
else
  info "Using existing registration: $repository_id"
  agentflow repo inspect "$repository_id" >/dev/null
fi

info "Creating immutable plan"
if [[ -n $backlog_path ]]; then
  plan_json=$(agentflow plan "$repository_id" --backlog "$backlog_path")
else
  plan_json=$(agentflow plan "$repository_id")
fi
plan_id=$(printf '%s' "$plan_json" | json_id) ||
  die "AgentFlow plan did not return a plan ID"

printf 'Repository ID: %s\n' "$repository_id"
printf 'Plan ID:       %s\n' "$plan_id"

if [[ $start_build == true ]]; then
  info "Starting build"
  agentflow run "$plan_id"
  info "Current AgentFlow status"
  agentflow status
else
  printf '\nPlan created but not started. Review it, then run:\n'
  printf '  agentflow run %q\n' "$plan_id"
fi
