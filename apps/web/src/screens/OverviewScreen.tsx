import { useState } from "react";
import { Button, Flash } from "@primer/react";
import {
  ArrowClockwiseIcon,
  PauseIcon,
  PlayIcon,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type {
  BuildSummary,
  HealthResponse,
  RepositorySummary,
} from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { Metric } from "../components/Metric.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { useBuildEvents } from "../hooks/use-build-events.js";

interface OverviewScreenProps {
  onNavigateRepositories: () => void;
}

type OverviewBuildAction = "start" | "pause" | "resume";

interface OverviewBuildControl {
  action: OverviewBuildAction;
  label: string;
  pendingLabel: string;
  icon: Icon;
}

export function OverviewScreen({
  onNavigateRepositories,
}: OverviewScreenProps): React.JSX.Element {
  const health = useSWR<HealthResponse>("/api/health", apiFetch, {
    refreshInterval: 5_000,
  });
  const repositories = useSWR<RepositorySummary[]>(
    "/api/repositories",
    apiFetch,
  );
  const builds = useSWR<BuildSummary[]>("/api/builds", apiFetch, {
    refreshInterval: 2_000,
  });
  const activeBuild =
    builds.data?.find((build) =>
      ["planning", "ready", "running", "paused", "interrupted"].includes(
        build.status,
      ),
    ) ?? null;
  const stream = useBuildEvents(activeBuild?.id ?? null);
  const [controlPending, setControlPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const buildControl = getBuildControl(activeBuild?.status ?? null);

  async function controlBuild(action: OverviewBuildAction): Promise<void> {
    if (activeBuild === null) {
      return;
    }
    setControlPending(true);
    setControlError(null);
    try {
      await postJson(`/api/builds/${activeBuild.id}/${action}`);
      await builds.mutate();
    } catch (cause) {
      setControlError(
        cause instanceof Error
          ? cause.message
          : `The ${action} action could not be confirmed.`,
      );
    } finally {
      setControlPending(false);
    }
  }

  if (
    health.error !== undefined ||
    builds.error !== undefined ||
    repositories.error !== undefined
  ) {
    return (
      <Flash variant="danger">
        AgentFlow could not load local system state. The API remains the source
        of truth; no build action was assumed successful.
      </Flash>
    );
  }

  return (
    <>
      <PageTitle
        title="Engineering control plane"
        description="Plan dependency-aware work, supervise isolated agents, and integrate only validated changes."
        actions={
          activeBuild === null || buildControl === null ? null : (
            <Button
              leadingVisual={buildControl.icon}
              disabled={controlPending}
              onClick={() => {
                void controlBuild(buildControl.action);
              }}
            >
              {controlPending ? buildControl.pendingLabel : buildControl.label}
            </Button>
          )
        }
      />

      {controlError === null ? null : (
        <Flash variant="danger" className="spaced-flash" role="alert">
          {controlError}
        </Flash>
      )}

      <section className="metrics-grid" aria-label="System summary">
        <Metric
          label="System"
          value={health.data?.status ?? "checking"}
          detail={health.data?.database.journalMode ?? "SQLite"}
        />
        <Metric
          label="Repositories"
          value={
            repositories.data === undefined
              ? "checking"
              : String(repositories.data.length)
          }
          detail="registered locally"
        />
        <Metric
          label="Active build"
          value={
            builds.data === undefined ? "checking" : (activeBuild?.status ?? "none")
          }
          detail={activeBuild?.integrationBranch ?? "one build maximum"}
        />
        <Metric
          label="Event stream"
          value={
            builds.data === undefined
              ? "checking"
              : stream.connected
                ? "live"
                : "idle"
          }
          detail={`${stream.events.length} recent events`}
        />
      </section>

      {builds.isLoading || health.isLoading || repositories.isLoading ? (
        <LoadingState label="Loading system overview" height="240px" />
      ) : activeBuild === null ? (
        <EmptyState
          title="No build is active"
          description="Register a source repository, validate its backlog, and review the plan before starting workers."
          actionLabel="Register repository"
          onAction={onNavigateRepositories}
        />
      ) : (
        <section className="build-board" aria-labelledby="active-build-title">
          <header className="section-heading">
            <div>
              <h2 id="active-build-title">{activeBuild.repositoryName}</h2>
              <span className="mono">{activeBuild.integrationBranch}</span>
            </div>
            <StatusBadge status={activeBuild.status} />
          </header>
          <div className="worker-grid">
            {Array.from({ length: activeBuild.workerLimit }, (_, index) => {
              const worker = activeBuild.workers?.find(
                (candidate) => candidate.slot === index + 1,
              );
              return (
                <article className="worker-slot" key={index}>
                  <span>Worker {index + 1}</span>
                  <strong>{worker?.taskId ?? "Available"}</strong>
                  <StatusBadge status={worker?.status ?? "idle"} />
                </article>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

function getBuildControl(status: string | null): OverviewBuildControl | null {
  switch (status) {
    case "ready":
      return {
        action: "start",
        label: "Start",
        pendingLabel: "Starting…",
        icon: PlayIcon,
      };
    case "running":
      return {
        action: "pause",
        label: "Pause",
        pendingLabel: "Pausing…",
        icon: PauseIcon,
      };
    case "paused":
    case "interrupted":
      return {
        action: "resume",
        label: "Resume",
        pendingLabel: "Resuming…",
        icon: ArrowClockwiseIcon,
      };
    default:
      return null;
  }
}
