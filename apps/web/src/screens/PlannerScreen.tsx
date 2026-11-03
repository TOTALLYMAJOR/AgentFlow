import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  WarningCircleIcon,
} from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import { pendingConfigurationReview, subscribeConfigurationReviews } from "../api/types.js";
import type {
  BuildSummary,
  BacklogGenerationResult,
  PlanSummary,
  RepositoryTarget,
  ReviewedBacklogCommitResult,
  ReviewedBacklogSnapshot,
} from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { Metric } from "../components/Metric.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface PlannerScreenProps {
  onNavigateRepositories: () => void;
  onBuildStarted: (buildId: string) => void;
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
  const repositories = useSWR<RepositoryTarget[]>(
    "/api/repositories/targets",
    apiFetch,
    { refreshInterval: 5_000 },
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
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [reviewCommit, setReviewCommit] =
    useState<ReviewedBacklogCommitResult | null>(null);
  const [committingReview, setCommittingReview] = useState(false);
  const [recordedCommitSha, setRecordedCommitSha] = useState<string | null>(null);
  const [reviewBlocked, setReviewBlocked] = useState(false);
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [recheckingReview, setRecheckingReview] = useState(false);
  const [recordedBuildId, setRecordedBuildId] = useState<string | null>(null);
  const [reviewSnapshot, setReviewSnapshot] = useState<ReviewedBacklogSnapshot | null>(null);
  const [loadingReview, setLoadingReview] = useState(false);
  const [reviewLoadError, setReviewLoadError] = useState<string | null>(null);
  const reviewRequestRef = useRef(0);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [planApproved, setPlanApproved] = useState(false);
  const [checkedPlanBinding, setCheckedPlanBinding] = useState<string | null>(null);
  const configurationRecovery = useSyncExternalStore(
    subscribeConfigurationReviews,
    () => pendingConfigurationReview(repositoryId),
    () => null,
  );
  const invalidatePlan = useCallback(() => {
    setPlan(null);
    setPlanApproved(false);
    setCheckedPlanBinding(null);
  }, []);
  useEffect(() => {
    if (configurationRecovery !== null) {
      invalidatePlan();
    }
  }, [configurationRecovery, invalidatePlan]);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<unknown>(null);
  const selectedRepository = useMemo(
    () =>
      repositories.data?.find(
        (repository) => repository.repositoryId === repositoryId,
      ) ?? null,
    [repositories.data, repositoryId],
  );

  const loadReviewSnapshot = useCallback(async (id: string): Promise<void> => {
    const request = ++reviewRequestRef.current;
    invalidatePlan();
    setReviewSnapshot(null);
    setReviewAcknowledged(false);
    setReviewLoadError(null);
    if (id.length === 0) {
      setLoadingReview(false);
      return;
    }
    setLoadingReview(true);
    try {
      const snapshot = await apiFetch<ReviewedBacklogSnapshot>(
        `/api/repositories/${id}/backlog/review`,
      );
      if (request === reviewRequestRef.current) {
        setReviewSnapshot(snapshot);
      }
    } catch (cause) {
      if (request === reviewRequestRef.current) {
        setReviewLoadError(cause instanceof Error ? cause.message : "The configured review files could not be loaded.");
      }
    } finally {
      if (request === reviewRequestRef.current) {
        setLoadingReview(false);
      }
    }
  }, [invalidatePlan]);

  useEffect(() => {
    void loadReviewSnapshot(repositoryId);
    return () => { reviewRequestRef.current += 1; };
  }, [repositoryId, loadReviewSnapshot]);

  const busy = generating || committingReview || planning || starting || recheckingReview || loadingReview;
  const selectedBacklogPath = generation?.backlogPath ?? backlogPath.trim();
  const reviewMatchesSelection = reviewSnapshot !== null && (
    selectedBacklogPath.length === 0 ||
    selectedBacklogPath.replace(/^\.\//u, "") === reviewSnapshot.backlogPath ||
    selectedBacklogPath === reviewSnapshot.absoluteBacklogPath
  );
  const hasBacklogForReview = generation !== null || (reviewSnapshot !== null && reviewMatchesSelection);
  const currentPlanBinding = JSON.stringify([
    repositoryId, backlogPath.trim(), generationMode, objective.trim(),
    reviewSnapshot?.backlogPath, reviewSnapshot?.backlogSha256, reviewSnapshot?.configurationSha256,
  ]);
  const planMatchesCurrentInputs = checkedPlanBinding !== null && checkedPlanBinding === currentPlanBinding;
  const canCheckPlan = configurationRecovery === null && selectedRepository?.eligible === true &&
    reviewSnapshot?.valid === true && reviewMatchesSelection &&
    !busy && !reviewBlocked && (generation === null || reviewConfirmed);

  async function generateBacklog(): Promise<void> {
    if (selectedRepository?.eligible !== true || busy || reviewBlocked || pendingConfigurationReview(repositoryId) !== null) {
      return;
    }
    setGenerating(true);
    setError(null);
    setErrorDetails(null);
    setPlan(null);
    setPlanApproved(false);
    setGeneration(null);
    setReviewAcknowledged(false);
    setReviewConfirmed(false);
    setReviewCommit(null);
    setRecordedCommitSha(null);
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
      await loadReviewSnapshot(repositoryId);
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

  async function commitReviewedBacklog(): Promise<void> {
    if (
      repositoryId.length === 0 ||
      reviewSnapshot?.valid !== true || !reviewMatchesSelection ||
      !reviewAcknowledged || busy || reviewBlocked || pendingConfigurationReview(repositoryId) !== null ||
      recordedCommitSha !== null
    ) {
      return;
    }
    setCommittingReview(true);
    setError(null);
    setErrorDetails(null);
    try {
      const result = await postJson<ReviewedBacklogCommitResult>(
        `/api/repositories/${repositoryId}/backlog/commit`,
        {
          expectedBacklogPath: reviewSnapshot.backlogPath,
          expectedBacklogSha256: reviewSnapshot.backlogSha256,
          expectedConfigurationSha256: reviewSnapshot.configurationSha256,
        },
      );
      setReviewCommit(result);
      setRecordedCommitSha(result.commitSha);
      setReviewBlocked(result.requiresWorktreeReview);
      setReviewConfirmed(!result.requiresWorktreeReview);
      setRecoveryAcknowledged(false);
      setPlan(null);
      setPlanApproved(false);
      await repositories.mutate().catch(() => undefined);
    } catch (cause) {
      const details = readErrorDetails(cause);
      const commitSha = readRecordedCommitSha(details);
      setReviewConfirmed(false);
      setReviewCommit(null);
      setRecordedCommitSha(commitSha);
      if (commitSha === null) {
        setReviewSnapshot(null);
        setReviewAcknowledged(false);
      }
      setReviewBlocked(commitSha !== null);
      setRecoveryAcknowledged(false);
      setPlan(null);
      setPlanApproved(false);
      setError(
        cause instanceof Error
          ? cause.message
          : "The reviewed plan could not be committed.",
      );
      setErrorDetails(details);
    } finally {
      setCommittingReview(false);
    }
  }

  async function recheckReviewedCheckout(): Promise<void> {
    if (!reviewBlocked || !recoveryAcknowledged || busy) {
      return;
    }
    setRecheckingReview(true);
    try {
      const targets = await repositories.mutate();
      const target = targets?.find((entry) => entry.repositoryId === repositoryId);
      if (target?.eligible !== true) {
        setError("The checkout is still blocked. Resolve the listed readiness issues before checking a new plan.");
        setErrorDetails(target?.blockers ?? null);
        return;
      }
      setReviewBlocked(false);
      setReviewConfirmed(true);
      await loadReviewSnapshot(repositoryId);
      setPlan(null);
      setPlanApproved(false);
      setError(null);
      setErrorDetails(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Readiness could not be confirmed.");
    } finally {
      setRecheckingReview(false);
    }
  }

  async function createPlan(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!canCheckPlan) {
      return;
    }
    setPlanning(true);
    invalidatePlan();
    const binding = currentPlanBinding;
    setError(null);
    setErrorDetails(null);
    try {
      const result = await postJson<PlanSummary>("/api/plans", {
        repositoryId,
        ...(backlogPath.length === 0 ? {} : { backlogPath }),
      });
      if (result.backlogSha256 !== undefined && result.backlogSha256 !== reviewSnapshot.backlogSha256) {
        throw new Error("The immutable plan differs from the reviewed backlog. Reload the current files and check a new plan.");
      }
      setPlan(result);
      setCheckedPlanBinding(binding);
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
    if (plan === null || reviewSnapshot === null || !planApproved || !planMatchesCurrentInputs || busy || reviewBlocked ||
      recordedBuildId !== null || pendingConfigurationReview(repositoryId) !== null) {
      return;
    }
    setStarting(true);
    setError(null);
    setErrorDetails(null);
    let createdBuild: BuildSummary | null = null;
    try {
      const current = await apiFetch<ReviewedBacklogSnapshot>(`/api/repositories/${repositoryId}/backlog/review`);
      if (pendingConfigurationReview(repositoryId) !== null || current.repositoryId !== repositoryId ||
        !current.valid || current.backlogPath !== reviewSnapshot.backlogPath ||
        current.backlogSha256 !== reviewSnapshot.backlogSha256 ||
        current.configurationSha256 !== reviewSnapshot.configurationSha256) {
        invalidatePlan();
        setReviewSnapshot(current.repositoryId === repositoryId ? current : null);
        setReviewAcknowledged(false);
        throw new Error("The reviewed source or setup recovery state changed. Review the current files, then check and approve a new plan before starting.");
      }
      createdBuild = await postJson<BuildSummary>("/api/builds", {
        planId: plan.id,
      });
      setRecordedBuildId(createdBuild.id);
      await postJson<BuildSummary>(`/api/builds/${createdBuild.id}/start`);
      onBuildStarted(createdBuild.id);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "The build could not be started.";
      setError(
        createdBuild === null
          ? message
          : `${message} Build ${createdBuild.id} is recorded; its current start state is unknown until read back in Activity.`,
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
          description="Review the outcome, source changes, and quality checks before explicitly starting coding work."
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
          description="Review the outcome, source changes, and quality checks before explicitly starting coding work."
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
          description="Review the outcome, source changes, and quality checks before explicitly starting coding work."
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
        description="Review the outcome, source changes, and quality checks before explicitly starting coding work."
        actions={
          plan === null ? null : (
            <Button
              variant="primary"
              leadingVisual={PlayIcon}
              disabled={busy || !planApproved || !planMatchesCurrentInputs || reviewBlocked || configurationRecovery !== null || recordedBuildId !== null}
              onClick={() => {
                void startBuild();
              }}
            >
              {starting ? "Starting work..." : "Approve and start"}
            </Button>
          )
        }
      />
      {configurationRecovery === null ? null : (
        <Flash variant="warning" className="spaced-flash" role="status">
          <strong>Setup recovery is required for this repository</strong>
          <p>Return to Workspace, select this project, and review the current setup and recorded commit. Generation, planning, saving and start remain blocked until explicit recovery and native readiness recheck.</p>
          <details><summary>View recorded setup commit</summary><code>{configurationRecovery.commitSha}</code></details>
        </Flash>
      )}
      <form className="planner-form" onSubmit={(event) => void createPlan(event)}>
        <FormControl required>
          <FormControl.Label>Repository</FormControl.Label>
          <Select
            block
            value={repositoryId}
            disabled={busy || recordedBuildId !== null}
            onChange={(event) => {
              invalidatePlan();
              setRepositoryId(event.target.value);
              setBacklogPath("");
              setGeneration(null);
              setReviewAcknowledged(false);
              setReviewConfirmed(false);
              setReviewCommit(null);
              setRecordedCommitSha(null);
              setReviewBlocked(false);
              setRecoveryAcknowledged(false);
              setError(null);
              setErrorDetails(null);
            }}
          >
            <Select.Option value="">Select repository</Select.Option>
            {repositories.data?.map((repository) => (
              <Select.Option
                key={repository.repositoryId}
                value={repository.repositoryId}
              >
                {repository.name}
                {repository.eligible
                  ? repository.designIntelligence.configured
                    ? " · Design Intelligence ready"
                    : " · ready"
                  : ` · ${repository.blockers[0]?.message ?? "unavailable"}`}
              </Select.Option>
            ))}
          </Select>
        </FormControl>
        <FormControl>
          <FormControl.Label>Backlog path override</FormControl.Label>
          <TextInput
            block
            value={backlogPath}
            disabled={busy || reviewBlocked || configurationRecovery !== null || recordedBuildId !== null}
            placeholder="BACKLOG.md"
            onChange={(event) => {
              invalidatePlan();
              setBacklogPath(event.target.value);
              setGeneration(null);
              setReviewAcknowledged(false);
              setReviewConfirmed(false);
              setReviewCommit(null);
              setRecordedCommitSha(null);
            }}
          />
          <FormControl.Caption>
            Leave blank to use the repository configuration.
          </FormControl.Caption>
        </FormControl>
        <Button
          variant="primary"
          type="submit"
          disabled={!canCheckPlan || recordedBuildId !== null}
        >
          {planning ? "Checking plan..." : "Check this plan"}
        </Button>
      </form>
      {generation === null && reviewLoadError !== null ? (
        <Flash variant="warning" className="spaced-flash" role="status">
          The configured backlog cannot yet be reviewed: {reviewLoadError}
          <p>If a backlog is missing, generate a draft below. Existing invalid files need checkout review.</p>
          <Button disabled={busy} onClick={() => void loadReviewSnapshot(repositoryId)}>Reload review files</Button>
        </Flash>
      ) : null}
      {generation === null && reviewSnapshot !== null && !reviewMatchesSelection ? (
        <Flash variant="warning" className="spaced-flash">
          This path is outside the configured backlog <code>{reviewSnapshot.backlogPath}</code>.
          Reconcile the selection and repository configuration before planning.
          This action will not edit configuration automatically.
        </Flash>
      ) : null}
      {selectedRepository === null || selectedRepository.eligible ? null : (
        <Flash variant="warning" className="spaced-flash" role="status">
          <strong>Checkout readiness needs attention</strong>
          <ul>
            {selectedRepository.blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.message} {blocker.recovery}</li>
            ))}
          </ul>
          {generation === null ? null : (
            <p>A generated review file must be reviewed and committed before planning.</p>
          )}
        </Flash>
      )}
      <section
        className="workflow-guide"
        aria-labelledby="workflow-guide-title"
      >
        <header className="section-heading">
          <div>
            <h2 id="workflow-guide-title">From repository to running build</h2>
            <span className="workflow-guide__subtitle">
              Follow the four gates in order. AgentFlow will stop before unsafe
              work. Checking a plan and starting it are separate actions.
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
          <li className={selectedRepository?.eligible === true && selectedRepository.clean ? "is-complete" : "is-current"}>
            <span className="workflow-step__number">1</span>
            <div>
              <strong>Choose a clean checkout</strong>
              <p>
                Register a clean Git worktree. AgentFlow will not generate a
                backlog in a checkout with uncommitted changes.
              </p>
              {selectedRepository === null ? null : (
                <code>{selectedRepository.path}</code>
              )}
            </div>
          </li>
          <li
            className={
              hasBacklogForReview
                ? "is-complete"
                : repositoryId.length > 0
                  ? "is-current"
                  : ""
            }
          >
            <span className="workflow-step__number">2</span>
            <div>
              <strong>Create or reuse the backlog</strong>
              <p>
                Reuse the configured backlog, or explicitly draft one from
                repository evidence or a chosen outcome. Generation writes a
                local review file and does not start coding work.
              </p>
            </div>
          </li>
          <li
            className={
              reviewConfirmed
                ? "is-complete"
                : hasBacklogForReview
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
          <li className={plan !== null || reviewConfirmed ? "is-current" : ""}>
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
              disabled={busy || reviewBlocked || configurationRecovery !== null || recordedBuildId !== null}
              onClick={() => {
                invalidatePlan();
                setGenerationMode("auto");
                setGeneration(null);
                setReviewAcknowledged(false);
                setReviewConfirmed(false);
                setReviewCommit(null);
              }}
            >
              <MagnifyingGlassIcon size={22} aria-hidden="true" />
              <span>
                <strong>Build out the backlog</strong>
                <small>
                  Codex reconciles repository evidence into remaining work.
                </small>
              </span>
            </button>
            <button
              type="button"
              className={generationMode === "objective" ? "mode-card is-selected" : "mode-card"}
              aria-pressed={generationMode === "objective"}
              disabled={busy || reviewBlocked || configurationRecovery !== null || recordedBuildId !== null}
              onClick={() => {
                invalidatePlan();
                setGenerationMode("objective");
                setGeneration(null);
                setReviewAcknowledged(false);
                setReviewConfirmed(false);
                setReviewCommit(null);
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
                disabled={busy || reviewBlocked || configurationRecovery !== null || recordedBuildId !== null}
                placeholder="Build athlete goals with coach review, organization isolation, accessible UI, API contracts, migrations, and focused tests."
                onChange={(event) => {
                  invalidatePlan();
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
                Codex will reconcile documented outcomes, shipped capabilities,
                gaps, queues, tests, TODOs, and recent history into a reviewed
                completion boundary, with exclusions and unknowns kept visible.
              </p>
            </div>
          )}

          <Button
            variant="primary"
            disabled={
              selectedRepository?.eligible !== true ||
              busy || reviewBlocked || configurationRecovery !== null || recordedBuildId !== null ||
              (generationMode === "objective" && objective.trim().length < 10)
            }
            onClick={() => {
              void generateBacklog();
            }}
          >
            {generating
              ? "Codex is inspecting the repository…"
              : generationMode === "auto"
                ? "Inspect repo and build backlog"
                : "Draft backlog"}
          </Button>
        </div>

        {generation === null && reviewSnapshot === null ? null : (
          <div className="backlog-review">
            <div className="backlog-review__heading" role="status">
              <CheckCircleIcon size={24} aria-hidden="true" />
              <div>
                <strong>{generation === null ? `Configured backlog at ${reviewSnapshot?.backlogPath ?? "the registered path"}` : `Backlog drafted at ${generation.backlogPath}`}</strong>
                <p>
                  Review the current exact files before saving any changes.
                  Reading or committing this backlog does not start coding;
                  publishing, deployment, and external operations remain separate.
                </p>
              </div>
            </div>
            {generation === null || generation.summary.length === 0 ? null : (
              <details>
                <summary>Read Codex’s selection summary</summary>
                <pre>{generation.summary}</pre>
              </details>
            )}
            {generation === null ? null : <div className="decomposition-summary">
              <span>
                <strong>{generation.decomposition.epics.length}</strong> epics
              </span>
              <span>
                <strong>{generation.decomposition.adrDrafts.length}</strong> ADR
                drafts
              </span>
              <StatusBadge
                status={reviewSnapshot?.valid === true ? "valid" : "review"}
              />
            </div>}
            {generation === null || generation.warnings.length === 0 ? null : (
              <Flash variant="warning">{generation.warnings}</Flash>
            )}
            <section className="backlog-file-review" aria-labelledby="backlog-file-review-title">
              <header>
                <h3 id="backlog-file-review-title">Review the exact local files</h3>
                <Button disabled={busy || recordedCommitSha !== null} onClick={() => void loadReviewSnapshot(repositoryId)}>
                  {loadingReview ? "Loading review files..." : "Reload review files"}
                </Button>
              </header>
              {loadingReview ? <LoadingState label="Reading configured backlog and setup" /> : reviewLoadError !== null ? (
                <Flash variant="warning">{reviewLoadError} Saving and planning remain unavailable until authoritative readback succeeds.</Flash>
              ) : reviewSnapshot === null ? (
                <p>Load the current configured files before recording review.</p>
              ) : (
                <>
                  <p>
                    Read-only snapshot of <code>{reviewSnapshot.backlogPath}</code> and{" "}
                    <code>{reviewSnapshot.configurationPath}</code>. Saving is bound to
                    these exact contents; later edits require a fresh review.
                  </p>
                  <pre className="backlog-file-review__contents" tabIndex={0} aria-label="Current configured backlog contents">{reviewSnapshot.backlogContents}</pre>
                  <details>
                    <summary>Review .agentflow.yaml contents</summary>
                    <pre className="backlog-file-review__contents" tabIndex={0}>{reviewSnapshot.configurationContents}</pre>
                  </details>
                  <details>
                    <summary>View review snapshot identities</summary>
                    <p>Backlog SHA-256: <code>{reviewSnapshot.backlogSha256}</code></p>
                    <p>Configuration SHA-256: <code>{reviewSnapshot.configurationSha256}</code></p>
                  </details>
                  {reviewMatchesSelection ? null : (
                    <Flash variant="warning">
                      The selected file <code>{selectedBacklogPath}</code> differs from
                      the configured backlog shown above. Saving and planning are blocked.
                      Reconcile the file selection and configuration in the checkout,
                      then reload the review files; no configuration is edited automatically.
                    </Flash>
                  )}
                  {reviewSnapshot.valid ? null : (
                    <Flash variant="warning">
                      The current backlog is invalid. Correct the review file in
                      the checkout, then reload these files before saving.
                      <ul>{reviewSnapshot.validationErrors.map((entry, index) => <li key={`${index}:${entry}`}>{entry}</li>)}</ul>
                    </Flash>
                  )}
                </>
              )}
            </section>
            <label className="review-confirmation">
              <Checkbox
                checked={reviewAcknowledged}
                disabled={busy || configurationRecovery !== null || recordedCommitSha !== null || reviewSnapshot?.valid !== true || !reviewMatchesSelection}
                onChange={(event) => {
                  setReviewAcknowledged(event.target.checked);
                }}
              />
              <span>
                I reviewed these exact backlog and setup contents, including
                the outcome, ownership, dependencies, and quality checks.
              </span>
            </label>
            {recordedCommitSha === null ? (
              <div className="review-commit-action">
                <div>
                  <strong>Record the reviewed backlog</strong>
                  <p>
                    AgentFlow may commit <code>.agentflow.yaml</code> and{" "}
                    <code>{reviewSnapshot?.backlogPath ?? generation?.backlogPath ?? "the configured backlog"}</code> locally. Unrelated or
                    partially staged changes must be resolved separately. No
                    remote push or coding work starts.
                  </p>
                </div>
                <Button
                  variant="primary"
                  disabled={
                    !reviewAcknowledged ||
                    reviewSnapshot?.valid !== true || !reviewMatchesSelection ||
                    busy || reviewBlocked || configurationRecovery !== null
                  }
                  onClick={() => {
                    void commitReviewedBacklog();
                  }}
                >
                  {committingReview ? "Recording backlog..." : "Commit reviewed backlog"}
                </Button>
              </div>
            ) : (
              <div className="review-commit-proof" role="status">
                {reviewBlocked ? <WarningCircleIcon size={22} aria-hidden="true" /> : <CheckCircleIcon size={22} aria-hidden="true" />}
                <div>
                  <strong>
                    {reviewBlocked ? "A local commit exists; checkout review is required" : "Reviewed backlog recorded locally"}
                  </strong>
                  <p>
                    {reviewBlocked
                      ? "Do not retry the commit. Review the recorded commit and any later checkout changes before checking an immutable plan."
                      : "The backlog is recorded. Check the immutable plan, review its tasks, then explicitly approve and start."}
                  </p>
                  {reviewCommit === null ? null : <p>{reviewCommit.nextAction}</p>}
                  <details>
                    <summary>Review local commit evidence</summary>
                    <code>{recordedCommitSha}</code>
                    {reviewCommit === null ? null : (
                      <>
                        <p>{reviewCommit.commitMessage}</p>
                        <ul>{reviewCommit.committedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
                      </>
                    )}
                  </details>
                </div>
              </div>
            )}
            {reviewBlocked ? (
              <div className="review-recovery">
                <label className="review-confirmation">
                  <Checkbox checked={recoveryAcknowledged} disabled={busy} onChange={(event) => setRecoveryAcknowledged(event.target.checked)} />
                  <span>I reviewed the recorded commit and resolved later checkout changes.</span>
                </label>
                <Button disabled={busy || !recoveryAcknowledged} onClick={() => void recheckReviewedCheckout()}>
                  {recheckingReview ? "Rechecking readiness..." : "Recheck reviewed checkout"}
                </Button>
                <p>This read-only check does not commit, plan, or start work.</p>
              </div>
            ) : null}
          </div>
        )}
      </section>
      {error === null ? null : (
        <Flash variant="danger" className="spaced-flash" role="alert">
          <strong>{recordedCommitSha === null ? "Action needs attention" : "Local commit recorded; review next steps"}</strong>
          <br />
          {error}
          <p>
            {recordedCommitSha !== null
              ? "A commit is already recorded. Review its evidence and the checkout; do not repeat the commit action blindly."
              : "Review the details, resolve invalid content or unrelated checkout changes, then reload and review the exact files before retrying. No plan has been approved by this error."}
          </p>
          {errorDetails === null ? null : (
            <details>
              <summary>Review action details</summary>
              <pre className="flash-details">{JSON.stringify(errorDetails, null, 2)}</pre>
            </details>
          )}
        </Flash>
      )}
      {recordedBuildId === null ? null : (
        <Flash variant="warning" className="spaced-flash" role="status">
          A build is recorded. Review its native state before taking another
          start action.
          <Button onClick={() => onBuildStarted(recordedBuildId)}>Review recorded build</Button>
          <details><summary>View build identity</summary><code>{recordedBuildId}</code></details>
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
              <details><summary>View immutable plan identity</summary><code>{plan.id}</code></details>
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
                  This plan contains {plan.tasks.length} steps in{" "}
                  {plan.waves.length} stages. Its estimated duration is{" "}
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
                disabled={busy || reviewBlocked || configurationRecovery !== null || !planMatchesCurrentInputs || recordedBuildId !== null}
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

function readErrorDetails(cause: unknown): unknown {
  return typeof cause === "object" && cause !== null && "details" in cause
    ? (cause as { details?: unknown }).details ?? null
    : null;
}

function readRecordedCommitSha(details: unknown): string | null {
  if (typeof details !== "object" || details === null || !("commitSha" in details)) {
    return null;
  }
  const value = (details as { commitSha?: unknown }).commitSha;
  return typeof value === "string" && value.length > 0 ? value : null;
}
