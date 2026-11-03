import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../src/integration/design-intelligence.js";
import { evaluateGovernor } from "../src/governor/control-service.js";
import { bindTrafficControlContract, fingerprintFailure, projectAgentFlowObservation, type AgentFlowObservationInput, type TrafficControlFailure } from "../src/integration/traffic-control.js";
import { approvedGovernedHandoff } from "./helpers/governed-handoff.js";

const handoff = approvedGovernedHandoff({
  handoffId: "DI-TCP-001",
  baseCommit: "a".repeat(40),
  remote: "repo-1",
  objective: "Exercise a native governed AgentFlow observation.",
  tasks: [
    { id: "AF-001", title: "First", description: "First governed task.", estimateHours: 1, dependsOn: [], owns: ["src/first"], acceptanceCriteria: ["First passes"], validate: ["npm test"], produces: [], consumes: [] },
    { id: "AF-002", title: "Second", description: "Second governed task.", estimateHours: 1, dependsOn: ["AF-001"], owns: ["src/second"], acceptanceCriteria: ["Second passes"], validate: ["npm test"], produces: [], consumes: [] },
  ],
  requiredEvidence: ["focused-tests"], claimBoundary: "Local integration proof only.",
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

  const failure: TrafficControlFailure = { code: "TEST_FAILED", classification: "deterministic", retryable: false, signature: "same", fingerprint: "" };
  function failureInput(): AgentFlowObservationInput {
    return { contract: bindTrafficControlContract(handoff), buildId: "build", phase: "RUNNING", attempt: 2, maxAttempts: 3, authority, taskChanges: [], impactedPaths: [], activeTaskCollisions: [], evidence: { items: [], satisfied: [], contradictory: [] }, failures: [failure, failure] };
  }

  // TCP-002 reference fixture at Traffic Control 53488c8: volatile run paths and
  // pointers describe one failure, while its HTTP status and semantic identity stay material.
  const volatileFailures: TrafficControlFailure[] = [
    "HTTP status 401 at /tmp/run-1/test.ts:42:9 pointer 0x1abc",
    "HTTP status 401 at /tmp/run-2/test.ts:42:9 pointer 0x2abc",
    "HTTP status 401 at /tmp/run-3/test.ts:42:9 pointer 0x3abc",
  ].map((signature) => ({ ...failure, validation: "inert-check", signature, files: ["src/a/index.ts"], requirementId: "REQ-INERT" }));

  it.each(volatileFailures)("matches the reference failure identity for $signature", (item) => {
    expect(fingerprintFailure(item)).toBe("5923295a4ebabadd226cf218fd6575d35fbfa44bcfc834a8823f003595f62a30");
  });

  it("proposes reconsideration after three identical failures with volatile run paths and pointers", () => {
    const input = { ...failureInput(), attempt: 3, maxAttempts: 4, failures: volatileFailures };
    const observation = projectAgentFlowObservation(input);
    expect(observation.failureRepeatCount).toBe(3);
    expect(observation.failureHistory.map((item) => item.signature)).toEqual(volatileFailures.map((item) => item.signature));
    expect(evaluateGovernor(input.contract, observation)).toMatchObject({
      action: "PROPOSE_REPLAN", authorityEffect: "PROPOSAL_ONLY", requiresApproval: true,
    });
  });

  it.each<{ name: string; change: Partial<TrafficControlFailure> }>([
    { name: "HTTP status", change: { signature: "HTTP status 500 at /tmp/run-4/test.ts:42:9 pointer 0x4abc" } },
    { name: "source file below the temporary run directory", change: { signature: "HTTP status 401 at /tmp/run-4/other.ts:42:9 pointer 0x4abc" } },
    { name: "failure code", change: { code: "OTHER_FAILURE" } },
    { name: "validation command", change: { validation: "other-check" } },
    { name: "changed file identity", change: { files: ["src/b/index.ts"] } },
    { name: "requirement identity", change: { requirementId: "REQ-OTHER" } },
  ])("does not combine repeated failures with a different $name", ({ change }) => {
    const currentFailure = { ...failure, validation: "inert-check", signature: "HTTP status 401 at /tmp/run-4/test.ts:42:9 pointer 0x4abc", files: ["src/a/index.ts"], requirementId: "REQ-INERT", ...change };
    const input = { ...failureInput(), attempt: 3, maxAttempts: 4, failures: volatileFailures, currentFailure };
    const observation = projectAgentFlowObservation(input);
    expect(observation.failureRepeatCount).toBe(0);
    expect(evaluateGovernor(input.contract, observation).action).toBe("REQUEST_REPAIR");
  });

  it("explicit null means no active failure while preserving full normalized history", () => {
    const observation = projectAgentFlowObservation({ ...failureInput(), currentFailure: null });
    expect(observation.failure).toBeNull();
    expect(observation.failureRepeatCount).toBe(0);
    expect(observation.failureHistory).toHaveLength(2);
    expect(observation.failureHistory[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omitted and undefined current failure preserve legacy fallback", () => {
    for (const input of [failureInput(), { ...failureInput(), currentFailure: undefined }]) {
      const observation = projectAgentFlowObservation(input);
      expect(observation.failure?.code).toBe("TEST_FAILED");
      expect(observation.failureRepeatCount).toBe(2);
    }
  });

  it("normalizes explicit current failure and counts matching history without replacing it", () => {
    const observation = projectAgentFlowObservation({ ...failureInput(), currentFailure: { ...failure, code: "OTHER", signature: "new" } });
    expect(observation.failure?.code).toBe("OTHER");
    expect(observation.failure?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(observation.failureRepeatCount).toBe(0);
    expect(observation.failureHistory.map((item) => item.code)).toEqual(["TEST_FAILED", "TEST_FAILED"]);
    const repeated = projectAgentFlowObservation({ ...failureInput(), currentFailure: failure });
    expect(repeated.failureRepeatCount).toBe(2);
  });
});
