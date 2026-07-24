import { Button, Flash, SkeletonBox } from "@primer/react";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type {
  BuildSummary,
  HealthResponse,
  RepositorySummary,
} from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { Metric } from "../components/Metric.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { useBuildEvents } from "../hooks/use-build-events.js";

interface OverviewScreenProps {
  onNavigateRepositories: () => void;
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

  async function toggleBuild(): Promise<void> {
    if (activeBuild === null) {
      return;
    }
    const action = activeBuild.status === "paused" ? "resume" : "pause";
    await postJson(`/api/builds/${activeBuild.id}/${action}`);
    await builds.mutate();
  }

  if (health.error !== undefined || builds.error !== undefined) {
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
          activeBuild === null ? null : (
            <Button
              leadingVisual={
                activeBuild.status === "paused" ? PlayIcon : PauseIcon
              }
              onClick={() => void toggleBuild()}
            >
              {activeBuild.status === "paused" ? "Resume" : "Pause"}
            </Button>
          )
        }
      />

      <section className="metrics-grid" aria-label="System summary">
        <Metric
          label="System"
          value={health.data?.status ?? "checking"}
          detail={health.data?.database.journalMode ?? "SQLite"}
        />
        <Metric
          label="Repositories"
          value={String(repositories.data?.length ?? 0)}
          detail="registered locally"
        />
        <Metric
          label="Active build"
          value={activeBuild?.status ?? "none"}
          detail={activeBuild?.integrationBranch ?? "one build maximum"}
        />
        <Metric
          label="Event stream"
          value={stream.connected ? "live" : "idle"}
          detail={`${stream.events.length} recent events`}
        />
      </section>

      {builds.isLoading ? (
        <SkeletonBox height="240px" width="100%" />
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
