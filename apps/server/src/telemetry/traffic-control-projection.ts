import { z } from "zod";
import { canonicalJsonSha256 } from "../integration/design-intelligence.js";
import { createRedactor } from "../workers/redaction.js";
import { parseCommandLine } from "../validation/command.js";
import type { OwnershipEvaluation } from "../validation/types.js";
import type { AttemptStatus } from "../db/types.js";
import type { TrafficControlObservation } from "../integration/traffic-control.js";

export type ProofEnvironment = "synthetic" | "local" | "ci" | "hosted" | "production" | "reviewed-outcome";
export interface SourceBuildEvent { sequence: number; buildId: string; taskId: string | null; type: string; payload: Record<string, unknown>; occurredAt: string; correctionOfEventId?: string; correctionReason?: string; }
export interface TelemetryCorrelation { repositoryId: string; runId: string; buildId?: string; taskId?: string; handoffId: string; contractSha256: string; policyVersion?: string; analysisRunId?: string; }
export interface TrafficControlTelemetryEvent {
  schemaVersion: "1.0.0"; kind: "traffic-control/telemetry-event"; eventId: string; eventType: string;
  occurredAt: string; recordedAt: string; sequence: number;
  source: { system: "proofloom" | "agentflow" | "traffic-control-governor" | "decision-intelligence" | "repository-authority"; component: string; sourceRecordId: string; sourceSha256?: string };
  correlation: TelemetryCorrelation; proofBoundary: "CONTRACT_AND_AUTHORITY" | "LOCAL_EXECUTION" | "LOCAL_EXECUTION_AND_INTEGRATION" | "HOSTED_RUNTIME" | "REVIEWED_OUTCOME";
  payload: Record<string, unknown>;
  correctionOfEventId?: string; correctionReason?: string;
}

export interface MetricSourceBinding { sourceRecordId: string; sourceSha256: string; }
export interface MetricReviewTarget {
  reviewEventId: string; targetEventId: string;
  kind: "run" | "intervention" | "protection-case" | "no-progress" | "disposition";
  protectionEventId?: string;
}
/** Read-only projections of existing native records, never a new authority artifact. */
export interface TrafficControlMetricRun {
  source: MetricSourceBinding; correlation: TelemetryCorrelation;
  verificationEventId: string; submittedEligibleHandoff: boolean; manualTranslation: boolean;
  closedEventId?: string; requiredLifecycleEvents: string[]; requiredEvidenceIds: string[];
  tasks: Array<{ taskId: string; ownershipRoots: string[] }>;
  ownershipAssessments?: Array<{ source: MetricSourceBinding; filesChangedEventId: string; evaluation: OwnershipEvaluation }>;
  attemptOutcomes?: Array<{ source: MetricSourceBinding; attemptEventId: string; status: AttemptStatus; evidenceDelta: TrafficControlObservation["evidenceDelta"] }>;
  issuedReceipts: Array<{ receiptSha256: string; auditEventId?: string }>;
  reviews: MetricReviewTarget[];
  thresholdCrossingEventId?: string;
  decisionTriggers: Array<{ decisionEventId: string; triggerEventId: string }>;
  structuralClosures: Array<{ concernEventId: string; supersessionEventId?: string }>;
  dimensions?: Partial<Record<"consumingProject" | "contractSchemaVersion" | "failureClassification" | "failureFingerprint" | "ownershipDomain" | "executionAdapter" | "runtimeVersion" | "releaseExposure" | "experimentExposure", string>>;
}
export interface TrafficControlReplayComparison {
  source: MetricSourceBinding; originalEventId: string; replayedEventId: string;
}
export interface TrafficControlOverride {
  source: MetricSourceBinding; dispositionEventId: string; occurredAt: string; direction: string;
}
export type MetricDimension = "repositoryId" | "runId" | "consumingProject" | "policyVersion" | "contractSchemaVersion" | "action" | "ruleId" | "failureClassification" | "failureFingerprint" | "taskId" | "ownershipDomain" | "executionAdapter" | "runtimeVersion" | "releaseExposure" | "experimentExposure" | "reviewStatus";
export interface TrafficControlMetricContext {
  source: MetricSourceBinding; environment: ProofEnvironment; cohortId: string;
  window: { start: string; end: string }; asOf: string; reviewWindowMs: number;
  maxClockSkewMs?: number;
  segment?: Partial<Record<MetricDimension, string>>;
  coverage: { lifecycle: boolean; reviews: boolean; replay: boolean; overrides: boolean; submissions: boolean };
  runs: TrafficControlMetricRun[];
  replayComparisons: TrafficControlReplayComparison[]; overrides: TrafficControlOverride[];
  /** Trusted native-adapter dependency. Verify the COMPLETE value and its source,
   * authority, targets and scope against existing stores. Schema-valid IDs, a
   * digest, a source label or a caller's boolean do not authenticate a fact.
   * This seam itself supplies no independent authorship or human acceptance proof. */
  verifySource: (fact: { kind: "cohort" | "run" | "event" | "replay" | "override"; value: unknown; scope: Omit<TrafficControlMetricContext, "verifySource"> }) => unknown;
}
export interface TrafficControlMetric {
  status: "AVAILABLE" | "UNAVAILABLE"; reason?: string; environment: ProofEnvironment;
  denominator: number | null; numerator?: number; value?: number;
  window: { start: string; end: string } | null;
  reviewCoverage: { reviewed: number; closed: number; value: number | null } | null;
  proofBoundary: "ADAPTER_VERIFIED_SOURCE_CALCULATION" | "UNVERIFIED_SOURCE"; proofLimits: string;
  unit?: string; samples?: number[]; segments?: Record<string, unknown>;
  sourceCoverage?: Record<string, number>;
  dimensions?: Array<Record<string, string | null>>;
  segment?: Partial<Record<MetricDimension, string>>;
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
  const correction: { correctionOfEventId?: string; correctionReason?: string } = {};
  if (source.correctionOfEventId !== undefined || source.correctionReason !== undefined) {
    if (typeof source.correctionOfEventId !== "string" || typeof source.correctionReason !== "string") throw new TypeError("Telemetry corrections require the prior event and reason together");
    correction.correctionOfEventId = source.correctionOfEventId;
    correction.correctionReason = source.correctionReason;
  }
  const sourceSha256 = canonicalJsonSha256({ sourceRecordId, type: source.type, occurredAt: source.occurredAt, payload, ...correction });
  const eventId = canonicalJsonSha256({ system: "agentflow", component: "build-events", sourceRecordId, sourceSha256, runId: options.correlation.runId, ...(options.correlation.analysisRunId === undefined ? {} : { analysisRunId: options.correlation.analysisRunId }) });
  const event: TrafficControlTelemetryEvent = {
    schemaVersion: "1.0.0", kind: "traffic-control/telemetry-event", eventId, eventType: source.type,
    occurredAt: source.occurredAt, recordedAt: options.recordedAt, sequence: source.sequence,
    source: { system: source.type === "governor.decision" ? "traffic-control-governor" : "agentflow", component: "build-events", sourceRecordId, sourceSha256 },
    correlation: { ...options.correlation, ...(source.taskId === null ? {} : { taskId: source.taskId }) },
    proofBoundary: options.environment === "reviewed-outcome" ? "REVIEWED_OUTCOME" : ["hosted", "production"].includes(options.environment) ? "HOSTED_RUNTIME" : "LOCAL_EXECUTION",
    payload, ...correction,
  };
  requireTelemetryEnvelope(event);
  return event;
}

