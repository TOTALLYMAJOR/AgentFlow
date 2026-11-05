import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  ArrowRightIcon,
  BugIcon,
  CheckCircleIcon,
  FolderOpenIcon,
  MagicWandIcon,
  PlusIcon,
  ShieldCheckIcon,
  SparkleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import { clearConfigurationReview, pendingConfigurationReview, retainConfigurationReview, subscribeConfigurationReviews } from "../api/types.js";
import type {
  BuildSummary,
  ConfigurationReviewSnapshot,
  HealthResponse,
  RepositoryPreflight,
  RepositorySummary,
  RepositoryTarget,
  ReviewedConfigurationCommitResult,
} from "../api/types.js";
import { LoadingState } from "../components/LoadingState.js";
import { StatusBadge } from "../components/StatusBadge.js";

interface StartScreenProps {
  onStartGoal: (draft: { repositoryId: string; objective: string }) => void;
  onOpenActivity: () => void;
}

const goalStarters = [
  {
    label: "Add a feature",
    description: "Turn a product idea into reviewed, tested work.",
    prompt: "Add a new feature that improves the core customer experience.",
    icon: SparkleIcon,
  },
  {
    label: "Fix a problem",
    description: "Find the cause, repair it, and prove the fix.",
    prompt: "Find and fix the most important user-facing problem in this project.",
    icon: BugIcon,
  },
  {
    label: "Improve the experience",
    description: "Make an existing workflow clearer and easier to use.",
    prompt: "Improve the usability of the most important customer workflow.",
    icon: MagicWandIcon,
  },
  {
    label: "Prepare for launch",
    description: "Close the highest-risk readiness gaps first.",
    prompt: "Prepare this project for a safe launch and report any remaining blockers.",
    icon: ShieldCheckIcon,
  },
] as const;

