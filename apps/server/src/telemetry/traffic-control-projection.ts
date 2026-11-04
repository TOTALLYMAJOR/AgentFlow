import { z } from "zod";
import { canonicalJsonSha256 } from "../integration/design-intelligence.js";
import { createRedactor } from "../workers/redaction.js";

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

// Runtime validation mirrors the published v1 envelope; parsed copies never
// replace source values or turn caller-supplied correlation into authority.
const eventTypes = z.enum([
  "contract.verification_completed", "execution.started", "attempt.started", "files.changed", "impact.assessed",
  "validation.completed", "evidence.recorded", "governor.decision", "intervention.completed", "integration.completed",
  "integration.blocked", "receipt.audit_completed", "structural.concern_recorded", "contract.superseded", "outcome.reviewed",
]);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const identifier = z.string().min(1);
const isoTimestamp = z.iso.datetime({ offset: true });
const timestamp = z.string().refine((value) => {
  const upper = value.toUpperCase();
  const leapSecond = /T\d{2}:\d{2}:60(?=\.|Z|[+-])/u.test(upper);
  const comparable = leapSecond ? upper.replace(/(T\d{2}:\d{2}):60(?=\.|Z|[+-])/u, "$1:59") : upper;
  if (!isoTimestamp.safeParse(comparable).success) return false;
  if (!leapSecond) return true;
  // RFC3339 leap-second examples include numeric offsets. This checks their
  // UTC month-end position, not an authoritative leap schedule or clock window.
  const utc = new Date(comparable);
  const next = new Date(utc);
  next.setUTCDate(next.getUTCDate() + 1);
  return utc.getUTCHours() === 23 && utc.getUTCMinutes() === 59 && next.getUTCDate() === 1;
});
const correlationFields = z.object({
  repositoryId: identifier, runId: identifier, buildId: identifier.optional(), taskId: identifier.optional(),
  handoffId: identifier, contractSha256: digest, policyVersion: identifier.optional(), analysisRunId: identifier.optional(),
}).strict();
const envelope = z.object({
  schemaVersion: z.literal("1.0.0"), kind: z.literal("traffic-control/telemetry-event"), eventId: identifier.max(200), eventType: eventTypes,
  occurredAt: timestamp, recordedAt: timestamp, sequence: z.number().refine((value) => Number.isInteger(value) && value >= 1),
  source: z.object({
    system: z.enum(["proofloom", "agentflow", "traffic-control-governor", "decision-intelligence", "repository-authority"]),
    component: identifier, sourceRecordId: identifier, sourceSha256: digest.optional(),
  }).strict(),
  correlation: correlationFields,
  proofBoundary: z.enum(["CONTRACT_AND_AUTHORITY", "LOCAL_EXECUTION", "LOCAL_EXECUTION_AND_INTEGRATION", "HOSTED_RUNTIME", "REVIEWED_OUTCOME"]),
  payload: z.record(z.string(), z.unknown()),
  correctionOfEventId: identifier.optional(), correctionReason: identifier.optional(),
}).refine((event) => (event.correctionOfEventId === undefined) === (event.correctionReason === undefined)).strict();

export function projectTrafficControlTelemetry(
  source: SourceBuildEvent,
  options: { correlation: TelemetryCorrelation; recordedAt: string; environment: ProofEnvironment },
): TrafficControlTelemetryEvent {
  if (!Number.isSafeInteger(source.sequence) || source.sequence < 1 || !source.buildId || !source.occurredAt) throw new TypeError("Authoritative source event identity is required");
  if (!eventTypes.safeParse(source.type).success) throw new TypeError("Unsupported selected telemetry event type");
  if (!correlationFields.safeParse(options.correlation).success) throw new TypeError("Governed telemetry correlation does not match v1");
  if (!isEnvironment(options.environment)) throw new TypeError("Telemetry proof environment is required");
  requireBoundedPayload({ buildId: source.buildId, taskId: source.taskId, occurredAt: source.occurredAt, recordedAt: options.recordedAt });
  requireBoundedPayload(options.correlation);
  if (typeof source.buildId !== "string" || options.correlation.buildId !== undefined && options.correlation.buildId !== source.buildId) throw new TypeError("Telemetry build correlation disagrees with native source");
  if (typeof source.taskId === "string" && source.taskId.length > 0 && options.correlation.taskId !== undefined && options.correlation.taskId !== source.taskId) throw new TypeError("Telemetry task correlation disagrees with native source");
  const payload = boundedPayload(source.type, source.payload, options.environment);
  requireBoundedPayload(payload);
  const sourceRecordId = `${source.buildId}:${source.sequence}`;
  const sourceSha256 = canonicalJsonSha256({ sourceRecordId, type: source.type, occurredAt: source.occurredAt, payload });
  const eventId = canonicalJsonSha256({ system: "agentflow", component: "build-events", sourceRecordId, sourceSha256, runId: options.correlation.runId });
  const event: TrafficControlTelemetryEvent = {
    schemaVersion: "1.0.0", kind: "traffic-control/telemetry-event", eventId, eventType: source.type,
    occurredAt: source.occurredAt, recordedAt: options.recordedAt, sequence: source.sequence,
    source: { system: source.type === "governor.decision" ? "traffic-control-governor" : "agentflow", component: "build-events", sourceRecordId, sourceSha256 },
    correlation: { ...options.correlation, ...(source.taskId === null ? {} : { taskId: source.taskId }) },
    proofBoundary: options.environment === "reviewed-outcome" ? "REVIEWED_OUTCOME" : ["hosted", "production"].includes(options.environment) ? "HOSTED_RUNTIME" : "LOCAL_EXECUTION",
    payload,
  };
  requireTelemetryEnvelope(event);
  return event;
}

