import { describe, expect, it } from "vitest";
import { GovernedTaskHandoffSchema, canonicalJsonSha256 } from "../src/integration/design-intelligence.js";
import { bindTrafficControlContract, projectAgentFlowObservation } from "../src/integration/traffic-control.js";

const handoff = GovernedTaskHandoffSchema.parse({
  schemaVersion: "2.0.0",
  kind: "design-intelligence/governed-task-handoff",
  handoffId: "DI-TCP-001",
  createdAt: "2026-09-17T12:00:00Z",
  repository: { baseCommit: "a".repeat(40), snapshotSha256: "b".repeat(64), worktreeState: "clean", remote: "repo-1" },
  objective: "Exercise a native governed AgentFlow observation.",
  authority: {
    status: "APPROVED",
    approvedBy: "owner",
    approvedAt: "2026-09-17T12:01:00Z",
    stateSha256: "c".repeat(64),
    governanceReportSha256: "d".repeat(64),
    sources: [{ path: "AGENTS.md", sha256: "e".repeat(64) }],
  },
  tasks: [
    { id: "AF-001", title: "First", description: "First governed task.", estimateHours: 1, dependsOn: [], owns: ["src/first"], acceptanceCriteria: ["First passes"], validate: ["npm test"], produces: [], consumes: [] },
    { id: "AF-002", title: "Second", description: "Second governed task.", estimateHours: 1, dependsOn: ["AF-001"], owns: ["src/second"], acceptanceCriteria: ["Second passes"], validate: ["npm test"], produces: [], consumes: [] },
  ],
  proof: { requiredEvidence: ["focused-tests"], claimBoundary: "Local integration proof only." },
});

const authority = {
  approvalAuthority: "HUMAN_OR_REPOSITORY" as const,
  handoffId: handoff.handoffId,
  handoffSha256: canonicalJsonSha256(handoff),
  repositoryId: "repo-1",
  baseCommit: handoff.repository.baseCommit,
  snapshotSha256: handoff.repository.snapshotSha256,
  worktreeState: "clean" as const,
  authorityStateSha256: handoff.authority.stateSha256,
  governanceReportSha256: handoff.authority.governanceReportSha256,
  authoritySources: handoff.authority.sources,
};

describe("AgentFlow Traffic Control observation adapter", () => {
  it("projects authoritative task, evidence, and impact facts", () => {
    const contract = bindTrafficControlContract(handoff);
    const observation = projectAgentFlowObservation({
      contract,
      buildId: "build-1",
      phase: "INTEGRATED",
      attempt: 1,
      maxAttempts: 3,
      authority,
      taskChanges: [
        { taskId: "AF-001", paths: ["src/first/index.ts"] },
        { taskId: "AF-002", paths: ["src/second/index.ts"] },
      ],
      impactedPaths: ["src/first/index.ts"],
      activeTaskCollisions: [],
      evidence: { items: ["validation-1"], satisfied: ["focused-tests"], contradictory: [] },
      failures: [],
    });

    expect(observation).toMatchObject({
      schema: "traffic-control/execution-observation@1",
      buildId: "build-1",
      phase: "INTEGRATED",
      changedPaths: ["src/first/index.ts", "src/second/index.ts"],
      impactDelta: { unexpectedChangedPaths: [], unexpectedImpactedPaths: [], activeTaskCollisions: [], expanded: false },
    });
  });

  it("fails closed when multi-task changes lose task attribution", () => {
    const contract = bindTrafficControlContract(handoff);
    const observation = projectAgentFlowObservation({
      contract,
      buildId: "build-1",
      phase: "RUNNING",
      attempt: 1,
      maxAttempts: 3,
      authority,
      taskChanges: [{ taskId: null, paths: ["src/first/index.ts"] }],
      impactedPaths: [],
      activeTaskCollisions: [],
      evidence: { items: [], satisfied: [], contradictory: [] },
      failures: [],
    });
    expect(observation.impactDelta.unexpectedChangedPaths).toEqual(["src/first/index.ts"]);
  });

  it("rejects missing authoritative identity instead of synthesizing it", () => {
    const contract = bindTrafficControlContract(handoff);
    expect(() => projectAgentFlowObservation({
      contract,
      buildId: "build-1",
      phase: "RUNNING",
      attempt: 1,
      maxAttempts: 3,
      authority: { ...authority, handoffSha256: "" },
      taskChanges: [], impactedPaths: [], activeTaskCollisions: [],
      evidence: { items: [], satisfied: [], contradictory: [] }, failures: [],
    })).toThrow("authoritative handoff digest");
  });
});
