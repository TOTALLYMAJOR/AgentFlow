import { useEffect, useRef, useState } from "react";
import { Button, Flash } from "@primer/react";
import {
  ArrowClockwiseIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type {
  ApprovalSummary,
  ArtifactSummary,
  BuildSummary,
  TaskManifest,
} from "../api/types.js";
import { ApprovalsPanel } from "../components/ApprovalsPanel.js";
import { BuildResources } from "../components/BuildResources.js";
import { EmptyState } from "../components/EmptyState.js";
import { EventTimeline } from "../components/EventTimeline.js";
import { LoadingState } from "../components/LoadingState.js";
import { Metric } from "../components/Metric.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { TaskInspector } from "../components/TaskInspector.js";
import { TaskQueues } from "../components/TaskQueues.js";
import { WorkerBoard } from "../components/WorkerBoard.js";
import { useBuildEvents } from "../hooks/use-build-events.js";

const activeStatuses = new Set([
  "planning",
  "ready",
  "running",
  "paused",
  "interrupted",
  "recovering",
]);

type BuildAction = "start" | "pause" | "resume" | "cancel";

export function BuildScreen(): React.JSX.Element {
  const builds = useSWR<BuildSummary[]>("/api/builds", apiFetch, {
    refreshInterval: 2_000,
  });
  const active =
    builds.data?.find((build) => activeStatuses.has(build.status)) ?? null;
  const approvals = useSWR<ApprovalSummary[]>(
    active === null ? null : `/api/builds/${active.id}/approvals`,
    apiFetch,
    { refreshInterval: 3_000 },
  );
  const artifacts = useSWR<ArtifactSummary[]>(
    active === null ? null : `/api/builds/${active.id}/artifacts`,
    apiFetch,
    { refreshInterval: 3_000 },
  );
  const manifests = useSWR<TaskManifest[]>(
    active === null ? null : `/api/builds/${active.id}/manifests`,
    apiFetch,
    { refreshInterval: 3_000 },
  );
  const stream = useBuildEvents(active?.id ?? null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const focusReturnTargetRef = useRef<HTMLButtonElement | null>(null);
  const shouldRestoreFocusRef = useRef(false);
  const [pendingAction, setPendingAction] = useState<BuildAction | null>(null);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const tasks = active?.tasks ?? [];
  const effectiveSelectedTaskId =
    selectedTaskId !== null &&
    tasks.some((candidate) => candidate.id === selectedTaskId)
      ? selectedTaskId
      : null;

  useEffect(() => {
    if (selectedTaskId !== null || !shouldRestoreFocusRef.current) {
      return;
    }
    shouldRestoreFocusRef.current = false;
    const focusTarget = focusReturnTargetRef.current;
    focusReturnTargetRef.current = null;
    if (focusTarget?.isConnected === true) {
      focusTarget.focus();
    }
  }, [selectedTaskId]);

  function selectTask(
    taskId: string,
    trigger: HTMLButtonElement,
  ): void {
    focusReturnTargetRef.current = trigger;
    setSelectedTaskId(taskId);
  }

  function closeTaskInspector(): void {
    shouldRestoreFocusRef.current = true;
    setSelectedTaskId(null);
  }

  async function act(action: BuildAction): Promise<void> {
    if (active === null) {
      return;
    }
    setPendingAction(action);
    setActionError(null);
    try {
      await postJson(`/api/builds/${active.id}/${action}`);
      await builds.mutate();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : `The ${action} action could not be confirmed.`,
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function decideApproval(
    approvalId: string,
    status: "approved" | "rejected" | "cancelled",
  ): Promise<void> {
    if (active === null) {
      return;
    }
    setPendingApprovalId(approvalId);
    setApprovalError(null);
    try {
      await postJson(
        `/api/builds/${active.id}/approvals/${approvalId}/decision`,
        { status, decidedBy: "local-dashboard" },
      );
      await Promise.all([approvals.mutate(), builds.mutate()]);
    } catch (cause) {
      setApprovalError(
        cause instanceof Error
          ? cause.message
          : "The approval decision could not be confirmed.",
      );
    } finally {
      setPendingApprovalId(null);
    }
  }

  if (builds.error !== undefined) {
    return (
      <>
        <PageTitle
          title="Active build"
          description="Supervise worker slots, queues, integration, and durable events."
        />
        <Flash variant="danger">
          Active build state could not be loaded. No control state has been
          inferred.
        </Flash>
      </>
    );
  }

  if (builds.isLoading) {
    return (
      <>
        <PageTitle
          title="Active build"
          description="Supervise worker slots, queues, integration, and durable events."
        />
        <LoadingState label="Loading active build" height="360px" />
      </>
    );
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
          description="Create and start a validated plan. Terminal build evidence remains available in Results."
        />
      </>
    );
  }

  const recoveryEvents = stream.events.filter((event) =>
    /(recover|reconcil|reattach|interrupt)/i.test(event.type),
  );
  const criticalTaskIds =
    active.normalizedPlan?.estimates?.criticalPathTaskIds ?? [];
  const canStart = active.status === "ready";
  const canPause = active.status === "running";
  const canResume = ["paused", "interrupted"].includes(active.status);

  return (
    <>
      <PageTitle
        title={active.repositoryName ?? "Active build"}
        description={`Integration target: ${active.integrationBranch}`}
        actions={
          <>
            {canStart ? (
              <Button
                variant="primary"
                leadingVisual={PlayIcon}
                disabled={pendingAction !== null}
                onClick={() => {
                  void act("start");
                }}
              >
                {pendingAction === "start" ? "Starting…" : "Start"}
              </Button>
            ) : null}
            {canPause ? (
              <Button
                leadingVisual={PauseIcon}
                disabled={pendingAction !== null}
                onClick={() => {
                  void act("pause");
                }}
              >
                {pendingAction === "pause" ? "Pausing…" : "Pause"}
              </Button>
            ) : null}
            {canResume ? (
              <Button
                leadingVisual={ArrowClockwiseIcon}
                disabled={pendingAction !== null}
                onClick={() => {
                  void act("resume");
                }}
              >
                {pendingAction === "resume" ? "Resuming…" : "Resume"}
              </Button>
            ) : null}
            <Button
              variant="danger"
              leadingVisual={StopIcon}
              disabled={pendingAction !== null}
              onClick={() => {
                void act("cancel");
              }}
            >
              {pendingAction === "cancel" ? "Cancelling…" : "Cancel"}
            </Button>
          </>
        }
      />

      {actionError === null ? null : (
        <Flash variant="danger" className="spaced-flash" role="alert">
          {actionError}
        </Flash>
      )}

      <div className="build-state-strip" aria-live="polite">
        <StatusBadge status={active.status} />
        <span className="mono">{active.id}</span>
        <span>{stream.connected ? "Events live" : "Reconnecting events"}</span>
      </div>

      <section className="metrics-grid" aria-label="Active build summary">
        <Metric
          label="Elapsed"
          value={formatElapsed(active)}
          detail={
            active.estimates.expectedElapsedHours === null
              ? "No estimate"
              : `${active.estimates.expectedElapsedHours.toFixed(1)}h expected`
          }
        />
        <Metric
          label="Critical path"
          value={
            active.estimates.criticalPathHours === null
              ? "unknown"
              : `${active.estimates.criticalPathHours.toFixed(1)}h`
          }
          detail={
            criticalTaskIds.length === 0
              ? "No path recorded"
              : criticalTaskIds.join(" → ")
          }
        />
        <Metric
          label="Progress"
          value={`${tasks.filter((task) => task.state === "integrated").length}/${tasks.length}`}
          detail="integrated tasks"
        />
        <Metric
          label="Expected savings"
          value={
            active.estimates.expectedSavingsPercent === null
              ? "unknown"
              : `${active.estimates.expectedSavingsPercent.toFixed(1)}%`
          }
          detail="planning model"
        />
      </section>

      <WorkerBoard
        workers={active.workers ?? []}
        tasks={tasks}
        workerLimit={active.workerLimit}
        onSelectTask={selectTask}
      />

      <TaskQueues
        tasks={tasks}
        selectedTaskId={effectiveSelectedTaskId}
        onSelectTask={selectTask}
      />

      <section className="build-panel all-tasks-panel" aria-labelledby="all-tasks-title">
        <header className="panel-heading">
          <div>
            <h2 id="all-tasks-title">All tasks</h2>
            <p>Select a task to inspect its durable execution evidence.</p>
          </div>
          <span className="queue-count">{tasks.length}</span>
        </header>
        {tasks.length === 0 ? (
          <p className="panel-empty">No tasks were captured in this build.</p>
        ) : (
          <ul className="all-task-grid">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className={
                    effectiveSelectedTaskId === task.id
                      ? "all-task-button is-selected"
                      : "all-task-button"
                  }
                  aria-pressed={effectiveSelectedTaskId === task.id}
                  onClick={(event) => {
                    selectTask(task.id, event.currentTarget);
                  }}
                >
                  <span>
                    <span className="mono">{task.backlogTaskId}</span>
                    <strong>{task.title}</strong>
                  </span>
                  <StatusBadge status={task.state} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {effectiveSelectedTaskId === null ? null : (
        <TaskInspector
          buildId={active.id}
          taskId={effectiveSelectedTaskId}
          liveEvents={stream.events}
          onClose={closeTaskInspector}
          onRetried={async () => {
            await builds.mutate();
          }}
        />
      )}

      <div className="build-detail-grid">
        <ApprovalsPanel
          approvals={approvals.data ?? []}
          loading={approvals.isLoading}
          error={
            approvalError ??
            (approvals.error === undefined
              ? null
              : "Approval gates could not be loaded.")
          }
          pendingApprovalId={pendingApprovalId}
          onDecide={(approvalId, status) => {
            void decideApproval(approvalId, status);
          }}
        />
        <BuildResources
          artifacts={artifacts.data ?? []}
          manifests={manifests.data ?? []}
          loading={artifacts.isLoading || manifests.isLoading}
          error={
            artifacts.error === undefined && manifests.error === undefined
              ? null
              : "Artifacts and manifests could not be loaded."
          }
          onSelectTask={selectTask}
        />
      </div>

      <div className="event-grid">
        <EventTimeline
          events={stream.events}
          connected={stream.connected}
          title="Recent durable events"
        />
        <EventTimeline
          events={recoveryEvents}
          connected={stream.connected}
          title="Recovery and reconciliation"
          emptyMessage="No recovery actions have been recorded for this build."
        />
      </div>
    </>
  );
}

function formatElapsed(build: BuildSummary): string {
  if (build.actualElapsedSeconds !== null && build.actualElapsedSeconds !== undefined) {
    return formatDuration(build.actualElapsedSeconds);
  }
  if (build.startedAt === null) {
    return "not started";
  }
  const endTime =
    build.completedAt === null ? Date.now() : new Date(build.completedAt).getTime();
  const elapsedSeconds = Math.max(
    0,
    Math.floor((endTime - new Date(build.startedAt).getTime()) / 1_000),
  );
  return formatDuration(elapsedSeconds);
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
