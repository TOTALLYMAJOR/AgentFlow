import { describe, expect, it, vi } from "vitest";
import { GovernorControlService } from "../src/governor/control-service.js";
import { applyGovernorDecision } from "../src/governor/runtime-adapter.js";
import { bindTrafficControlContract, type TrafficControlObservation } from "../src/integration/traffic-control.js";
import { approvedGovernedHandoff } from "./helpers/governed-handoff.js";

const governedHandoff = approvedGovernedHandoff({
  handoffId: "DI-1", baseCommit: "b".repeat(40), objective: "Exercise deterministic Governor controls.",
  tasks: [{ id: "AF-001", title: "Task", description: "Governed task.", estimateHours: 1, dependsOn: [], owns: ["src/"], acceptanceCriteria: ["Passes"], validate: ["npm test"], produces: [], consumes: [] }],
  requiredEvidence: ["focused-tests"], claimBoundary: "Local only.",
});
const contract = bindTrafficControlContract(governedHandoff);
const authority = {
  approvalAuthority: "HUMAN_OR_REPOSITORY" as const, handoffId: contract.binding.id, handoffSha256: contract.binding.sha256, repositoryId: null,
  baseCommit: contract.binding.baseCommit, snapshotSha256: contract.binding.snapshotSha256, worktreeState: "clean" as const,
  authorityStateSha256: governedHandoff.authority.stateSha256, governanceReportSha256: governedHandoff.authority.governanceReportSha256,
  authoritySources: governedHandoff.authority.sources,
};

function observation(overrides: Partial<TrafficControlObservation> = {}): TrafficControlObservation {
  return {
    schema: "traffic-control/execution-observation@1", buildId: "build-1", phase: "RUNNING", attempt: 1, maxAttempts: 3,
    authority, evidence: { items: [], satisfied: [], contradictory: [] }, changedPaths: [], impactedPaths: [], activeTaskCollisions: [],
    failure: null, failureHistory: [], failureRepeatCount: 0,
    evidenceDelta: { newItems: [], newlySatisfied: [], newContradictions: [], score: 0, direction: "ZERO" },
    impactDelta: { unexpectedChangedPaths: [], unexpectedImpactedPaths: [], activeTaskCollisions: [], expanded: false }, structuralConcern: null,
    ...overrides,
  };
}

describe("Governor control service", () => {
  it("persists a hash-linked deterministic decision", () => {
    const append = vi.fn();
    const service = new GovernorControlService({ append });
    const result = service.evaluate({ contract, observation: observation(), recordedAt: "2026-09-17T12:00:00Z" });
    expect(result.decision).toMatchObject({ policyVersion: "governor.v1", action: "CONTINUE", ruleId: "entitled-to-continue" });
    expect(result.record.recordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ buildId: "build-1", type: "governor.decision" }));
  });

  it("fails closed for missing proof at integration", () => {
    const service = new GovernorControlService({ append: vi.fn() });
    const result = service.evaluate({ contract, observation: observation({ phase: "INTEGRATING" }), recordedAt: "2026-09-17T12:00:00Z" });
    expect(result.decision).toMatchObject({ action: "BLOCK_INTEGRATION", ruleId: "required-evidence-missing" });
  });

  it("keeps structural replan proposal-only", async () => {
    const service = new GovernorControlService({ append: vi.fn() });
    const failure = { code: "TEST_FAILED", classification: "deterministic" as const, retryable: false, signature: "same", fingerprint: "f".repeat(64) };
    const result = service.evaluate({ contract, observation: observation({ failure, failureHistory: [failure, failure, failure], failureRepeatCount: 3 }), recordedAt: "2026-09-17T12:00:00Z" });
    expect(result.decision).toMatchObject({ action: "PROPOSE_REPLAN", authorityEffect: "PROPOSAL_ONLY", requiresApproval: true });
    const proposeReplan = vi.fn().mockResolvedValue({ acknowledged: true });
    await applyGovernorDecision(result.decision, { proposeReplan });
    expect(proposeReplan).toHaveBeenCalledOnce();
  });

  it("delegates retry through the supplied AgentFlow runtime port", async () => {
    const delegateRetry = vi.fn().mockResolvedValue({ acknowledged: true });
    await applyGovernorDecision({ policyVersion: "governor.v1", action: "DELEGATE_RETRY", ruleId: "runtime-retry-eligible", authorityEffect: "NONE", requiresApproval: false, signals: {} }, { delegateRetry });
    expect(delegateRetry).toHaveBeenCalledOnce();
  });

  it("replay never persists or mutates live execution", async () => {
    const append = vi.fn();
    const service = new GovernorControlService({ append });
    const result = service.evaluate({ contract, observation: observation(), recordedAt: "2026-09-17T12:00:00Z", mode: "REPLAY" });
    expect(append).not.toHaveBeenCalled();
    await expect(applyGovernorDecision(result.decision, {}, { mode: "REPLAY" })).rejects.toThrow("cannot mutate live execution");
  });
});