export function summarizeTrafficControlMetrics(events: readonly TrafficControlTelemetryEvent[], context?: TrafficControlMetricContext): {
  populations: Partial<Record<ProofEnvironment, { sourceEventCount: number; liveEventCount: number; analysisEventCount: number; rejectedContractCount: number; metrics: Record<string, TrafficControlMetric> }>>;
} {
  const unique = new Map<string, TrafficControlTelemetryEvent>();
  const sourceFacts = new Map<string, string>();
  const eventFacts = new Map<string, string>();
  const sequences = new Map<string, string>();
  for (const event of events) {
    requireTelemetryEnvelope(event);
    const { recordedAt, ...stableFact } = event;
    void recordedAt;
    const factHash = canonicalJsonSha256(stableFact);
    const sourceIdentity = canonicalJsonSha256({ component: event.source.component, sourceRecordId: event.source.sourceRecordId, analysisRunId: event.correlation.analysisRunId ?? null });
    const sequenceIdentity = canonicalJsonSha256({ environment: event.payload.environment, repositoryId: event.correlation.repositoryId, runId: event.correlation.runId, analysisRunId: event.correlation.analysisRunId ?? null, sequence: event.sequence });
    const priorSource = sourceFacts.get(sourceIdentity);
    const priorEvent = eventFacts.get(event.eventId);
    const priorSequence = sequences.get(sequenceIdentity);
    if ((priorSource !== undefined && priorSource !== factHash) || (priorEvent !== undefined && priorEvent !== factHash) || (priorSequence !== undefined && priorSequence !== factHash)) throw new TypeError("Conflicting native telemetry source fact or run sequence");
    sourceFacts.set(sourceIdentity, factHash);
    eventFacts.set(event.eventId, factHash);
    sequences.set(sequenceIdentity, factHash);
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
  if (context !== undefined && isEnvironment(context.environment) && !grouped.has(context.environment)) grouped.set(context.environment, []);
  const populations: ReturnType<typeof summarizeTrafficControlMetrics>["populations"] = {};
  for (const [environment, population] of grouped) {
    const live = population.filter((event) => event.correlation.analysisRunId === undefined);
    const selected = context?.environment === environment ? context : undefined;
    populations[environment] = {
      sourceEventCount: population.length, liveEventCount: live.length, analysisEventCount: population.length - live.length,
      rejectedContractCount: live.filter((event) => event.eventType === "contract.verification_completed" && ["REJECTED", "FAILED"].includes(String(event.payload.result).toUpperCase())).length,
      metrics: evaluateMetrics(population, environment, selected),
    };
  }
  return { populations };
}

const PROOF_LIMITS = "Arithmetic over complete facts verified by the supplied trusted native adapter; no independent authorship, human acceptance, deployment, production readiness, causal effect, or pilot-outcome proof. No live consumer is installed by this component.";
const METRIC_IDS = Array.from({ length: 19 }, (_, index) => `M-${String(index + 1).padStart(2, "0")}`);
const protectiveActions = new Set(["BLOCK_INTEGRATION", "PAUSE_FOR_REVIEW", "REQUEST_REPAIR", "DELEGATE_RETRY", "REQUEST_RECONSIDER", "PROPOSE_REPLAN"]);
const closedTypes = new Set(["integration.completed", "integration.blocked", "intervention.completed", "contract.superseded"]);

function evaluateMetrics(population: TrafficControlTelemetryEvent[], environment: ProofEnvironment, context?: TrafficControlMetricContext): Record<string, TrafficControlMetric> {
  const base = { environment, denominator: null, window: null, reviewCoverage: null, proofBoundary: "UNVERIFIED_SOURCE" as TrafficControlMetric["proofBoundary"], proofLimits: PROOF_LIMITS };
  const unavailable = (reason: string): TrafficControlMetric => ({ ...base, status: "UNAVAILABLE", reason });
  const metrics = Object.fromEntries(METRIC_IDS.map((id) => [id, unavailable(id === "M-01" && !population.some((event) => event.eventType === "outcome.reviewed") ? "No reviewed outcomes" : "Source-verified eligible cohort, observation window, and complete source coverage are unavailable")])) as Record<string, TrafficControlMetric>;
  const current = (id: string): TrafficControlMetric => metrics[id] ?? unavailable("Metric calculation is unavailable");
  if (context === undefined) return metrics;
  const { verifySource, ...suppliedContext } = context;
  const verified = (kind: Parameters<TrafficControlMetricContext["verifySource"]>[0]["kind"], value: unknown): boolean => {
    try { return typeof verifySource === "function" && verifySource({ kind, value, scope: suppliedContext }) === true; } catch { return false; }
  };
  const validBinding = (source: MetricSourceBinding): boolean => isRecord(source) && identifier.safeParse(source.sourceRecordId).success && digest.safeParse(source.sourceSha256).success;
  // The callback sees the whole read-only calculation input, including scope,
  // coverage, eligibility, target links and all review/replay/override bindings.
  try { requireBoundedPayload({ ...suppliedContext, runs: suppliedContext.runs.map((run) => run.correlation) }); } catch { return metrics; }
  if (!validBinding(context.source) || !verified("cohort", suppliedContext) || !timestamp.safeParse(context.window.start).success || !timestamp.safeParse(context.window.end).success || !timestamp.safeParse(context.asOf).success || !Number.isFinite(context.reviewWindowMs) || context.reviewWindowMs < 0) return metrics;
  const start = Date.parse(context.window.start); const end = Date.parse(context.window.end); const asOf = Date.parse(context.asOf);
  if (!(start < end && end <= asOf) || !isRecord(context.coverage) || !Object.values(context.coverage).every((value) => typeof value === "boolean")) return metrics;
  const within = (event: TrafficControlTelemetryEvent): boolean => Date.parse(event.occurredAt) >= start && Date.parse(event.occurredAt) < end && Date.parse(event.recordedAt) <= asOf;
  if (context.maxClockSkewMs !== undefined && (!Number.isFinite(context.maxClockSkewMs) || context.maxClockSkewMs < 0)) return metrics;
  if (population.some((event) => Date.parse(event.recordedAt) <= asOf && Date.parse(event.occurredAt) - Date.parse(event.recordedAt) > (context.maxClockSkewMs ?? 0))) return metrics;
  const byId = new Map(population.map((event) => [event.eventId, event]));
  const corrected = new Set<string>();
  for (const correction of population.filter((event) => event.correctionOfEventId !== undefined && Date.parse(event.recordedAt) <= asOf)) {
    const priorId = correction.correctionOfEventId;
    const prior = priorId === undefined ? undefined : byId.get(priorId);
    if (prior === undefined || Date.parse(prior.recordedAt) > asOf || corrected.has(prior.eventId) || prior.eventType !== correction.eventType || prior.sequence >= correction.sequence || prior.correlation.repositoryId !== correction.correlation.repositoryId || prior.correlation.runId !== correction.correlation.runId || prior.correlation.handoffId !== correction.correlation.handoffId || prior.correlation.contractSha256 !== correction.correlation.contractSha256 || prior.correlation.analysisRunId !== correction.correlation.analysisRunId || !verified("event", prior) || !verified("event", correction)) return metrics;
    corrected.add(prior.eventId);
  }
  const eventVerified = (event: TrafficControlTelemetryEvent | undefined): event is TrafficControlTelemetryEvent => event !== undefined && event.source.sourceSha256 !== undefined && verified("event", event);
  const eventFor = (id: string | undefined, type?: string): TrafficControlTelemetryEvent | undefined => {
    const event = id === undefined ? undefined : byId.get(id);
    return eventVerified(event) && !corrected.has(event.eventId) && (type === undefined || event.eventType === type) && Date.parse(event.recordedAt) <= asOf ? event : undefined;
  };
  interface Run { fact: TrafficControlMetricRun; events: TrafficControlTelemetryEvent[]; closed: TrafficControlTelemetryEvent | undefined; reviews: Array<{ binding: MetricReviewTarget; event: TrafficControlTelemetryEvent; target: TrafficControlTelemetryEvent }>; }
  const runs: Run[] = [];
  const seenRuns = new Set<string>();
  for (const fact of context.runs) {
    try { requireBoundedPayload(fact); } catch { return metrics; }
    const key = `${fact.correlation.repositoryId}:${fact.correlation.runId}`;
    if (seenRuns.has(key) || !validBinding(fact.source) || !correlationFields.safeParse(fact.correlation).success || fact.correlation.analysisRunId !== undefined || !verified("run", fact)) return metrics;
    seenRuns.add(key);
    const contractEvent = eventFor(fact.verificationEventId, "contract.verification_completed");
    const sameRun = (event: TrafficControlTelemetryEvent): boolean => event.correlation.repositoryId === fact.correlation.repositoryId && event.correlation.runId === fact.correlation.runId && event.correlation.analysisRunId === undefined;
    const authorityKey = (value: TelemetryCorrelation): string => `${value.handoffId}:${value.contractSha256}`;
    const bindings = new Set([authorityKey(fact.correlation)]);
    const candidates = population.filter(sameRun).filter((event) => !corrected.has(event.eventId) && Date.parse(event.recordedAt) <= asOf).sort((a, b) => a.sequence - b.sequence);
    // runId survives supersession. Join the approved prior/new handoff link to
    // the new contract's actual verification event and digest; a source label
    // or unrelated callback success cannot admit another authority into a run.
    for (const supersession of candidates.filter((event) => event.eventType === "contract.superseded")) {
      if (!catalogComplete(supersession) || !eventVerified(supersession)) return metrics;
      const prior = String(supersession.payload.priorHandoffId); const next = String(supersession.payload.newHandoffId);
      const predecessor = candidates.find((event) => event.correlation.handoffId === prior && bindings.has(authorityKey(event.correlation)));
      const successor = candidates.find((event) => event.eventType === "contract.verification_completed" && event.correlation.handoffId === next && event.sequence >= supersession.sequence && catalogComplete(event) && ["PASSED", "ACCEPTED"].includes(String(event.payload.result).toUpperCase()) && eventVerified(event));
      // A link may be observed before its successor is submitted. It is still
      // available to M15 when the trusted adapter verifies the approved link;
      // it does not authorize mixing unverified successor lifecycle facts.
      if (predecessor === undefined || prior === next || (supersession.correlation.handoffId !== prior && supersession.correlation.handoffId !== next)) return metrics;
      if (successor !== undefined) bindings.add(authorityKey(successor.correlation));
      if (!bindings.has(authorityKey(supersession.correlation))) return metrics;
    }
    const belongs = (event: TrafficControlTelemetryEvent): boolean => sameRun(event) && bindings.has(authorityKey(event.correlation));
    if (contractEvent === undefined || !belongs(contractEvent) || !catalogComplete(contractEvent)) return metrics;
    const verificationResult = String(contractEvent.payload.result).toUpperCase();
    if (!["PASSED", "ACCEPTED", "FAILED", "REJECTED"].includes(verificationResult)) return metrics;
    const eligible = ["PASSED", "ACCEPTED"].includes(verificationResult);
    if (!eligible) continue; // Retained separately in rejectedContractCount.
    const events = candidates.filter(belongs);
    if (events.some((event) => !eventVerified(event))) return metrics;
    if (candidates.some((event) => !belongs(event))) return metrics;
    const closed = eventFor(fact.closedEventId);
    if (fact.closedEventId !== undefined && (closed === undefined || !belongs(closed) || !closedTypes.has(closed.eventType) || !within(closed))) return metrics;
    const reviews: Run["reviews"] = [];
    for (const binding of fact.reviews) {
      const review = eventFor(binding.reviewEventId, "outcome.reviewed"); const target = eventFor(binding.targetEventId);
      if (review === undefined || target === undefined || !belongs(review) || !belongs(target) || !catalogComplete(review) || !timestamp.safeParse(review.payload.reviewedAt).success || Date.parse(String(review.payload.reviewedAt)) > asOf || review.sequence <= target.sequence) return metrics;
      if (reviews.some((prior) => prior.binding.kind === binding.kind && prior.binding.targetEventId === binding.targetEventId)) return metrics;
      reviews.push({ binding, event: review, target });
    }
    runs.push({ fact, events, closed, reviews });
  }
  const closedRuns = runs.filter((run) => run.closed !== undefined);
  const runReview = (run: Run) => run.reviews.find((review) => review.binding.kind === "run" && review.target.eventId === run.closed?.eventId);
  const reviewCoverage = { reviewed: closedRuns.filter((run) => runReview(run) !== undefined).length, closed: closedRuns.length, value: closedRuns.length === 0 ? null : closedRuns.filter((run) => runReview(run) !== undefined).length / closedRuns.length };
  const unitDimensions = (run: Run, unit?: TrafficControlTelemetryEvent): Record<MetricDimension, string | null> => {
    const supplied = run.fact.dimensions;
    const known = (value: unknown): string | null => typeof value === "string" ? value : null;
    let decision = unit?.eventType === "governor.decision" ? unit : undefined;
    if (decision === undefined && typeof unit?.payload.triggerRecordHash === "string") decision = run.events.find((event) => event.eventType === "governor.decision" && event.payload.recordHash === unit.payload.triggerRecordHash);
    if (decision === undefined && unit !== undefined) {
      const binding = run.fact.decisionTriggers.find((item) => item.triggerEventId === unit.eventId);
      if (binding !== undefined) decision = eventFor(binding.decisionEventId, "governor.decision");
    }
    const signals = isRecord(decision?.payload.signals) ? decision.payload.signals : {};
    return {
      repositoryId: run.fact.correlation.repositoryId, runId: run.fact.correlation.runId,
      consumingProject: known(supplied?.consumingProject), policyVersion: known(decision?.correlation.policyVersion ?? unit?.correlation.policyVersion ?? run.fact.correlation.policyVersion),
      contractSchemaVersion: known(supplied?.contractSchemaVersion), action: known(unit?.payload.action ?? decision?.payload.action), ruleId: known(decision?.payload.ruleId),
      failureClassification: known(signals.failureClassification ?? supplied?.failureClassification), failureFingerprint: known(signals.failureFingerprint ?? supplied?.failureFingerprint),
      taskId: known(unit?.correlation.taskId ?? unit?.payload.taskId ?? decision?.correlation.taskId), ownershipDomain: known(supplied?.ownershipDomain), executionAdapter: known(supplied?.executionAdapter),
      runtimeVersion: known(supplied?.runtimeVersion ?? run.events.find((event) => event.eventType === "execution.started")?.payload.runtimeVersion),
      releaseExposure: known(supplied?.releaseExposure), experimentExposure: known(supplied?.experimentExposure),
      reviewStatus: unit === undefined ? (runReview(run) === undefined ? "provisional" : "reviewed") : run.reviews.some((review) => review.target.eventId === unit.eventId) ? "reviewed" : "provisional",
    };
  };
  const unknownSegments = new Set<string>();
  const included = (id: string, run: Run, unit?: TrafficControlTelemetryEvent): boolean => {
    if (context.segment === undefined) return true;
    const values: Partial<Record<string, string | null>> = unitDimensions(run, unit);
    let matches = true;
    for (const [key, expected] of Object.entries(context.segment)) {
      const value = values[key];
      if (value === undefined || value === null) { unknownSegments.add(id); matches = false; }
      else if (value !== expected) matches = false;
    }
    return matches;
  };
  const dimensions = runs.flatMap((run) => {
    const decisions = run.events.filter((event) => event.eventType === "governor.decision");
    return (decisions.length === 0 ? [undefined] : decisions).map((decision) => unitDimensions(run, decision));
  });
  const meta = { ...base, proofBoundary: "ADAPTER_VERIFIED_SOURCE_CALCULATION" as const, window: { ...context.window }, reviewCoverage, dimensions, ...(context.segment === undefined ? {} : { segment: { ...context.segment } }) };
  for (const id of METRIC_IDS) metrics[id] = { ...current(id), ...meta };
  const missing = (id: string, reason: string, denominator?: number): void => { metrics[id] = { ...meta, status: "UNAVAILABLE", reason, denominator: denominator ?? null }; };
  const ratio = (id: string, numerator: number, denominator: number, unit: string): void => {
    metrics[id] = denominator === 0 ? { ...meta, status: "UNAVAILABLE", reason: "The qualified denominator is zero", denominator: 0, unit } : { ...meta, status: "AVAILABLE", numerator, denominator, value: numerator / denominator, unit };
  };
  const duration = (id: string, samples: number[], unit: string, segments?: Record<string, unknown>): void => {
    ratio(id, samples.reduce((sum, value) => sum + value, 0), samples.length, unit);
    if (current(id).status === "AVAILABLE") metrics[id] = { ...current(id), samples: [...samples], ...(segments === undefined ? {} : { segments }) };
  };
  if (!context.coverage.lifecycle) {
    for (const id of METRIC_IDS) missing(id, "Complete lifecycle source coverage is unavailable");
    return metrics;
  }
  const reviewed = closedRuns.flatMap((run) => { const review = runReview(run); return review === undefined || !included("M-01", run, run.closed) ? [] : [review]; });
  if (context.coverage.reviews) ratio("M-01", reviewed.filter((review) => review.event.payload.correctDisposition === true).length, reviewed.length, "reviewed eligible closed runs");
  else missing("M-01", "Complete outcome-review source coverage is unavailable");
  const integrated = closedRuns.filter((run) => run.events.some((event) => event.eventType === "integration.completed" && within(event)));
  const audits = (run: Run) => run.fact.issuedReceipts.map((issued) => ({ issued, audit: eventFor(issued.auditEventId, "receipt.audit_completed") }));
  const allAuditsKnown = (run: Run): boolean => run.fact.issuedReceipts.length > 0 && audits(run).every(({ issued, audit }) => audit !== undefined && catalogComplete(audit) && ["PASSED", "FAILED"].includes(String(audit.payload.result).toUpperCase()) && audit.payload.receiptSha256 === issued.receiptSha256 && run.events.includes(audit));
  const audited = integrated.filter(allAuditsKnown);
  const escapeAudited = audited.filter((run) => included("M-02", run, run.events.find((event) => event.eventType === "integration.completed")));
  const proofAudited = audited.filter((run) => included("M-06", run, run.events.find((event) => event.eventType === "integration.completed")));
  if (!context.coverage.reviews || escapeAudited.some((run) => runReview(run) === undefined || typeof runReview(run)?.event.payload.invalidEscape !== "boolean")) missing("M-02", "An integration lacks its complete exact receipt audit and target-bound escape review", integrated.length);
  else ratio("M-02", escapeAudited.filter((run) => runReview(run)?.event.payload.invalidEscape === true).length, escapeAudited.length, "audited integrations");
  // Replays compare actual tuples. Analysis records never enter live run metrics.
  if (context.coverage.replay) {
    let agrees = 0; let replayValid = true; const originals = new Set<string>();
    let replayDenominator = 0;
    for (const comparison of context.replayComparisons) {
      const original = eventFor(comparison.originalEventId, "governor.decision"); const replay = eventFor(comparison.replayedEventId, "governor.decision");
      if (!validBinding(comparison.source) || !verified("replay", comparison) || original === undefined || replay === undefined || original.correlation.analysisRunId !== undefined || replay.correlation.analysisRunId === undefined || originals.has(original.eventId) || !catalogComplete(original) || !catalogComplete(replay) || original.correlation.repositoryId !== replay.correlation.repositoryId || original.correlation.runId !== replay.correlation.runId || original.correlation.contractSha256 !== replay.correlation.contractSha256 || original.correlation.handoffId !== replay.correlation.handoffId || original.correlation.policyVersion !== replay.correlation.policyVersion || original.payload.observationSha256 !== replay.payload.observationSha256 || !within(original)) { replayValid = false; break; }
      const originalRun = runs.find((run) => run.events.includes(original));
      if (originalRun === undefined) { replayValid = false; break; }
      originals.add(original.eventId);
      if (!included("M-03", originalRun, original)) continue;
      replayDenominator += 1;
      const tuple = (event: TrafficControlTelemetryEvent) => ({ action: event.payload.action, ruleId: event.payload.ruleId, authorityEffect: event.payload.authorityEffect, signals: event.payload.signals });
      if (canonicalJsonSha256(tuple(original)) === canonicalJsonSha256(tuple(replay))) agrees += 1;
    }
    if (replayValid) ratio("M-03", agrees, replayDenominator, "replayed decision points");
    else missing("M-03", "A replay lacks exact source, input, policy, or distinct analysis-run binding");
  }
  const applied = (event: TrafficControlTelemetryEvent): boolean => catalogComplete(event) && (event.eventType === "integration.blocked" || event.eventType === "intervention.completed" && protectiveActions.has(String(event.payload.action)) && ["APPLIED", "COMPLETED"].includes(String(event.payload.status).toUpperCase()));
  const protectionFor = (run: Run, decision: TrafficControlTelemetryEvent) => run.events.find((event) => event.sequence >= decision.sequence && applied(event) && event.payload.triggerRecordHash === decision.payload.recordHash);
  const drifts = runs.flatMap((run) => run.events.filter((event) => within(event) && event.eventType === "governor.decision" && event.payload.ruleId === "authority-drift" && isRecord(event.payload.signals) && typeof event.payload.signals.violationCode === "string").map((event) => ({ run, event }))).filter(({ run, event }) => included("M-04", run, event));
  ratio("M-04", drifts.filter(({ run, event }) => { const protection = protectionFor(run, event); return protection !== undefined && !run.events.some((later) => later.sequence > event.sequence && later.sequence < protection.sequence && ["attempt.started", "files.changed", "integration.completed"].includes(later.eventType)) && !run.events.some((later) => later.sequence > event.sequence && ["attempt.started", "files.changed", "integration.completed"].includes(later.eventType)); }).length, drifts.length, "detected authority-drift cases");
  const ownershipState = { known: true };
  const ownershipCases = runs.filter((run) => {
    let violated = false;
    for (const event of run.events.filter((item) => item.eventType === "files.changed")) {
      const assessment = run.fact.ownershipAssessments?.find((item) => item.filesChangedEventId === event.eventId);
      // Reuse the native validator's actual rename-aware evaluation. A catalog
      // path list cannot establish that previousPath or forbidden paths passed.
      if (assessment === undefined || !validBinding(assessment.source) || !catalogComplete(event) || !stringArray(event.payload.paths) || !Array.isArray(assessment.evaluation.changedFiles) || !Array.isArray(assessment.evaluation.violations) || assessment.evaluation.passed !== (assessment.evaluation.violations.length === 0) || event.payload.paths.some((path) => !assessment.evaluation.changedFiles.some((change) => change.path === path)) || assessment.evaluation.changedFiles.some((change) => !(event.payload.paths as string[]).includes(change.path))) { ownershipState.known = false; continue; }
      if (!assessment.evaluation.passed && included("M-05", run, event)) violated = true;
    }
    return violated;
  });
  if (!ownershipState.known) missing("M-05", "Actual changed paths lack their native rename-aware ownership assessment");
  else ratio("M-05", ownershipCases.filter((run) => {
    if (run.events.some((event) => event.eventType === "integration.completed")) return false;
    const violations = run.fact.ownershipAssessments?.filter((assessment) => !assessment.evaluation.passed && included("M-05", run, eventFor(assessment.filesChangedEventId))) ?? [];
    return violations.every((assessment) => {
      const changed = eventFor(assessment.filesChangedEventId, "files.changed");
      return changed !== undefined && run.fact.decisionTriggers.some((binding) => {
        const decision = eventFor(binding.decisionEventId, "governor.decision");
        const protection = decision === undefined ? undefined : protectionFor(run, decision);
        return binding.triggerEventId === changed.eventId && decision !== undefined && decision.sequence > changed.sequence && protection !== undefined && (protection.eventType === "integration.blocked" || protection.payload.action === "BLOCK_INTEGRATION");
      });
    });
  }).length, ownershipCases.length, "runs with unauthorized changed paths");
  let proofKnown = true; let proofEscapes = 0;
  for (const run of proofAudited) {
    const integration = run.events.find((event) => event.eventType === "integration.completed");
    const evidence = run.events.filter((event) => event.eventType === "evidence.recorded" && event.sequence < (integration?.sequence ?? 0)).at(-1);
    if (run.fact.requiredEvidenceIds.length === 0) continue;
    if (evidence === undefined || !catalogComplete(evidence) || !stringArray(evidence.payload.satisfied) || !stringArray(evidence.payload.contradicted)) { proofKnown = false; continue; }
    if (run.fact.requiredEvidenceIds.some((id) => !(evidence.payload.satisfied as string[]).includes(id) || (evidence.payload.contradicted as string[]).includes(id))) proofEscapes += 1;
  }
  if (proofKnown) ratio("M-06", proofEscapes, proofAudited.length, "audited integrations");
  else missing("M-06", "An audited integration lacks contract-required evidence or complete receipt-audit coverage", integrated.length);
  for (const run of closedRuns) {
    const review = runReview(run);
    if (review?.event.payload.correctDisposition !== true || !included("M-01", run, run.closed)) continue;
    if (review.event.payload.invalidEscape !== false) missing("M-01", "A correctness review contradicts escape evidence", reviewed.length);
    if (run.events.some((event) => event.eventType === "integration.completed")) {
      const integration = run.events.find((event) => event.eventType === "integration.completed");
      if (integration === undefined) { missing("M-01", "Integration source is unavailable"); continue; }
      const evidence = run.events.filter((event) => event.eventType === "evidence.recorded" && event.sequence < integration.sequence).at(-1);
      const requiredProofEscaped = run.fact.requiredEvidenceIds.length > 0 && (evidence === undefined || !stringArray(evidence.payload.satisfied) || !stringArray(evidence.payload.contradicted) || run.fact.requiredEvidenceIds.some((id) => !(evidence.payload.satisfied as string[]).includes(id) || (evidence.payload.contradicted as string[]).includes(id)));
      if (!allAuditsKnown(run) || audits(run).some(({ audit }) => String(audit?.payload.result).toUpperCase() !== "PASSED" || (audit?.payload.violationCodes as unknown[]).length > 0) || review.event.payload.invalidEscape !== false || requiredProofEscaped || run.fact.ownershipAssessments?.some((assessment) => !assessment.evaluation.passed)) missing("M-01", "A correctness review contradicts or lacks valid audited integration and escape evidence", reviewed.length);
    } else if (run.closed === undefined || !applied(run.closed)) missing("M-01", "A correctness review lacks an actual protective terminal disposition", reviewed.length);
  }
  const auditCoverage = { auditedIntegrations: audited.length, totalIntegrations: integrated.length };
  metrics["M-02"] = { ...current("M-02"), sourceCoverage: auditCoverage };
  metrics["M-06"] = { ...current("M-06"), sourceCoverage: auditCoverage };
  const issued = runs.flatMap((run) => audits(run).filter(({ audit }) => included("M-07", run, audit ?? run.closed)));
  if (issued.some(({ issued: receipt, audit }) => audit === undefined || !catalogComplete(audit) || audit.payload.receiptSha256 !== receipt.receiptSha256 || !["PASSED", "FAILED"].includes(String(audit.payload.result).toUpperCase()) || String(audit.payload.result).toUpperCase() === "PASSED" && (audit.payload.violationCodes as unknown[]).length > 0)) missing("M-07", "An issued receipt lacks its exact completed audit", issued.length);
  else ratio("M-07", issued.filter(({ audit }) => String(audit?.payload.result).toUpperCase() === "PASSED").length, issued.length, "issued receipts");
  const allReviews = runs.flatMap((run) => run.reviews.map((review) => ({ run, ...review })));
  const interventions = allReviews.filter((review) => review.binding.kind === "intervention" && included("M-08", review.run, review.target));
  if (context.coverage.reviews && interventions.every((review) => applied(review.target))) ratio("M-08", interventions.filter((review) => review.event.payload.correctDisposition === true).length, interventions.length, "reviewed protective interventions");
  else missing("M-08", "Complete target-bound protective-intervention review coverage is unavailable");
  const cases = allReviews.filter((review) => review.binding.kind === "protection-case" && included("M-09", review.run, review.target));
  const protectionIsTimely = (review: typeof allReviews[number]): boolean => {
    const protection = eventFor(review.binding.protectionEventId);
    if (protection === undefined || !review.run.events.includes(protection) || !applied(protection) || protection.sequence < review.target.sequence) return false;
    return !review.run.events.some((event) => event.eventType === "integration.completed" && event.sequence < protection.sequence);
  };
  if (context.coverage.reviews && cases.every((review) => typeof review.event.payload.protectionRequired === "boolean")) {
    const required = cases.filter((review) => review.event.payload.protectionRequired === true);
    ratio("M-09", required.filter(protectionIsTimely).length, required.length, "reviewed cases requiring protection");
  } else missing("M-09", "Target-bound protection-case adjudication is unavailable");
  const noProgress = allReviews.filter((review) => review.binding.kind === "no-progress" && included("M-10", review.run, review.target));
  if (context.coverage.reviews && noProgress.every((review) => typeof review.event.payload.repeatedNoProgress === "boolean" && eventFor(review.run.fact.thresholdCrossingEventId) !== undefined)) {
    const repeated = noProgress.filter((review) => review.event.payload.repeatedNoProgress === true);
    ratio("M-10", repeated.filter((review) => { const protection = eventFor(review.binding.protectionEventId); const threshold = eventFor(review.run.fact.thresholdCrossingEventId); return protectionIsTimely(review) && protection !== undefined && threshold !== undefined && (protection.sequence <= threshold.sequence || !review.run.events.some((event) => event.eventType === "attempt.started" && event.sequence > threshold.sequence && event.sequence < protection.sequence)); }).length, repeated.length, "reviewed repeated no-progress cases");
  } else missing("M-10", "Reviewed no-progress cases or policy-threshold source bindings are unavailable");
  const thresholdRuns = runs.filter((run) => run.fact.thresholdCrossingEventId !== undefined && included("M-11", run, eventFor(run.fact.thresholdCrossingEventId)));
  let excessKnown = true; let excess = 0;
  for (const run of thresholdRuns) {
    const threshold = eventFor(run.fact.thresholdCrossingEventId, "governor.decision");
    const protection = threshold === undefined ? undefined : run.events.find((event) => event.sequence >= threshold.sequence && applied(event));
    if (threshold === undefined || !run.events.includes(threshold) || !isRecord(threshold.payload.signals) || typeof threshold.payload.signals.repeatCount !== "number" || threshold.payload.signals.repeatCount < 1 || protection === undefined) { excessKnown = false; continue; }
    excess += run.events.filter((event) => event.eventType === "attempt.started" && event.sequence > threshold.sequence && event.sequence < protection.sequence).length;
  }
  if (excessKnown) ratio("M-11", excess, thresholdRuns.length, "excess attempts per threshold-crossing run");
  else missing("M-11", "A threshold crossing or subsequent protective disposition is unavailable", thresholdRuns.length);
  let failed = 0; let gained = 0; let failureKnown = true;
  for (const run of runs) {
    const attempts = run.events.filter((event) => event.eventType === "attempt.started" && within(event));
    if (run.fact.attemptOutcomes === undefined || run.fact.attemptOutcomes.length !== attempts.length) { if (attempts.length > 0) failureKnown = false; continue; }
    const seen = new Set<string>();
    for (const outcome of run.fact.attemptOutcomes) {
      const attempt = eventFor(outcome.attemptEventId, "attempt.started");
      const delta = outcome.evidenceDelta;
      if (!validBinding(outcome.source) || attempt === undefined || !attempts.includes(attempt) || seen.has(attempt.eventId) || !catalogComplete(attempt) || !["succeeded", "failed", "cancelled", "interrupted"].includes(outcome.status) || !isRecord(delta) || !stringArray(delta.newItems) || !stringArray(delta.newlySatisfied) || !stringArray(delta.newContradictions)) { failureKnown = false; continue; }
      seen.add(attempt.eventId);
      // This is the existing native observation score, including double
      // weighting contradictions. No validation event is required for a worker
      // attempt that failed before reaching validation.
      const score = delta.newItems.length + 2 * delta.newlySatisfied.length - 2 * delta.newContradictions.length;
      const direction = score > 0 ? "POSITIVE" : score < 0 ? "NEGATIVE" : "ZERO";
      if (delta.score !== score || delta.direction !== direction) { failureKnown = false; continue; }
      if (outcome.status === "failed" && included("M-12", run, attempt)) { failed += 1; if (score > 0) gained += 1; }
    }
  }
  if (failureKnown) ratio("M-12", gained, failed, "failed attempts");
  else missing("M-12", "Complete native attempt-outcome and evidence-delta source coverage is unavailable");
  const latencies: number[] = []; let latencyKnown = true;
  for (const run of runs) {
    const decisions = run.events.filter((event) => event.eventType === "governor.decision");
    if (decisions.length !== run.fact.decisionTriggers.length) latencyKnown = false;
    for (const binding of run.fact.decisionTriggers) {
      const decision = eventFor(binding.decisionEventId, "governor.decision"); const trigger = eventFor(binding.triggerEventId);
      const elapsed = decision === undefined || trigger === undefined ? NaN : Date.parse(decision.occurredAt) - Date.parse(trigger.occurredAt);
      if (decision === undefined || trigger === undefined || !run.events.includes(decision) || !run.events.includes(trigger) || trigger.sequence >= decision.sequence || !Number.isFinite(elapsed) || elapsed < 0) latencyKnown = false;
      else if (included("M-13", run, decision)) latencies.push(elapsed);
    }
  }
  if (latencyKnown) duration("M-13", latencies, "milliseconds per decision");
  else missing("M-13", "An exact triggering source event or complete decision coverage is unavailable");
  const times: number[] = []; const dispositionSegments: Record<string, number[]> = {}; let dispositionKnown = true;
  for (const run of closedRuns) {
    const starts = run.events.filter((event) => event.eventType === "execution.started"); const first = starts[0]; const closed = run.closed;
    const elapsed = first === undefined || closed === undefined ? NaN : Date.parse(closed.occurredAt) - Date.parse(first.occurredAt);
    if (starts.length !== 1 || first === undefined || closed === undefined || first.sequence >= closed.sequence || !Number.isFinite(elapsed) || elapsed < 0 || !catalogComplete(first)) { dispositionKnown = false; continue; }
    if (!included("M-14", run, closed)) continue;
    times.push(elapsed); const disposition = typeof closed.payload.action === "string" ? closed.payload.action : closed.eventType; (dispositionSegments[disposition] ??= []).push(elapsed);
  }
  if (dispositionKnown) duration("M-14", times, "milliseconds per governed disposition", dispositionSegments);
  else missing("M-14", "An exact execution start or terminal governed disposition is unavailable");
  const structuralTimes: number[] = []; let structuralKnown = true;
  for (const run of runs) {
    const concerns = run.events.filter((event) => event.eventType === "structural.concern_recorded");
    if (concerns.length !== run.fact.structuralClosures.length) structuralKnown = false;
    for (const binding of run.fact.structuralClosures) {
      const concern = eventFor(binding.concernEventId, "structural.concern_recorded"); const supersession = eventFor(binding.supersessionEventId, "contract.superseded");
      const elapsed = concern === undefined || supersession === undefined ? NaN : Date.parse(supersession.occurredAt) - Date.parse(concern.occurredAt);
      if (concern === undefined || supersession === undefined || !run.events.includes(concern) || !run.events.includes(supersession) || !catalogComplete(concern) || !catalogComplete(supersession) || supersession.payload.priorHandoffId !== concern.correlation.handoffId || supersession.payload.newHandoffId === concern.correlation.handoffId || supersession.sequence <= concern.sequence || !Number.isFinite(elapsed) || elapsed < 0) structuralKnown = false;
      else if (included("M-15", run, concern)) structuralTimes.push(elapsed);
    }
  }
  if (structuralKnown) duration("M-15", structuralTimes, "milliseconds per approved structural closure");
  else missing("M-15", "A structural concern lacks its approved superseding-contract source; unresolved cases are censored");
  if (context.coverage.submissions) {
    const submissions = context.runs.filter((fact) => { const run = runs.find((item) => item.fact === fact); return fact.submittedEligibleHandoff && (run === undefined ? (context.segment === undefined || (unknownSegments.add("M-16"), false)) : included("M-16", run, eventFor(fact.verificationEventId))); });
    const handoffs = new Set(submissions.map((run) => `${run.correlation.repositoryId}:${run.correlation.handoffId}:${run.correlation.contractSha256}`));
    if (handoffs.size !== submissions.length) missing("M-16", "Eligible handoff submission identities are duplicated");
    else ratio("M-16", submissions.filter((fact) => !fact.manualTranslation && runs.some((run) => run.fact === fact)).length, submissions.length, "eligible handoffs submitted");
  }
  const requirementsState = { known: true };
  const completenessRuns = closedRuns.filter((run) => included("M-17", run, run.closed));
  const complete = completenessRuns.filter((run) => {
    if (run.fact.requiredLifecycleEvents.length === 0 || run.fact.requiredLifecycleEvents.some((type) => !eventTypes.safeParse(type).success)) { requirementsState.known = false; return false; }
    return run.fact.requiredLifecycleEvents.every((type) => run.events.some((event) => event.eventType === type && catalogComplete(event) && (!(["attempt.started", "files.changed", "validation.completed"].includes(type)) || run.fact.tasks.length <= 1 || event.correlation.taskId !== undefined)));
  });
  if (requirementsState.known) ratio("M-17", complete.length, completenessRuns.length, "closed runs with contract-applicable lifecycle requirements");
  else missing("M-17", "Contract-applicable lifecycle requirements are unavailable");
  const closedTime = (run: Run): number => run.closed === undefined ? NaN : Date.parse(run.closed.occurredAt);
  const reviewRuns = closedRuns.filter((run) => included("M-18", run, run.closed));
  if (context.coverage.reviews && reviewRuns.every((run) => closedTime(run) + context.reviewWindowMs <= asOf)) {
    ratio("M-18", reviewRuns.filter((run) => { const review = runReview(run); return review !== undefined && Date.parse(String(review.event.payload.reviewedAt)) >= closedTime(run) && Date.parse(String(review.event.payload.reviewedAt)) <= closedTime(run) + context.reviewWindowMs; }).length, reviewRuns.length, "closed runs reviewed within the review horizon");
  } else missing("M-18", "Outcome-review coverage is incomplete or a closed run has not reached its review horizon", closedRuns.length);
  const allDispositions = allReviews.filter((review) => review.binding.kind === "disposition" && review.target.eventType === "governor.decision");
  const dispositions = allDispositions.filter((review) => included("M-19", review.run, review.target));
  if (context.coverage.reviews && context.coverage.overrides) {
    let overrideKnown = true; const targets = new Set<string>(); const segments: Record<string, number> = {};
    for (const override of context.overrides) {
      const target = eventFor(override.dispositionEventId, "governor.decision");
      if (!validBinding(override.source) || !verified("override", override) || target === undefined || !allDispositions.some((review) => review.target.eventId === target.eventId) || targets.has(target.eventId) || !timestamp.safeParse(override.occurredAt).success || Date.parse(override.occurredAt) < Date.parse(target.occurredAt) || Date.parse(override.occurredAt) > asOf || !identifier.safeParse(override.direction).success) { overrideKnown = false; break; }
      const review = allDispositions.find((item) => item.target.eventId === target.eventId);
      if (review === undefined || !included("M-19", review.run, target)) continue;
      targets.add(target.eventId); const key = `${String(target.payload.ruleId)}:${override.direction}`; segments[key] = (segments[key] ?? 0) + 1;
    }
    if (overrideKnown) { ratio("M-19", targets.size, dispositions.length, "reviewed dispositions"); metrics["M-19"] = { ...current("M-19"), segments }; }
    else missing("M-19", "A manual override lacks its exact source, reviewed disposition, or direction binding");
  }
  for (const id of unknownSegments) missing(id, "A relevant counting unit has an unknown requested segment dimension");
  return metrics;
}

function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function catalogComplete(event: TrafficControlTelemetryEvent): boolean {
  const required: Record<string, string[]> = {
    "contract.verification_completed": ["result", "violationCode", "baseCommit", "authoritySourceDigests"],
    "execution.started": ["maxAttempts", "planId", "runtimeVersion"], "attempt.started": ["attempt", "maxAttempts", "taskId"],
    "files.changed": ["taskId", "paths", "commit"], "impact.assessed": ["impactedPaths", "activeTaskCollisions", "expanded"],
    "validation.completed": ["taskId", "command", "status", "evidenceId", "artifactSha256"],
    "evidence.recorded": ["items", "satisfied", "contradicted", "artifactDigests"],
    "governor.decision": ["action", "ruleId", "authorityEffect", "requiresApproval", "signals", "observationSha256", "recordHash"],
    "intervention.completed": ["action", "status", "triggerRecordHash", "latencyMs"],
    "integration.completed": ["integrationCommit", "taskIntegrationCommits"], "integration.blocked": ["reason", "triggerRecordHash"],
    "receipt.audit_completed": ["result", "receiptSha256", "violationCodes"], "structural.concern_recorded": ["reason", "sourceEvidenceIds"],
    "contract.superseded": ["priorHandoffId", "newHandoffId", "approvalId"],
    "outcome.reviewed": ["correctDisposition", "invalidEscape", "outcomeClass", "reviewerAuthority", "reviewedAt"],
  };
  return (required[event.eventType] ?? []).every((key) => Object.hasOwn(event.payload, key) && (event.payload[key] !== null || key === "violationCode")) && selectedPayloadSchema(event.eventType).safeParse(event.payload).success;
}

function requireTelemetryEnvelope(event: TrafficControlTelemetryEvent): void {
  const { payload, ...metadata } = event;
  requireBoundedPayload(metadata);
  requireBoundedPayload(payload);
  if (event.eventType === "validation.completed" && typeof payload.command === "string") requireCommandMetadata(payload.command);
  if (!envelope.safeParse(event).success) throw new TypeError("Telemetry event does not match the published v1 envelope");
  // A v1 sourceRecordId is opaque. Raw identity agreement is checked only
  // by the projector while the original native SourceBuildEvent is available.
}

const MAX_PAYLOAD_BYTES = 32 * 1024;
const rejectCredential = createRedactor();
const SENSITIVE_FIELDS = new Set(["apikey", "accesstoken", "authtoken", "password", "credential", "credentials", "privatekey", "secret", "secrets", "token", "tokens", "prompt", "prompts", "sourcecode", "rawlog", "rawlogs", "log", "logs", "stdout", "stderr", "env", "environmentvalues", "envvalues", "environmentvariables", "envvars"]);

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
        if (key.toLowerCase() === "environment" && typeof item !== "string") throw new TypeError("Product telemetry cannot contain raw environment values");
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
      signals: isRecord(decision.signals) ? copySelectedFact(decision.signals) : {},
      observationSha256: source.observationHash ?? null,
      recordHash: source.recordHash ?? null,
    };
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
  const keys: Record<string, string[]> = {
    "contract.verification_completed": ["result", "violationCode", "baseCommit", "authoritySourceDigests"],
    "execution.started": ["maxAttempts", "planId", "runtimeVersion"],
    "attempt.started": ["attempt", "maxAttempts", "taskId"], "files.changed": ["taskId", "paths", "commit"],
    "validation.completed": ["taskId", "command", "status", "evidenceId", "artifactSha256", "attempt"],
    "evidence.recorded": ["items", "satisfied", "contradicted", "artifactDigests"],
    "intervention.completed": ["action", "status", "triggerRecordHash", "latencyMs"],
    "integration.completed": ["integrationCommit", "taskIntegrationCommits"], "integration.blocked": ["reason", "triggerRecordHash"],
    "receipt.audit_completed": ["result", "receiptSha256", "violationCodes"],
    "structural.concern_recorded": ["reason", "sourceEvidenceIds"], "contract.superseded": ["priorHandoffId", "newHandoffId", "approvalId"],
    "outcome.reviewed": ["correctDisposition", "invalidEscape", "outcomeClass", "reviewerAuthority", "reviewedAt", "protectionRequired", "repeatedNoProgress"],
  };
  const payload: Record<string, unknown> = { environment };
  for (const key of keys[type] ?? []) if (source[key] !== undefined) payload[key] = copySelectedFact(source[key]);
  if (!selectedPayloadSchema(type).safeParse(payload).success) throw new TypeError("Selected telemetry catalog facts have invalid types");
  if (typeof payload.command === "string") requireCommandMetadata(payload.command);
  return payload;
}

