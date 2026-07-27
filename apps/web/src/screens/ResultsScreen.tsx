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
        title="Completed work"
        description="Review what changed, how it was checked, and what still needs attention."
      />
      {builds.error !== undefined ? (
        <Flash variant="danger">
          Completed work could not be loaded. No historical outcome has been
          inferred.
        </Flash>
      ) : builds.isLoading ? (
        <LoadingState label="Loading completed work" height="360px" />
      ) : completed?.length === 0 ? (
        <EmptyState
          title="No completed work yet"
          description="Finished and stopped work will appear here with its confirmed evidence."
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
