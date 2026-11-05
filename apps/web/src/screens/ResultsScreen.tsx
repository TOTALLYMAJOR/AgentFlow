import { Flash } from "@primer/react";
import { useEffect, useState } from "react";
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
  const builds = useSWR<BuildSummary[]>(
    "/api/builds?scope=terminal&limit=50",
    apiFetch,
    { revalidateOnMount: false },
  );
  const [readbackComplete, setReadbackComplete] = useState(false);
  const refreshBuilds = builds.mutate;
  useEffect(() => {
    let current = true;
    // A previous visit can retain an empty response inside SWR's dedup window.
    // Bound mutation requests a fresh native list without changing its key.
    void Promise.allSettled([refreshBuilds()]).then(() => {
      if (current) setReadbackComplete(true);
    });
    return () => { current = false; };
  }, [refreshBuilds]);
  const completed = builds.data
    ?.filter((build) => terminalStatuses.has(build.status))
    .sort(
      (first, second) =>
        new Date(second.completedAt ?? second.createdAt).getTime() -
        new Date(first.completedAt ?? first.createdAt).getTime(),
    );
  const loading = !readbackComplete || builds.isLoading;
  const hasConfirmedResults = completed !== undefined && completed.length > 0;

  return (
    <>
      <PageTitle
        title="Completed work"
        description="Review local integration and quality evidence. Publication, deployment, and external operation remain separate outcomes."
      />
      {loading ? (
        hasConfirmedResults ? (
          <p role="status">Loading completed work. Showing the last confirmed list.</p>
        ) : (
          <LoadingState label="Loading completed work" height="360px" />
        )
      ) : null}
      {!loading && builds.error !== undefined ? (
        <Flash variant="danger">
          Completed work could not be loaded. No historical outcome has been
          inferred.
        </Flash>
      ) : null}
      {hasConfirmedResults ? (
        <>
          {!loading && builds.error !== undefined ? <p>Showing the last confirmed list.</p> : null}
          <div className="result-list">
            {completed.map((build) => (
              <ResultBuildCard build={build} key={build.id} />
            ))}
          </div>
        </>
      ) : !loading && builds.error === undefined && completed?.length === 0 ? (
        <EmptyState
          title="No completed work yet"
          description="Finished and stopped work will appear here with its confirmed evidence."
        />
      ) : null}
    </>
  );
}
