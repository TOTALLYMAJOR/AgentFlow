import { canonicalJsonSha256, type GovernedTaskHandoff } from "./design-intelligence.js";

export interface TrafficControlContract {
  document: GovernedTaskHandoff;
  binding: {
    algorithm: "sha256";
    id: string;
    sha256: string;
    baseCommit: string;
    snapshotSha256: string;
    proofBoundary: string;
    repositoryId: string | null;
  };
}

export interface TrafficControlAuthority {
  approvalAuthority: "HUMAN_OR_REPOSITORY";
  handoffId: string;
  handoffSha256: string;
  repositoryId: string | null;
  baseCommit: string;
  snapshotSha256: string;
  worktreeState: "clean";
  authorityStateSha256: string;
  governanceReportSha256: string;
  authoritySources: Array<{ path: string; sha256: string }>;
}

export interface TrafficControlFailure {
  code: string;
  classification: "deterministic" | "transient" | "unknown";
  retryable: boolean;
  signature: string;
  validation?: string | null;
  files?: string[];
  requirementId?: string | null;
  fingerprint: string;
}

export interface TrafficControlObservation {
  schema: "traffic-control/execution-observation@1";
  buildId: string;
  phase: "PENDING" | "RUNNING" | "INTEGRATING" | "INTEGRATED";
  attempt: number;
  maxAttempts: number;
  authority: TrafficControlAuthority | null;
  evidence: { items: string[]; satisfied: string[]; contradictory: string[] };
  changedPaths: string[];
  impactedPaths: string[];
  activeTaskCollisions: string[];
  failure: TrafficControlFailure | null;
  failureHistory: TrafficControlFailure[];
  failureRepeatCount: number;
  evidenceDelta: { newItems: string[]; newlySatisfied: string[]; newContradictions: string[]; score: number; direction: "POSITIVE" | "NEGATIVE" | "ZERO" };
  impactDelta: { unexpectedChangedPaths: string[]; unexpectedImpactedPaths: string[]; activeTaskCollisions: string[]; expanded: boolean };
  structuralConcern: { reason: string; source: string } | null;
}

export interface AgentFlowObservationInput {
  contract: TrafficControlContract;
  buildId: string;
  phase: TrafficControlObservation["phase"];
  attempt: number;
  maxAttempts: number;
  authority: TrafficControlAuthority;
  taskChanges: Array<{ taskId: string | null; paths: string[] }>;
  impactedPaths: string[];
  activeTaskCollisions: string[];
  evidence: TrafficControlObservation["evidence"];
  failures: TrafficControlFailure[];
  previousEvidence?: TrafficControlObservation["evidence"];
  structuralConcern?: { reason: string; source?: string } | null;
}

export function bindTrafficControlContract(handoff: GovernedTaskHandoff): TrafficControlContract {
  return {
    document: structuredClone(handoff),
    binding: {
      algorithm: "sha256",
      id: handoff.handoffId,
      sha256: canonicalJsonSha256(handoff),
      baseCommit: handoff.repository.baseCommit,
      snapshotSha256: handoff.repository.snapshotSha256,
      proofBoundary: handoff.proof.claimBoundary,
      repositoryId: handoff.repository.remote ?? null,
    },
  };
}

