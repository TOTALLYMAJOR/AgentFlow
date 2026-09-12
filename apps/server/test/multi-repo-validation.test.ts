import { describe, expect, it } from "vitest";
import { executionDependencies, validateInitiativeGraph, type InitiativePlanEvidence } from "../src/multi-repo/validation.js";

const plan = (planId: string, repositoryId: string, artifacts: Array<{ name: string; version: string }> = []): InitiativePlanEvidence => ({ planId, repositoryId, baseCommit: `${planId}-commit`, planSha256: `${planId}-sha`, producedArtifacts: artifacts });

describe("cross-repository initiative validation", () => {
  it("derives deterministic waves for an exact artifact handoff", () => {
    const result = validateInitiativeGraph([plan("contract", "repo-contract", [{ name: "api", version: "1.0.0" }]), plan("service", "repo-service"), plan("web", "repo-web")], [
      { producerPlanId: "contract", consumerPlanId: "service", dependencyType: "artifact", artifactName: "api", artifactVersion: "1.0.0" },
      { producerPlanId: "service", consumerPlanId: "web", dependencyType: "hard" },
    ]);
    expect(result).toMatchObject({ valid: true, waves: [["contract"], ["service"], ["web"]] });
  });

  it("rejects missing and mismatched artifacts plus dependency cycles", () => {
    const result = validateInitiativeGraph([plan("a", "repo-a"), plan("b", "repo-b")], [
      { producerPlanId: "a", consumerPlanId: "b", dependencyType: "artifact", artifactName: "api", artifactVersion: "2.0.0" },
      { producerPlanId: "b", consumerPlanId: "a", dependencyType: "hard" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(["ARTIFACT_NOT_PRODUCED", "INITIATIVE_DEPENDENCY_CYCLE"]));
  });

  it("serializes every participant in a shared resource deterministically", () => {
    const dependencies = [
      { producerPlanId: "zeta", consumerPlanId: "alpha", dependencyType: "shared_resource" as const, sharedResource: "staging" },
      { producerPlanId: "zeta", consumerPlanId: "middle", dependencyType: "shared_resource" as const, sharedResource: "staging" },
    ];
    expect(executionDependencies(dependencies)).toEqual([
      { producerPlanId: "alpha", consumerPlanId: "middle", dependencyType: "shared_resource", sharedResource: "staging" },
      { producerPlanId: "middle", consumerPlanId: "zeta", dependencyType: "shared_resource", sharedResource: "staging" },
    ]);
    expect(validateInitiativeGraph([plan("zeta", "repo-z"), plan("alpha", "repo-a"), plan("middle", "repo-m")], dependencies)).toMatchObject({ valid: true, waves: [["alpha"], ["middle"], ["zeta"]] });
  });
});
