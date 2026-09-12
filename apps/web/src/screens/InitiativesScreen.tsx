import { Button, Flash } from "@primer/react";
import { useState } from "react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type { InitiativeSummary } from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function InitiativesScreen(): React.JSX.Element {
  const initiatives = useSWR<InitiativeSummary[]>("/api/initiatives", apiFetch, { refreshInterval: 2000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  async function act(id: string, action: "approve" | "start" | "pause" | "resume" | "cancel" | "reconcile"): Promise<void> {
    setBusy(`${id}:${action}`); setActionError(null);
    try { await postJson(`/api/initiatives/${id}/${action}`); await initiatives.mutate(); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Initiative action failed"); }
    finally { setBusy(null); }
  }
  return <>
    <PageTitle title="Multi-repository initiatives" description="Supervise exact repository plans, cross-project handoffs, blockers, and recovery without confusing integration with publication or deployment." />
    {actionError === null ? null : <Flash variant="danger">{actionError}. No success state has been inferred.</Flash>}
    {initiatives.error !== undefined ? <Flash variant="danger">Initiative state could not be loaded. No completion state has been inferred.</Flash>
      : initiatives.isLoading ? <LoadingState label="Loading initiatives" height="360px" />
      : initiatives.data?.length === 0 ? <EmptyState title="No initiatives yet" description="Create an initiative through the API from two or more reviewed immutable plans." />
      : <div className="result-list">{initiatives.data?.map((initiative) => <article key={initiative.id}>
          <header><div><h2>{initiative.title}</h2><p>{initiative.objective}</p></div><StatusBadge status={initiative.status} /></header>
          <p><strong>{initiative.members.length}</strong> repositories · <strong>{initiative.dependencies.length}</strong> cross-repository handoffs</p>
          <ul>{initiative.members.map((member) => <li key={member.planId}><code>{member.repositoryId}</code> — {member.buildId === null ? "waiting for an eligible wave" : `build ${member.buildId}`}</li>)}</ul>
          {initiative.blockers.length === 0 ? null : <section aria-label="Blocked repositories"><h3>Blocked work</h3><ul>{initiative.blockers.map((blocker) => <li key={`${blocker.planId}:${blocker.code}`}><strong>{blocker.message}</strong><br />Recovery: {blocker.recovery}</li>)}</ul></section>}
          <div aria-label="Initiative controls">
            {initiative.status === "proposed" ? <Button disabled={busy !== null} onClick={() => { void act(initiative.id, "approve"); }}>Approve reviewed initiative</Button> : null}
            {initiative.status === "approved" ? <Button disabled={busy !== null} onClick={() => { void act(initiative.id, "start"); }}>Start eligible repositories</Button> : null}
            {initiative.status === "running" ? <Button disabled={busy !== null} onClick={() => { void act(initiative.id, "pause"); }}>Pause initiative</Button> : null}
            {initiative.status === "paused" ? <Button disabled={busy !== null} onClick={() => { void act(initiative.id, "resume"); }}>Resume initiative</Button> : null}
            {initiative.status === "running" || initiative.status === "partial" ? <Button disabled={busy !== null} onClick={() => { void act(initiative.id, "reconcile"); }}>Reconcile now</Button> : null}
            {["proposed", "approved", "running", "paused", "partial"].includes(initiative.status) ? <Button variant="danger" disabled={busy !== null} onClick={() => { void act(initiative.id, "cancel"); }}>Cancel initiative</Button> : null}
          </div>
          <details><summary>Governed identity</summary><code>{initiative.id}</code><br />Digest: <code>{initiative.digest ?? "not approved"}</code><p>Integrated work is not represented as published, deployed, or externally operational.</p></details>
        </article>)}</div>}
  </>;
}
