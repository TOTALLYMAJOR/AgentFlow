import { useState } from "react";
import { Button, Flash, FormControl, TextInput } from "@primer/react";
import { ArrowClockwiseIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type { RepositorySummary } from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function RepositoriesScreen(): React.JSX.Element {
  const repositories = useSWR<RepositorySummary[]>(
    "/api/repositories",
    apiFetch,
  );
  const [path, setPath] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function registerRepository(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await postJson("/api/repositories", { path });
      setPath("");
      setShowForm(false);
      await repositories.mutate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Registration failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function inspectRepository(id: string): Promise<void> {
    await postJson(`/api/repositories/${id}/inspect`);
    await repositories.mutate();
  }

  async function removeRepository(id: string): Promise<void> {
    await apiFetch(`/api/repositories/${id}`, { method: "DELETE" });
    await repositories.mutate();
  }

  return (
    <>
      <PageTitle
        title="Repositories"
        description="Register local Git repositories. Removal changes AgentFlow metadata only and never deletes source."
        actions={
          <Button
            variant="primary"
            leadingVisual={PlusIcon}
            onClick={() => {
              setShowForm((current) => !current);
            }}
          >
            Add repository
          </Button>
        }
      />

      {showForm ? (
        <form className="inline-form" onSubmit={(event) => void registerRepository(event)}>
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
          {error === null ? null : <Flash variant="danger">{error}</Flash>}
          <Button variant="primary" type="submit" disabled={submitting}>
            {submitting ? "Inspecting..." : "Register"}
          </Button>
        </form>
      ) : null}

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
        <div className="table-shell" role="region" aria-label="Repositories" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Branch</th>
                <th scope="col">Stack</th>
                <th scope="col">Health</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {repositories.data?.map((repository) => (
                <tr key={repository.id}>
                  <td>
                    <strong>{repository.name}</strong>
                    <span className="path-text">{repository.localPath}</span>
                  </td>
                  <td className="mono">{repository.baseBranch}</td>
                  <td>
                    {[
                      repository.detectedStack.packageManager,
                      ...repository.detectedStack.frameworks,
                    ]
                      .filter(Boolean)
                      .join(", ") || "not detected"}
                  </td>
                  <td>
                    <StatusBadge status={repository.status} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <Button
                        size="small"
                        leadingVisual={ArrowClockwiseIcon}
                        onClick={() => void inspectRepository(repository.id)}
                      >
                        Inspect
                      </Button>
                      <Button
                        size="small"
                        variant="danger"
                        leadingVisual={TrashIcon}
                        onClick={() => void removeRepository(repository.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
