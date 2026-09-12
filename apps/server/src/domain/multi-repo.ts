export const INITIATIVE_STATUSES = [
  "proposed", "approved", "running", "paused", "partial", "completed", "failed", "cancelled",
] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

export interface InitiativeMemberInput {
  repositoryId: string;
  planId: string;
  baseCommit: string;
  planSha256: string;
}

export interface InitiativeDependencyInput {
  producerPlanId: string;
  consumerPlanId: string;
  dependencyType: "hard" | "artifact" | "runtime" | "shared_resource";
  artifactName?: string;
  artifactVersion?: string;
  sharedResource?: string;
}
