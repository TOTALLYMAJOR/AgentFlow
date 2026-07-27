import { useState } from "react";
import { Button, Checkbox, Flash, FormControl, TextInput } from "@primer/react";
import {
  ArrowClockwiseIcon,
  GitBranchIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type {
  BuildSummary,
  GovernanceOverview,
  ImpactAnalysis,
  KnowledgeSnapshot,
  RepositorySummary,
  VisualComparison,
} from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function RepositoriesScreen(): React.JSX.Element {
  const repositories = useSWR<RepositorySummary[]>(
    "/api/repositories",
    apiFetch,
  );
  const builds = useSWR<BuildSummary[]>("/api/builds", apiFetch);
  const governance = useSWR<GovernanceOverview>("/api/governance", apiFetch);
  const [path, setPath] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingRepositoryId, setPendingRepositoryId] = useState<string | null>(
    null,
  );
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visualRepositoryId, setVisualRepositoryId] = useState("");
  const [visualUrl, setVisualUrl] = useState("http://127.0.0.1:3000");
  const [baselinePath, setBaselinePath] = useState("");
  const [visualPending, setVisualPending] = useState(false);
  const [visualResult, setVisualResult] =
    useState<VisualComparison | null>(null);
  const [knowledgePendingId, setKnowledgePendingId] = useState<string | null>(
    null,
  );
  const [knowledgeSnapshot, setKnowledgeSnapshot] =
    useState<KnowledgeSnapshot | null>(null);
  const [impactRepositoryId, setImpactRepositoryId] = useState("");
  const [impactPath, setImpactPath] = useState("");
  const [impactPending, setImpactPending] = useState(false);
  const [impactResult, setImpactResult] = useState<ImpactAnalysis | null>(null);
  const [templateRepositoryId, setTemplateRepositoryId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [templateConfirmed, setTemplateConfirmed] = useState(false);
  const [templatePending, setTemplatePending] = useState(false);
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);

  async function registerRepository(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await postJson("/api/repositories", { path });
      await repositories.mutate();
      setPath("");
      setShowForm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Registration failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function inspectRepository(id: string): Promise<void> {
    setPendingRepositoryId(id);
    setError(null);
    try {
      await postJson(`/api/repositories/${id}/inspect`);
      await repositories.mutate();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Repository inspection failed.",
      );
    } finally {
      setPendingRepositoryId(null);
    }
  }

  async function removeRepository(id: string): Promise<void> {
    setPendingRepositoryId(id);
    setError(null);
    try {
      await apiFetch<unknown>(`/api/repositories/${id}`, { method: "DELETE" });
      await repositories.mutate();
      setConfirmRemoveId(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Repository removal failed.",
      );
    } finally {
      setPendingRepositoryId(null);
    }
  }

  async function compareRoute(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setVisualPending(true);
    setVisualResult(null);
    setError(null);
    try {
      const result = await postJson<VisualComparison>(
        "/api/visual-comparisons",
        {
          repositoryId: visualRepositoryId,
          url: visualUrl,
          baselinePath,
        },
      );
      setVisualResult(result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Browser screenshot comparison failed.",
      );
    } finally {
      setVisualPending(false);
    }
  }

  async function scanKnowledge(repositoryId: string): Promise<void> {
    setKnowledgePendingId(repositoryId);
    setError(null);
    try {
      const result = await postJson<{
        snapshot: KnowledgeSnapshot;
        skippedFiles: number;
      }>(`/api/repositories/${repositoryId}/knowledge/scan`);
      setKnowledgeSnapshot(result.snapshot);
      setImpactRepositoryId(repositoryId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Repository knowledge scan failed.",
      );
    } finally {
      setKnowledgePendingId(null);
    }
  }

  async function analyzeRepositoryImpact(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setImpactPending(true);
    setImpactResult(null);
    setError(null);
    try {
      setImpactResult(
        await postJson<ImpactAnalysis>(
          `/api/repositories/${impactRepositoryId}/knowledge/impact`,
          { changedPaths: [impactPath] },
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Impact analysis failed.",
      );
    } finally {
      setImpactPending(false);
    }
  }

  async function applyTemplate(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setTemplatePending(true);
    setTemplateMessage(null);
    setError(null);
    try {
      const result = await postJson<{ nextAction: string }>(
        "/api/governance/templates/apply",
        {
          repositoryId: templateRepositoryId,
          templateId,
          confirmOverwrite: templateConfirmed,
        },
      );
      setTemplateMessage(result.nextAction);
      setTemplateConfirmed(false);
      await repositories.mutate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Template application failed.");
    } finally {
      setTemplatePending(false);
    }
  }

  if (repositories.error !== undefined) {
    return (
      <>
        <PageTitle
          title="Projects"
          description="Connect local Git projects. Removing a connection never deletes source files."
        />
        <Flash variant="danger">
          The local repository registry could not be loaded.
        </Flash>
      </>
    );
  }

  if (repositories.isLoading) {
    return (
      <>
        <PageTitle
          title="Projects"
          description="Connect local Git projects. Removing a connection never deletes source files."
        />
        <LoadingState label="Loading repository registry" />
      </>
    );
  }

  return (
    <>
      <PageTitle
        title="Projects"
        description="Connect local Git projects. Removing a connection never deletes source files."
        actions={
          <Button
            variant="primary"
            leadingVisual={showForm ? XIcon : PlusIcon}
            onClick={() => {
              setShowForm((current) => !current);
              setError(null);
            }}
          >
            {showForm ? "Close setup" : "Connect project"}
          </Button>
        }
      />

      {showForm ? (
        <form
          className="inline-form"
          onSubmit={(event) => void registerRepository(event)}
        >
          <FormControl required>
            <FormControl.Label>Project folder</FormControl.Label>
            <TextInput
              block
              value={path}
              placeholder="/home/you/projects/service"
              onChange={(event) => {
                setPath(event.target.value);
              }}
            />
            <FormControl.Caption>
              The directory must be readable, use Git, and contain a valid
              .agentflow.yaml file.
            </FormControl.Caption>
          </FormControl>
          <Button
            variant="primary"
            type="submit"
            disabled={submitting || path.trim().length === 0}
          >
            {submitting ? "Checking..." : "Check and connect"}
          </Button>
        </form>
      ) : null}

      {error === null ? null : (
        <Flash variant="danger" className="spaced-flash" role="alert">
          {error}
        </Flash>
      )}

      {builds.error === undefined ? null : (
        <Flash variant="warning" className="spaced-flash">
          Build history could not be loaded. Repository health remains current,
          but last-build cells are unavailable.
        </Flash>
      )}

      {repositories.data?.length === 0 ? (
        <EmptyState
          title="No projects connected"
          description="AgentFlow stores only registry metadata and operational state outside the source repository."
          actionLabel="Connect project"
          onAction={() => {
            setShowForm(true);
          }}
        />
      ) : (
        <div
          className="table-shell"
          role="region"
          aria-label="Repositories"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Base branch</th>
                <th scope="col">Detected stack</th>
                <th scope="col">Health</th>
                <th scope="col">Last build</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {repositories.data?.map((repository) => {
                const lastBuild = findLastBuild(
                  builds.data ?? [],
                  repository.id,
                );
                const isPending = pendingRepositoryId === repository.id;
                const isConfirming = confirmRemoveId === repository.id;
                return (
                  <tr key={repository.id}>
                    <td>
                      <strong>{repository.name}</strong>
                      <span className="path-text">{repository.localPath}</span>
                    </td>
                    <td className="mono">{repository.baseBranch}</td>
                    <td>
                      <span>
                        {[
                          repository.detectedStack.packageManager,
                          ...repository.detectedStack.frameworks,
                        ]
                          .filter(Boolean)
                          .join(", ") || "not detected"}
                      </span>
                      {repository.detectedStack.monorepo ? (
                        <span className="table-detail">Monorepo</span>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge status={repository.status} />
                      <time
                        className="table-detail"
                        dateTime={repository.updatedAt}
                      >
                        checked {new Date(repository.updatedAt).toLocaleString()}
                      </time>
                    </td>
                    <td>
                      {builds.isLoading ? (
                        <span className="table-detail">Loading…</span>
                      ) : lastBuild === null ? (
                        <span className="table-detail">No builds</span>
                      ) : (
                        <>
                          <StatusBadge status={lastBuild.status} />
                          <span className="mono">{lastBuild.id}</span>
                        </>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button
                          size="small"
                          leadingVisual={GitBranchIcon}
                          disabled={knowledgePendingId === repository.id}
                          onClick={() => {
                            void scanKnowledge(repository.id);
                          }}
                        >
                          {knowledgePendingId === repository.id
                            ? "Mapping…"
                            : "Map"}
                        </Button>
                        <Button
                          size="small"
                          leadingVisual={ArrowClockwiseIcon}
                          disabled={isPending}
                          onClick={() => {
                            void inspectRepository(repository.id);
                          }}
                        >
                          {isPending && !isConfirming
                            ? "Inspecting…"
                            : "Inspect"}
                        </Button>
                        {isConfirming ? (
                          <>
                            <Button
                              size="small"
                              variant="danger"
                              leadingVisual={TrashIcon}
                              disabled={isPending}
                              onClick={() => {
                                void removeRepository(repository.id);
                              }}
                            >
                              {isPending ? "Removing…" : "Confirm remove"}
                            </Button>
                            <Button
                              size="small"
                              leadingVisual={XIcon}
                              disabled={isPending}
                              onClick={() => {
                                setConfirmRemoveId(null);
                              }}
                            >
                              Keep
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="small"
                            variant="danger"
                            leadingVisual={TrashIcon}
                            disabled={isPending}
                            onClick={() => {
                              setConfirmRemoveId(repository.id);
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {repositories.data?.length === 0 ? null : (
        <section className="impact-analysis" aria-labelledby="governance-title">
          <header className="section-heading">
            <div>
              <h2 id="governance-title">Organization policy and templates</h2>
              <span>
                Apply a reviewed baseline to one repository. Existing
                .agentflow.yaml content is replaced only after confirmation.
              </span>
            </div>
            {governance.data === undefined ? null : (
              <span className="mono">
                max {governance.data.policy.workers.maximum_per_repository} workers
              </span>
            )}
          </header>
          <form onSubmit={(event) => void applyTemplate(event)}>
            <FormControl required>
              <FormControl.Label>Repository</FormControl.Label>
              <select
                value={templateRepositoryId}
                onChange={(event) => setTemplateRepositoryId(event.target.value)}
              >
                <option value="">Choose repository</option>
                {repositories.data?.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.name}
                  </option>
                ))}
              </select>
            </FormControl>
            <FormControl required>
              <FormControl.Label>Template</FormControl.Label>
              <select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                <option value="">Choose template</option>
                {governance.data?.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}: {template.description}
                  </option>
                ))}
              </select>
            </FormControl>
            <FormControl>
              <Checkbox
                checked={templateConfirmed}
                onChange={(event) => setTemplateConfirmed(event.target.checked)}
              />
              <FormControl.Label>
                Replace this repository’s .agentflow.yaml
              </FormControl.Label>
            </FormControl>
            <Button
              type="submit"
              variant="primary"
              disabled={
                templatePending ||
                !templateConfirmed ||
                templateRepositoryId.length === 0 ||
                templateId.length === 0
              }
            >
              {templatePending ? "Applying…" : "Apply template"}
            </Button>
          </form>
          {templateMessage === null ? null : (
            <Flash variant="success">{templateMessage}</Flash>
          )}
          {governance.data === undefined ? null : (
            <p className="table-detail">
              Policy: {governance.data.policyPath}. Allowed providers:{" "}
              {governance.data.policy.providers.allowed.join(", ")}. Retry cap:{" "}
              {governance.data.policy.retries.maximum_attempts}.
            </p>
          )}
        </section>
      )}

      {repositories.data?.length === 0 ? null : (
        <section className="impact-analysis" aria-labelledby="impact-title">
          <header className="section-heading">
            <div>
              <h2 id="impact-title">Knowledge graph and impact</h2>
              <span>
                Map tracked imports, then trace a changed path into dependent
                files and active task ownership.
              </span>
            </div>
            {knowledgeSnapshot === null ? null : (
              <span className="mono">
                {knowledgeSnapshot.nodeCount} nodes ·{" "}
                {knowledgeSnapshot.edgeCount} edges
              </span>
            )}
          </header>
          <form onSubmit={(event) => void analyzeRepositoryImpact(event)}>
            <FormControl required>
              <FormControl.Label>Repository</FormControl.Label>
              <select
                value={impactRepositoryId}
                onChange={(event) => {
                  setImpactRepositoryId(event.target.value);
                  setImpactResult(null);
                }}
              >
                <option value="">Choose mapped repository</option>
                {repositories.data?.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.name}
                  </option>
                ))}
              </select>
            </FormControl>
            <FormControl required>
              <FormControl.Label>Changed file or directory</FormControl.Label>
              <TextInput
                block
                placeholder="src/contracts/"
                value={impactPath}
                onChange={(event) => {
                  setImpactPath(event.target.value);
                }}
              />
            </FormControl>
            <Button
              type="submit"
              variant="primary"
              disabled={
                impactPending ||
                impactRepositoryId.length === 0 ||
                impactPath.trim().length === 0
              }
            >
              {impactPending ? "Tracing…" : "Analyze impact"}
            </Button>
          </form>
          {impactResult === null ? null : (
            <>
              <dl className="impact-summary">
                <div>
                  <dt>Direct</dt>
                  <dd>{impactResult.summary.directFiles}</dd>
                </div>
                <div>
                  <dt>Transitive</dt>
                  <dd>{impactResult.summary.transitiveFiles}</dd>
                </div>
                <div>
                  <dt>Active tasks</dt>
                  <dd>{impactResult.summary.activeTasks}</dd>
                </div>
                <div>
                  <dt>Depth</dt>
                  <dd>{impactResult.summary.maximumDistance}</dd>
                </div>
              </dl>
              <ol className="impact-files">
                {impactResult.impactedFiles.slice(0, 50).map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    <span>
                      {file.distance === 0
                        ? "changed directly"
                        : `${file.distance} dependency hops`}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}

      {repositories.data?.length === 0 ? null : (
        <section className="visual-proof" aria-labelledby="visual-proof-title">
          <header className="section-heading">
            <div>
              <h2 id="visual-proof-title">Browser screenshot comparison</h2>
              <span>
                Capture a loopback route and compare it with a committed PNG
                baseline.
              </span>
            </div>
            {visualResult === null ? null : (
              <StatusBadge status={visualResult.status} />
            )}
          </header>
          <form onSubmit={(event) => void compareRoute(event)}>
            <FormControl required>
              <FormControl.Label>Repository</FormControl.Label>
              <select
                value={visualRepositoryId}
                onChange={(event) => {
                  setVisualRepositoryId(event.target.value);
                }}
              >
                <option value="">Choose repository</option>
                {repositories.data?.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.name}
                  </option>
                ))}
              </select>
            </FormControl>
            <FormControl required>
              <FormControl.Label>Loopback route URL</FormControl.Label>
              <TextInput
                block
                value={visualUrl}
                onChange={(event) => {
                  setVisualUrl(event.target.value);
                }}
              />
            </FormControl>
            <FormControl required>
              <FormControl.Label>Baseline path</FormControl.Label>
              <TextInput
                block
                placeholder="e2e/baselines/dashboard.png"
                value={baselinePath}
                onChange={(event) => {
                  setBaselinePath(event.target.value);
                }}
              />
              <FormControl.Caption>
                Repository-relative PNG path. Captures and diffs remain in
                AgentFlow artifacts.
              </FormControl.Caption>
            </FormControl>
            <Button
              type="submit"
              variant="primary"
              disabled={
                visualPending ||
                visualRepositoryId.length === 0 ||
                baselinePath.trim().length === 0
              }
            >
              {visualPending ? "Capturing…" : "Capture and compare"}
            </Button>
          </form>
          {visualResult === null ? null : (
            <dl className="visual-proof__result">
              <div>
                <dt>Difference</dt>
                <dd>{(visualResult.differenceRatio * 100).toFixed(3)}%</dd>
              </div>
              <div>
                <dt>Pixels</dt>
                <dd>{visualResult.differentPixels.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Viewport</dt>
                <dd>
                  {visualResult.width} × {visualResult.height}
                </dd>
              </div>
              <div>
                <dt>Evidence</dt>
                <dd className="mono">{visualResult.diffPath ?? "size mismatch"}</dd>
              </div>
            </dl>
          )}
        </section>
      )}
    </>
  );
}

function findLastBuild(
  builds: BuildSummary[],
  repositoryId: string,
): BuildSummary | null {
  return (
    builds
      .filter((build) => build.repositoryId === repositoryId)
      .sort(
        (first, second) =>
          new Date(second.createdAt).getTime() -
          new Date(first.createdAt).getTime(),
      )[0] ?? null
  );
}
