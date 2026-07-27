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
  initialDraft: {
    repositoryId: string;
    objective: string;
  } | null;
}

export function PlannerScreen({
  onNavigateRepositories,
  onBuildStarted,
  initialDraft,
}: PlannerScreenProps): React.JSX.Element {
  const repositories = useSWR<RepositorySummary[]>(
    "/api/repositories",
    apiFetch,
  );
  const [repositoryId, setRepositoryId] = useState(
    initialDraft?.repositoryId ?? "",
  );
  const [backlogPath, setBacklogPath] = useState("");
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [generationMode, setGenerationMode] = useState<"objective" | "auto">(
    initialDraft === null ? "auto" : "objective",
  );
  const [objective, setObjective] = useState(initialDraft?.objective ?? "");
  const [generating, setGenerating] = useState(false);
  const [generation, setGeneration] =
    useState<BacklogGenerationResult | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [planApproved, setPlanApproved] = useState(false);
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
      setPlanApproved(false);
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
    if (plan === null || !planApproved) {
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
          title="Review the work plan"
          description="AgentFlow explains the outcome, boundaries, and quality checks before any work begins."
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
          title="Review the work plan"
          description="AgentFlow explains the outcome, boundaries, and quality checks before any work begins."
        />
        <LoadingState label="Loading planner repositories" />
      </>
    );
  }

  if (repositories.data?.length === 0) {
    return (
      <>
        <PageTitle
          title="Review the work plan"
          description="AgentFlow explains the outcome, boundaries, and quality checks before any work begins."
        />
        <EmptyState
          title="Connect a project first"
          description="AgentFlow needs a connected Git project before it can prepare a reviewed work plan."
          actionLabel="Open projects"
          onAction={onNavigateRepositories}
        />
      </>
    );
  }

  return (
    <>
      <PageTitle
        title="Review the work plan"
        description="AgentFlow explains the outcome, boundaries, and quality checks before any work begins."
        actions={
          plan === null ? null : (
            <Button
              variant="primary"
              leadingVisual={PlayIcon}
              disabled={starting || !planApproved}
              onClick={() => {
                void startBuild();
              }}
            >
              {starting ? "Starting work..." : "Approve and start"}
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
              setPlanApproved(false);
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
              setPlanApproved(false);
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
          {planning ? "Checking plan..." : "Check this plan"}
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
            <div className="decomposition-summary">
              <span>
                <strong>{generation.decomposition.epics.length}</strong> epics
              </span>
              <span>
                <strong>{generation.decomposition.adrDrafts.length}</strong> ADR
                drafts
              </span>
              <StatusBadge
                status={generation.decomposition.valid ? "valid" : "review"}
              />
            </div>
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
              <h2 id="plan-result-title">Your proposed plan</h2>
              <span className="mono">{plan.id}</span>
            </div>
            <StatusBadge status="validated" />
          </header>
          <section
            className="plain-plan-approval"
            aria-labelledby="plain-plan-approval-title"
          >
            <div className="plain-plan-approval__summary">
              <span className="plain-plan-approval__icon">
                <CheckCircleIcon size={28} aria-hidden="true" />
              </span>
              <div>
                <h3 id="plain-plan-approval-title">
                  {objective.trim().length > 0
                    ? objective.trim()
                    : `Complete ${plan.tasks.length} reviewed improvements`}
                </h3>
                <p>
                  AgentFlow will complete {plan.tasks.length} planned steps in{" "}
                  {plan.waves.length} stages. The expected duration is{" "}
                  {formatPlanTime(plan.estimates.expectedElapsedHours)}.
                </p>
              </div>
            </div>
            <dl className="plain-plan-facts">
              <div>
                <dt>What may change</dt>
                <dd>{summarizeOwnedPaths(plan)}</dd>
              </div>
              <div>
                <dt>How it will be checked</dt>
                <dd>{summarizeChecks(plan)}</dd>
              </div>
              <div>
                <dt>Safety level</dt>
                <dd>{summarizeRisk(plan)}</dd>
              </div>
            </dl>
            <label className="plan-approval-confirmation">
              <Checkbox
                checked={planApproved}
                onChange={(event) => {
                  setPlanApproved(event.target.checked);
                }}
              />
              <span>
                <strong>I approve this plan.</strong>
                AgentFlow may start the listed work. Publishing and external
                changes still require their own confirmed evidence.
              </span>
            </label>
          </section>
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
              detail={
                plan.calibration === undefined ||
                plan.calibration.confidence === "insufficient"
                  ? `${plan.estimates.expectedSavingsPercent.toFixed(1)}% savings · no history yet`
                  : `${plan.calibration.appliedMultiplier.toFixed(2)}× historical · ${plan.calibration.taskSampleCount} tasks`
              }
            />
            <Metric
              label="Concurrency"
              value={String(plan.estimates.maximumTheoreticalConcurrency)}
              detail="theoretical maximum"
            />
          </div>

          <section className="epic-decomposition" aria-labelledby="epic-plan-title">
            <header className="subsection-heading">
              <div>
                <h3 id="epic-plan-title">Epic decomposition</h3>
                <span>
                  Outcome groups derived from the authoritative dependency graph
                </span>
              </div>
            </header>
            <div className="epic-grid">
              {plan.epics.map((epic) => (
                <article key={epic.id}>
                  <span className="mono">{epic.id}</span>
                  <strong>{epic.title}</strong>
                  <p>{epic.outcome}</p>
                  <small>
                    {epic.taskIds.length} tasks · {epic.estimateHours.toFixed(1)}h
                    {epic.dependsOnEpicIds.length === 0
                      ? " · foundation"
                      : ` · after ${epic.dependsOnEpicIds.join(", ")}`}
                  </small>
                </article>
              ))}
            </div>
            {plan.adrDrafts.length === 0 ? null : (
              <details className="adr-drafts">
                <summary>{plan.adrDrafts.length} proposed ADR drafts</summary>
                {plan.adrDrafts.map((draft) => (
                  <article key={draft.id}>
                    <strong>
                      {draft.id} · {draft.title}
                    </strong>
                    <pre>{draft.markdown}</pre>
                  </article>
                ))}
              </details>
            )}
          </section>

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

function formatPlanTime(hours: number): string {
  if (hours < 1) {
    return `${Math.max(1, Math.round(hours * 60))} minutes`;
  }
  return `${hours.toFixed(1)} hours`;
}

function summarizeOwnedPaths(plan: PlanSummary): string {
  const roots = Array.from(
    new Set(
      plan.tasks.flatMap((task) =>
        task.owns.map((path) => path.split("/").slice(0, 2).join("/")),
      ),
    ),
  );
  if (roots.length === 0) {
    return "No project paths are reserved yet.";
  }
  const visible = roots.slice(0, 3).join(", ");
  return roots.length > 3
    ? `${visible}, and ${roots.length - 3} more reviewed areas`
    : visible;
}

function summarizeChecks(plan: PlanSummary): string {
  const commands = plan.tasks.reduce(
    (total, task) => total + (task.validate?.length ?? 0),
    0,
  );
  return commands === 0
    ? "Plan structure, dependencies, and file ownership"
    : `${commands} declared quality checks plus ownership validation`;
}

function summarizeRisk(plan: PlanSummary): string {
  const approvalCount = plan.tasks.filter(
    (task) => task.requiresApproval === true,
  ).length;
  const highestRisk = Math.max(
    0,
    ...plan.tasks.map((task) => task.riskScore ?? 0),
  );
  if (approvalCount > 0) {
    return `${approvalCount} step${approvalCount === 1 ? "" : "s"} will pause for approval`;
  }
  return highestRisk >= 7
    ? "Higher-risk changes are isolated and validated"
    : "Standard guarded work with validation before integration";
}
