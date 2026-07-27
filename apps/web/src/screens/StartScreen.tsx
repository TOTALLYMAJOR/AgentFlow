import { useState } from "react";
import {
  Button,
  Flash,
  FormControl,
  Select,
  Textarea,
  TextInput,
} from "@primer/react";
import {
  ArrowRightIcon,
  BugIcon,
  FolderOpenIcon,
  MagicWandIcon,
  PlusIcon,
  ShieldCheckIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type {
  BuildSummary,
  HealthResponse,
  RepositorySummary,
} from "../api/types.js";
import { LoadingState } from "../components/LoadingState.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface StartScreenProps {
  onStartGoal: (draft: { repositoryId: string; objective: string }) => void;
  onOpenActivity: () => void;
}

const goalStarters = [
  {
    label: "Add a feature",
    description: "Turn a product idea into reviewed, tested work.",
    prompt: "Add a new feature that improves the core customer experience.",
    icon: SparkleIcon,
  },
  {
    label: "Fix a problem",
    description: "Find the cause, repair it, and prove the fix.",
    prompt: "Find and fix the most important user-facing problem in this project.",
    icon: BugIcon,
  },
  {
    label: "Improve the experience",
    description: "Make an existing workflow clearer and easier to use.",
    prompt: "Improve the usability of the most important customer workflow.",
    icon: MagicWandIcon,
  },
  {
    label: "Prepare for launch",
    description: "Close the highest-risk readiness gaps first.",
    prompt: "Prepare this project for a safe launch and report any remaining blockers.",
    icon: ShieldCheckIcon,
  },
] as const;