/** Preserve ordinary command metadata exactly. Recognized inline programs,
 * model prompts and credential arguments are rejected rather than exported.
 * This bounded pattern guard is not a universal source-code/secret classifier. */
function requireCommandMetadata(command: string): void {
  const argv = parseCommandLine(command);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = (argv[index] ?? "").toLowerCase();
    if (/^--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret|authorization|prompt|system[-_]?prompt)(?:=|$)/u.test(argument)) throw new TypeError("Product telemetry cannot contain credential or prompt command arguments");
    const executable = argument.split(/[\\/]/u).at(-1)?.replace(/\.exe$/u, "") ?? argument;
    const rest = argv.slice(index + 1).map((value) => value.toLowerCase());
    const inline = /^(?:node|nodejs)$/u.test(executable) ? rest.some((value) => /^-(?:e|p)(?:[^-]|$)|^--(?:eval|print)(?:=|$)/u.test(value))
      : /^python(?:\d+(?:\.\d+)?)?$/u.test(executable) ? rest.some((value) => /^-[^-]*c/u.test(value))
        : /^(?:sh|bash|dash|zsh|ksh)$/u.test(executable) ? rest.some((value) => /^-[^-]*c/u.test(value))
          : /^(?:powershell|pwsh)$/u.test(executable) ? rest.some((value) => /^-(?:c|command|encodedcommand|enc|e)(?:=|$)/u.test(value))
            : /^(?:ruby|perl)$/u.test(executable) ? rest.some((value) => /^-[^-]*e/u.test(value))
              : executable === "php" ? rest.some((value) => /^-r/u.test(value))
                : executable === "cmd" ? rest.some((value) => /^\/(?:c|k)$/u.test(value)) : false;
    if (inline || ["codex", "claude", "gemini", "aider", "llm"].includes(executable) && rest.some((value) => !["--version", "--help", "-h"].includes(value))) throw new TypeError("Product telemetry cannot contain inline source code or model prompts");
  }
}

