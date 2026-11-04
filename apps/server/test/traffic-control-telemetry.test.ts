import { describe, expect, it } from "vitest";
import { projectTrafficControlTelemetry, summarizeTrafficControlMetrics } from "../src/telemetry/traffic-control-projection.js";
import type { TrafficControlTelemetryEvent } from "../src/telemetry/traffic-control-projection.js";

const source = {
  sequence: 7, buildId: "build-1", taskId: null, type: "governor.decision",
  payload: {
    recordHash: "a".repeat(64), observationHash: "b".repeat(64), policyVersion: "governor.v1",
    decision: { action: "CONTINUE", ruleId: "entitled-to-continue", authorityEffect: "NONE", requiresApproval: false, signals: {} },
  },
  occurredAt: "2026-09-17T12:00:00Z",
};
const correlation = { repositoryId: "repo-1", runId: "run-1", buildId: "build-1", handoffId: "DI-1", contractSha256: "c".repeat(64) };

describe("Traffic Control telemetry projection", () => {
  it("projects an idempotent bounded Governor event", () => {
    const event = projectTrafficControlTelemetry(source, { correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local" });
    expect(event).toMatchObject({ schemaVersion: "1.0.0", kind: "traffic-control/telemetry-event", eventType: "governor.decision", sequence: 7, proofBoundary: "LOCAL_EXECUTION" });
    expect(event.eventId).toBe(projectTrafficControlTelemetry(source, { correlation, recordedAt: "2026-09-17T12:00:02Z", environment: "local" }).eventId);
    expect(JSON.stringify(event)).not.toContain("prompt");
  });

  it("deduplicates source facts and never mixes proof environments", () => {
    const local = projectTrafficControlTelemetry(source, { correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local" });
    const hosted = projectTrafficControlTelemetry({ ...source, sequence: 8 }, { correlation: { ...correlation, runId: "run-2" }, recordedAt: "2026-09-17T12:00:01Z", environment: "hosted" });
    const summary = summarizeTrafficControlMetrics([local, local, hosted]);
    expect(summary.populations.local?.sourceEventCount).toBe(1);
    expect(summary.populations.hosted?.sourceEventCount).toBe(1);
    expect(summary.populations.production).toBeUndefined();
  });

  it("marks review-dependent metrics unavailable without review evidence", () => {
    const event = projectTrafficControlTelemetry(source, { correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local" });
    const summary = summarizeTrafficControlMetrics([event]);
    expect(summary.populations.local?.metrics["M-01"]).toEqual({ status: "UNAVAILABLE", reason: "No reviewed outcomes" });
  });
});

describe("Traffic Control v1 boundary compatibility", () => {
  const options = { correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local" as const };
  const project = () => projectTrafficControlTelemetry(source, options);
  const asEvent = (value: unknown) => value as TrafficControlTelemetryEvent;
  const nativeFailure = {
    ...source, sequence: 8, type: "governor.evaluation_failed",
    payload: {
      decisionRecordHash: "a".repeat(64), action: "PAUSE_FOR_REVIEW", acknowledged: false,
      details: { runtimeApplyInvoked: true, acknowledgementAvailable: false, receiptPersistAttempted: false, observedBuildStatusAfter: "paused" },
    },
  };

  it("refuses an explicitly selected unsupported native failure without changing it", () => {
    const before = structuredClone(nativeFailure);
    expect(() => projectTrafficControlTelemetry(nativeFailure, options)).toThrow();
    expect(nativeFailure).toEqual(before);
  });

  it("refuses to count an unsupported failure as a v1 telemetry event", () => {
    const event = asEvent({ ...project(), eventType: nativeFailure.type, payload: { environment: "local", action: "PAUSE_FOR_REVIEW" } });
    expect(() => summarizeTrafficControlMetrics([event])).toThrow();
  });

  it("refuses unknown correlation fields before they can leave the projector", () => {
    const invalid = { ...correlation, secret: "INERT_QA_SENTINEL" };
    expect(() => projectTrafficControlTelemetry(source, { ...options, correlation: invalid })).toThrow();
  });

  it("refuses known native build and nonempty task disagreements", () => {
    expect(() => projectTrafficControlTelemetry(source, { ...options, correlation: { ...correlation, buildId: "different-build" } })).toThrow();
    expect(() => projectTrafficControlTelemetry({ ...source, taskId: "native-task" }, { ...options, correlation: { ...correlation, taskId: "different-task" } })).toThrow();
  });

  it("does not infer raw native identity from a schema-valid opaque source record", () => {
    const event = { ...project(), source: { ...project().source, sourceRecordId: "opaque-foreign-record:7" }, correlation: { ...correlation, buildId: "declared-context-only" } };
    expect(summarizeTrafficControlMetrics([event]).populations.local?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("preserves caller task context when the native event has no task identity", () => {
    const event = projectTrafficControlTelemetry({ ...source, type: "attempt.started", payload: { attempt: 1, taskId: "payload-context-only" } }, { ...options, correlation: { ...correlation, taskId: "caller-context-only" } });
    expect(event.correlation.taskId).toBe("caller-context-only");
    expect(summarizeTrafficControlMetrics([event]).populations.local?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
  });

  const invalidHeaders: Array<[string, (event: Record<string, unknown>) => void]> = [
    ["schema version", (event) => { event.schemaVersion = "2.0.0"; }],
    ["kind", (event) => { event.kind = "other/event"; }],
    ["additional header", (event) => { event.rawLog = "INERT_QA_SENTINEL"; }],
    ["missing header", (event) => { delete event.recordedAt; }],
    ["empty event identity", (event) => { event.eventId = ""; }],
    ["invalid sequence", (event) => { event.sequence = 0; }],
    ["unknown proof boundary", (event) => { event.proofBoundary = "AUTOMATIC_SUCCESS"; }],
    ["additional source field", (event) => { (event.source as Record<string, unknown>).rawLog = "INERT_QA_SENTINEL"; }],
    ["invalid source digest", (event) => { (event.source as Record<string, unknown>).sourceSha256 = "not-a-digest"; }],
    ["additional correlation field", (event) => { (event.correlation as Record<string, unknown>).secret = "INERT_QA_SENTINEL"; }],
    ["missing governed correlation", (event) => { delete (event.correlation as Record<string, unknown>).handoffId; }],
    ["null optional correlation", (event) => { (event.correlation as Record<string, unknown>).taskId = null; }],
    ["unpaired correction", (event) => { event.correctionOfEventId = "prior-event"; }],
  ];
  it.each(invalidHeaders)("refuses an invalid %s before summarization", (_label, mutate) => {
    const event = structuredClone(project()) as unknown as Record<string, unknown>;
    mutate(event);
    expect(() => summarizeTrafficControlMetrics([asEvent(event)])).toThrow();
  });

  it.each(["September 17, 2026", "2026-02-30T12:00:00Z", "2026-09-17T24:00:00Z", "2026-09-17T12:00:00", "2026-09-17T12:00:00+24:00"])("refuses malformed date-time %s without a clock-window policy", (timestamp) => {
    expect(() => projectTrafficControlTelemetry({ ...source, occurredAt: timestamp }, options)).toThrow();
    expect(() => projectTrafficControlTelemetry(source, { ...options, recordedAt: timestamp })).toThrow();
    expect(() => summarizeTrafficControlMetrics([{ ...project(), recordedAt: timestamp }])).toThrow();
  });

  it("requires an explicit supported environment without substituting a default", () => {
    const invalid = { ...options, environment: undefined } as unknown as Parameters<typeof projectTrafficControlTelemetry>[1];
    expect(() => projectTrafficControlTelemetry(source, invalid)).toThrow();
  });

  it("preserves optional IDs/digest and the existing null-task caller context", () => {
    const requiredCorrelation = { repositoryId: correlation.repositoryId, runId: correlation.runId, handoffId: correlation.handoffId, contractSha256: correlation.contractSha256 };
    const noOptionalId = projectTrafficControlTelemetry(source, { ...options, correlation: requiredCorrelation });
    const event = structuredClone(noOptionalId) as unknown as Record<string, unknown>;
    delete (event.source as Record<string, unknown>).sourceSha256;
    expect(summarizeTrafficControlMetrics([asEvent(event)]).populations.local?.sourceEventCount).toBe(1);
    const context = projectTrafficControlTelemetry(source, { ...options, correlation: { ...correlation, taskId: "caller-context-only" } });
    expect(context.correlation.taskId).toBe("caller-context-only");
    expect(summarizeTrafficControlMetrics([context]).populations.local?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("accepts all published proof boundaries and paired correction metadata without claiming outcomes", () => {
    for (const proofBoundary of ["CONTRACT_AND_AUTHORITY", "LOCAL_EXECUTION", "LOCAL_EXECUTION_AND_INTEGRATION", "HOSTED_RUNTIME", "REVIEWED_OUTCOME"]) {
      const event = asEvent({ ...project(), proofBoundary, correctionOfEventId: "prior-event", correctionReason: "Bounded fixture correction" });
      expect(summarizeTrafficControlMetrics([event]).populations.local?.metrics["M-01"]).toEqual({ status: "UNAVAILABLE", reason: "No reviewed outcomes" });
    }
  });

  it.each(["2026-09-17T14:30:00.123456+02:30", "2026-09-17t12:00:00z", "1990-12-31T23:59:60Z", "1990-12-31T15:59:60-08:00"])("preserves published date-time spelling %s", (timestamp) => {
    const event = projectTrafficControlTelemetry({ ...source, occurredAt: timestamp }, { ...options, recordedAt: timestamp });
    expect(event.occurredAt).toBe(timestamp);
    expect(event.recordedAt).toBe(timestamp);
    expect(summarizeTrafficControlMetrics([event]).populations.local?.sourceEventCount).toBe(1);
  });

  it("keeps the original valid projected-fact digest and event identity", () => {
    const event = project();
    expect(event.source.sourceSha256).toBe("6afca2cfd973c728bf860325bfd825e0939cc4eac5c31fcbbf93aac49abce93e");
    expect(event.eventId).toBe("b848598630e2ac935743a97d02cf80b223cbe2af06529b7e4e8cc0183e554c9a");
  });
});

describe("Traffic Control telemetry evidence limits", () => {
  const reviewedSource = (sequence: number, correctDisposition: boolean, runId = "run-1") => ({
    sequence, buildId: `build-${runId}`, taskId: null, type: "outcome.reviewed",
    payload: { correctDisposition, invalidEscape: false, outcomeClass: "protective-stop", reviewerAuthority: "REPOSITORY_FIXTURE", reviewedAt: "2026-09-17T12:00:00Z" },
    occurredAt: "2026-09-17T12:00:00Z",
  });
  const projectReview = (sequence: number, correctDisposition: boolean, runId = "run-1") => projectTrafficControlTelemetry(reviewedSource(sequence, correctDisposition, runId), {
    correlation: { ...correlation, runId, buildId: `build-${runId}` }, recordedAt: "2026-09-17T12:00:01Z", environment: "local",
  });

  it("does not claim complete review coverage from a partial two-run lifecycle", () => {
    const lifecycle = (sequence: number, runId: string) => projectTrafficControlTelemetry({
      sequence, buildId: `build-${runId}`, taskId: null, type: "integration.completed", payload: { integrationCommit: "d".repeat(40) }, occurredAt: "2026-09-17T12:00:00Z",
    }, { correlation: { ...correlation, runId, buildId: `build-${runId}` }, recordedAt: "2026-09-17T12:00:01Z", environment: "local" });
    // These events do not establish eligibility, closed-run adjudication or a
    // review window. A partial array cannot supply the missing denominator.
    const summary = summarizeTrafficControlMetrics([lifecycle(1, "run-1"), projectReview(2, true), lifecycle(3, "run-2")]);
    expect(summary.populations.local?.sourceEventCount).toBe(3);
    expect(summary.populations.local?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE", reason: expect.any(String) as unknown });
    expect(summary.populations.local?.metrics["M-01"]).not.toHaveProperty("reviewCoverage", 1);
  });

  it("does not convert a review lacking authority into adjudicated correctness", () => {
    const nativeReview = reviewedSource(1, true);
    const event = projectTrafficControlTelemetry({ ...nativeReview, payload: { correctDisposition: true } }, {
      correlation: { ...correlation, buildId: nativeReview.buildId }, recordedAt: "2026-09-17T12:00:01Z", environment: "local",
    });
    expect(summarizeTrafficControlMetrics([event]).populations.local?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE", reason: expect.any(String) as unknown });
  });

  it("does not infer a review window from an old reviewedAt value", () => {
    const event = projectReview(1, true);
    event.payload.reviewedAt = "2001-01-01T00:00:00Z";
    expect(summarizeTrafficControlMetrics([event]).populations.local?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE", reason: expect.any(String) as unknown });
  });

  it("does not count multiple reviews as multiple eligible closed runs", () => {
    const summary = summarizeTrafficControlMetrics([projectReview(1, true), projectReview(2, false)]);
    expect(summary.populations.local?.sourceEventCount).toBe(2);
    expect(summary.populations.local?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE", reason: expect.any(String) as unknown });
  });

  it("refuses conflicting facts with the same native source identity", () => {
    expect(() => summarizeTrafficControlMetrics([projectReview(1, true), projectReview(1, false)])).toThrow();
  });

  it("refuses a changed payload hidden behind the same event ID", () => {
    const first = projectReview(1, true);
    const changed = { ...first, payload: { ...first.payload, correctDisposition: false } };
    expect(() => summarizeTrafficControlMetrics([first, changed])).toThrow();
  });

  it("refuses nested credential fields before producing product telemetry", () => {
    expect(() => projectTrafficControlTelemetry({ ...source, payload: { ...source.payload, decision: { ...source.payload.decision, signals: { api_key: "SYNTHETIC_ONLY_SENTINEL" } } } }, {
      correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local",
    })).toThrow();
  });

  it.each(["credential", "credentials", "privateKey", "private_key", "private-key"])("refuses the sensitive nested %s field", (field) => {
    expect(() => projectTrafficControlTelemetry({ ...source, payload: { ...source.payload, decision: { ...source.payload.decision, signals: { [field]: "SYNTHETIC_ONLY_SENTINEL" } } } }, {
      correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local",
    })).toThrow();
  });

  it("refuses recognized credentials inside otherwise allowed string fields", () => {
    expect(() => projectTrafficControlTelemetry({ ...source, payload: { ...source.payload, decision: { ...source.payload.decision, signals: { concern: { reason: "password=SYNTHETIC_ONLY_SENTINEL", source: "fixture" } } } } }, {
      correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local",
    })).toThrow();
  });

  it("refuses an unbounded raw log nested in Governor signals", () => {
    expect(() => projectTrafficControlTelemetry({ ...source, payload: { ...source.payload, decision: { ...source.payload.decision, signals: { rawLog: "x".repeat(100_000) } } } }, {
      correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local",
    })).toThrow();
  });

  it("bounds free-text data in an allowed generic payload field", () => {
    expect(() => projectTrafficControlTelemetry({ ...source, type: "integration.blocked", payload: { reason: "x".repeat(100_000) } }, {
      correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local",
    })).toThrow();
  });

  it("preserves benign Governor facts and exact native provenance", () => {
    const signals = { unauthorizedPaths: ["src/example.ts"], failureFingerprint: "d".repeat(64), repeatCount: 3, evidenceDelta: "ZERO", concern: { reason: "A bounded strategy review is required", source: "execution-evidence" } };
    const input = { ...source, payload: { ...source.payload, decision: { ...source.payload.decision, signals } } };
    const before = structuredClone(input);
    const event = projectTrafficControlTelemetry(input, { correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local" });
    expect(event.payload).toEqual({ environment: "local", action: "CONTINUE", ruleId: "entitled-to-continue", authorityEffect: "NONE", requiresApproval: false, signals, observationSha256: "b".repeat(64), recordHash: "a".repeat(64) });
    expect(event.source).toMatchObject({ system: "traffic-control-governor", component: "build-events", sourceRecordId: "build-1:7", sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown });
    expect(event.correlation).toEqual(correlation);
    expect(event.sequence).toBe(7);
    expect(event.proofBoundary).toBe("LOCAL_EXECUTION");
    expect(input).toEqual(before);
  });

  it("counts an exact source replay with a later recordedAt once", () => {
    const first = projectReview(1, true);
    const replay = { ...first, recordedAt: "2026-09-18T12:00:01Z" };
    expect(summarizeTrafficControlMetrics([first, replay]).populations.local?.sourceEventCount).toBe(1);
  });

  it("keeps every proof population separate without claiming reviewed rates", () => {
    const environments = ["synthetic", "local", "ci", "hosted", "production", "reviewed-outcome"] as const;
    const events = environments.map((environment, index) => projectTrafficControlTelemetry({ ...source, sequence: index + 1 }, { correlation, recordedAt: "2026-09-17T12:00:01Z", environment }));
    const summary = summarizeTrafficControlMetrics(events);
    for (const environment of environments) {
      expect(summary.populations[environment]?.sourceEventCount).toBe(1);
      expect(summary.populations[environment]?.metrics["M-01"]).toEqual({ status: "UNAVAILABLE", reason: "No reviewed outcomes" });
    }
  });

  it("refuses cyclic selected data before producing a telemetry event", () => {
    const signals: Record<string, unknown> = {};
    signals.self = signals;
    expect(() => projectTrafficControlTelemetry({ ...source, payload: { ...source.payload, decision: { ...source.payload.decision, signals } } }, { correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local" })).toThrow(TypeError);
  });

  it("refuses excessive selected nesting before hashing a source fact", () => {
    let signals: Record<string, unknown> = { count: 1 };
    for (let index = 0; index < 40; index += 1) signals = { nested: signals };
    expect(() => projectTrafficControlTelemetry({ ...source, payload: { ...source.payload, decision: { ...source.payload.decision, signals } } }, { correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local" })).toThrow(TypeError);
  });
});