export function StartScreen({
  onStartGoal,
  onOpenActivity,
}: StartScreenProps): React.JSX.Element {
  const health = useSWR<HealthResponse>("/api/health", apiFetch, {
    refreshInterval: 5_000,
  });
  const repositories = useSWR<RepositorySummary[]>(
    "/api/repositories",
    apiFetch,
  );
  const builds = useSWR<BuildSummary[]>("/api/builds", apiFetch, {
    refreshInterval: 3_000,
  });
  const [repositoryId, setRepositoryId] = useState("");
  const [objective, setObjective] = useState("");
  const [showConnection, setShowConnection] = useState(false);
  const [path, setPath] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const activeBuilds =
    builds.data?.filter((build) =>
      ["planning", "ready", "running", "paused", "interrupted"].includes(
        build.status,
      ),
    ) ?? [];
  const activeBuild = activeBuilds[0] ?? null;

  async function connectProject(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setConnecting(true);
    setConnectionError(null);
    try {
      const created = await postJson<RepositorySummary>("/api/repositories", {
        path: path.trim(),
      });
      await repositories.mutate();
      setRepositoryId(created.id);
      setPath("");
      setShowConnection(false);
    } catch (cause) {
      setConnectionError(
        cause instanceof Error
          ? cause.message
          : "AgentFlow could not connect this project.",
      );
    } finally {
      setConnecting(false);
    }
  }

  if (health.error !== undefined || repositories.error !== undefined) {
    return (
      <Flash variant="danger">
        AgentFlow could not load your projects. No work has been started.
      </Flash>
    );
  }

  if (health.isLoading || repositories.isLoading) {
    return <LoadingState label="Preparing your workspace" height="420px" />;
  }

  return (
    <div className="start-screen">
      <header className="start-hero">
        <div>
          <span className="start-hero__label">AgentFlow</span>
          <h1>What would you like to improve?</h1>
          <p>
            Describe the outcome. AgentFlow will inspect the project, propose a
            safe plan, and wait for your approval before changing code.
          </p>
        </div>
        <div className="start-hero__trust">
          <ShieldCheckIcon size={24} aria-hidden="true" />
          <div>
            <strong>Your project stays under your control</strong>
            <span>Local only. Reviewed plan. Validated changes.</span>
          </div>
        </div>
      </header>

      {activeBuild === null ? null : (
        <button
          type="button"
          className="current-work-callout"
          onClick={onOpenActivity}
        >
          <span>
            <StatusBadge status={activeBuild.status} />
            <span>
              <strong>
                {activeBuild.repositoryName ?? "Project work"} is{" "}
                {plainStatus(activeBuild.status)}
              </strong>
              <small>Open activity to see what is happening and what comes next.</small>
            </span>
          </span>
          <ArrowRightIcon size={20} aria-hidden="true" />
        </button>
      )}

      <section className="goal-composer" aria-labelledby="goal-composer-title">
        <div className="goal-composer__intro">
          <h2 id="goal-composer-title">Start new work</h2>
          <p>Choose a starting point or write the outcome in your own words.</p>
        </div>

        <div className="goal-starters">
          {goalStarters.map((starter) => {
            const StarterIcon = starter.icon;
            return (
              <button
                type="button"
                key={starter.label}
                className="goal-starter"
                onClick={() => {
                  setObjective(starter.prompt);
                }}
              >
                <StarterIcon size={22} aria-hidden="true" />
                <span>
                  <strong>{starter.label}</strong>
                  <small>{starter.description}</small>
                </span>
              </button>
            );
          })}
        </div>

        <div className="goal-composer__form">
          <FormControl required>
            <FormControl.Label>Project</FormControl.Label>
            <Select
              block
              value={repositoryId}
              onChange={(event) => {
                setRepositoryId(event.target.value);
              }}
            >
              <Select.Option value="">Choose a project</Select.Option>
              {repositories.data?.map((repository) => (
                <Select.Option key={repository.id} value={repository.id}>
                  {repository.name}
                </Select.Option>
              ))}
            </Select>
          </FormControl>
          <FormControl required>
            <FormControl.Label>Desired outcome</FormControl.Label>
            <Textarea
              block
              rows={5}
              value={objective}
              placeholder="Example: Make onboarding easier for first-time customers and verify it on mobile."
              onChange={(event) => {
                setObjective(event.target.value);
              }}
            />
            <FormControl.Caption>
              Focus on what should be better for the user. Technical details are
              optional.
            </FormControl.Caption>
          </FormControl>
          <div className="goal-composer__actions">
            <Button
              variant="primary"
              trailingVisual={ArrowRightIcon}
              disabled={
                repositoryId.length === 0 || objective.trim().length < 10
              }
              onClick={() => {
                onStartGoal({
                  repositoryId,
                  objective: objective.trim(),
                });
              }}
            >
              Review a proposed plan
            </Button>
            <Button
              leadingVisual={showConnection ? FolderOpenIcon : PlusIcon}
              onClick={() => {
                setShowConnection((current) => !current);
                setConnectionError(null);
              }}
            >
              {showConnection ? "Close project setup" : "Connect another project"}
            </Button>
          </div>
        </div>
      </section>

      {showConnection ? (
        <section
          className="connection-wizard"
          aria-labelledby="connection-wizard-title"
        >
          <div className="connection-wizard__heading">
            <span>1</span>
            <div>
              <h2 id="connection-wizard-title">Connect a local project</h2>
              <p>
                Choose the project folder. AgentFlow will confirm that it is
                ready without changing its source.
              </p>
            </div>
          </div>
          <form onSubmit={(event) => void connectProject(event)}>
            <FormControl required>
              <FormControl.Label>Project folder</FormControl.Label>
              <TextInput
                block
                leadingVisual={FolderOpenIcon}
                value={path}
                placeholder="/home/you/projects/my-app"
                onChange={(event) => {
                  setPath(event.target.value);
                }}
              />
              <FormControl.Caption>
                The folder must be a Git project with an AgentFlow configuration.
              </FormControl.Caption>
            </FormControl>
            <Button
              type="submit"
              variant="primary"
              disabled={connecting || path.trim().length === 0}
            >
              {connecting ? "Checking project..." : "Check and connect"}
            </Button>
          </form>
          {connectionError === null ? null : (
            <Flash variant="danger" role="alert">
              <strong>Project not connected</strong>
              <br />
              {connectionError}
            </Flash>
          )}
        </section>
      ) : null}

      <footer className="workspace-summary">
        <span>
          <strong>{repositories.data?.length ?? 0}</strong> connected projects
        </span>
        <span>
          <strong>{activeBuilds.length}</strong> active work items
        </span>
        <span>
          <strong>{health.data?.resources.availableWorkers ?? 0}</strong> AI
          agents available
        </span>
      </footer>
    </div>
  );
}

function plainStatus(status: string): string {
  const labels: Record<string, string> = {
    planning: "being planned",
    ready: "ready to start",
    running: "in progress",
    paused: "paused",
    interrupted: "waiting to resume",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}
