import { useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Flash,
  FormControl,
  Select,
  Textarea,
  TextInput,
} from "@primer/react";
import {
  CheckCircleIcon,
  GitBranchIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlayIcon,
} from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type {
  BuildSummary,
  BacklogGenerationResult,
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
  const [generationMode, setGenerationMode] = useState<"objective" | "auto">(
    "auto",
  );
  const [objective, setObjective] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generation, setGeneration] =
    useState<BacklogGenerationResult | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<unknown>(null);
  const selectedRepository = useMemo(
    () =>
      repositories.data?.find(
        (repository) => repository.id === repositoryId,
      ) ?? null,
    [repositories.data, repositoryId],
  );

  async function generateBacklog(): Promise<void> {
    if (repositoryId.length === 0) {
      return;
    }
    setGenerating(true);
    setError(null);
    setErrorDetails(null);
    setPlan(null);
    setGeneration(null);
    setReviewConfirmed(false);
    try {
      const result = await postJson<BacklogGenerationResult>(
        `/api/repositories/${repositoryId}/backlog/generate`,
        {
          mode: generationMode,
          ...(generationMode === "objective"
            ? { objective: objective.trim() }
            : {}),
          ...(backlogPath.trim().length === 0 ? {} : { backlogPath }),
        },
      );
      setGeneration(result);
      if (backlogPath.length === 0) {
        setBacklogPath(result.backlogPath);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Backlog generation failed",
      );
      setErrorDetails(
        typeof cause === "object" && cause !== null && "details" in cause
          ? (cause as { details?: unknown }).details
          : null,
      );
    } finally {
      setGenerating(false);
    }
  }

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
              setGeneration(null);
              setReviewConfirmed(false);
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
          disabled={
            repositoryId.length === 0 ||
            planning ||
            (generation !== null && !reviewConfirmed)
          }
        >
          {planning ? "Validating…" : "Validate plan"}
        </Button>
      </form>
      <section
        className="workflow-guide"
        aria-labelledby="workflow-guide-title"
      >
        <header className="section-heading">
          <div>
            <h2 id="workflow-guide-title">From repository to running build</h2>
            <span className="workflow-guide__subtitle">
              Follow the four gates in order. AgentFlow will stop before unsafe
              work.
            </span>
          </div>
          <StatusBadge
            status={
              plan !== null
                ? "validated"
                : generation !== null
                  ? "review"
                  : "ready"
            }
          />
        </header>

        <ol className="workflow-steps">
          <li className={repositoryId.length > 0 ? "is-complete" : "is-current"}>
            <span className="workflow-step__number">1</span>
            <div>
              <strong>Choose a clean checkout</strong>
              <p>
                Register a clean Git worktree. AgentFlow will not generate a
                backlog in a checkout with uncommitted changes.
              </p>
              {selectedRepository === null ? null : (
                <code>{selectedRepository.localPath}</code>
              )}
            </div>
          </li>
          <li
            className={
              generation !== null
                ? "is-complete"
                : repositoryId.length > 0
                  ? "is-current"
                  : ""
            }
          >
            <span className="workflow-step__number">2</span>
            <div>
              <strong>Create the backlog</strong>
              <p>
                Let Codex choose from repository evidence, or give it one clear
                outcome. Only the backlog file may change.
              </p>
            </div>
          </li>
          <li
            className={
              reviewConfirmed
                ? "is-complete"
                : generation !== null
                  ? "is-current"
                  : ""
            }
          >
            <span className="workflow-step__number">3</span>
            <div>
              <strong>Review and commit</strong>
              <p>
                Inspect dependencies, ownership, commands, and acceptance
                criteria. Workers only receive committed source.
              </p>
            </div>
          </li>
          <li className={plan !== null ? "is-complete" : reviewConfirmed ? "is-current" : ""}>
            <span className="workflow-step__number">4</span>
            <div>
              <strong>Validate and start</strong>
              <p>
                Create an immutable plan, review its execution waves, then
                explicitly start the build.
              </p>
            </div>
          </li>
        </ol>

        <div className="backlog-builder">
          <div className="backlog-mode-picker" role="group" aria-label="Backlog creation mode">
            <button
              type="button"
              className={generationMode === "auto" ? "mode-card is-selected" : "mode-card"}
              aria-pressed={generationMode === "auto"}
              onClick={() => {
                setGenerationMode("auto");
                setGeneration(null);
                setReviewConfirmed(false);
              }}
            >
              <MagnifyingGlassIcon size={22} aria-hidden="true" />
              <span>
                <strong>Discover for me</strong>
                <small>
                  Codex selects the highest-value evidence-backed program.
                </small>
              </span>
            </button>
            <button
              type="button"
              className={generationMode === "objective" ? "mode-card is-selected" : "mode-card"}
              aria-pressed={generationMode === "objective"}
              onClick={() => {
                setGenerationMode("objective");
                setGeneration(null);
                setReviewConfirmed(false);
              }}
            >
              <PencilSimpleIcon size={22} aria-hidden="true" />
              <span>
                <strong>Guide the outcome</strong>
                <small>
                  You choose the product outcome; Codex designs the task graph.
                </small>
              </span>
            </button>
          </div>

          {generationMode === "objective" ? (
            <FormControl required>
              <FormControl.Label>What outcome should this program deliver?</FormControl.Label>
              <Textarea
                block
                rows={4}
                value={objective}
                placeholder="Build athlete goals with coach review, organization isolation, accessible UI, API contracts, migrations, and focused tests."
                onChange={(event) => {
                  setObjective(event.target.value);
                }}
              />
              <FormControl.Caption>
                Describe the user outcome and important boundaries. Codex will
                inspect the repository for implementation details.
              </FormControl.Caption>
            </FormControl>
          ) : (
            <div className="auto-discovery-note">
              <MagnifyingGlassIcon size={20} aria-hidden="true" />
              <p>
                Codex will compare documented gaps, queues, tests, TODOs, recent
                history, user impact, readiness, and dependency-unblocking
                value before choosing.
              </p>
            </div>
          )}

          <Button
            variant="primary"
            disabled={
              repositoryId.length === 0 ||
              generating ||
              (generationMode === "objective" && objective.trim().length < 10)
            }
            onClick={() => {
              void generateBacklog();
            }}
          >
            {generating
              ? "Codex is inspecting the repository…"
              : generationMode === "auto"
                ? "Discover and draft backlog"
                : "Draft backlog"}
          </Button>
        </div>

        {generation === null ? null : (
          <div className="backlog-review" role="status">
            <div className="backlog-review__heading">
              <CheckCircleIcon size={24} aria-hidden="true" />
              <div>
                <strong>Backlog drafted at {generation.backlogPath}</strong>
                <p>{generation.nextAction}</p>
              </div>
            </div>
            {generation.summary.length === 0 ? null : (
              <details>
                <summary>Read Codex’s selection summary</summary>
                <pre>{generation.summary}</pre>
              </details>
            )}
            <div className="commit-instructions">
              <span>Review and commit from the registered checkout:</span>
              <code>
                git add {generation.backlogPath} &amp;&amp; git commit -m
                &quot;docs: define AgentFlow backlog&quot;
              </code>
            </div>
            <label className="review-confirmation">
              <Checkbox
                checked={reviewConfirmed}
                onChange={(event) => {
                  setReviewConfirmed(event.target.checked);
                }}
              />
              <span>I reviewed and committed this backlog.</span>
            </label>
          </div>
        )}
      </section>
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
