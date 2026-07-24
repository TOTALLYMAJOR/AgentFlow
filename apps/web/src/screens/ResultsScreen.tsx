import { Flash } from "@primer/react";
import useSWR from "swr";
import { apiFetch } from "../api/client.js";
import type { BuildSummary } from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { PageTitle } from "../components/PageTitle.js";
import { ResultBuildCard } from "../components/ResultBuildCard.js";

const terminalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "blocked_failed",
]);

export function ResultsScreen(): React.JSX.Element {
  const builds = useSWR<BuildSummary[]>("/api/builds", apiFetch);
  const completed = builds.data
    ?.filter((build) => terminalStatuses.has(build.status))
    .sort(
      (first, second) =>
        new Date(second.completedAt ?? second.createdAt).getTime() -
        new Date(first.completedAt ?? first.createdAt).getTime(),
    );

  return (
    <>
      <PageTitle
        title="Build results"
        description="Review integration outcomes, estimates, utilization, validation failures, artifacts, and publication state."
      />
      {builds.error !== undefined ? (
        <Flash variant="danger">
          Build results could not be loaded. No historical outcome has been
          inferred.
        </Flash>
      ) : builds.isLoading ? (
        <LoadingState label="Loading build results" height="360px" />
      ) : completed?.length === 0 ? (
        <EmptyState
          title="No completed builds"
          description="Results appear only after a build reaches an explicit terminal state."
        />
      ) : (
        <div className="result-list">
          {completed?.map((build) => (
            <ResultBuildCard build={build} key={build.id} />
          ))}
        </div>
      )}
    </>
  );
}
