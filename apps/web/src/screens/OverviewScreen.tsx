import { useEffect, useState } from "react";
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
  const activeBuilds =
    builds.data?.filter((build) =>
      ["planning", "ready", "running", "paused", "interrupted"].includes(
        build.status,
      ),
    ) ?? [];
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
  const activeBuild =
    activeBuilds.find((build) => build.id === selectedBuildId) ??
    activeBuilds[0] ??
    null;
  const stream = useBuildEvents(activeBuild?.id ?? null);
  const [controlPending, setControlPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const buildControl = getBuildControl(activeBuild?.status ?? null);

  useEffect(() => {
    if (
      activeBuilds.length > 0 &&
      !activeBuilds.some((build) => build.id === selectedBuildId)
    ) {
      setSelectedBuildId(activeBuilds[0]?.id ?? null);
    }
  }, [activeBuilds, selectedBuildId]);

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
          label="Active builds"
          value={
            builds.data === undefined ? "checking" : String(activeBuilds.length)
          }
          detail={
            activeBuilds.length === 0
              ? "none"
              : `${activeBuilds.filter((build) => build.status === "running").length} running`
          }
        />
        <Metric
          label="Worker budget"
          value={
            health.data === undefined
              ? "checking"
              : `${health.data.resources.busyWorkers}/${health.data.resources.workerCapacity}`
          }
          detail={
            health.data === undefined
              ? "installation capacity"
              : `${health.data.resources.availableWorkers} available · ${stream.connected ? "events live" : "events idle"}`
          }
        />
      </section>

      <section className="runner-summary" aria-labelledby="runner-summary-title">
        <div>
          <span id="runner-summary-title">Execution fabric</span>
          <strong>
            {health.data?.agentProviders.default ?? "checking provider"}
          </strong>
        </div>
        <dl>
          <div>
            <dt>Remote machines</dt>
            <dd>
              {health.data === undefined
                ? "checking"
                : `${health.data.runners.online}/${health.data.runners.total} online`}
            </dd>
          </div>
          <div>
            <dt>Remote capacity</dt>
            <dd>
              {health.data === undefined
                ? "checking"
                : `${health.data.runners.availableSlots} slots available`}
            </dd>
          </div>
          <div>
            <dt>Remote queue</dt>
            <dd>
              {health.data === undefined
                ? "checking"
                : `${health.data.remoteJobs.queued} queued · ${health.data.remoteJobs.leased} leased · ${health.data.retries.pending} retrying`}
            </dd>
          </div>
        </dl>
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
        <>
          <section
            className="active-build-rail"
            aria-labelledby="active-build-rail-title"
          >
            <header>
              <h2 id="active-build-rail-title">Repository builds</h2>
              <span>{activeBuilds.length} active</span>
            </header>
            <div>
              {activeBuilds.map((build) => (
                <button
                  type="button"
                  className={
                    build.id === activeBuild.id
                      ? "active-build-choice is-selected"
                      : "active-build-choice"
                  }
                  aria-pressed={build.id === activeBuild.id}
                  key={build.id}
                  onClick={() => {
                    setSelectedBuildId(build.id);
                  }}
                >
                  <span>
                    <strong>{build.repositoryName ?? build.repositoryId}</strong>
                    <code>{build.integrationBranch}</code>
                  </span>
                  <StatusBadge status={build.status} />
                </button>
              ))}
            </div>
          </section>
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
        </>
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
