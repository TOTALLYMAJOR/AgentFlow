import {
  canonicalJsonSha256,
  GovernedTaskHandoffSchema,
  type GovernedTaskHandoff,
} from "../../src/integration/design-intelligence.js";

interface GovernedTaskInput {
  id: string;
  title: string;
  description: string;
  estimateHours: number;
  dependsOn: string[];
  owns: string[];
  acceptanceCriteria: string[];
  validate: string[];
  produces: [];
  consumes: [];
}

export function approvedGovernedHandoff(input: {
  handoffId: string;
  baseCommit: string;
  objective: string;
  tasks: GovernedTaskInput[];
  requiredEvidence: string[];
  claimBoundary: string;
  remote?: string;
}): GovernedTaskHandoff {
  const sources = [{ path: "AGENTS.md", sha256: "e".repeat(64) }];
  const authorityStateSha256 = "c".repeat(64);
  const governanceReportSha256 = "d".repeat(64);
  const snapshotSha256 = canonicalJsonSha256({
    baseCommit: input.baseCommit,
    worktreeState: "clean",
    authorityStateSha256,
    governanceReportSha256,
    sources,
  });
  const proposed = {
    schemaVersion: "2.1.0" as const,
    kind: "design-intelligence/governed-task-handoff" as const,
    handoffId: input.handoffId,
    createdAt: "2026-10-16T12:00:00Z",
    repository: {
      baseCommit: input.baseCommit,
      snapshotSha256,
      worktreeState: "clean" as const,
      ...(input.remote === undefined ? {} : { remote: input.remote }),
    },
    objective: input.objective,
    authority: {
      status: "PROPOSED" as const,
      stateSha256: authorityStateSha256,
      governanceReportSha256,
      sources,
    },
    tasks: input.tasks,
    proof: { requiredEvidence: input.requiredEvidence, claimBoundary: input.claimBoundary },
  };
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const validUntil = new Date(Date.now() + 60 * 60_000).toISOString();
  const receiptWithoutId = {
    schemaVersion: 1 as const,
    kind: "proofloom/execution-approval-receipt" as const,
    receiptType: "EXECUTION_APPROVAL" as const,
    policyVersion: "human-authority/v1" as const,
    decision: "APPROVED" as const,
    sessionId: "governor-test-session",
    authority: { actorId: "human:test-owner", role: "repository-owner" as const, basis: "focused integration test" },
    repositoryRevision: input.baseCommit,
    artifact: {
      kind: "design-intelligence/governed-task-handoff-scope" as const,
      id: input.handoffId,
      sha256: canonicalJsonSha256(proposed),
    },
    scope: {
      repository: "." as const,
      paths: [...new Set(input.tasks.flatMap((task) => task.owns))],
      actions: ["execute-governed-handoff"],
    },
    governingSources: sources,
    issuedAt,
    validUntil,
    supersedes: null,
    transition: { handoffId: input.handoffId },
    constraints: {
      allowedActions: ["execute-governed-handoff"],
      requiredEvidence: input.requiredEvidence,
      escalationConditions: ["authority drift"],
      resourceCeilings: { wallClockMinutes: 60 },
      iterationCeiling: 1,
      revocationAuthorityRoles: ["repository-owner" as const],
    },
    mutationPerformed: false as const,
  };
  const approvalReceipt = {
    ...receiptWithoutId,
    receiptId: `HAR-${canonicalJsonSha256(receiptWithoutId).slice(0, 20).toUpperCase()}`,
  };
  return GovernedTaskHandoffSchema.parse({
    ...proposed,
    authority: {
      ...proposed.authority,
      status: "APPROVED",
      approvedBy: "human:test-owner",
      approvedAt: issuedAt,
      approvalReceipt,
    },
  });
}