export function summarizeTrafficControlMetrics(events: readonly TrafficControlTelemetryEvent[]): {
  populations: Partial<Record<ProofEnvironment, { sourceEventCount: number; metrics: Record<string, unknown> }>>;
} {
  const unique = new Map<string, TrafficControlTelemetryEvent>();
  const sourceFacts = new Map<string, string>();
  const eventFacts = new Map<string, string>();
  for (const event of events) {
    requireTelemetryEnvelope(event);
    const { recordedAt, ...stableFact } = event;
    void recordedAt;
    const factHash = canonicalJsonSha256(stableFact);
    // AgentFlow and Governor projections share the native build-event journal.
    const sourceIdentity = canonicalJsonSha256({ component: event.source.component, sourceRecordId: event.source.sourceRecordId });
    const priorSource = sourceFacts.get(sourceIdentity);
    const priorEvent = eventFacts.get(event.eventId);
    if ((priorSource !== undefined && priorSource !== factHash) || (priorEvent !== undefined && priorEvent !== factHash)) throw new TypeError("Conflicting native telemetry source fact");
    sourceFacts.set(sourceIdentity, factHash);
    eventFacts.set(event.eventId, factHash);
    unique.set(sourceIdentity, event);
  }
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
    populations[environment] = {
      sourceEventCount: population.length,
      metrics: {
        "M-01": reviews.length === 0
          ? { status: "UNAVAILABLE", reason: "No reviewed outcomes" }
          : { status: "UNAVAILABLE", reason: "Eligible reviewed closed-run cohort and review window are unavailable" },
      },
    };
  }
  return { populations };
}

function requireTelemetryEnvelope(event: TrafficControlTelemetryEvent): void {
  const { payload, ...metadata } = event;
  requireBoundedPayload(metadata);
  requireBoundedPayload(payload);
  if (!envelope.safeParse(event).success) throw new TypeError("Telemetry event does not match the published v1 envelope");
  // A v1 sourceRecordId is opaque. Raw identity agreement is checked only
  // by the projector while the original native SourceBuildEvent is available.
}

const MAX_PAYLOAD_BYTES = 32 * 1024;
const rejectCredential = createRedactor();
const SENSITIVE_FIELDS = new Set(["apikey", "accesstoken", "authtoken", "password", "credential", "credentials", "privatekey", "secret", "secrets", "token", "tokens", "prompt", "prompts", "sourcecode", "rawlog", "rawlogs", "environmentvalues", "envvalues", "environmentvariables", "envvars"]);

function requireBoundedPayload(payload: unknown): void {
  let remaining = MAX_PAYLOAD_BYTES;
  const ancestors = new Set<object>();
  const consume = (bytes: number): void => {
    remaining -= bytes;
    if (remaining < 0) throw new TypeError("Product telemetry payload exceeds its bounded size");
  };
  const stringBytes = (value: string): number => {
    // Bound allocation before escaping or scanning a string.
    if (Buffer.byteLength(value, "utf8") > remaining) throw new TypeError("Product telemetry payload exceeds its bounded size");
    if (rejectCredential(value) !== value) throw new TypeError("Product telemetry cannot contain recognized credentials");
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) throw new TypeError("Product telemetry payload nesting is unsupported");
    if (typeof value === "string") { consume(stringBytes(value)); return; }
    if (value === null || typeof value === "boolean") { consume(5); return; }
    if (typeof value === "number" && Number.isFinite(value)) { consume(String(value).length); return; }
    if (typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError("Product telemetry payload must contain bounded JSON values");
    if (ancestors.has(value)) throw new TypeError("Product telemetry payload cannot contain cycles");
    ancestors.add(value);
    consume(2);
    if (Array.isArray(value)) {
      for (const item of value) { consume(1); visit(item, depth + 1); }
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (SENSITIVE_FIELDS.has(key.replace(/[^a-z0-9]/giu, "").toLowerCase())) throw new TypeError("Product telemetry cannot contain sensitive payload fields");
        consume(stringBytes(key) + 2);
        visit(item, depth + 1);
      }
    }
    ancestors.delete(value);
  };
  visit(payload, 0);
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
  if (type === "impact.assessed") {
    const { impactedPaths, activeTaskCollisions, expanded } = source;
    requireBoundedPayload({ environment, impactedPaths, activeTaskCollisions, expanded });
    if (typeof expanded !== "boolean") throw new TypeError("Impact telemetry requires a supplied expansion fact");
    const copyStrings = (value: unknown): string[] => {
      if (!Array.isArray(value)) throw new TypeError("Impact telemetry requires supplied string-array facts");
      const length = value.length;
      // A caller-owned iterator cannot hide more entries than the existing
      // byte budget could represent, or select different values for the copy.
      if (length > MAX_PAYLOAD_BYTES) throw new TypeError("Product telemetry payload exceeds its bounded size");
      const copy: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const item: unknown = value[index];
        if (typeof item !== "string") throw new TypeError("Impact telemetry requires supplied string-array facts");
        copy.push(item);
      }
      return copy;
    };
    return { environment, impactedPaths: copyStrings(impactedPaths), activeTaskCollisions: copyStrings(activeTaskCollisions), expanded };
  }
  const allowed = ["result", "violationCode", "maxAttempts", "attempt", "taskId", "paths", "commit", "status", "evidenceId", "action", "triggerRecordHash", "integrationCommit", "reason"];
  const payload: Record<string, unknown> = { environment };
  for (const key of allowed) if (source[key] !== undefined) payload[key] = source[key];
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isEnvironment(value: unknown): value is ProofEnvironment { return typeof value === "string" && ["synthetic", "local", "ci", "hosted", "production", "reviewed-outcome"].includes(value); }
