import { canonicalJsonSha256 } from "../integration/design-intelligence.js";
import type { TrafficControlContract, TrafficControlObservation } from "../integration/traffic-control.js";

export type GovernorAction = "CONTINUE" | "DELEGATE_RETRY" | "REQUEST_REPAIR" | "REQUEST_RECONSIDER" | "BLOCK_INTEGRATION" | "PAUSE_FOR_REVIEW" | "PROPOSE_REPLAN" | "CANCEL";
export interface GovernorDecision { policyVersion: "governor.v1"; action: GovernorAction; ruleId: string; authorityEffect: "NONE" | "PROPOSAL_ONLY"; requiresApproval: boolean; signals: Record<string, unknown>; }
export interface GovernorDecisionRecord { schema: "traffic-control/governor-decision-record@1"; recordedAt: string; contractHash: string; observationHash: string; previousRecordHash: string | null; policyVersion: "governor.v1"; decision: GovernorDecision; recordHash: string; }
interface EventPort { append(input: { buildId: string; type: string; payload: Record<string, unknown>; occurredAt?: string }): unknown; }

export class GovernorControlService {
  constructor(private readonly events: EventPort) {}

  evaluate(input: { contract: TrafficControlContract; observation: TrafficControlObservation; recordedAt: string; previousRecordHash?: string | null; mode?: "LIVE" | "REPLAY" }): { decision: GovernorDecision; record: GovernorDecisionRecord } {
    const decision = evaluateGovernor(input.contract, input.observation);
    const payload = {
      schema: "traffic-control/governor-decision-record@1" as const,
      recordedAt: input.recordedAt,
      contractHash: input.contract.binding.sha256,
      observationHash: canonicalJsonSha256(input.observation),
      previousRecordHash: input.previousRecordHash ?? null,
      policyVersion: decision.policyVersion,
      decision,
    };
    const record = { ...payload, recordHash: canonicalJsonSha256(payload) };
    if ((input.mode ?? "LIVE") === "LIVE") {
      this.events.append({
        buildId: input.observation.buildId,
        type: "governor.decision",
        payload: { ...record, authorityObservation: input.observation.authority },
        occurredAt: input.recordedAt,
      });
    }
    return { decision, record };
  }
}

export function evaluateGovernor(contract: TrafficControlContract, observation: TrafficControlObservation): GovernorDecision {
  const authorityViolation = verifyAuthority(contract, observation);
  if (authorityViolation !== null) return decision("PAUSE_FOR_REVIEW", "authority-drift", { violationCode: authorityViolation });
  if (observation.impactDelta.unexpectedChangedPaths.length > 0) return decision("BLOCK_INTEGRATION", "ownership-violation", { unauthorizedPaths: observation.impactDelta.unexpectedChangedPaths });
  if (observation.structuralConcern !== null) return decision("REQUEST_RECONSIDER", "structural-concern", { concern: observation.structuralConcern }, true);
  const missingEvidence = contract.document.proof.requiredEvidence.filter((requirement) => !observation.evidence.satisfied.includes(requirement));
  const contradictedEvidence = contract.document.proof.requiredEvidence.filter((requirement) => observation.evidence.contradictory.includes(requirement));
  if (["INTEGRATING", "INTEGRATED"].includes(observation.phase) && contradictedEvidence.length > 0) return decision("BLOCK_INTEGRATION", "required-evidence-contradicted", { contradictedEvidence });
  if (["INTEGRATING", "INTEGRATED"].includes(observation.phase) && missingEvidence.length > 0) return decision("BLOCK_INTEGRATION", "required-evidence-missing", { missingEvidence });
  if (observation.impactDelta.unexpectedImpactedPaths.length > 0 || observation.impactDelta.activeTaskCollisions.length > 0) return decision("PAUSE_FOR_REVIEW", "impact-expansion", { unexpectedImpactedPaths: observation.impactDelta.unexpectedImpactedPaths, activeTaskCollisions: observation.impactDelta.activeTaskCollisions });
  if (observation.failure?.classification === "deterministic" && observation.failureRepeatCount >= 3 && observation.evidenceDelta.score <= 0) return decision("PROPOSE_REPLAN", "repeated-no-progress-failure", { failureFingerprint: observation.failure.fingerprint, repeatCount: observation.failureRepeatCount, evidenceDelta: observation.evidenceDelta.direction }, true);
  if (observation.failure?.retryable === true && observation.attempt < observation.maxAttempts) return decision("DELEGATE_RETRY", "runtime-retry-eligible", { attemptsRemaining: observation.maxAttempts - observation.attempt });
  if (observation.failure?.retryable === true && observation.attempt >= observation.maxAttempts) return decision("PAUSE_FOR_REVIEW", "retry-budget-exhausted", { attempt: observation.attempt, maxAttempts: observation.maxAttempts, failureFingerprint: observation.failure.fingerprint });
  if (observation.failure?.classification === "deterministic") return decision("REQUEST_REPAIR", "bounded-implementation-failure", { failureFingerprint: observation.failure.fingerprint });
  if (observation.failure !== null) return decision("PAUSE_FOR_REVIEW", "unclassified-failure", { classification: observation.failure.classification, failureFingerprint: observation.failure.fingerprint });
  return decision("CONTINUE", "entitled-to-continue", {});
}

function verifyAuthority(contract: TrafficControlContract, observation: TrafficControlObservation): string | null {
  const authority = observation.authority;
  if (authority === null) return "INVALID_APPROVAL_AUTHORITY";
  if (authority.handoffId !== contract.binding.id || authority.handoffSha256 !== contract.binding.sha256) return "CONTRACT_BINDING_DRIFT";
  if (authority.baseCommit !== contract.binding.baseCommit) return "BASE_COMMIT_DRIFT";
  if (authority.snapshotSha256 !== contract.binding.snapshotSha256) return "SNAPSHOT_DRIFT";
  if (authority.authorityStateSha256 !== contract.document.authority.stateSha256) return "AUTHORITY_STATE_DRIFT";
  if (authority.governanceReportSha256 !== contract.document.authority.governanceReportSha256) return "GOVERNANCE_REPORT_DRIFT";
  if (canonicalJsonSha256(authority.authoritySources) !== canonicalJsonSha256(contract.document.authority.sources)) return "AUTHORITY_SOURCE_DRIFT";
  return null;
}

function decision(action: GovernorAction, ruleId: string, signals: Record<string, unknown>, proposalOnly = false): GovernorDecision {
  return { policyVersion: "governor.v1", action, ruleId, authorityEffect: proposalOnly ? "PROPOSAL_ONLY" : "NONE", requiresApproval: proposalOnly, signals };
}
