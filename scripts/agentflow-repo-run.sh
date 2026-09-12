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
  source-repository  current working directory
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

source_repository=$PWD
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
    [[ $(git -C "$target_repository" rev-parse --path-format=absolute --git-common-dir) == $(git -C "$source_repository" rev-parse --path-format=absolute --git-common-dir) ]] ||
      die "existing checkout belongs to another repository: $target_repository"
    [[ $(git -C "$target_repository" rev-parse HEAD) == "$source_head" ]] ||
      die "existing checkout is at a different commit; choose a new --worktree path"
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

if [[ ! -f "$target_repository/.agentflow.yaml" ]]; then
  agentflow setup "$target_repository" --prepare
  exit 0
fi

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


if [[ -n $backlog_objective || $backlog_auto == true ]]; then
  generation_args=(backlog generate "$repository_id")
  if [[ $backlog_auto == true ]]; then
    generation_args+=(--auto)
  else
    generation_args+=(--objective "$backlog_objective")
  fi
  if [[ -n $backlog_path ]]; then
    generation_args+=(--backlog "$backlog_path")
  fi
  agentflow "${generation_args[@]}"
  exit 0
fi

if [[ -n $backlog_path ]]; then
  [[ $backlog_path != /* && "/$backlog_path/" != */../* && $backlog_path != .git && $backlog_path != .git/* ]] || die "--backlog must stay inside the repository and outside .git"
  [[ -f "$target_repository/$backlog_path" ]] ||
    die "backlog does not exist in target checkout: $backlog_path"
fi

[[ -z $(git -C "$target_repository" status --porcelain) ]] ||
  die "AgentFlow target must be clean: $target_repository"

info "AgentFlow target: $target_repository"


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
