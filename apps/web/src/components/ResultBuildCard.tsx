import { Flash } from "@primer/react";
import useSWR from "swr";
import { apiFetch } from "../api/client.js";
import type {
  ArtifactSummary,
  BuildEvent,
  BuildMetrics,
  BuildSummary,
  TaskManifest,
} from "../api/types.js";
import { Metric } from "./Metric.js";
import { StatusBadge } from "./StatusBadge.js";

interface ResultBuildCardProps {
  build: BuildSummary;
}

export function ResultBuildCard({
  build,
}: ResultBuildCardProps): React.JSX.Element {
  const metrics = useSWR<BuildMetrics>(
    `/api/builds/${build.id}/metrics`,
    apiFetch,
  );
  const events = useSWR<BuildEvent[]>(
    `/api/builds/${build.id}/events?limit=10000`,
    apiFetch,
  );
  const artifacts = useSWR<ArtifactSummary[]>(
    `/api/builds/${build.id}/artifacts`,
    apiFetch,
  );
  const manifests = useSWR<TaskManifest[]>(
    `/api/builds/${build.id}/manifests`,
    apiFetch,
  );

  const loadFailed = [
    metrics.error,
    events.error,
    artifacts.error,
    manifests.error,
  ].some((error) => error !== undefined);
  const loading =
    metrics.isLoading ||
    events.isLoading ||
    artifacts.isLoading ||
    manifests.isLoading;
  const failedValidationEvents = (events.data ?? []).filter(
    (event) =>
      /validation/i.test(event.type) &&
      (/fail/i.test(event.type) || event.payload.status === "failed"),
  );
  const utilization =
    metrics.data?.workerUtilizationPercent ?? calculateUtilization(build);
  const pushStatus =
    build.pushStatus ??
    metrics.data?.pushStatus ??
    inferPushStatus(events.data ?? []);
  const actualElapsedSeconds =
    metrics.data?.actualElapsedSeconds ?? build.actualElapsedSeconds ?? null;

  if (loading) {
    return (
      <article className="result-card">
        <header>
          <div>
            <strong>{build.repositoryName ?? build.repositoryId}</strong>
            <span className="mono">{build.integrationBranch}</span>
            <span className="mono">{build.id}</span>
          </div>
          <StatusBadge status={build.status} />
        </header>
        <p className="panel-empty" aria-live="polite">
          Loading durable result evidence…
        </p>
      </article>
    );
  }

  return (
    <article className="result-card">
      <header>
        <div>
          <strong>{build.repositoryName ?? build.repositoryId}</strong>
          <span className="mono">{build.integrationBranch}</span>
          <span className="mono">{build.id}</span>
        </div>
        <StatusBadge status={build.status} />
      </header>

      {loadFailed ? (
        <Flash variant="warning" className="result-warning">
          Some result evidence could not be loaded. Visible values are limited
          to confirmed build data.
        </Flash>
      ) : null}

      <div className="metrics-grid metrics-grid--compact">
        <Metric
          label="Elapsed"
          value={
            actualElapsedSeconds === null
              ? "not recorded"
              : formatDuration(actualElapsedSeconds)
          }
          detail={
            build.estimates.expectedElapsedHours === null
              ? "No estimate"
              : `${build.estimates.expectedElapsedHours.toFixed(1)}h expected`
          }
        />
        <Metric
          label="Worker utilization"
          value={utilization === null ? "not recorded" : `${utilization.toFixed(1)}%`}
          detail={`${build.workerLimit} enabled slots`}
        />
        <Metric
          label="Savings"
          value={
            metrics.data?.actualSavingsPercent === null ||
            metrics.data?.actualSavingsPercent === undefined
              ? `${build.estimates.expectedSavingsPercent ?? 0}% expected`
              : `${metrics.data.actualSavingsPercent.toFixed(1)}% actual`
          }
          detail="elapsed versus sequential estimate"
        />
        <Metric
          label="Push status"
          value={pushStatus}
          detail="No push is inferred without a durable record"
        />
      </div>

      <div className="result-detail-grid">
        <section aria-labelledby={`outcomes-${build.id}`}>
          <div className="subsection-heading">
            <div>
              <h3 id={`outcomes-${build.id}`}>Task outcomes</h3>
              <p>{build.tasks?.length ?? 0} planned tasks</p>
            </div>
          </div>
          {build.tasks?.length === 0 || build.tasks === undefined ? (
            <p className="panel-empty">No task outcomes were recorded.</p>
          ) : (
            <ul className="outcome-list">
              {build.tasks.map((task) => (
                <li key={task.id}>
                  <span>
                    <span className="mono">{task.backlogTaskId}</span>
                    <strong>{task.title}</strong>
                  </span>
                  <StatusBadge status={task.state} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby={`validations-${build.id}`}>
          <div className="subsection-heading">
            <div>
              <h3 id={`validations-${build.id}`}>Failed validations</h3>
              <p>
                {metrics.data?.failedTasks ?? 0} failed tasks ·{" "}
                {metrics.data?.ownershipViolations ?? 0} ownership violations
              </p>
            </div>
          </div>
          {events.isLoading ? (
            <p className="panel-empty" aria-live="polite">
              Loading validation evidence…
            </p>
          ) : failedValidationEvents.length === 0 ? (
            <p className="panel-empty">
              No failed validation event was recorded.
            </p>
          ) : (
            <ul className="failure-list">
              {failedValidationEvents.map((event) => (
                <li key={event.sequence}>
                  <strong>{event.type}</strong>
                  <span className="mono">{event.taskId ?? "Build validation"}</span>
                  <time dateTime={event.occurredAt}>
                    {new Date(event.occurredAt).toLocaleString()}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="result-footer">
        <span>{artifacts.data?.length ?? 0} artifacts</span>
        <span>{manifests.data?.length ?? 0} manifests</span>
        <span>
          Completed{" "}
          {build.completedAt === null
            ? "without a completion timestamp"
            : new Date(build.completedAt).toLocaleString()}
        </span>
      </footer>
    </article>
  );
}

function calculateUtilization(build: BuildSummary): number | null {
  if (
    build.startedAt === null ||
    build.completedAt === null ||
    build.workerLimit === 0
  ) {
    return null;
  }
  const buildDuration =
    new Date(build.completedAt).getTime() - new Date(build.startedAt).getTime();
  if (buildDuration <= 0) {
    return null;
  }
  const workerDuration = (build.workers ?? []).reduce((total, worker) => {
    if (worker.startedAt === null || worker.startedAt === undefined) {
      return total;
    }
    const stoppedAt =
      worker.stoppedAt === null || worker.stoppedAt === undefined
        ? new Date(build.completedAt as string).getTime()
        : new Date(worker.stoppedAt).getTime();
    return total + Math.max(0, stoppedAt - new Date(worker.startedAt).getTime());
  }, 0);
  if (workerDuration === 0) {
    return null;
  }
  return Math.min(100, (workerDuration / (buildDuration * build.workerLimit)) * 100);
}

function inferPushStatus(events: BuildEvent[]): string {
  const pushEvent = events
    .slice()
    .reverse()
    .find((event) => /push/i.test(event.type));
  if (pushEvent === undefined) {
    return "not recorded";
  }
  return typeof pushEvent.payload.status === "string"
    ? pushEvent.payload.status
    : pushEvent.type.replaceAll("_", " ");
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
