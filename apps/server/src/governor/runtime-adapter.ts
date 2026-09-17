import type { GovernorAction, GovernorDecision } from "./control-service.js";

export type InterventionAcknowledgement = { acknowledged: boolean; details?: Record<string, unknown> };
export interface GovernorRuntimePort {
  continue?: (decision: GovernorDecision) => Promise<InterventionAcknowledgement>;
  delegateRetry?: (decision: GovernorDecision) => Promise<InterventionAcknowledgement>;
  requestRepair?: (decision: GovernorDecision) => Promise<InterventionAcknowledgement>;
  requestReconsider?: (decision: GovernorDecision) => Promise<InterventionAcknowledgement>;
  blockIntegration?: (decision: GovernorDecision) => Promise<InterventionAcknowledgement>;
  pauseForReview?: (decision: GovernorDecision) => Promise<InterventionAcknowledgement>;
  proposeReplan?: (decision: GovernorDecision) => Promise<InterventionAcknowledgement>;
  cancel?: (decision: GovernorDecision) => Promise<InterventionAcknowledgement>;
}

const methods: Record<GovernorAction, keyof GovernorRuntimePort> = {
  CONTINUE: "continue", DELEGATE_RETRY: "delegateRetry", REQUEST_REPAIR: "requestRepair", REQUEST_RECONSIDER: "requestReconsider",
  BLOCK_INTEGRATION: "blockIntegration", PAUSE_FOR_REVIEW: "pauseForReview", PROPOSE_REPLAN: "proposeReplan", CANCEL: "cancel",
};

export async function applyGovernorDecision(decision: GovernorDecision, runtime: GovernorRuntimePort, options: { mode?: "LIVE" | "REPLAY" } = {}): Promise<InterventionAcknowledgement> {
  if ((options.mode ?? "LIVE") === "REPLAY") throw new Error("Historical replay cannot mutate live execution");
  if (["REQUEST_RECONSIDER", "PROPOSE_REPLAN"].includes(decision.action) && (decision.authorityEffect !== "PROPOSAL_ONLY" || !decision.requiresApproval)) throw new Error("Structural interventions are proposal-only and require external approval");
  const method = methods[decision.action];
  const handler = runtime[method] as ((value: GovernorDecision) => Promise<InterventionAcknowledgement>) | undefined;
  if (handler === undefined) throw new TypeError(`Runtime adapter cannot apply ${decision.action}`);
  return handler(decision);
}