function selectedPayloadSchema(type: string) {
  const strings = z.array(z.string()); const gitCommit = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
  const shapes: Record<string, z.ZodRawShape> = {
    "contract.verification_completed": { result: identifier, violationCode: z.string().nullable(), baseCommit: gitCommit, authoritySourceDigests: z.record(z.string(), digest) },
    "execution.started": { maxAttempts: z.number().int().positive(), planId: identifier, runtimeVersion: identifier },
    "attempt.started": { attempt: z.number().int().positive(), maxAttempts: z.number().int().positive(), taskId: identifier },
    "files.changed": { taskId: identifier, paths: strings, commit: gitCommit },
    "impact.assessed": { impactedPaths: strings, activeTaskCollisions: strings, expanded: z.boolean() },
    "validation.completed": { taskId: identifier, command: identifier, status: identifier, evidenceId: identifier, artifactSha256: digest, attempt: z.number().int().positive() },
    "evidence.recorded": { items: z.array(z.unknown()), satisfied: strings, contradicted: strings, artifactDigests: z.union([z.record(z.string(), digest), z.array(digest)]) },
    "governor.decision": { action: identifier, ruleId: identifier, authorityEffect: identifier, requiresApproval: z.boolean(), signals: z.record(z.string(), z.unknown()), observationSha256: digest, recordHash: digest },
    "intervention.completed": { action: identifier, status: identifier, triggerRecordHash: digest, latencyMs: z.number().nonnegative() },
    "integration.completed": { integrationCommit: gitCommit, taskIntegrationCommits: z.record(z.string(), gitCommit) },
    "integration.blocked": { reason: identifier, triggerRecordHash: digest },
    "receipt.audit_completed": { result: identifier, receiptSha256: digest, violationCodes: strings },
    "structural.concern_recorded": { reason: identifier, sourceEvidenceIds: strings },
    "contract.superseded": { priorHandoffId: identifier, newHandoffId: identifier, approvalId: identifier },
    "outcome.reviewed": { correctDisposition: z.boolean(), invalidEscape: z.boolean(), outcomeClass: identifier, reviewerAuthority: identifier, reviewedAt: timestamp, protectionRequired: z.boolean(), repeatedNoProgress: z.boolean() },
  };
  return z.object(shapes[type] ?? {}).partial().loose();
}

