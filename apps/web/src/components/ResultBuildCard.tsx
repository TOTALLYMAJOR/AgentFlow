import { Flash } from "@primer/react";
import {
  CheckCircleIcon,
  ImageSquareIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
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
  const failedTaskCount = metrics.data?.failedTasks ?? 0;
  const hasRecordedFailures = failedValidationEvents.length > 0 || failedTaskCount > 0;
  const qualityEvidenceAvailable = metrics.error === undefined && events.error === undefined;
  const integrationCount = metrics.data?.integratedTasks ??
    (build.tasks === undefined ? null : build.tasks.filter((task) => task.state === "integrated").length);
  const qualitySummary = failedValidationEvents.length > 0
    ? `${failedValidationEvents.length} failed validation events recorded`
    : failedTaskCount > 0
      ? `${failedTaskCount} failed tasks recorded`
      : qualityEvidenceAvailable
        ? "No failures recorded; review checks"
        : "Quality outcome unknown";
  const utilization =
    metrics.data?.workerUtilizationPercent ?? calculateUtilization(build);
  const pushStatus =
    build.pushStatus ??
    metrics.data?.pushStatus ??
    inferPushStatus(events.data ?? []);
  const actualElapsedSeconds =
    metrics.data?.actualElapsedSeconds ?? build.actualElapsedSeconds ?? null;
  const visualEvidence = (artifacts.data ?? []).filter((artifact) =>
    /image|screenshot|visual|png/i.test(
      `${artifact.name} ${artifact.artifactType} ${artifact.repositoryPath ?? ""}`,
    ),
  );

  if (loading) {
    return (
      <article className="result-card">
        <header>
          <div>
            <strong>{build.repositoryName ?? build.repositoryId}</strong>
            <span>
              {build.completedAt === null
                ? "Completion time not recorded"
                : new Date(build.completedAt).toLocaleString()}
            </span>
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
          <span>
            {build.completedAt === null
              ? "Completion time not recorded"
              : new Date(build.completedAt).toLocaleString()}
          </span>
        </div>
        <StatusBadge status={build.status} />
      </header>

      {loadFailed ? (
        <Flash variant="warning" className="result-warning">
          Some result evidence could not be loaded. Visible values are limited
          to confirmed build data.
        </Flash>
      ) : null}

      <section className="completed-report-summary">
        <div className="completed-report-summary__lead">
          {build.status === "completed" ? (
            <CheckCircleIcon size={34} aria-hidden="true" />
          ) : (
            <WarningCircleIcon size={34} aria-hidden="true" />
          )}
          <div>
            <span>
              {build.status === "completed"
                ? "Local build completed"
                : "Work stopped before completion"}
            </span>
            <h2>
              {integrationCount === null
                ? "Integration evidence is unavailable"
                : `${integrationCount} planned step${integrationCount === 1 ? "" : "s"} integrated locally`}
            </h2>
            <p>{resultRecommendation(build, hasRecordedFailures, qualityEvidenceAvailable)}</p>
          </div>
        </div>
        <dl>
          <div>
            <dt>Quality checks</dt>
            <dd>
              {qualitySummary}
            </dd>
          </div>
          <div>
            <dt>Publication</dt>
            <dd>{plainPushStatus(pushStatus)}</dd>
          </div>
          <div>
            <dt>Deployment</dt>
            <dd>Separate deployment evidence required</dd>
          </div>
          <div>
            <dt>External operation</dt>
            <dd>Separate operation evidence required</dd>
          </div>
          <div>
            <dt>Evidence</dt>
            <dd>
              {artifacts.error !== undefined || manifests.error !== undefined
                ? "Record count unavailable"
                : `${(artifacts.data?.length ?? 0) + (manifests.data?.length ?? 0)} confirmed records`}
            </dd>
          </div>
        </dl>
      </section>

      <details className="completed-technical-details">
        <summary>View task and validation details</summary>
        <div className="completed-technical-details__content">
      <div className="result-technical-identity">
        <code>{build.integrationBranch}</code>
        <code>{build.id}</code>
      </div>
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
              ? build.estimates.expectedSavingsPercent === null
                ? "not recorded"
                : `${build.estimates.expectedSavingsPercent}% expected`
              : `${metrics.data.actualSavingsPercent.toFixed(1)}% actual`
          }
          detail="elapsed versus sequential estimate, not product benefit"
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
              <h3 id={`outcomes-${build.id}`}>What changed</h3>
              <p>{build.tasks?.length ?? 0} reviewed steps</p>
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
              <h3 id={`validations-${build.id}`}>Quality checks</h3>
              <p>
                {metrics.data === undefined
                  ? "Quality counts are unavailable."
                  : `${metrics.data.failedTasks} failed tasks · ${metrics.data.ownershipViolations} ownership violations`}
              </p>
            </div>
          </div>
          {events.error !== undefined ? (
            <p className="panel-empty">Validation events could not be loaded; the quality outcome is unknown.</p>
          ) : events.isLoading ? (
            <p className="panel-empty" aria-live="polite">
              Loading validation evidence…
            </p>
          ) : failedValidationEvents.length === 0 ? (
            <p className="panel-empty">
              {!hasRecordedFailures
                ? "No failed validation event was recorded."
                : "Failed tasks were recorded, but no dedicated validation event was stored."}
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
        </div>
      </details>

      {visualEvidence.length === 0 ? null : (
        <section
          className="visual-evidence-report"
          aria-labelledby={`visual-evidence-${build.id}`}
        >
          <div>
            <ImageSquareIcon size={26} aria-hidden="true" />
            <div>
              <h3 id={`visual-evidence-${build.id}`}>Visual evidence</h3>
              <p>Confirmed screenshots and comparison artifacts from this work.</p>
            </div>
          </div>
          <ul>
            {visualEvidence.slice(0, 4).map((artifact) => (
              <li key={artifact.id}>
                <strong>{artifact.name}</strong>
                <span>{artifact.repositoryPath ?? artifact.artifactType}</span>
                <StatusBadge status={artifact.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="result-footer">
        <span>{artifacts.error === undefined ? `${artifacts.data?.length ?? 0} artifacts` : "Artifacts unavailable"}</span>
        <span>{manifests.error === undefined ? `${manifests.data?.length ?? 0} manifests` : "Manifests unavailable"}</span>
        <span>
          Ended{" "}
          {build.completedAt === null
            ? "without a completion timestamp"
            : new Date(build.completedAt).toLocaleString()}
        </span>
      </footer>
    </article>
  );
}

function resultRecommendation(
  build: BuildSummary,
  hasRecordedFailures: boolean,
  qualityEvidenceAvailable: boolean,
): string {
  if (!qualityEvidenceAvailable) {
    return "Some quality evidence is unavailable. Review the durable records before treating this work as ready.";
  }
  if (build.status === "completed" && !hasRecordedFailures) {
    return "Review the recorded checks and task outcomes. Local completion does not establish publication, deployment, or external operation.";
  }
  if (hasRecordedFailures) {
    return "Review the failed quality checks before treating this work as ready.";
  }
  return "Review the delivered steps and remaining work before deciding what to do next.";
}

function plainPushStatus(status: string): string {
  if (status === "not recorded") {
    return "Publication unknown; no record";
  }
  return status.replaceAll("_", " ");
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
