import { useState } from "react";
import { Button, Flash, FormControl, Select, TextInput } from "@primer/react";
import { GitBranchIcon, PlayIcon } from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type {
  BuildSummary,
  PlanSummary,
  RepositorySummary,
} from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { Metric } from "../components/Metric.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface PlannerScreenProps {
  onNavigateRepositories: () => void;
  onBuildStarted: () => void;
}

export function PlannerScreen({
  onNavigateRepositories,
  onBuildStarted,
}: PlannerScreenProps): React.JSX.Element {
  const repositories = useSWR<RepositorySummary[]>(
    "/api/repositories",
    apiFetch,
  );
  const [repositoryId, setRepositoryId] = useState("");
  const [backlogPath, setBacklogPath] = useState("");
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<unknown>(null);

  async function createPlan(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setPlanning(true);
    setError(null);
    setErrorDetails(null);
    try {
      const result = await postJson<PlanSummary>("/api/plans", {
        repositoryId,
        ...(backlogPath.length === 0 ? {} : { backlogPath }),
      });
      setPlan(result);
    } catch (cause) {
      setPlan(null);
      setError(cause instanceof Error ? cause.message : "Planning failed");
      setErrorDetails(
        typeof cause === "object" && cause !== null && "details" in cause
          ? (cause as { details?: unknown }).details
          : null,
      );
    } finally {
      setPlanning(false);
    }
  }

  async function startBuild(): Promise<void> {
    if (plan === null) {
      return;
    }
    setStarting(true);
    setError(null);
    let createdBuild: BuildSummary | null = null;
    try {
      createdBuild = await postJson<BuildSummary>("/api/builds", {
        planId: plan.id,
      });
      await postJson<BuildSummary>(`/api/builds/${createdBuild.id}/start`);
      onBuildStarted();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "The build could not be started.";
      setError(
        createdBuild === null
          ? message
          : `${message} Build ${createdBuild.id} remains recorded as ready for review.`,
      );
    } finally {
      setStarting(false);
    }
  }

  if (repositories.error !== undefined) {
    return (
      <>
        <PageTitle
          title="Backlog planner"
          description="Validate dependencies, ownership, artifacts, and expected elapsed time before any worker is dispatched."
        />
        <Flash variant="danger">
          Repository state could not be loaded, so planning is unavailable.
        </Flash>
      </>
    );
  }

  if (repositories.isLoading) {
    return (
      <>
        <PageTitle
          title="Backlog planner"
          description="Validate dependencies, ownership, artifacts, and expected elapsed time before any worker is dispatched."
        />
        <LoadingState label="Loading planner repositories" />
      </>
    );
  }

  if (repositories.data?.length === 0) {
    return (
      <>
        <PageTitle
          title="Backlog planner"
          description="Validate dependencies, ownership, artifacts, and expected elapsed time before any worker is dispatched."
        />
        <EmptyState
          title="Register a repository first"
          description="Planning reads the immutable backlog and AgentFlow configuration from a registered local Git repository."
          actionLabel="Open repositories"
          onAction={onNavigateRepositories}
        />
      </>
    );
  }

  return (
    <>
      <PageTitle
        title="Backlog planner"
        description="Validate dependencies, ownership, artifacts, and expected elapsed time before any worker is dispatched."
        actions={
          plan === null ? null : (
            <Button
              variant="primary"
              leadingVisual={PlayIcon}
              disabled={starting}
              onClick={() => {
                void startBuild();
              }}
            >
              {starting ? "Starting build…" : "Start build"}
            </Button>
          )
        }
      />
      <form className="planner-form" onSubmit={(event) => void createPlan(event)}>
        <FormControl required>
          <FormControl.Label>Repository</FormControl.Label>
          <Select
            block
            value={repositoryId}
            onChange={(event) => {
              setRepositoryId(event.target.value);
              setPlan(null);
            }}
          >
            <Select.Option value="">Select repository</Select.Option>
            {repositories.data?.map((repository) => (
              <Select.Option key={repository.id} value={repository.id}>
                {repository.name} · {repository.status}
              </Select.Option>
            ))}
          </Select>
        </FormControl>
        <FormControl>
          <FormControl.Label>Backlog path override</FormControl.Label>
          <TextInput
            block
            value={backlogPath}
            placeholder="BACKLOG.md"
            onChange={(event) => {
              setBacklogPath(event.target.value);
              setPlan(null);
            }}
          />
          <FormControl.Caption>
            Leave blank to use the repository configuration.
          </FormControl.Caption>
        </FormControl>
        <Button
          variant="primary"
          type="submit"
          disabled={repositoryId.length === 0 || planning}
        >
          {planning ? "Validating…" : "Validate plan"}
        </Button>
      </form>
      {error === null ? null : (
        <Flash variant="danger" className="spaced-flash" role="alert">
          <strong>Plan not confirmed</strong>
          <br />
          {error}
          {errorDetails === null ? null : (
            <pre className="flash-details">
              {JSON.stringify(errorDetails, null, 2)}
            </pre>
          )}
        </Flash>
      )}
      {plan === null ? (
        <section className="planner-guidance" aria-labelledby="planner-guidance-title">
          <GitBranchIcon aria-hidden="true" size={28} />
          <div>
            <h2 id="planner-guidance-title">Preflight before dispatch</h2>
            <p>
              AgentFlow rejects missing dependencies, dependency cycles,
              ownership conflicts, and invalid handoff requirements before a
              build can be created.
            </p>
          </div>
        </section>
      ) : (
        <section className="plan-result" aria-labelledby="plan-result-title">
          <header className="section-heading">
            <div>
              <h2 id="plan-result-title">Validated plan</h2>
              <span className="mono">{plan.id}</span>
            </div>
            <StatusBadge status="validated" />
          </header>
          <div className="metrics-grid metrics-grid--compact">
            <Metric
              label="Tasks"
              value={String(plan.tasks.length)}
              detail={`${plan.waves.length} execution waves`}
            />
            <Metric
              label="Sequential"
              value={`${plan.estimates.sequentialHours.toFixed(1)}h`}
              detail={`${plan.estimates.criticalPathHours.toFixed(1)}h critical path`}
            />
            <Metric
              label="Expected"
              value={`${plan.estimates.expectedElapsedHours.toFixed(1)}h`}
              detail={`${plan.estimates.expectedSavingsPercent.toFixed(1)}% savings`}
            />
            <Metric
              label="Concurrency"
              value={String(plan.estimates.maximumTheoreticalConcurrency)}
              detail="theoretical maximum"
            />
          </div>

          <div className="plan-sections">
            <section aria-labelledby="validation-result-title">
              <header className="subsection-heading">
                <div>
                  <h3 id="validation-result-title">Validation results</h3>
                  <p>Graph, ownership, and plan schema checks completed.</p>
                </div>
                <StatusBadge
                  status={
                    plan.ownershipConflicts.length === 0
                      ? "passed"
                      : "conflict"
                  }
                />
              </header>
              {plan.ownershipConflicts.length === 0 ? (
                <p className="panel-empty">
                  No overlapping ownership reservations were detected.
                </p>
              ) : (
                <ul className="conflict-list">
                  {plan.ownershipConflicts.map((conflict) => (
                    <li
                      key={`${conflict.firstTaskId}:${conflict.secondTaskId}:${conflict.firstPath}`}
                    >
                      <strong>
                        {conflict.firstTaskId} ↔ {conflict.secondTaskId}
                      </strong>
                      <code>
                        {conflict.firstPath} overlaps {conflict.secondPath}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="dependency-graph-title">
              <header className="subsection-heading">
                <div>
                  <h3 id="dependency-graph-title">Dependency graph and waves</h3>
                  <p>Critical-path tasks use an amber edge.</p>
                </div>
              </header>
              <div className="wave-graph" aria-label="Execution waves">
                {plan.waves.map((wave, index) => (
                  <div className="wave" key={wave.join(":")}>
                    <span>Wave {index + 1}</span>
                    <div>
                      {wave.map((taskId) => (
                        <code
                          className={
                            plan.estimates.criticalPathTaskIds.includes(taskId)
                              ? "task-node task-node--critical"
                              : "task-node"
                          }
                          key={taskId}
                        >
                          {taskId}
                        </code>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section aria-labelledby="planned-task-title">
              <header className="subsection-heading">
                <div>
                  <h3 id="planned-task-title">Planned tasks</h3>
                  <p>Dependencies and ownership captured by the immutable plan.</p>
                </div>
              </header>
              <ul className="planned-task-list">
                {plan.tasks.map((task) => (
                  <li key={task.id}>
                    <div>
                      <code>{task.id}</code>
                      <strong>{task.title}</strong>
                    </div>
                    <span>
                      {task.dependsOn.length === 0
                        ? "No dependencies"
                        : `After ${task.dependsOn.join(", ")}`}
                    </span>
                    <span>
                      {task.owns.length === 0
                        ? "No paths reserved"
                        : task.owns.join(", ")}
                    </span>
                    <span>{task.estimateHours.toFixed(1)}h</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </section>
      )}
    </>
  );
}
