import { Button, Flash } from "@primer/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type { InitiativeSummary } from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function InitiativesScreen(): React.JSX.Element {
  const initiatives = useSWR<InitiativeSummary[]>("/api/initiatives", apiFetch, { refreshInterval: 2000 });
  async function reconcile(id: string): Promise<void> { await postJson(`/api/initiatives/${id}/reconcile`); await initiatives.mutate(); }
  return <>
    <PageTitle title="Multi-repository initiatives" description="Supervise exact repository plans, cross-project handoffs, blockers, and recovery without confusing integration with publication or deployment." />
    {initiatives.error !== undefined ? <Flash variant="danger">Initiative state could not be loaded. No completion state has been inferred.</Flash>
      : initiatives.isLoading ? <LoadingState label="Loading initiatives" height="360px" />
      : initiatives.data?.length === 0 ? <EmptyState title="No initiatives yet" description="Create an initiative through the API from two or more reviewed immutable plans." />
      : <div className="result-list">{initiatives.data?.map((initiative) => <article key={initiative.id}>
          <header><div><h2>{initiative.title}</h2><p>{initiative.objective}</p></div><StatusBadge status={initiative.status} /></header>
          <p><strong>{initiative.members.length}</strong> repositories · <strong>{initiative.dependencies.length}</strong> cross-repository handoffs</p>
          <ul>{initiative.members.map((member) => <li key={member.planId}><code>{member.repositoryId}</code> — {member.buildId === null ? "waiting for an eligible wave" : `build ${member.buildId}`}</li>)}</ul>
          {initiative.status === "running" || initiative.status === "partial" ? <Button onClick={() => { void reconcile(initiative.id); }}>Reconcile now</Button> : null}
          <details><summary>Governed identity</summary><code>{initiative.id}</code><br />Digest: <code>{initiative.digest ?? "not approved"}</code><p>Integrated work is not represented as published, deployed, or externally operational.</p></details>
        </article>)}</div>}
  </>;
}