export function projectAgentFlowObservation(input: AgentFlowObservationInput): TrafficControlObservation {
  requireAuthority(input.authority);
  if (!input.buildId || !Number.isInteger(input.attempt) || input.attempt < 0 || !Number.isInteger(input.maxAttempts) || input.maxAttempts < input.attempt) {
    throw new TypeError("Authoritative build identity and retry facts are required");
  }
  const tasks = new Map(input.contract.document.tasks.map((task) => [task.id, task]));
  const changedPaths = sortedUnique(input.taskChanges.flatMap((change) => change.paths));
  const unexpectedByTask = input.taskChanges.flatMap((change) => {
    const task = change.taskId === null ? undefined : tasks.get(change.taskId);
    if (task === undefined) return change.paths;
    return change.paths.filter((changedPath) => !pathAllowed(changedPath, task.owns));
  });
  const plannedPaths = input.contract.document.tasks.flatMap((task) => task.owns);
  const unexpectedChangedPaths = sortedUnique([
    ...changedPaths.filter((changedPath) => !pathAllowed(changedPath, plannedPaths)),
    ...unexpectedByTask,
  ]);
  const unexpectedImpactedPaths = sortedUnique(input.impactedPaths.filter((impactedPath) => !pathAllowed(impactedPath, plannedPaths)));
  const collisions = sortedUnique(input.activeTaskCollisions);
  const evidence = normalizeEvidence(input.evidence);
  const delta = evidenceDelta(normalizeEvidence(input.previousEvidence ?? { items: [], satisfied: [], contradictory: [] }), evidence);
  const failureHistory = input.failures.map((failure) => ({ ...failure, fingerprint: failure.fingerprint || fingerprintFailure(failure) }));
  const failure = failureHistory.at(-1) ?? null;
  const repeatCount = failure === null ? 0 : failureHistory.filter((candidate) => candidate.fingerprint === failure.fingerprint).length;
  return {
    schema: "traffic-control/execution-observation@1",
    buildId: input.buildId,
    phase: input.phase,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    authority: structuredClone(input.authority),
    evidence,
    changedPaths,
    impactedPaths: sortedUnique(input.impactedPaths),
    activeTaskCollisions: collisions,
    failure,
    failureHistory,
    failureRepeatCount: repeatCount,
    evidenceDelta: delta,
    impactDelta: {
      unexpectedChangedPaths,
      unexpectedImpactedPaths,
      activeTaskCollisions: collisions,
      expanded: unexpectedChangedPaths.length > 0 || unexpectedImpactedPaths.length > 0 || collisions.length > 0,
    },
    structuralConcern: input.structuralConcern === undefined || input.structuralConcern === null ? null : { reason: input.structuralConcern.reason, source: input.structuralConcern.source ?? "execution-evidence" },
  };
}

export function fingerprintFailure(failure: Omit<TrafficControlFailure, "fingerprint"> | TrafficControlFailure): string {
  return canonicalJsonSha256({
    code: failure.code || "UNKNOWN",
    classification: failure.classification,
    validation: failure.validation ?? null,
    signature: failure.signature.toLowerCase().replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>").replace(/:\d+(?::\d+)?\b/g, ":<line>").replace(/\s+/g, " ").trim(),
    files: sortedUnique(failure.files ?? []),
    requirementId: failure.requirementId ?? null,
  });
}

function requireAuthority(authority: TrafficControlAuthority): void {
  if (!authority.handoffId || !/^[0-9a-f]{64}$/.test(authority.handoffSha256)) throw new TypeError("An authoritative handoff digest is required");
  if (!/^[0-9a-f]{40}$/.test(authority.baseCommit) || !/^[0-9a-f]{64}$/.test(authority.snapshotSha256)) throw new TypeError("Authoritative repository snapshot facts are required");
  if (!/^[0-9a-f]{64}$/.test(authority.authorityStateSha256) || !/^[0-9a-f]{64}$/.test(authority.governanceReportSha256) || authority.authoritySources.length === 0) throw new TypeError("Authoritative governance provenance is required");
}

function normalizeEvidence(value: TrafficControlObservation["evidence"]): TrafficControlObservation["evidence"] {
  return { items: sortedUnique(value.items), satisfied: sortedUnique(value.satisfied), contradictory: sortedUnique(value.contradictory) };
}

function evidenceDelta(previous: TrafficControlObservation["evidence"], current: TrafficControlObservation["evidence"]): TrafficControlObservation["evidenceDelta"] {
  const newItems = difference(current.items, previous.items);
  const newlySatisfied = difference(current.satisfied, previous.satisfied);
  const newContradictions = difference(current.contradictory, previous.contradictory);
  const score = newItems.length + newlySatisfied.length * 2 - newContradictions.length * 2;
  return { newItems, newlySatisfied, newContradictions, score, direction: score > 0 ? "POSITIVE" : score < 0 ? "NEGATIVE" : "ZERO" };
}

function difference(current: string[], previous: string[]): string[] { const existing = new Set(previous); return sortedUnique(current.filter((value) => !existing.has(value))); }
function sortedUnique(values: readonly string[]): string[] { return [...new Set(values)].sort(); }
function pathAllowed(candidate: string, roots: readonly string[]): boolean { return roots.some((root) => { const normalized = root.replace(/\/+$/u, ""); return candidate === normalized || candidate.startsWith(`${normalized}/`); }); }