/** Copy indexed JSON values so custom iterators and later mutation cannot change
 * selected facts. The existing privacy/size guard applies to every copied value. */
function copySelectedFact(input: unknown): unknown {
  const ancestors = new Set<object>(); let remaining = MAX_PAYLOAD_BYTES;
  const copy = (value: unknown, depth: number): unknown => {
    if (depth > 8) throw new TypeError("Product telemetry payload nesting is unsupported");
    if (typeof value !== "object" || value === null) { requireBoundedPayload(value); remaining -= Buffer.byteLength(JSON.stringify(value), "utf8"); if (remaining < 0) throw new TypeError("Product telemetry payload exceeds its bounded size"); return value; }
    if (ancestors.has(value)) throw new TypeError("Product telemetry payload cannot contain cycles");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("Product telemetry payload must contain bounded JSON values");
    ancestors.add(value); let output: unknown;
    if (Array.isArray(value)) {
      if (value.length > MAX_PAYLOAD_BYTES) throw new TypeError("Product telemetry payload exceeds its bounded size");
      const result: unknown[] = []; for (let index = 0; index < value.length; index += 1) result.push(copy(value[index], depth + 1)); output = result;
    } else {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of Object.entries(value)) { if (SENSITIVE_FIELDS.has(key.replace(/[^a-z0-9]/giu, "").toLowerCase())) throw new TypeError("Product telemetry cannot contain sensitive payload fields"); remaining -= Buffer.byteLength(key, "utf8"); result[key] = copy(item, depth + 1); }
      output = result;
    }
    ancestors.delete(value); requireBoundedPayload(output); return output;
  };
  return copy(input, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isEnvironment(value: unknown): value is ProofEnvironment { return typeof value === "string" && ["synthetic", "local", "ci", "hosted", "production", "reviewed-outcome"].includes(value); }
