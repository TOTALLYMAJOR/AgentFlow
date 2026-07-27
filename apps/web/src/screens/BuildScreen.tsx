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
  const activeBuilds =
    builds.data?.filter((build) => activeStatuses.has(build.status)) ?? [];
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
  const active =
    activeBuilds.find((build) => build.id === selectedBuildId) ??
    activeBuilds[0] ??
    null;
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

  useEffect(() => {
    if (
      activeBuilds.length > 0 &&
      !activeBuilds.some((build) => build.id === selectedBuildId)
    ) {
      setSelectedBuildId(activeBuilds[0]?.id ?? null);
      setSelectedTaskId(null);
    }
  }, [activeBuilds, selectedBuildId]);

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
  const completedTasks = tasks.filter((task) =>
    ["integrated", "completed"].includes(task.state),
  );
  const blockedTasks = tasks.filter((task) =>
    ["failed", "blocked_failed", "awaiting_approval"].includes(task.state),
  );
  const currentTask =
    tasks.find((task) =>
      ["running", "validating", "integrating", "assigned"].includes(task.state),
    ) ?? null;
  const progressPercent =
    tasks.length === 0
      ? 0
      : Math.round((completedTasks.length / tasks.length) * 100);

  return (
    <>
      <PageTitle
        title={active.repositoryName ?? "Work in progress"}
        description="See what is happening, whether AgentFlow needs you, and what comes next."
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
              {pendingAction === "cancel" ? "Stopping..." : "Stop work"}
            </Button>
          </>
        }
      />

      {activeBuilds.length <= 1 ? null : (
        <section
          className="active-build-rail active-build-rail--compact"
          aria-labelledby="build-supervision-title"
        >
          <header>
            <h2 id="build-supervision-title">Builds under supervision</h2>
            <span>{activeBuilds.length} repositories</span>
          </header>
          <div>
            {activeBuilds.map((build) => (
              <button
                type="button"
                className={
                  build.id === active.id
                    ? "active-build-choice is-selected"
                    : "active-build-choice"
                }
                aria-pressed={build.id === active.id}
                key={build.id}
                onClick={() => {
                  setSelectedBuildId(build.id);
                  setSelectedTaskId(null);
                }}
              >
                <span>
                  <strong>{build.repositoryName ?? build.repositoryId}</strong>
                  <code>{build.id}</code>
                </span>
                <StatusBadge status={build.status} />
              </button>
            ))}
          </div>
        </section>
      )}

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

      <section className="consumer-progress" aria-labelledby="progress-title">
        <div className="consumer-progress__heading">
          <div>
            <span>{plainBuildStatus(active.status)}</span>
            <h2 id="progress-title">
              {currentTask === null
                ? nextProgressMessage(active.status, tasks.length)
                : currentTask.title}
            </h2>
            <p>
              {completedTasks.length} of {tasks.length} planned steps complete
              {blockedTasks.length === 0
                ? ". No blockers need your attention."
                : blockedTasks.length === 1
                  ? ". 1 item needs attention."
                  : `. ${blockedTasks.length} items need attention.`}
            </p>
          </div>
          <strong>{progressPercent}%</strong>
        </div>
        <progress
          value={completedTasks.length}
          max={Math.max(1, tasks.length)}
          aria-label={`${progressPercent}% complete`}
        />
        <div className="consumer-progress__next">
          <span>
            <strong>What happens next</strong>
            {nextActionMessage(active.status, blockedTasks.length)}
          </span>
          <span>
            <strong>Time elapsed</strong>
            {formatElapsed(active)}
          </span>
        </div>
      </section>

      {approvals.isLoading ||
      approvals.error !== undefined ||
      approvalError !== null ||
      (approvals.data?.length ?? 0) > 0 ? (
        <ApprovalsPanel
          approvals={approvals.data ?? []}
          loading={approvals.isLoading}
          error={
            approvalError ??
            (approvals.error === undefined
              ? null
              : "Approval requests could not be loaded.")
          }
          pendingApprovalId={pendingApprovalId}
          onDecide={(approvalId, status) => {
            void decideApproval(approvalId, status);
          }}
        />
      ) : null}

      <details className="technical-work-details">
        <summary>View technical activity and evidence</summary>
        <div className="technical-work-details__content">
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
        </div>
      </details>
    </>
  );
}

function plainBuildStatus(status: string): string {
  const labels: Record<string, string> = {
    ready: "Ready for your approval",
    running: "Work is moving forward",
    paused: "Work is paused",
    interrupted: "Work is waiting to resume",
    recovering: "AgentFlow is recovering safely",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function nextProgressMessage(status: string, taskCount: number): string {
  if (taskCount === 0) {
    return "Preparing the first steps";
  }
  if (status === "paused") {
    return "Ready when you are";
  }
  if (status === "ready") {
    return "The plan is ready to begin";
  }
  return "Checking the remaining work";
}

function nextActionMessage(status: string, blockedCount: number): string {
  if (blockedCount > 0) {
    return "Review the approval or failed step below.";
  }
  if (status === "paused") {
    return "Resume when you want AgentFlow to continue.";
  }
  if (status === "ready") {
    return "Start the approved work when you are ready.";
  }
  return "AgentFlow will continue through the reviewed plan.";
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
