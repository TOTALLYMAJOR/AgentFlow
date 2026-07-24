import { Button, Flash } from "@primer/react";
import { ArrowClockwiseIcon, PauseIcon, StopIcon } from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type { BuildSummary } from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { useBuildEvents } from "../hooks/use-build-events.js";

export function BuildScreen(): React.JSX.Element {
  const builds = useSWR<BuildSummary[]>("/api/builds", apiFetch, {
    refreshInterval: 2_000,
  });
  const active =
    builds.data?.find((build) =>
      ["planning", "ready", "running", "paused", "interrupted"].includes(
        build.status,
      ),
    ) ?? null;
  const stream = useBuildEvents(active?.id ?? null);

  async function act(action: "pause" | "resume" | "cancel"): Promise<void> {
    if (active === null) {
      return;
    }
    await postJson(`/api/builds/${active.id}/${action}`);
    await builds.mutate();
  }

  if (builds.error !== undefined) {
    return <Flash variant="danger">Active build state could not be loaded.</Flash>;
  }

  if (active === null) {
    return (
      <>
        <PageTitle
          title="Active build"
          description="Supervise worker slots, queues, integration, and durable events."
        />
        <EmptyState
          title="No build is active"
          description="Create a validated plan before starting a build."
        />
      </>
    );
  }

  return (
    <>
      <PageTitle
        title={active.repositoryName ?? "Active build"}
        description={active.integrationBranch}
        actions={
          <>
            <Button
              leadingVisual={
                active.status === "paused" ? ArrowClockwiseIcon : PauseIcon
              }
              onClick={() =>
                void act(active.status === "paused" ? "resume" : "pause")
              }
            >
              {active.status === "paused" ? "Resume" : "Pause"}
            </Button>
            <Button
              variant="danger"
              leadingVisual={StopIcon}
              onClick={() => void act("cancel")}
            >
              Cancel
            </Button>
          </>
        }
      />
      <div className="build-state-strip">
        <StatusBadge status={active.status} />
        <span className="mono">{active.id}</span>
        <span>{stream.connected ? "Events live" : "Reconnecting events"}</span>
      </div>
      <section className="build-columns">
        <div>
          <h2>Tasks</h2>
          <div className="task-list">
            {active.tasks?.map((task) => (
              <article key={task.id}>
                <div>
                  <span className="mono">{task.backlogTaskId}</span>
                  <strong>{task.title}</strong>
                </div>
                <StatusBadge status={task.state} />
              </article>
            ))}
          </div>
        </div>
        <div>
          <h2>Recent events</h2>
          <ol className="event-list">
            {stream.events
              .slice()
              .reverse()
              .map((event) => (
                <li key={event.sequence}>
                  <span className="mono">#{event.sequence}</span>
                  <strong>{event.type}</strong>
                  <time dateTime={event.occurredAt}>
                    {new Date(event.occurredAt).toLocaleTimeString()}
                  </time>
                </li>
              ))}
          </ol>
        </div>
      </section>
    </>
  );
}
