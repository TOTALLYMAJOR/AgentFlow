import type { InitiativeDependencyInput, InitiativeMemberInput } from "../domain/multi-repo.js";

export interface InitiativeValidationError { code: string; message: string; planId?: string }
export interface InitiativePlanEvidence extends InitiativeMemberInput { producedArtifacts: Array<{ name: string; version: string }> }

export function validateInitiativeGraph(plans: readonly InitiativePlanEvidence[], dependencies: readonly InitiativeDependencyInput[]): { valid: boolean; errors: InitiativeValidationError[]; waves: string[][] } {
  const errors: InitiativeValidationError[] = [];
  const byPlan = new Map(plans.map((plan) => [plan.planId, plan]));
  if (byPlan.size !== plans.length) errors.push({ code: "DUPLICATE_PLAN", message: "Initiative plan IDs must be unique" });
  if (new Set(plans.map((plan) => plan.repositoryId)).size !== plans.length) errors.push({ code: "DUPLICATE_REPOSITORY", message: "An initiative may bind only one plan per repository" });
  for (const edge of dependencies) {
    const producer = byPlan.get(edge.producerPlanId);
    const consumer = byPlan.get(edge.consumerPlanId);
    if (!producer) errors.push({ code: "MISSING_PRODUCER", message: `Producer plan ${edge.producerPlanId} is not an initiative member`, planId: edge.producerPlanId });
    if (!consumer) errors.push({ code: "MISSING_CONSUMER", message: `Consumer plan ${edge.consumerPlanId} is not an initiative member`, planId: edge.consumerPlanId });
    if (edge.dependencyType === "artifact" && producer) {
      if (!edge.artifactName || !edge.artifactVersion) errors.push({ code: "ARTIFACT_REQUIREMENT_INCOMPLETE", message: "Artifact dependencies require an exact name and version", planId: edge.consumerPlanId });
      else if (!producer.producedArtifacts.some((artifact) => artifact.name === edge.artifactName && artifact.version === edge.artifactVersion)) errors.push({ code: "ARTIFACT_NOT_PRODUCED", message: `${edge.artifactName}@${edge.artifactVersion} is not produced by ${edge.producerPlanId}`, planId: edge.consumerPlanId });
    }
    if (edge.dependencyType === "shared_resource" && !edge.sharedResource) errors.push({ code: "SHARED_RESOURCE_REQUIRED", message: "Shared-resource dependencies require a resource name", planId: edge.consumerPlanId });
  }
  const incoming = new Map(plans.map((plan) => [plan.planId, 0]));
  const outgoing = new Map(plans.map((plan) => [plan.planId, [] as string[]]));
  for (const edge of dependencies) if (byPlan.has(edge.producerPlanId) && byPlan.has(edge.consumerPlanId)) { outgoing.get(edge.producerPlanId)?.push(edge.consumerPlanId); incoming.set(edge.consumerPlanId, (incoming.get(edge.consumerPlanId) ?? 0) + 1); }
  const waves: string[][] = [];
  let ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id).sort();
  let visited = 0;
  while (ready.length > 0) { waves.push(ready); visited += ready.length; const next: string[] = []; for (const id of ready) for (const child of outgoing.get(id) ?? []) { const count = (incoming.get(child) ?? 0) - 1; incoming.set(child, count); if (count === 0) next.push(child); } ready = [...new Set(next)].sort(); }
  if (visited !== plans.length) errors.push({ code: "INITIATIVE_DEPENDENCY_CYCLE", message: "Cross-repository dependency graph contains a cycle" });
  return { valid: errors.length === 0, errors, waves: errors.some((error) => error.code === "INITIATIVE_DEPENDENCY_CYCLE") ? [] : waves };
}
