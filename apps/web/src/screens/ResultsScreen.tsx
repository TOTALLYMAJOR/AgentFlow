import useSWR from "swr";
import { apiFetch } from "../api/client.js";
import type { BuildSummary } from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { Metric } from "../components/Metric.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function ResultsScreen(): React.JSX.Element {
  const builds = useSWR<BuildSummary[]>("/api/builds", apiFetch);
  const completed = builds.data?.filter((build) =>
    ["completed", "failed", "cancelled"].includes(build.status),
  );

  return (
    <>
      <PageTitle
        title="Build results"
        description="Review integration outcomes, estimates, utilization, validation failures, and publication state."
      />
      {completed?.length === 0 ? (
        <EmptyState
          title="No completed builds"
          description="Results appear only after a build reaches an explicit terminal state."
        />
      ) : (
        <div className="result-list">
          {completed?.map((build) => (
            <article key={build.id}>
              <header>
                <div>
                  <strong>{build.repositoryName ?? build.repositoryId}</strong>
                  <span className="mono">{build.integrationBranch}</span>
                </div>
                <StatusBadge status={build.status} />
              </header>
              <div className="metrics-grid metrics-grid--compact">
                <Metric
                  label="Sequential"
                  value={`${build.estimates.sequentialHours ?? 0}h`}
                />
                <Metric
                  label="Expected"
                  value={`${build.estimates.expectedElapsedHours ?? 0}h`}
                />
                <Metric
                  label="Savings"
                  value={`${build.estimates.expectedSavingsPercent ?? 0}%`}
                />
                <Metric
                  label="Tasks"
                  value={String(build.tasks?.length ?? 0)}
                />
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
