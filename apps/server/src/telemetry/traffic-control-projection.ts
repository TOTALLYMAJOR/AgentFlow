import { canonicalJsonSha256 } from "../integration/design-intelligence.js";

export type ProofEnvironment = "synthetic" | "local" | "ci" | "hosted" | "production" | "reviewed-outcome";
export interface SourceBuildEvent { sequence: number; buildId: string; taskId: string | null; type: string; payload: Record<string, unknown>; occurredAt: string; }
export interface TelemetryCorrelation { repositoryId: string; runId: string; buildId?: string; taskId?: string; handoffId: string; contractSha256: string; policyVersion?: string; analysisRunId?: string; }
export interface TrafficControlTelemetryEvent {
  schemaVersion: "1.0.0"; kind: "traffic-control/telemetry-event"; eventId: string; eventType: string;
  occurredAt: string; recordedAt: string; sequence: number;
  source: { system: "agentflow" | "traffic-control-governor"; component: string; sourceRecordId: string; sourceSha256: string };
  correlation: TelemetryCorrelation; proofBoundary: "LOCAL_EXECUTION" | "HOSTED_RUNTIME" | "REVIEWED_OUTCOME";
  payload: Record<string, unknown>;
}

export function projectTrafficControlTelemetry(
  source: SourceBuildEvent,
  options: { correlation: TelemetryCorrelation; recordedAt: string; environment: ProofEnvironment },
): TrafficControlTelemetryEvent {
  if (!Number.isSafeInteger(source.sequence) || source.sequence < 1 || !source.buildId || !source.occurredAt) throw new TypeError("Authoritative source event identity is required");
  if (!options.correlation.repositoryId || !options.correlation.runId || !options.correlation.handoffId || !/^[0-9a-f]{64}$/.test(options.correlation.contractSha256)) throw new TypeError("Governed telemetry correlation is incomplete");
  const payload = boundedPayload(source.type, source.payload, options.environment);
  const sourceRecordId = `${source.buildId}:${source.sequence}`;
  const sourceSha256 = canonicalJsonSha256({ sourceRecordId, type: source.type, occurredAt: source.occurredAt, payload });
  const eventId = canonicalJsonSha256({ system: "agentflow", component: "build-events", sourceRecordId, sourceSha256, runId: options.correlation.runId });
  return {
    schemaVersion: "1.0.0", kind: "traffic-control/telemetry-event", eventId, eventType: source.type,
    occurredAt: source.occurredAt, recordedAt: options.recordedAt, sequence: source.sequence,
    source: { system: source.type === "governor.decision" ? "traffic-control-governor" : "agentflow", component: "build-events", sourceRecordId, sourceSha256 },
    correlation: { ...options.correlation, ...(source.taskId === null ? {} : { taskId: source.taskId }) },
    proofBoundary: options.environment === "reviewed-outcome" ? "REVIEWED_OUTCOME" : ["hosted", "production"].includes(options.environment) ? "HOSTED_RUNTIME" : "LOCAL_EXECUTION",
    payload,
  };
}

export function summarizeTrafficControlMetrics(events: readonly TrafficControlTelemetryEvent[]): {
  populations: Partial<Record<ProofEnvironment, { sourceEventCount: number; metrics: Record<string, unknown> }>>;
} {
  const unique = new Map(events.map((event) => [event.eventId, event]));
  const grouped = new Map<ProofEnvironment, TrafficControlTelemetryEvent[]>();
  for (const event of unique.values()) {
    const environment = event.payload.environment;
    if (!isEnvironment(environment)) throw new TypeError(`Telemetry event ${event.eventId} has no valid proof environment`);
    const population = grouped.get(environment) ?? [];
    population.push(event);
    grouped.set(environment, population);
  }
  const populations: Partial<Record<ProofEnvironment, { sourceEventCount: number; metrics: Record<string, unknown> }>> = {};
  for (const [environment, population] of grouped) {
    const reviews = population.filter((event) => event.eventType === "outcome.reviewed");
    const correct = reviews.filter((event) => event.payload.correctDisposition === true).length;
    populations[environment] = {
      sourceEventCount: population.length,
      metrics: {
        "M-01": reviews.length === 0
          ? { status: "UNAVAILABLE", reason: "No reviewed outcomes" }
          : { status: "AVAILABLE", numerator: correct, denominator: reviews.length, value: correct / reviews.length, reviewCoverage: 1 },
      },
    };
  }
  return { populations };
}

function boundedPayload(type: string, source: Record<string, unknown>, environment: ProofEnvironment): Record<string, unknown> {
  if (type === "governor.decision") {
    const decision = isRecord(source.decision) ? source.decision : {};
    return {
      environment,
      action: decision.action ?? null,
      ruleId: decision.ruleId ?? null,
      authorityEffect: decision.authorityEffect ?? null,
      requiresApproval: decision.requiresApproval ?? null,
      signals: isRecord(decision.signals) ? decision.signals : {},
      observationSha256: source.observationHash ?? null,
      recordHash: source.recordHash ?? null,
    };
  }
  if (type === "outcome.reviewed") {
    return { environment, correctDisposition: source.correctDisposition ?? null, invalidEscape: source.invalidEscape ?? null, outcomeClass: source.outcomeClass ?? null, reviewerAuthority: source.reviewerAuthority ?? null, reviewedAt: source.reviewedAt ?? null };
  }
  const allowed = ["result", "violationCode", "maxAttempts", "attempt", "taskId", "paths", "commit", "status", "evidenceId", "action", "triggerRecordHash", "integrationCommit", "reason"];
  const payload: Record<string, unknown> = { environment };
  for (const key of allowed) if (source[key] !== undefined) payload[key] = source[key];
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isEnvironment(value: unknown): value is ProofEnvironment { return ["synthetic", "local", "ci", "hosted", "production", "reviewed-outcome"].includes(String(value)); }