export function StartScreen({
  onStartGoal,
  onOpenActivity,
}: StartScreenProps): React.JSX.Element {
  const health = useSWR<HealthResponse>("/api/health", apiFetch, {
    refreshInterval: 5_000,
  });
  const repositories = useSWR<RepositoryTarget[]>(
    "/api/repositories/targets",
    apiFetch,
    { refreshInterval: 5_000 },
  );
  const builds = useSWR<BuildSummary[]>("/api/builds?scope=active", apiFetch, {
    refreshInterval: 3_000,
  });
  const [repositoryId, setRepositoryId] = useState("");
  const [objective, setObjective] = useState("");
  const [showConnection, setShowConnection] = useState(false);
  const [path, setPath] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<RepositoryPreflight | null>(null);
  const [connectedProject, setConnectedProject] = useState<string | null>(null);
  const [setupRepositoryId, setSetupRepositoryId] = useState<string | null>(null);
  const [setupReview, setSetupReview] = useState<ConfigurationReviewSnapshot | null>(null);
  const [setupAcknowledged, setSetupAcknowledged] = useState(false);
  const [loadingSetup, setLoadingSetup] = useState(false);
  const [savingSetup, setSavingSetup] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupCommit, setSetupCommit] = useState<ReviewedConfigurationCommitResult | null>(null);
  const [setupCommitSha, setSetupCommitSha] = useState<string | null>(null);
  const [setupNeedsReview, setSetupNeedsReview] = useState(false);
  const [setupRecoveryAcknowledged, setSetupRecoveryAcknowledged] = useState(false);
  const selectedRepositoryIdRef = useRef(repositoryId);
  const setupContextRef = useRef<string | null>(null);
  const setupRequestRef = useRef(0);
  const selectedRecovery = useSyncExternalStore(
    subscribeConfigurationReviews,
    () => pendingConfigurationReview(repositoryId),
    () => null,
  );
  const setupBusy = loadingSetup || savingSetup;

  useEffect(() => () => { setupRequestRef.current += 1; }, []);

  const selectedRepository = repositories.data?.find(
    (repository) => repository.repositoryId === repositoryId,
  );

  const activeBuilds =
    builds.data?.filter((build) =>
      ["planning", "ready", "running", "paused", "interrupted"].includes(
        build.status,
      ),
    ) ?? [];
  const activeBuild = activeBuilds[0] ?? null;

  async function preflightProject(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (connecting || setupBusy || path.trim().length === 0) {
      return;
    }
    setConnecting(true);
    setConnectionError(null);
    setPreflight(null);
    setConnectedProject(null);
    try {
      const result = await postJson<RepositoryPreflight>(
        "/api/repositories/preflight",
        {
          path: path.trim(),
        },
      );
      setPreflight(result);
    } catch (cause) {
      setConnectionError(
        cause instanceof Error
          ? cause.message
          : "AgentFlow could not inspect this project.",
      );
    } finally {
      setConnecting(false);
    }
  }

  async function connectPreparedProject(initialize: boolean): Promise<void> {
    if (
      connecting || setupBusy ||
      preflight === null ||
      (initialize ? !preflight.requiresInitialization : !preflight.canConnect)
    ) {
      return;
    }
    setConnecting(true);
    setConnectionError(null);
    try {
      const created = await postJson<RepositorySummary>("/api/repositories", {
        path: preflight.localPath,
        initializeIfMissing: initialize,
      });
      await repositories.mutate().catch(() => undefined);
      selectRepository(created.id);
      setConnectedProject(created.name);
      setPath("");
      setPreflight(null);
      setShowConnection(false);
      if (initialize) {
        await loadSetupReview(created.id);
      }
    } catch (cause) {
      setPreflight(null);
      setConnectionError(
        `${cause instanceof Error ? cause.message : "The connection was not confirmed."} Check readiness again before retrying; any setup already written must be reviewed.`,
      );
    } finally {
      setConnecting(false);
    }
  }

  function selectRepository(id: string): void {
    selectedRepositoryIdRef.current = id;
    setupContextRef.current = null;
    setupRequestRef.current += 1;
    setRepositoryId(id);
    setSetupRepositoryId(null);
    setSetupReview(null);
    setSetupAcknowledged(false);
    setSetupRecoveryAcknowledged(false);
    setSetupError(null);
    setSetupCommit(null);
    setSetupCommitSha(null);
    setSetupNeedsReview(false);
    setLoadingSetup(false);
  }

  function currentSetupRequest(id: string, request: number): boolean {
    return selectedRepositoryIdRef.current === id && setupContextRef.current === id && setupRequestRef.current === request;
  }

  async function loadSetupReview(id: string): Promise<void> {
    if (id !== selectedRepositoryIdRef.current || savingSetup) {
      return;
    }
    const request = ++setupRequestRef.current;
    const recovery = pendingConfigurationReview(id);
    setupContextRef.current = id;
    setSetupRepositoryId(id);
    setLoadingSetup(true);
    setSetupReview(null);
    setSetupAcknowledged(false);
    setSetupError(null);
    setSetupCommit(null);
    setSetupCommitSha(recovery?.commitSha ?? null);
    setSetupNeedsReview(recovery !== null);
    setSetupRecoveryAcknowledged(false);
    try {
      const snapshot = await apiFetch<ConfigurationReviewSnapshot>(`/api/repositories/${id}/configuration/review`);
      if (currentSetupRequest(id, request)) {
        if (snapshot.repositoryId !== id) {
          throw new Error("The setup readback belongs to another repository. No review was accepted.");
        }
        setSetupReview(snapshot);
      }
    } catch (cause) {
      if (currentSetupRequest(id, request)) {
        setSetupError(cause instanceof Error ? cause.message : "The local setup could not be reviewed.");
      }
    } finally {
      if (currentSetupRequest(id, request)) {
        setLoadingSetup(false);
      }
    }
  }

  async function saveReviewedSetup(): Promise<void> {
    const id = setupRepositoryId;
    const snapshot = setupReview;
    if (id === null || snapshot === null || snapshot.repositoryId !== id ||
      selectedRepositoryIdRef.current !== id || !setupAcknowledged || savingSetup || loadingSetup ||
      setupCommitSha !== null || pendingConfigurationReview(id) !== null) {
      return;
    }
    const request = ++setupRequestRef.current;
    setSavingSetup(true);
    setSetupError(null);
    try {
      const result = await postJson<ReviewedConfigurationCommitResult>(
        `/api/repositories/${id}/configuration/commit`,
        { expectedConfigurationSha256: snapshot.configurationSha256 },
      );
      if (result.repositoryId !== id) {
        throw new Error("The setup commit response belongs to another repository. Read back the native state before continuing.");
      }
      if (result.requiresWorktreeReview) {
        retainConfigurationReview({ repositoryId: id, commitSha: result.commitSha, configurationSha256: snapshot.configurationSha256 });
      }
      if (currentSetupRequest(id, request)) {
        setSetupCommit(result);
        setSetupCommitSha(result.commitSha);
        setSetupNeedsReview(result.requiresWorktreeReview);
        setSetupRecoveryAcknowledged(false);
        if (result.requiresWorktreeReview) {
          setSetupReview(null);
        }
      }
      await repositories.mutate().catch(() => undefined);
    } catch (cause) {
      const details = typeof cause === "object" && cause !== null && "details" in cause
        ? (cause as { details?: unknown }).details : null;
      const commitSha = typeof details === "object" && details !== null && "commitSha" in details
        ? (details as { commitSha?: unknown }).commitSha : null;
      if (typeof commitSha === "string" && commitSha.length > 0) {
        // Retain the exact repository receipt even if navigation unmounted this screen.
        retainConfigurationReview({ repositoryId: id, commitSha, configurationSha256: snapshot.configurationSha256 });
      }
      if (currentSetupRequest(id, request)) {
        if (typeof commitSha === "string" && commitSha.length > 0) {
          setSetupCommitSha(commitSha);
          setSetupNeedsReview(true);
        }
        setSetupReview(null);
        setSetupAcknowledged(false);
        setSetupRecoveryAcknowledged(false);
        setSetupError(cause instanceof Error ? cause.message : "The setup commit could not be confirmed.");
      }
    } finally {
      if (currentSetupRequest(id, request)) {
        setSavingSetup(false);
      }
    }
  }

  async function recheckSetupCheckout(): Promise<void> {
    const id = setupRepositoryId;
    const snapshot = setupReview;
    if (id === null || snapshot === null || !setupRecoveryAcknowledged || setupBusy ||
      id !== selectedRepositoryIdRef.current || pendingConfigurationReview(id) === null) {
      return;
    }
    const request = ++setupRequestRef.current;
    setLoadingSetup(true);
    setSetupError(null);
    try {
      const current = await apiFetch<ConfigurationReviewSnapshot>(`/api/repositories/${id}/configuration/review`);
      if (!currentSetupRequest(id, request)) {
        return;
      }
      if (current.repositoryId !== id || current.configurationPath !== snapshot.configurationPath ||
        current.configurationSha256 !== snapshot.configurationSha256) {
        setSetupReview(current.repositoryId === id ? current : null);
        setSetupRecoveryAcknowledged(false);
        setSetupError("Setup changed after the displayed readback. Review the current contents and acknowledge recovery again.");
        return;
      }
      const targets = await repositories.mutate();
      if (!currentSetupRequest(id, request)) {
        return;
      }
      if (targets?.find((entry) => entry.repositoryId === id)?.eligible !== true) {
        setSetupError("The checkout is still blocked. Resolve the native readiness issues before continuing.");
        return;
      }
      clearConfigurationReview(id);
      setSetupNeedsReview(false);
      setSetupError(null);
    } catch (cause) {
      if (currentSetupRequest(id, request)) {
        setSetupError(cause instanceof Error ? cause.message : "Readiness could not be confirmed.");
      }
    } finally {
      if (currentSetupRequest(id, request)) {
        setLoadingSetup(false);
      }
    }
  }

  if (health.error !== undefined || repositories.error !== undefined) {
    return (
      <Flash variant="danger">
        AgentFlow could not load your projects. No work has been started.
      </Flash>
    );
  }

  if (health.isLoading || repositories.isLoading) {
    return <LoadingState label="Preparing your workspace" height="420px" />;
  }

  return (
    <div className="start-screen">
      <header className="start-hero">
        <div>
          <h1>What would you like to improve?</h1>
          <p>
            Describe the outcome. AgentFlow will inspect the project, propose a
            safe plan, and wait for explicit approval before starting coding work.
          </p>
        </div>
      </header>

      {activeBuild === null ? null : (
        <button
          type="button"
          className="current-work-callout"
          onClick={onOpenActivity}
        >
          <span>
            <StatusBadge status={activeBuild.status} />
            <span>
              <strong>
                {activeBuild.repositoryName ?? "Project work"} is{" "}
                {plainStatus(activeBuild.status)}
              </strong>
              <small>Open activity to see what is happening and what comes next.</small>
            </span>
          </span>
          <ArrowRightIcon size={20} aria-hidden="true" />
        </button>
      )}

      {connectedProject === null ? null : (
        <Flash variant="success" role="status">
          {connectedProject} is connected. Choose an outcome, then review the
          plan. Connecting has not started coding work.
        </Flash>
      )}
      {setupRepositoryId === null ? null : (
        <section className="setup-review" aria-labelledby="setup-review-title">
          <header>
            <div>
              <h2 id="setup-review-title">Review local project setup</h2>
              <p>A clean, committed checkout is required before backlog generation.</p>
              <p>Project: {repositories.data?.find((entry) => entry.repositoryId === setupRepositoryId)?.name ?? setupRepositoryId}</p>
            </div>
            <Button disabled={connecting || setupBusy || (setupCommitSha !== null && !setupNeedsReview)} onClick={() => void loadSetupReview(setupRepositoryId)}>
              {loadingSetup ? "Loading setup..." : setupNeedsReview ? "Load current setup for recovery" : "Reload setup review"}
            </Button>
          </header>
          {setupReview === null ? null : (
            <>
              <p>
                Review <code>{setupReview.configurationPath}</code> before saving.
                The explicit action below commits only this setup file locally;
                it does not generate a backlog, push, or start coding.
              </p>
              <pre className="backlog-file-review__contents" tabIndex={0} aria-label="Current setup configuration contents">{setupReview.configurationContents}</pre>
              <details><summary>View setup snapshot identity</summary><code>{setupReview.configurationSha256}</code></details>
              {setupCommitSha === null ? (
                <>
                  <label className="review-confirmation">
                    <Checkbox checked={setupAcknowledged} disabled={loadingSetup || savingSetup} onChange={(event) => setSetupAcknowledged(event.target.checked)} />
                    <span>I reviewed these exact setup contents and approve a local configuration-only commit.</span>
                  </label>
                  <Button variant="primary" disabled={!setupAcknowledged || loadingSetup || savingSetup} onClick={() => void saveReviewedSetup()}>
                    {savingSetup ? "Saving setup..." : "Save reviewed setup"}
                  </Button>
                </>
              ) : null}
            </>
          )}
          {setupCommitSha === null ? null : (
            <Flash variant={setupNeedsReview ? "warning" : "success"} role="status">
              <strong>{setupNeedsReview ? "A setup commit exists; checkout review is required" : "Setup recorded locally"}</strong>
              <p>{setupNeedsReview
                ? "Do not retry the commit. Review the recorded commit and later checkout changes before continuing."
                : "Review the refreshed native readiness below. Backlog generation remains a separate explicit action."}</p>
              <details>
                <summary>Review setup commit evidence</summary>
                <code>{setupCommitSha}</code>
                {setupCommit === null ? null : <p>{setupCommit.commitMessage}</p>}
              </details>
            </Flash>
          )}
          {!setupNeedsReview ? null : (
            <>
              <label className="review-confirmation">
                <Checkbox checked={setupRecoveryAcknowledged} disabled={setupBusy || setupReview === null} onChange={(event) => setSetupRecoveryAcknowledged(event.target.checked)} />
                <span>I reviewed the current setup readback and recorded commit, and resolved later checkout changes.</span>
              </label>
              <Button disabled={!setupRecoveryAcknowledged || setupBusy || setupReview === null} onClick={() => void recheckSetupCheckout()}>
                Recheck reviewed checkout
              </Button>
            </>
          )}
          {setupError === null ? null : (
            <Flash variant="warning" role="alert">
              {setupError}
              <p>{setupCommitSha === null
                ? "Resolve unrelated or invalid checkout changes, then reload and review the setup before retrying."
                : "A local commit is recorded. Review its evidence; no automatic retry or rollback was performed."}</p>
            </Flash>
          )}
        </section>
      )}
      {builds.error === undefined ? null : (
        <Flash variant="warning">
          Current activity could not be loaded. Active work may exist; check
          Activity before starting another item.
        </Flash>
      )}
      <section className="goal-composer" aria-labelledby="goal-composer-title">
        <h2 id="goal-composer-title" className="visually-hidden">
          Start new work
        </h2>
        <div className="goal-composer__layout">
          <div className="goal-composer__form">
            <FormControl required>
              <FormControl.Label>Project</FormControl.Label>
              <Select
                block
                value={repositoryId}
                disabled={connecting || setupBusy}
                onChange={(event) => {
                  selectRepository(event.target.value);
                }}
              >
                <Select.Option value="">Choose a project</Select.Option>
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
            {selectedRepository === undefined || selectedRepository.eligible ? null : (
              <Flash variant="warning" role="status">
                <strong>This project is blocked</strong>
                <ul>
                  {selectedRepository.blockers.map((blocker) => (
                    <li key={blocker.code}>
                      {blocker.message} {blocker.recovery}
                    </li>
                  ))}
                </ul>
                <Button disabled={connecting || loadingSetup || savingSetup || (setupCommitSha !== null && setupRepositoryId === selectedRepository.repositoryId)} onClick={() => void loadSetupReview(selectedRepository.repositoryId)}>
                  Review local setup
                </Button>
                <p>Read-only review does not authorize generation or execution.</p>
              </Flash>
            )}
            {selectedRecovery === null ? null : (
              <Flash variant="warning" role="status">
                <strong>Setup recovery is required for this project</strong>
                <p>Native eligibility does not clear this recorded review requirement. Review current setup and the recorded commit before continuing.</p>
                <details><summary>View recorded setup commit</summary><code>{selectedRecovery.commitSha}</code></details>
                <Button disabled={connecting || setupBusy} onClick={() => void loadSetupReview(repositoryId)}>Review setup recovery</Button>
              </Flash>
            )}
            <FormControl required>
              <FormControl.Label>What should be better?</FormControl.Label>
              <Textarea
                block
                rows={6}
                value={objective}
                placeholder="Describe the outcome you want for the user."
                onChange={(event) => {
                  setObjective(event.target.value);
                }}
              />
              <FormControl.Caption>
                Focus on the outcome. Technical details are optional.
              </FormControl.Caption>
            </FormControl>
            <div className="goal-composer__actions">
              <Button
                variant="primary"
                trailingVisual={ArrowRightIcon}
                disabled={
                  selectedRepository?.eligible !== true || selectedRecovery !== null ||
                  connecting || setupBusy ||
                  objective.trim().length < 10
                }
                onClick={() => {
                  if (selectedRepository?.eligible !== true || pendingConfigurationReview(repositoryId) !== null || connecting || setupBusy) {
                    return;
                  }
                  onStartGoal({
                    repositoryId,
                    objective: objective.trim(),
                  });
                }}
              >
                Review plan
              </Button>
              <Button
                leadingVisual={showConnection ? FolderOpenIcon : PlusIcon}
                disabled={connecting || setupBusy}
                onClick={() => {
                  setShowConnection((current) => !current);
                  setConnectionError(null);
                  setPreflight(null);
                }}
              >
                {showConnection ? "Close setup" : "Connect project"}
              </Button>
            </div>
            <div className="goal-composer__assurance">
              <ShieldCheckIcon size={18} aria-hidden="true" />
              <span>
                Setup and backlog drafts need explicit actions. Coding starts
                only after plan approval and start.
              </span>
            </div>
          </div>

          <aside className="goal-starters" aria-label="Outcome suggestions">
            <div className="goal-starters__heading">
              <strong>Need a starting point?</strong>
              <span>Choose one to prefill the outcome.</span>
            </div>
            {goalStarters.map((starter) => {
              const StarterIcon = starter.icon;
              const selected = objective === starter.prompt;
              return (
                <button
                  type="button"
                  key={starter.label}
                  className={selected ? "goal-starter is-selected" : "goal-starter"}
                  aria-pressed={selected}
                  onClick={() => {
                    setObjective(starter.prompt);
                  }}
                >
                  <StarterIcon size={20} aria-hidden="true" />
                  <span>
                    <strong>{starter.label}</strong>
                    <small>{starter.description}</small>
                  </span>
                </button>
              );
            })}
          </aside>
        </div>
      </section>

      {showConnection ? (
        <section
          className="connection-wizard"
          aria-labelledby="connection-wizard-title"
        >
          <div className="connection-wizard__heading">
            <span>1</span>
            <div>
              <h2 id="connection-wizard-title">Connect a local project</h2>
              <p>
                Choose the project folder. AgentFlow will confirm that it is
                ready without changing its source.
              </p>
            </div>
          </div>
          <form onSubmit={(event) => void preflightProject(event)}>
            <FormControl required>
              <FormControl.Label>Project folder</FormControl.Label>
              <TextInput
                block
                leadingVisual={FolderOpenIcon}
                value={path}
                disabled={connecting}
                placeholder="/home/you/projects/my-app"
                onChange={(event) => {
                  setPath(event.target.value);
                  setPreflight(null);
                  setConnectionError(null);
                }}
              />
              <FormControl.Caption>
                The first check is read-only. AgentFlow will show any proposed
                setup before writing a file.
              </FormControl.Caption>
            </FormControl>
            <Button
              type="submit"
              variant="primary"
              disabled={connecting || path.trim().length === 0}
            >
              {connecting && preflight === null
                ? "Checking project..."
                : "Check readiness"}
            </Button>
          </form>
          {preflight === null ? null : (
            <div className="project-readiness" aria-live="polite">
              <div className="project-readiness__lead">
                {preflight.canConnect ? (
                  <CheckCircleIcon size={28} aria-hidden="true" />
                ) : (
                  <WarningCircleIcon size={28} aria-hidden="true" />
                )}
                <div>
                  <strong>
                    {preflight.canConnect
                      ? "Ready to connect"
                      : preflight.requiresInitialization
                        ? "One setup file is needed"
                        : "This project needs attention"}
                  </strong>
                  <p>{preflight.nextAction}</p>
                </div>
              </div>
              <dl className="project-readiness__checks">
                <ReadinessCheck
                  label="Git project"
                  passed={preflight.checks.gitRepository}
                />
                <ReadinessCheck
                  label="AgentFlow setup"
                  passed={preflight.checks.configValid}
                />
                <ReadinessCheck
                  label="Base branch"
                  passed={preflight.checks.baseBranchExists}
                />
              </dl>
              {preflight.issues.length === 0 ? null : (
                <details>
                  <summary>View readiness details</summary>
                  <ul>
                    {preflight.issues.map((issue) => (
                      <li key={`${issue.code}:${issue.message}`}>
                        <strong>{plainIssueCode(issue.code)}</strong>
                        <span>{issue.message}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {preflight.requiresInitialization ? (
                <div className="setup-consent">
                  <div>
                    <strong>Approve local project setup</strong>
                    <p>
                      Create <code>.agentflow.yaml</code> in this checkout and
                      register the project. This does not change product code,
                      create a commit, or start coding work.
                    </p>
                  </div>
                  <details>
                    <summary>Review proposed setup paths</summary>
                    <ul>
                      {preflight.proposedChanges.map((change) => (
                        <li key={change}><code>{change}</code></li>
                      ))}
                    </ul>
                  </details>
                  <Button
                    variant="primary"
                    disabled={connecting}
                    onClick={() => {
                      void connectPreparedProject(true);
                    }}
                  >
                    {connecting ? "Connecting..." : "Create setup and connect"}
                  </Button>
                </div>
              ) : preflight.canConnect ? (
                <Button
                  variant="primary"
                  disabled={connecting}
                  onClick={() => {
                    void connectPreparedProject(false);
                  }}
                >
                  {connecting ? "Connecting..." : "Connect configured project"}
                </Button>
              ) : null}
            </div>
          )}
          {connectionError === null ? null : (
            <Flash variant="danger" role="alert">
              <strong>Connection needs attention</strong>
              <br />
              {connectionError}
            </Flash>
          )}
        </section>
      ) : null}

      <footer className="workspace-summary">
        <span>
          <strong>{repositories.data?.length ?? 0}</strong> connected projects
        </span>
        <span>
          <strong>{activeBuilds.length}</strong> active work items
        </span>
        <span>
          <strong>{health.data?.resources.availableWorkers ?? 0}</strong> AI
          agents available
        </span>
      </footer>
    </div>
  );
}

function ReadinessCheck({
  label,
  passed,
}: {
  label: string;
  passed: boolean;
}): React.JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={passed ? "is-ready" : "is-pending"}>
        {passed ? "Passed" : "Not confirmed"}
      </dd>
    </div>
  );
}

function plainIssueCode(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function plainStatus(status: string): string {
  const labels: Record<string, string> = {
    planning: "being planned",
    ready: "ready to start",
    running: "in progress",
    paused: "paused",
    interrupted: "waiting to resume",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}
