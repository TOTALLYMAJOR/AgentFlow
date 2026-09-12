import { Button, Checkbox, Flash, FormControl, Textarea, TextInput } from "@primer/react";
import { useState } from "react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type { InitiativeCandidate, InitiativeSummary } from "../api/types.js";
import { EmptyState } from "../components/EmptyState.js";
import { LoadingState } from "../components/LoadingState.js";
import { PageTitle } from "../components/PageTitle.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function InitiativesScreen(): React.JSX.Element {
  const initiatives = useSWR<InitiativeSummary[]>("/api/initiatives", apiFetch, { refreshInterval: 2000 });
  const candidates = useSWR<InitiativeCandidate[]>("/api/initiative-candidates", apiFetch);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [selectedPlans, setSelectedPlans] = useState<string[]>([]);
  const [ordered, setOrdered] = useState(false);
  async function act(id: string, action: "approve" | "start" | "pause" | "resume" | "cancel" | "reconcile"): Promise<void> {
    setBusy(`${id}:${action}`); setActionError(null);
    try { await postJson(`/api/initiatives/${id}/${action}`); await initiatives.mutate(); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Initiative action failed"); }
    finally { setBusy(null); }
  }
  async function cleanup(initiativeId: string, buildId: string): Promise<void> {
    setBusy(`${initiativeId}:cleanup:${buildId}`); setActionError(null);
    try { await postJson(`/api/builds/${buildId}/cleanup`, { deleteMergedBranches: true }); await initiatives.mutate(); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Build cleanup failed"); }
    finally { setBusy(null); }
  }
  async function create(event: React.SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const selected = (candidates.data ?? []).filter((candidate) => selectedPlans.includes(candidate.planId));
    if (selected.length < 2) { setActionError("Select at least two repository plans"); return; }
    setBusy("create"); setActionError(null);
    try {
      await postJson("/api/initiatives", { title: title.trim(), objective: objective.trim(), members: selected.map((candidate) => ({ planId: candidate.planId, baseCommit: candidate.baseCommit })), dependencies: ordered ? selected.slice(1).map((candidate, index) => ({ producerPlanId: selected[index]?.planId, consumerPlanId: candidate.planId, dependencyType: "hard" })) : [] });
      setTitle(""); setObjective(""); setSelectedPlans([]); await initiatives.mutate();
    } catch (error) { setActionError(error instanceof Error ? error.message : "Initiative creation failed"); }
    finally { setBusy(null); }
  }
  const latestCandidates = (candidates.data ?? []).filter((candidate, index, all) => all.findIndex((other) => other.repositoryId === candidate.repositoryId) === index);
  return <>
    <PageTitle title="Multi-repository initiatives" description="Supervise exact repository plans, cross-project handoffs, blockers, and recovery without confusing integration with publication or deployment." />
    {actionError === null ? null : <Flash variant="danger">{actionError}. No success state has been inferred.</Flash>}
    <form onSubmit={(event) => { void create(event); }}>
      <h2>Create a reviewed initiative</h2>
      <p>Select the latest immutable plan for at least two repositories. AgentFlow binds each selection to the current exact base commit before approval.</p>
      <FormControl required><FormControl.Label>Initiative title</FormControl.Label><TextInput value={title} onChange={(event) => { setTitle(event.target.value); }} /></FormControl>
      <FormControl required><FormControl.Label>Shared objective</FormControl.Label><Textarea value={objective} onChange={(event) => { setObjective(event.target.value); }} /></FormControl>
      <fieldset><legend>Repository plans</legend>{latestCandidates.map((candidate) => <FormControl key={candidate.planId}><Checkbox checked={selectedPlans.includes(candidate.planId)} onChange={(event) => { setSelectedPlans((current) => event.target.checked ? [...current, candidate.planId] : current.filter((planId) => planId !== candidate.planId)); }} /><FormControl.Label>{candidate.repositoryName} — {candidate.taskCount} tasks</FormControl.Label><FormControl.Caption>Plan <code>{candidate.planId}</code> at <code>{candidate.baseCommit.slice(0, 12)}</code></FormControl.Caption></FormControl>)}</fieldset>
      <FormControl><Checkbox checked={ordered} onChange={(event) => { setOrdered(event.target.checked); }} /><FormControl.Label>Run selected repositories in the displayed order</FormControl.Label><FormControl.Caption>Leave clear for independent repositories that may run concurrently.</FormControl.Caption></FormControl>
      <Button type="submit" variant="primary" disabled={busy !== null || title.trim().length === 0 || objective.trim().length === 0}>Create proposed initiative</Button>
    </form>
    {initiatives.error !== undefined ? <Flash variant="danger">Initiative state could not be loaded. No completion state has been inferred.</Flash>
      : initiatives.isLoading ? <LoadingState label="Loading initiatives" height="360px" />
      : initiatives.data?.length === 0 ? <EmptyState title="No initiatives yet" description="Create an initiative through the API from two or more reviewed immutable plans." />
      : <div className="result-list">{initiatives.data?.map((initiative) => <article key={initiative.id}>
          <header><div><h2>{initiative.title}</h2><p>{initiative.objective}</p></div><StatusBadge status={initiative.status} /></header>
          <p><strong>{initiative.members.length}</strong> repositories · <strong>{initiative.dependencies.length}</strong> cross-repository handoffs</p>
          <ul>{initiative.members.map((member) => <li key={member.planId}><code>{member.repositoryId}</code> — {member.buildId === null ? "waiting for an eligible wave" : `build ${member.buildId}`}</li>)}</ul>
          {initiative.dependencies.length === 0 ? <p>No cross-repository ordering constraints; eligible repositories may run concurrently.</p> : <details><summary>Cross-repository handoffs</summary><ul>{initiative.dependencies.map((dependency) => <li key={`${dependency.producerPlanId}:${dependency.consumerPlanId}:${dependency.dependencyType}`}><code>{dependency.producerPlanId}</code> → <code>{dependency.consumerPlanId}</code> · {dependency.dependencyType}{dependency.artifactName === undefined ? "" : ` · ${dependency.artifactName}@${dependency.artifactVersion ?? "unknown"}`}{dependency.sharedResource === undefined ? "" : ` · shared ${dependency.sharedResource}`}</li>)}</ul></details>}
          {initiative.blockers.length === 0 ? null : <section aria-label="Blocked repositories"><h3>Blocked work</h3><ul>{initiative.blockers.map((blocker) => <li key={`${blocker.planId}:${blocker.code}`}><strong>{blocker.message}</strong><br />Recovery: {blocker.recovery}</li>)}</ul></section>}
          <div aria-label="Initiative controls">
            {initiative.status === "proposed" ? <Button disabled={busy !== null} onClick={() => { void act(initiative.id, "approve"); }}>Approve reviewed initiative</Button> : null}
            {initiative.status === "approved" ? <Button disabled={busy !== null} onClick={() => { void act(initiative.id, "start"); }}>Start eligible repositories</Button> : null}
            {initiative.status === "running" ? <Button disabled={busy !== null} onClick={() => { void act(initiative.id, "pause"); }}>Pause initiative</Button> : null}
            {initiative.status === "paused" ? <Button disabled={busy !== null} onClick={() => { void act(initiative.id, "resume"); }}>Resume initiative</Button> : null}
            {initiative.status === "running" || initiative.status === "partial" ? <Button disabled={busy !== null} onClick={() => { void act(initiative.id, "reconcile"); }}>Reconcile now</Button> : null}
            {["proposed", "approved", "running", "paused", "partial"].includes(initiative.status) ? <Button variant="danger" disabled={busy !== null} onClick={() => { void act(initiative.id, "cancel"); }}>Cancel initiative</Button> : null}
          </div>
          {initiative.cleanup.length === 0 ? null : <details><summary>Terminal Git cleanup</summary>{initiative.cleanup.map((entry) => <section key={entry.buildId}><h3>Build <code>{entry.buildId}</code></h3><p>{entry.status === "completed" ? `Eligible after ${entry.eligibleAt ?? "recorded completion"}` : `Preserved while build is ${entry.status}`}</p>{entry.status === "completed" ? <Button disabled={busy !== null} onClick={() => { void cleanup(initiative.id, entry.buildId); }}>Clean eligible local branches</Button> : null}{entry.receipts.length === 0 ? <p>No cleanup decision recorded.</p> : <ul>{entry.receipts.map((receipt) => <li key={receipt.sequence}>{receipt.action}: <code>{receipt.target}</code> — {receipt.reason}</li>)}</ul>}</section>)}</details>}
          <details><summary>Governed identity</summary><code>{initiative.id}</code><br />Digest: <code>{initiative.digest ?? "not approved"}</code><p>Integrated work is not represented as published, deployed, or externally operational.</p></details>
        </article>)}</div>}
  </>;
}
