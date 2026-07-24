import { useState } from "react";
import { Button, Flash, FormControl, TextInput } from "@primer/react";
import {
  ArrowClockwiseIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type {
  BuildSummary,
  RepositorySummary,
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
  const [path, setPath] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingRepositoryId, setPendingRepositoryId] = useState<string | null>(
    null,
  );
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (repositories.error !== undefined) {
    return (
      <>
        <PageTitle
          title="Repositories"
          description="Register local Git repositories. Removal changes AgentFlow metadata only and never deletes source."
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
          title="Repositories"
          description="Register local Git repositories. Removal changes AgentFlow metadata only and never deletes source."
        />
        <LoadingState label="Loading repository registry" />
      </>
    );
  }

  return (
    <>
      <PageTitle
        title="Repositories"
        description="Register local Git repositories. Removal changes AgentFlow metadata only and never deletes source."
        actions={
          <Button
            variant="primary"
            leadingVisual={showForm ? XIcon : PlusIcon}
            onClick={() => {
              setShowForm((current) => !current);
              setError(null);
            }}
          >
            {showForm ? "Close form" : "Add repository"}
          </Button>
        }
      />

      {showForm ? (
        <form
          className="inline-form"
          onSubmit={(event) => void registerRepository(event)}
        >
          <FormControl required>
            <FormControl.Label>Absolute repository path</FormControl.Label>
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
            {submitting ? "Inspecting…" : "Register"}
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
          title="No repositories registered"
          description="AgentFlow stores only registry metadata and operational state outside the source repository."
          actionLabel="Add repository"
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
