import { describe, expect, it } from "vitest";
import { projectTrafficControlTelemetry, summarizeTrafficControlMetrics } from "../src/telemetry/traffic-control-projection.js";
import type { MetricReviewTarget, TrafficControlMetric, TrafficControlMetricContext, TrafficControlMetricRun, TrafficControlTelemetryEvent } from "../src/telemetry/traffic-control-projection.js";

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
  it("reports every original metric with explicit missing-fact boundaries", () => {
    const event = projectTrafficControlTelemetry(source, { correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local" });
    const metrics = summarizeTrafficControlMetrics([event]).populations.local?.metrics;
    for (let index = 1; index <= 19; index += 1) {
      expect(metrics?.[`M-${String(index).padStart(2, "0")}`]).toMatchObject({ status: "UNAVAILABLE" });
    }
  });
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
    expect(summary.populations.local?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE", reason: "No reviewed outcomes" });
  });
});

describe("Traffic Control impact facts", () => {
  const options = { correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local" as const };

  it("preserves the supplied impact facts instead of discarding catalog-required fields", () => {
    const event = projectTrafficControlTelemetry({
      ...source, type: "impact.assessed",
      payload: { impactedPaths: ["src/app.ts"], activeTaskCollisions: ["TASK-OTHER"], expanded: false },
    }, options);

    expect(event.payload).toEqual({
      environment: "local", impactedPaths: ["src/app.ts"], activeTaskCollisions: ["TASK-OTHER"], expanded: false,
    });
  });

  it("preserves empty impact lists and an explicit false expansion fact", () => {
    const event = projectTrafficControlTelemetry({
      ...source, type: "impact.assessed", payload: { impactedPaths: [], activeTaskCollisions: [], expanded: false },
    }, options);
    expect(event.payload).toEqual({ environment: "local", impactedPaths: [], activeTaskCollisions: [], expanded: false });
  });

  it("preserves literal string facts without introducing a path or task-ID policy", () => {
    const event = projectTrafficControlTelemetry({
      ...source, type: "impact.assessed", payload: { impactedPaths: [""], activeTaskCollisions: [""], expanded: false },
    }, options);
    expect(event.payload).toEqual({ environment: "local", impactedPaths: [""], activeTaskCollisions: [""], expanded: false });
  });

  it("selects only the impact facts without mutating or copying unrelated raw data", () => {
    const input = {
      ...source, type: "impact.assessed",
      payload: { impactedPaths: ["src/app.ts"], activeTaskCollisions: [], expanded: true, reason: "unselected", rawLog: "x".repeat(100_000) },
    };
    const before = structuredClone(input);
    const event = projectTrafficControlTelemetry(input, options);
    expect(event.payload).toEqual({ environment: "local", impactedPaths: ["src/app.ts"], activeTaskCollisions: [], expanded: true });
    expect(input).toEqual(before);
  });

  it("detaches both retained lists from mutable source arrays", () => {
    const impactedPaths = ["src/app.ts"];
    const activeTaskCollisions = ["TASK-OTHER"];
    const event = projectTrafficControlTelemetry({
      ...source, type: "impact.assessed", payload: { impactedPaths, activeTaskCollisions, expanded: false },
    }, options);
    impactedPaths.push("src/later.ts");
    activeTaskCollisions.push("TASK-LATER");
    expect(event.payload).toEqual({ environment: "local", impactedPaths: ["src/app.ts"], activeTaskCollisions: ["TASK-OTHER"], expanded: false });
  });

  it.each(["impactedPaths", "activeTaskCollisions"])("ignores caller-owned every when validating %s elements", (field) => {
    const invalid = [1];
    Object.defineProperty(invalid, "every", { value: () => true });
    const payload = { impactedPaths: [], activeTaskCollisions: [], expanded: false, [field]: invalid };
    expect(() => projectTrafficControlTelemetry({ ...source, type: "impact.assessed", payload }, options)).toThrow(TypeError);
  });

  it("reads indexed facts instead of a caller-owned custom iterator", () => {
    const impactedPaths = ["src/app.ts"];
    Object.defineProperty(impactedPaths, Symbol.iterator, { value: function* () { yield 1; } });
    const event = projectTrafficControlTelemetry({
      ...source, type: "impact.assessed", payload: { impactedPaths, activeTaskCollisions: [], expanded: false },
    }, options);
    expect(event.payload.impactedPaths).toEqual(["src/app.ts"]);
  });

  it("preserves the array byte budget when a custom iterator hides actual entries", () => {
    const impactedPaths = Array<string>(32 * 1024 + 1).fill("src/app.ts");
    Object.defineProperty(impactedPaths, Symbol.iterator, { value: () => [][Symbol.iterator]() });
    expect(() => projectTrafficControlTelemetry({
      ...source, type: "impact.assessed", payload: { impactedPaths, activeTaskCollisions: [], expanded: false },
    }, options)).toThrow(/bounded size/u);
  });

  it.each([
    ["impactedPaths", { activeTaskCollisions: [], expanded: false }],
    ["activeTaskCollisions", { impactedPaths: [], expanded: false }],
    ["expanded", { impactedPaths: [], activeTaskCollisions: [] }],
  ])("refuses an impact event missing %s instead of supplying a default", (_field, payload) => {
    expect(() => projectTrafficControlTelemetry({ ...source, type: "impact.assessed", payload }, options)).toThrow(TypeError);
  });

  const malformedFacts: Array<[string, string, unknown]> = [
    ["null impacted paths", "impactedPaths", null],
    ["null collisions", "activeTaskCollisions", null],
    ["null expansion", "expanded", null],
    ["object instead of paths", "impactedPaths", {}],
    ["string instead of collisions", "activeTaskCollisions", "TASK-OTHER"],
    ["string instead of expansion", "expanded", "false"],
    ["non-string path", "impactedPaths", ["src/app.ts", 1]],
    ["non-string collision", "activeTaskCollisions", ["TASK-OTHER", {}]],
    ["sparse paths", "impactedPaths", Array<string>(1)],
  ];
  it.each(malformedFacts)("refuses %s before publishing an impact fact", (_label, field, value) => {
    const payload = { impactedPaths: [], activeTaskCollisions: [], expanded: false, [field]: value };
    expect(() => projectTrafficControlTelemetry({ ...source, type: "impact.assessed", payload }, options)).toThrow(TypeError);
  });

  it("applies the existing size bound to selected impact facts", () => {
    expect(() => projectTrafficControlTelemetry({
      ...source, type: "impact.assessed", payload: { impactedPaths: ["x".repeat(100_000)], activeTaskCollisions: [], expanded: false },
    }, options)).toThrow(/bounded size/u);
  });

  it("applies the existing recognized-credential guard to selected impact facts", () => {
    expect(() => projectTrafficControlTelemetry({
      ...source, type: "impact.assessed", payload: { impactedPaths: [], activeTaskCollisions: ["password=SYNTHETIC_ONLY_SENTINEL"], expanded: false },
    }, options)).toThrow(/recognized credentials/u);
  });

  it.each([
    { impactedPaths: ["src/other.ts"], activeTaskCollisions: ["TASK-OTHER"], expanded: false },
    { impactedPaths: ["src/app.ts"], activeTaskCollisions: ["TASK-DIFFERENT"], expanded: false },
    { impactedPaths: ["src/app.ts"], activeTaskCollisions: ["TASK-OTHER"], expanded: true },
  ])("binds a change in each supplied impact fact to its source digest and event identity", (payload) => {
    const first = projectTrafficControlTelemetry({
      ...source, type: "impact.assessed", payload: { impactedPaths: ["src/app.ts"], activeTaskCollisions: ["TASK-OTHER"], expanded: false },
    }, options);
    const changed = projectTrafficControlTelemetry({ ...source, type: "impact.assessed", payload }, options);
    expect(changed.source.sourceSha256).not.toBe(first.source.sourceSha256);
    expect(changed.eventId).not.toBe(first.eventId);
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
      expect(summarizeTrafficControlMetrics([event]).populations.local?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE", reason: "No reviewed outcomes" });
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
      expect(summary.populations[environment]?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE", reason: "No reviewed outcomes" });
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

// These are arithmetic/source-fidelity witnesses over controlled synthetic
// native-adapter projections. They do not represent actual reviewer authority,
// a live pilot, provider execution, deployment, or accepted product outcomes.

type SyntheticRun = {
  fact: TrafficControlMetricRun;
  add: (type: string, payload: Record<string, unknown>, at?: number) => TrafficControlTelemetryEvent;
  close: (action?: string, at?: number) => TrafficControlTelemetryEvent;
  review: (target: TrafficControlTelemetryEvent, kind: MetricReviewTarget["kind"], payload?: Record<string, unknown>, protection?: TrafficControlTelemetryEvent, at?: number) => TrafficControlTelemetryEvent;
};
const syntheticDigest = (index: number) => index.toString(16).padStart(64, "0");
const syntheticCommit = "e".repeat(40);
const syntheticEpoch = Date.parse("2026-09-17T10:00:00Z");
const syntheticTime = (seconds: number) => new Date(syntheticEpoch + seconds * 1000).toISOString();
const metricIds = Array.from({ length: 19 }, (_, index) => `M-${String(index + 1).padStart(2, "0")}`);

function requireSyntheticValue<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`Synthetic fixture is missing ${label}`);
  return value;
}

function syntheticMetricFixture() {
  const events: TrafficControlTelemetryEvent[] = [];
  let identity = 100;
  const sourceRef = () => ({ sourceRecordId: `synthetic-native-record-${identity}`, sourceSha256: syntheticDigest(identity++) });
  const context: TrafficControlMetricContext = {
    source: sourceRef(), environment: "synthetic", cohortId: "synthetic-closed-cohort",
    window: { start: "2026-09-17T00:00:00Z", end: "2026-09-18T00:00:00Z" },
    asOf: "2026-09-28T00:00:00Z", reviewWindowMs: 7 * 24 * 60 * 60 * 1000,
    maxClockSkewMs: 1000,
    coverage: { lifecycle: true, reviews: true, replay: true, overrides: true, submissions: true },
    runs: [], replayComparisons: [], overrides: [], verifySource: () => false,
  };
  const addRun = (name: string, verificationResult = "PASSED"): SyntheticRun => {
    let sequence = 0;
    const runCorrelation = { repositoryId: "synthetic-repository", runId: `synthetic-run-${name}`, buildId: `synthetic-build-${name}`, handoffId: `synthetic-handoff-${name}`, contractSha256: syntheticDigest(identity++), policyVersion: "governor.v1" };
    const add = (type: string, payload: Record<string, unknown>, at?: number) => {
      sequence += 1;
      const seconds = at ?? sequence;
      const taskId = ["attempt.started", "files.changed", "validation.completed"].includes(type) ? "SYNTHETIC-TASK" : null;
      const event = projectTrafficControlTelemetry({ sequence, buildId: runCorrelation.buildId, taskId, type, payload, occurredAt: syntheticTime(seconds) }, {
        correlation: runCorrelation, recordedAt: syntheticTime(Math.max(seconds, 0) + 1), environment: "synthetic",
      });
      events.push(event);
      return event;
    };
    const verification = add("contract.verification_completed", { result: verificationResult, violationCode: verificationResult === "PASSED" ? null : "SCHEMA_INVALID", baseCommit: syntheticCommit, authoritySourceDigests: { "governance/authority.md": syntheticDigest(90) } }, -1);
    add("execution.started", { maxAttempts: 20, planId: `synthetic-plan-${name}`, runtimeVersion: "synthetic-runtime-1" }, 0);
    const fact: TrafficControlMetricRun = {
      source: sourceRef(), correlation: runCorrelation, verificationEventId: verification.eventId,
      submittedEligibleHandoff: verificationResult === "PASSED", manualTranslation: false,
      requiredLifecycleEvents: ["contract.verification_completed", "execution.started", "intervention.completed"], requiredEvidenceIds: [],
      tasks: [{ taskId: "SYNTHETIC-TASK", ownershipRoots: ["src"] }], issuedReceipts: [], reviews: [], decisionTriggers: [], structuralClosures: [],
    };
    context.runs.push(fact);
    const close = (action = "PAUSE_FOR_REVIEW", at?: number) => {
      const event = add("intervention.completed", { action, status: "APPLIED", triggerRecordHash: syntheticDigest(1), latencyMs: 50 }, at);
      fact.closedEventId = event.eventId;
      return event;
    };
    const review = (target: TrafficControlTelemetryEvent, kind: MetricReviewTarget["kind"], payload: Record<string, unknown> = {}, protection?: TrafficControlTelemetryEvent, at?: number) => {
      const seconds = at ?? Math.max(sequence + 1, (Date.parse(target.occurredAt) - syntheticEpoch) / 1000 + 1);
      const event = add("outcome.reviewed", { correctDisposition: true, invalidEscape: false, outcomeClass: "synthetic-protective-disposition", reviewerAuthority: "SYNTHETIC_REPOSITORY_FIXTURE", reviewedAt: syntheticTime(seconds), ...payload }, seconds);
      fact.reviews.push({ reviewEventId: event.eventId, targetEventId: target.eventId, kind, ...(protection === undefined ? {} : { protectionEventId: protection.eventId }) });
      return event;
    };
    return { fact, add, close, review };
  };
  const seal = (refusedEventIds: string[] = []) => {
    const { verifySource, ...scope } = context;
    void verifySource;
    const expectedScope = JSON.stringify(structuredClone(scope));
    const known = {
      cohort: new Set([expectedScope]),
      run: new Set(context.runs.map((fact) => JSON.stringify(structuredClone(fact)))),
      event: new Set(events.filter((event) => !refusedEventIds.includes(event.eventId)).map((event) => JSON.stringify(structuredClone(event)))),
      replay: new Set(context.replayComparisons.map((fact) => JSON.stringify(structuredClone(fact)))),
      override: new Set(context.overrides.map((fact) => JSON.stringify(structuredClone(fact)))),
    };
    context.verifySource = (fact) => JSON.stringify(fact.scope) === expectedScope && known[fact.kind].has(JSON.stringify(fact.value));
    return context;
  };
  const metrics = () => requireSyntheticValue(summarizeTrafficControlMetrics(events, context).populations.synthetic, "the synthetic population").metrics;
  const decision = (run: SyntheticRun, signals: Record<string, unknown> = {}, at?: number, action = "PAUSE_FOR_REVIEW", ruleId = "synthetic-rule") => run.add("governor.decision", {
    recordHash: syntheticDigest(identity++), observationHash: syntheticDigest(identity++),
    decision: { action, ruleId, authorityEffect: "NONE", requiresApproval: false, signals },
  }, at);
  const receipt = (run: SyntheticRun, result = "PASSED") => {
    const receiptSha256 = syntheticDigest(identity++);
    const audit = run.add("receipt.audit_completed", { result, receiptSha256, violationCodes: result === "PASSED" ? [] : ["SYNTHETIC_AUDIT_FAILURE"] });
    run.fact.issuedReceipts.push({ receiptSha256, auditEventId: audit.eventId });
    return audit;
  };
  const integrate = (run: SyntheticRun, at?: number) => {
    const event = run.add("integration.completed", { integrationCommit: syntheticCommit, taskIntegrationCommits: { "SYNTHETIC-TASK": syntheticCommit } }, at);
    run.fact.closedEventId = event.eventId;
    run.fact.requiredLifecycleEvents = ["contract.verification_completed", "execution.started", "integration.completed"];
    return event;
  };
  return { events, context, addRun, seal, metrics, sourceRef, decision, receipt, integrate };
}

function expectSyntheticRate(metric: TrafficControlMetric | undefined, numerator: number, denominator: number) {
  expect(metric).toMatchObject({ status: "AVAILABLE", numerator, denominator, value: numerator / denominator, environment: "synthetic", window: { start: "2026-09-17T00:00:00Z", end: "2026-09-18T00:00:00Z" }, proofBoundary: "ADAPTER_VERIFIED_SOURCE_CALCULATION" });
  expect(metric).toHaveProperty("reviewCoverage");
  expect(metric).toHaveProperty("proofLimits");
}

describe("Traffic Control original metric arithmetic over synthetic verified source maps", () => {
  it("M-01 uses reviewed eligible closed runs and exposes unreviewed coverage", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 4; index += 1) {
      const run = fixture.addRun(`resolution-${index}`); const terminal = run.close();
      if (index < 2) run.review(terminal, "run", { correctDisposition: index === 0 });
    }
    fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-01"], 1, 2);
    expect(fixture.metrics()["M-01"]?.reviewCoverage).toEqual({ reviewed: 2, closed: 4, value: 0.5 });
  });

  it("M-02 counts exact audited invalid integration escapes once", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 3; index += 1) {
      const run = fixture.addRun(`escape-${index}`); const integration = fixture.integrate(run); fixture.receipt(run);
      run.review(integration, "run", { invalidEscape: index === 0, correctDisposition: index !== 0 });
    }
    fixture.seal();
    const repeated = requireSyntheticValue(summarizeTrafficControlMetrics([...fixture.events, ...fixture.events], fixture.context).populations.synthetic, "the deduplicated synthetic population").metrics;
    expectSyntheticRate(repeated["M-02"], 1, 3);
  });

  it("M-03 compares all four actual decision fields and excludes analysis from live metrics", () => {
    const fixture = syntheticMetricFixture();
    const run = fixture.addRun("replays");
    for (let index = 0; index < 3; index += 1) {
      const original = fixture.decision(run, { repeatCount: index + 1 });
      const replay: TrafficControlTelemetryEvent = {
        ...structuredClone(original), eventId: `synthetic-replayed-decision-${index}`, sequence: 1,
        source: { ...original.source, sourceRecordId: `synthetic-analysis-source-${index}`, sourceSha256: syntheticDigest(200 + index) },
        correlation: { ...original.correlation, analysisRunId: `synthetic-analysis-${index}` },
        payload: { ...original.payload, signals: index === 2 ? { repeatCount: 99 } : original.payload.signals },
      };
      fixture.events.push(replay);
      fixture.context.replayComparisons.push({ source: fixture.sourceRef(), originalEventId: original.eventId, replayedEventId: replay.eventId });
    }
    run.close(); fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-03"], 2, 3);
    const population = requireSyntheticValue(summarizeTrafficControlMetrics(fixture.events, fixture.context).populations.synthetic, "the replay synthetic population");
    expect(population.analysisEventCount).toBe(3);
    expect(population.liveEventCount).toBe(fixture.events.length - 3);
  });

  it("M-04 requires actual containment before mutation, not only a pause decision", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 2; index += 1) {
      const run = fixture.addRun(`drift-${index}`); const drift = fixture.decision(run, { violationCode: "AUTHORITY_SOURCE_DRIFT" }, undefined, "PAUSE_FOR_REVIEW", "authority-drift");
      if (index === 1) run.add("files.changed", { taskId: "SYNTHETIC-TASK", paths: ["src/app.ts"], commit: syntheticCommit });
      const protection = run.add("intervention.completed", { action: "PAUSE_FOR_REVIEW", status: "APPLIED", triggerRecordHash: drift.payload.recordHash, latencyMs: 50 });
      run.fact.closedEventId = protection.eventId;
    }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-04"], 1, 2);
  });

  it("M-05 uses native ownership findings and pre-integration containment", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 2; index += 1) {
      const run = fixture.addRun(`ownership-${index}`);
      const changed = run.add("files.changed", { taskId: "SYNTHETIC-TASK", paths: ["outside.ts"], commit: syntheticCommit });
      run.fact.ownershipAssessments = [{ source: fixture.sourceRef(), filesChangedEventId: changed.eventId, evaluation: {
        passed: false, ownedRoots: ["src"], forbiddenRoots: [],
        changedFiles: [{ path: "outside.ts", changeType: "modified", previousPath: null, withinOwnership: false }],
        violations: [{ path: "outside.ts", changePath: "outside.ts", previousPath: null, reason: "outside_ownership" }],
      } }];
      const ownershipDecision = fixture.decision(run, { unauthorizedPaths: ["outside.ts"] }, undefined, "BLOCK_INTEGRATION", "unauthorized-changed-path");
      run.fact.decisionTriggers = [{ decisionEventId: ownershipDecision.eventId, triggerEventId: changed.eventId }];
      if (index === 1) fixture.integrate(run);
      const protection = run.add("intervention.completed", { action: "BLOCK_INTEGRATION", status: "APPLIED", triggerRecordHash: ownershipDecision.payload.recordHash, latencyMs: 50 });
      if (index === 1) run.fact.closedEventId = requireSyntheticValue(fixture.events.find((event) => event.correlation.runId === run.fact.correlation.runId && event.eventType === "integration.completed"), "the escaped integration event").eventId;
      else run.fact.closedEventId = protection.eventId;
    }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-05"], 1, 2);
  });

  it("M-06 counts both missing and contradicted contract-required proof", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 3; index += 1) {
      const run = fixture.addRun(`proof-${index}`); run.fact.requiredEvidenceIds = ["required-proof"];
      run.add("evidence.recorded", { items: ["fact-1"], satisfied: index === 1 ? [] : ["required-proof"], contradicted: index === 2 ? ["required-proof"] : [], artifactDigests: { "required-proof": syntheticDigest(20) } });
      fixture.integrate(run); fixture.receipt(run, index === 0 ? "PASSED" : "FAILED");
    }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-06"], 2, 3);
  });

  it("M-07 uses every issued receipt and refuses a missing audit", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 4; index += 1) { const run = fixture.addRun(`receipt-${index}`); fixture.integrate(run); fixture.receipt(run, index < 3 ? "PASSED" : "FAILED"); }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-07"], 3, 4);
    const fourthRun = requireSyntheticValue(fixture.context.runs[3], "the fourth issued-receipt run");
    delete requireSyntheticValue(fourthRun.issuedReceipts[0], "the fourth issued receipt").auditEventId;
    fixture.seal();
    expect(fixture.metrics()["M-07"]).toMatchObject({ status: "UNAVAILABLE", denominator: 4 });
    expect(fixture.metrics()["M-07"]).not.toHaveProperty("value");
  });

  it("M-08 counts distinct reviewed interventions rather than reviewed runs", () => {
    const fixture = syntheticMetricFixture();
    for (let runIndex = 0; runIndex < 2; runIndex += 1) {
      const run = fixture.addRun(`precision-${runIndex}`);
      for (let interventionIndex = 0; interventionIndex < 2; interventionIndex += 1) {
        const intervention = run.close(); run.review(intervention, "intervention", { correctDisposition: runIndex + interventionIndex < 2 });
      }
    }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-08"], 3, 4);
  });

  it("M-09 uses reviewed protection-required cases and rejects protection after integration", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 3; index += 1) {
      const run = fixture.addRun(`recall-${index}`); const caseEvent = fixture.decision(run, { unauthorizedPaths: ["outside.ts"] });
      let integration: TrafficControlTelemetryEvent | undefined;
      if (index === 2) integration = fixture.integrate(run);
      const protection = run.close("BLOCK_INTEGRATION");
      if (integration !== undefined) run.fact.closedEventId = integration.eventId;
      run.review(caseEvent, "protection-case", { protectionRequired: true }, protection);
    }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-09"], 2, 3);
  });

  it("M-10 counts protection at the threshold even though acknowledgement follows the decision", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 4; index += 1) {
      const run = fixture.addRun(`no-progress-${index}`); const crossing = fixture.decision(run, { repeatCount: 3, evidenceDelta: "ZERO", failureFingerprint: syntheticDigest(50) }, undefined, "PROPOSE_REPLAN", "repeated-no-progress-failure");
      run.fact.thresholdCrossingEventId = crossing.eventId;
      if (index === 3) run.add("attempt.started", { taskId: "SYNTHETIC-TASK", attempt: 4, maxAttempts: 20 });
      const protection = run.close("PROPOSE_REPLAN");
      run.review(crossing, "no-progress", { repeatedNoProgress: true }, protection);
    }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-10"], 3, 4);
  });

  it("M-11 divides summed actual excess attempts by threshold-crossing runs, not a median", () => {
    const fixture = syntheticMetricFixture();
    for (const [index, excess] of [0, 1, 5].entries()) {
      const run = fixture.addRun(`excess-${index}`); const crossing = fixture.decision(run, { repeatCount: 3, evidenceDelta: "ZERO", failureFingerprint: syntheticDigest(50) }, undefined, "PROPOSE_REPLAN", "repeated-no-progress-failure");
      run.fact.thresholdCrossingEventId = crossing.eventId;
      for (let attempt = 0; attempt < excess; attempt += 1) run.add("attempt.started", { taskId: "SYNTHETIC-TASK", attempt: 4 + attempt, maxAttempts: 20 });
      run.close("PROPOSE_REPLAN");
    }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-11"], 6, 3);
    expect(fixture.metrics()["M-11"]?.value).not.toBe(1);
  });

  it("M-12 distinguishes positive native evidence deltas from unchanged or contradicted failures", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 4; index += 1) {
      const run = fixture.addRun(`learning-${index}`);
      run.add("evidence.recorded", { items: [], satisfied: [], contradicted: [], artifactDigests: {} });
      const attempt = run.add("attempt.started", { taskId: "SYNTHETIC-TASK", attempt: 1, maxAttempts: 20 });
      run.fact.attemptOutcomes = [{ source: fixture.sourceRef(), attemptEventId: attempt.eventId, status: "failed", evidenceDelta: { newItems: index === 0 ? ["new-finding"] : [], newlySatisfied: index === 1 ? ["required-proof"] : [], newContradictions: index === 3 ? ["required-proof"] : [], score: index === 0 ? 1 : index === 1 ? 2 : index === 3 ? -2 : 0, direction: index < 2 ? "POSITIVE" : index === 3 ? "NEGATIVE" : "ZERO" } }];
      run.add("validation.completed", { taskId: "SYNTHETIC-TASK", command: "npm test", status: "FAILED", evidenceId: "validation-1", artifactSha256: syntheticDigest(71) });
      run.add("evidence.recorded", { items: index === 0 ? ["new-finding"] : [], satisfied: index === 1 ? ["required-proof"] : [], contradicted: index === 3 ? ["required-proof"] : [], artifactDigests: {} });
      run.close("REQUEST_REPAIR");
    }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-12"], 2, 4);
  });

  it("M-13 measures trigger-to-decision time independently of intervention latency", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("latency");
    const trigger = run.add("evidence.recorded", { items: [], satisfied: [], contradicted: [], artifactDigests: {} }, 0);
    const decision = fixture.decision(run, {}, 2); run.fact.decisionTriggers = [{ decisionEventId: decision.eventId, triggerEventId: trigger.eventId }];
    run.close("PAUSE_FOR_REVIEW", 3); fixture.seal();
    expect(fixture.metrics()["M-13"]).toMatchObject({ status: "AVAILABLE", denominator: 1, value: 2000, samples: [2000], unit: "milliseconds per decision" });
    expect(fixture.metrics()["M-13"]?.value).not.toBe(50);
  });

  it("M-14 measures the exact terminal disposition and preserves its class", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("disposition-time");
    fixture.decision(run, {}, 2); run.close("PAUSE_FOR_REVIEW", 8); fixture.seal();
    expect(fixture.metrics()["M-14"]).toMatchObject({ status: "AVAILABLE", denominator: 1, value: 8000, samples: [8000], segments: { PAUSE_FOR_REVIEW: [8000] } });
  });

  it("M-15 measures approved supersession and keeps open structural concerns unavailable", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("structural-time");
    const concern = run.add("structural.concern_recorded", { reason: "synthetic structural finding", sourceEvidenceIds: ["evidence-1"] }, 0);
    const supersession = run.add("contract.superseded", { priorHandoffId: run.fact.correlation.handoffId, newHandoffId: "synthetic-approved-replacement", approvalId: "synthetic-existing-authority-record" }, 120);
    run.fact.structuralClosures = [{ concernEventId: concern.eventId, supersessionEventId: supersession.eventId }]; run.close("REQUEST_RECONSIDER", 121); fixture.seal();
    expect(fixture.metrics()["M-15"]).toMatchObject({ status: "AVAILABLE", denominator: 1, value: 120000, samples: [120000] });
    const open = run.add("structural.concern_recorded", { reason: "synthetic unresolved finding", sourceEvidenceIds: ["evidence-2"] }, 122);
    run.fact.structuralClosures.push({ concernEventId: open.eventId }); fixture.seal();
    expect(fixture.metrics()["M-15"]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()["M-15"]).not.toHaveProperty("value", 0);
  });

  it("M-16 distinguishes native ingestion from manual translation and rejected contracts", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 4; index += 1) { const run = fixture.addRun(`ingestion-${index}`); run.fact.manualTranslation = index === 3; run.close(); }
    fixture.addRun("rejection-1", "FAILED"); fixture.addRun("rejection-2", "REJECTED"); fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-16"], 3, 4);
    expect(summarizeTrafficControlMetrics(fixture.events, fixture.context).populations.synthetic?.rejectedContractCount).toBe(2);
  });

  it("M-17 evaluates each run's applicable contract requirements rather than all catalog events", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 3; index += 1) { const run = fixture.addRun(`completeness-${index}`); run.close(); if (index === 2) run.fact.requiredLifecycleEvents.push("evidence.recorded"); }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-17"], 2, 3);
  });

  it("M-18 uses all mature closed runs and a separate seven-day review horizon", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 4; index += 1) {
      const run = fixture.addRun(`review-coverage-${index}`); const closed = run.close();
      if (index < 3) run.review(closed, "run", {}, undefined, index === 2 ? 8 * 24 * 60 * 60 : 1 * 24 * 60 * 60);
    }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-18"], 2, 4);
    const immature = syntheticMetricFixture();
    for (let index = 0; index < 4; index += 1) immature.addRun(`immature-review-${index}`).close();
    immature.context.asOf = "2026-09-19T00:00:00Z"; immature.seal();
    expect(immature.metrics()["M-18"]).toMatchObject({ status: "UNAVAILABLE", denominator: 4 });
  });

  it("M-19 requires actual source-bound override evidence and retains rule/direction", () => {
    const fixture = syntheticMetricFixture();
    for (let index = 0; index < 5; index += 1) {
      const run = fixture.addRun(`overrides-${index}`); const decision = fixture.decision(run); run.close(); run.review(decision, "disposition");
      if (index === 0) fixture.context.overrides.push({ source: fixture.sourceRef(), dispositionEventId: decision.eventId, occurredAt: syntheticTime(100), direction: "PAUSE_TO_CONTINUE" });
    }
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-19"], 1, 5);
    expect(fixture.metrics()["M-19"]?.segments).toEqual({ "synthetic-rule:PAUSE_TO_CONTINUE": 1 });
    fixture.context.coverage.overrides = false; fixture.seal();
    expect(fixture.metrics()["M-19"]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()["M-19"]).not.toHaveProperty("value", 0);
  });

  it.each(metricIds)("%s refuses an absent or refused full source-verification seam", (id) => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun(`refusal-${id}`); const closed = run.close(); run.review(closed, "run");
    fixture.seal(); fixture.context.verifySource = () => false;
    expect(fixture.metrics()[id]).toMatchObject({ status: "UNAVAILABLE", proofBoundary: "UNVERIFIED_SOURCE" });
    expect(fixture.metrics()[id]).not.toHaveProperty("value");
  });

  it.each(metricIds)("%s reports a qualified zero denominator as unavailable", (id) => {
    const fixture = syntheticMetricFixture(); fixture.seal();
    expect(fixture.metrics()[id]).toMatchObject({ status: "UNAVAILABLE", denominator: 0 });
    expect(fixture.metrics()[id]).not.toHaveProperty("value");
  });

  it("does not accept a modified review merely because its ID and digest are unchanged", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("changed-source-review"); const closed = run.close(); const review = run.review(closed, "run", { correctDisposition: false });
    fixture.seal(); review.payload.correctDisposition = true;
    expect(fixture.metrics()["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()["M-01"]).not.toHaveProperty("value", 1);
  });

  it("does not count transport acknowledgement alone as an applied protective effect", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("ack-only"); const drift = fixture.decision(run, { violationCode: "AUTHORITY_SOURCE_DRIFT" }, undefined, "PAUSE_FOR_REVIEW", "authority-drift");
    const ack = run.add("intervention.completed", { action: "PAUSE_FOR_REVIEW", status: "ACKNOWLEDGED", triggerRecordHash: drift.payload.recordHash, latencyMs: 50 });
    run.fact.closedEventId = ack.eventId; fixture.seal();
    expect(fixture.metrics()["M-04"]).not.toMatchObject({ status: "AVAILABLE", numerator: 1, value: 1 });
  });

  it("does not pool a context's synthetic cohort into hosted metrics", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("environment-separation"); const closed = run.close(); run.review(closed, "run");
    const hosted = { ...structuredClone(closed), eventId: "hosted-foreign-event", sequence: 1, source: { ...closed.source, sourceRecordId: "hosted-foreign-source" }, correlation: { ...closed.correlation, runId: "hosted-foreign-run" }, payload: { ...closed.payload, environment: "hosted" } };
    fixture.events.push(hosted); fixture.seal();
    const populations = summarizeTrafficControlMetrics(fixture.events, fixture.context).populations;
    expectSyntheticRate(populations.synthetic?.metrics["M-01"], 1, 1);
    expect(populations.hosted?.metrics["M-01"]).toMatchObject({ status: "UNAVAILABLE", environment: "hosted", proofBoundary: "UNVERIFIED_SOURCE" });
  });

  it("recomputes a late source-bound review without mutating previous history", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("late-review"); const closed = run.close(); fixture.seal();
    const originalHistory = structuredClone(fixture.events); const before = fixture.metrics()["M-01"];
    run.review(closed, "run", { correctDisposition: true }, undefined, 2 * 24 * 60 * 60); fixture.seal();
    expect(before).toMatchObject({ status: "UNAVAILABLE", denominator: 0 });
    expectSyntheticRate(fixture.metrics()["M-01"], 1, 1);
    expect(fixture.events.slice(0, originalHistory.length)).toEqual(originalHistory);
  });
});

describe("Traffic Control source fidelity and incomplete cohort boundaries", () => {
  it.each(metricIds)("%s remains unavailable when lifecycle coverage is explicitly incomplete", (id) => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun(`coverage-${id}`); run.close();
    fixture.context.coverage.lifecycle = false; fixture.seal();
    expect(fixture.metrics()[id]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()[id]).not.toHaveProperty("value");
  });

  it.each(["throws", "promise", "string"])("refuses a verifier that %s rather than verifying the complete fact synchronously", (mode) => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun(`verifier-${mode}`); const closed = run.close(); run.review(closed, "run"); fixture.seal();
    fixture.context.verifySource = () => {
      if (mode === "throws") throw new Error("Synthetic native source is unavailable");
      return mode === "promise" ? Promise.resolve(true) : "true";
    };
    for (const id of metricIds) expect(fixture.metrics()[id]).toMatchObject({ status: "UNAVAILABLE", proofBoundary: "UNVERIFIED_SOURCE" });
  });

  it("does not turn a run-level review into per-intervention precision", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("no-review-expansion");
    run.close(); const closed = run.close(); run.review(closed, "run", { correctDisposition: true }); fixture.seal();
    expect(fixture.metrics()["M-08"]).toMatchObject({ status: "UNAVAILABLE", denominator: 0 });
  });

  it("does not infer ownership violations from changed paths without native ownership evidence", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("missing-ownership-finding");
    run.add("files.changed", { taskId: "SYNTHETIC-TASK", paths: ["outside.ts"], commit: syntheticCommit }); run.close("BLOCK_INTEGRATION"); fixture.seal();
    expect(fixture.metrics()["M-05"]).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("does not compare replays made under a different historical policy", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("historical-policy"); const original = fixture.decision(run);
    const replay: TrafficControlTelemetryEvent = { ...structuredClone(original), eventId: "synthetic-foreign-policy-replay", source: { ...original.source, sourceRecordId: "synthetic-foreign-policy-source" }, correlation: { ...original.correlation, analysisRunId: "synthetic-analysis", policyVersion: "governor.other" } };
    fixture.events.push(replay); fixture.context.replayComparisons.push({ source: fixture.sourceRef(), originalEventId: original.eventId, replayedEventId: replay.eventId }); run.close(); fixture.seal();
    expect(fixture.metrics()["M-03"]).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("does not adjudicate a review target from a different governed run", () => {
    const fixture = syntheticMetricFixture(); const first = fixture.addRun("target-first"); const firstClosed = first.close();
    const other = fixture.addRun("target-other"); other.close(); other.review(firstClosed, "run"); fixture.seal();
    expect(fixture.metrics()["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("does not drop an open threshold-crossing run from excess-attempt coverage", () => {
    const fixture = syntheticMetricFixture();
    const closed = fixture.addRun("closed-threshold"); const closedCrossing = fixture.decision(closed, { repeatCount: 3, evidenceDelta: "ZERO", failureFingerprint: syntheticDigest(50) }, undefined, "PROPOSE_REPLAN", "repeated-no-progress-failure");
    closed.fact.thresholdCrossingEventId = closedCrossing.eventId; closed.close("PROPOSE_REPLAN");
    const open = fixture.addRun("open-threshold"); const openCrossing = fixture.decision(open, { repeatCount: 3, evidenceDelta: "ZERO", failureFingerprint: syntheticDigest(51) }, undefined, "PROPOSE_REPLAN", "repeated-no-progress-failure");
    open.fact.thresholdCrossingEventId = openCrossing.eventId;
    open.add("attempt.started", { taskId: "SYNTHETIC-TASK", attempt: 4, maxAttempts: 20 }); fixture.seal();
    expect(fixture.metrics()["M-11"]).toMatchObject({ status: "UNAVAILABLE", denominator: 2 });
    expect(fixture.metrics()["M-11"]).not.toHaveProperty("value", 0);
  });

  it("includes an issued receipt on an eligible open run in the receipt denominator", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("open-receipt"); fixture.receipt(run); fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-07"], 1, 1);
  });

  it("includes a reviewed applied intervention on an eligible open run", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("open-reviewed-intervention");
    const intervention = run.add("intervention.completed", { action: "REQUEST_REPAIR", status: "APPLIED", triggerRecordHash: syntheticDigest(1), latencyMs: 50 });
    run.review(intervention, "intervention"); fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-08"], 1, 1);
  });

  it("includes failed attempts on an eligible open run even before validation starts", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("open-failed-attempt");
    const attempt = run.add("attempt.started", { taskId: "SYNTHETIC-TASK", attempt: 1, maxAttempts: 20 });
    run.fact.attemptOutcomes = [{ source: fixture.sourceRef(), attemptEventId: attempt.eventId, status: "failed", evidenceDelta: { newItems: ["new-runtime-finding"], newlySatisfied: [], newContradictions: [], score: 1, direction: "POSITIVE" } }];
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-12"], 1, 1);
  });

  it("uses the existing native contradiction weight when calculating failure evidence delta", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("offsetting-failure-evidence");
    const attempt = run.add("attempt.started", { taskId: "SYNTHETIC-TASK", attempt: 1, maxAttempts: 20 });
    run.fact.attemptOutcomes = [{ source: fixture.sourceRef(), attemptEventId: attempt.eventId, status: "failed", evidenceDelta: { newItems: ["finding-1", "finding-2"], newlySatisfied: [], newContradictions: ["contradicted-required-proof"], score: 0, direction: "ZERO" } }];
    run.close("REQUEST_REPAIR"); fixture.seal(); expectSyntheticRate(fixture.metrics()["M-12"], 0, 1);
  });

  it("includes trigger-bound decisions on eligible open runs in decision-latency samples", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("open-decision-latency");
    const trigger = run.add("evidence.recorded", { items: [], satisfied: [], contradicted: [], artifactDigests: {} }, 0); const decision = fixture.decision(run, {}, 2);
    run.fact.decisionTriggers = [{ decisionEventId: decision.eventId, triggerEventId: trigger.eventId }]; fixture.seal();
    expect(fixture.metrics()["M-13"]).toMatchObject({ status: "AVAILABLE", denominator: 1, value: 2000, samples: [2000] });
  });

  it("includes reviewed dispositions and actual overrides on eligible open runs", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("open-overridden-disposition"); const decision = fixture.decision(run);
    run.review(decision, "disposition"); fixture.context.overrides.push({ source: fixture.sourceRef(), dispositionEventId: decision.eventId, occurredAt: syntheticTime(100), direction: "REPAIR_TO_PAUSE" }); fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-19"], 1, 1);
  });
});

describe("Traffic Control contradictory resolution evidence", () => {
  it.each(["invalid escape", "failed audit", "required proof escape"])("does not count a favorable review contradicted by %s", (contradiction) => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun(`contradictory-${contradiction}`);
    if (contradiction === "required proof escape") {
      run.fact.requiredEvidenceIds = ["required-proof"];
      run.add("evidence.recorded", { items: [], satisfied: [], contradicted: [], artifactDigests: {} });
    }
    const integration = fixture.integrate(run); fixture.receipt(run, contradiction === "failed audit" ? "FAILED" : "PASSED");
    run.review(integration, "run", { correctDisposition: true, invalidEscape: contradiction === "invalid escape" }); fixture.seal();
    expect(fixture.metrics()["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()["M-01"]).not.toHaveProperty("value", 1);
  });

  it.each(["ACKNOWLEDGED", "CONTINUE"])("does not treat %s as a correct terminal protective effect", (invalidEffect) => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun(`invalid-terminal-${invalidEffect}`);
    const terminal = run.add("intervention.completed", { action: invalidEffect === "CONTINUE" ? "CONTINUE" : "PAUSE_FOR_REVIEW", status: invalidEffect === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : "APPLIED", triggerRecordHash: syntheticDigest(1), latencyMs: 50 });
    run.fact.closedEventId = terminal.eventId; run.review(terminal, "run", { correctDisposition: true }); fixture.seal();
    expect(fixture.metrics()["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()["M-01"]).not.toHaveProperty("value", 1);
  });
});

const completeSyntheticCatalog: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ["contract.verification_completed", { result: "PASSED", violationCode: null, baseCommit: syntheticCommit, authoritySourceDigests: { "authority.md": syntheticDigest(80) } }, { result: "PASSED", violationCode: null, baseCommit: syntheticCommit, authoritySourceDigests: { "authority.md": syntheticDigest(80) } }],
  ["execution.started", { maxAttempts: 20, planId: "synthetic-plan", runtimeVersion: "synthetic-runtime" }, { maxAttempts: 20, planId: "synthetic-plan", runtimeVersion: "synthetic-runtime" }],
  ["attempt.started", { attempt: 2, maxAttempts: 20, taskId: "SYNTHETIC-TASK" }, { attempt: 2, maxAttempts: 20, taskId: "SYNTHETIC-TASK" }],
  ["files.changed", { taskId: "SYNTHETIC-TASK", paths: ["src/app.ts"], commit: syntheticCommit }, { taskId: "SYNTHETIC-TASK", paths: ["src/app.ts"], commit: syntheticCommit }],
  ["impact.assessed", { impactedPaths: ["src/app.ts"], activeTaskCollisions: ["SYNTHETIC-OTHER"], expanded: false }, { impactedPaths: ["src/app.ts"], activeTaskCollisions: ["SYNTHETIC-OTHER"], expanded: false }],
  ["validation.completed", { taskId: "SYNTHETIC-TASK", command: "npm test", status: "PASSED", evidenceId: "validation-proof", artifactSha256: syntheticDigest(81) }, { taskId: "SYNTHETIC-TASK", command: "npm test", status: "PASSED", evidenceId: "validation-proof", artifactSha256: syntheticDigest(81) }],
  ["evidence.recorded", { items: ["finding"], satisfied: ["required-proof"], contradicted: [], artifactDigests: { "required-proof": syntheticDigest(82) } }, { items: ["finding"], satisfied: ["required-proof"], contradicted: [], artifactDigests: { "required-proof": syntheticDigest(82) } }],
  ["governor.decision", { decision: { action: "CONTINUE", ruleId: "entitled-to-continue", authorityEffect: "NONE", requiresApproval: false, signals: {} }, observationHash: syntheticDigest(83), recordHash: syntheticDigest(84) }, { action: "CONTINUE", ruleId: "entitled-to-continue", authorityEffect: "NONE", requiresApproval: false, signals: {}, observationSha256: syntheticDigest(83), recordHash: syntheticDigest(84) }],
  ["intervention.completed", { action: "PAUSE_FOR_REVIEW", status: "APPLIED", triggerRecordHash: syntheticDigest(84), latencyMs: 50 }, { action: "PAUSE_FOR_REVIEW", status: "APPLIED", triggerRecordHash: syntheticDigest(84), latencyMs: 50 }],
  ["integration.completed", { integrationCommit: syntheticCommit, taskIntegrationCommits: { "SYNTHETIC-TASK": syntheticCommit } }, { integrationCommit: syntheticCommit, taskIntegrationCommits: { "SYNTHETIC-TASK": syntheticCommit } }],
  ["integration.blocked", { reason: "synthetic proof contradiction", triggerRecordHash: syntheticDigest(84) }, { reason: "synthetic proof contradiction", triggerRecordHash: syntheticDigest(84) }],
  ["receipt.audit_completed", { result: "PASSED", receiptSha256: syntheticDigest(85), violationCodes: [] }, { result: "PASSED", receiptSha256: syntheticDigest(85), violationCodes: [] }],
  ["structural.concern_recorded", { reason: "synthetic structural concern", sourceEvidenceIds: ["evidence-1"] }, { reason: "synthetic structural concern", sourceEvidenceIds: ["evidence-1"] }],
  ["contract.superseded", { priorHandoffId: "synthetic-prior", newHandoffId: "synthetic-next", approvalId: "synthetic-existing-approval" }, { priorHandoffId: "synthetic-prior", newHandoffId: "synthetic-next", approvalId: "synthetic-existing-approval" }],
  ["outcome.reviewed", { correctDisposition: true, invalidEscape: false, outcomeClass: "synthetic-protective-stop", reviewerAuthority: "SYNTHETIC_REPOSITORY_FIXTURE", reviewedAt: syntheticTime(0) }, { correctDisposition: true, invalidEscape: false, outcomeClass: "synthetic-protective-stop", reviewerAuthority: "SYNTHETIC_REPOSITORY_FIXTURE", reviewedAt: syntheticTime(0) }],
];

describe("Traffic Control complete catalog source projection", () => {
  it.each(completeSyntheticCatalog)("retains every required %s fact while excluding unrelated private raw data", (type, supplied, expected) => {
    const payload = { ...structuredClone(supplied), rawLog: "x".repeat(100_000), prompt: "SYNTHETIC_PRIVATE_PROMPT", environmentValues: { PRIVATE_VALUE: "synthetic" } };
    const before = structuredClone(payload);
    const event = projectTrafficControlTelemetry({ sequence: 1, buildId: "synthetic-catalog-build", taskId: null, type, payload, occurredAt: syntheticTime(0) }, {
      correlation: { repositoryId: "synthetic-catalog-repo", runId: "synthetic-catalog-run", buildId: "synthetic-catalog-build", handoffId: "synthetic-catalog-handoff", contractSha256: syntheticDigest(86) },
      recordedAt: syntheticTime(1), environment: "synthetic",
    });
    expect(event.payload).toEqual({ environment: "synthetic", ...expected });
    expect(payload).toEqual(before);
    expect(JSON.stringify(event)).not.toContain("SYNTHETIC_PRIVATE_PROMPT");
    expect(JSON.stringify(event)).not.toContain("PRIVATE_VALUE");
    expect(event.source.sourceSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("detaches retained nested catalog maps from mutable native source objects", () => {
    const authoritySourceDigests = { "authority.md": syntheticDigest(87) };
    const event = projectTrafficControlTelemetry({ sequence: 1, buildId: "synthetic-detached-build", taskId: null, type: "contract.verification_completed", payload: { result: "PASSED", violationCode: null, baseCommit: syntheticCommit, authoritySourceDigests }, occurredAt: syntheticTime(0) }, {
      correlation: { repositoryId: "synthetic-detached-repo", runId: "synthetic-detached-run", buildId: "synthetic-detached-build", handoffId: "synthetic-detached-handoff", contractSha256: syntheticDigest(86) }, recordedAt: syntheticTime(1), environment: "synthetic",
    });
    authoritySourceDigests["authority.md"] = syntheticDigest(88);
    expect(event.payload.authoritySourceDigests).toEqual({ "authority.md": syntheticDigest(87) });
  });

  it("refuses private selected nested evidence instead of exporting it", () => {
    expect(() => projectTrafficControlTelemetry({ sequence: 1, buildId: "synthetic-private-build", taskId: null, type: "evidence.recorded", payload: { items: [{ sourceCode: "SYNTHETIC_PRIVATE_CODE" }], satisfied: [], contradicted: [], artifactDigests: {} }, occurredAt: syntheticTime(0) }, {
      correlation: { repositoryId: "synthetic-private-repo", runId: "synthetic-private-run", buildId: "synthetic-private-build", handoffId: "synthetic-private-handoff", contractSha256: syntheticDigest(86) }, recordedAt: syntheticTime(1), environment: "synthetic",
    })).toThrow(/sensitive/u);
  });
});

function appendSyntheticReviewCorrection(
  fixture: ReturnType<typeof syntheticMetricFixture>, run: SyntheticRun, prior: TrafficControlTelemetryEvent,
  correctDisposition: boolean, targetEventId = prior.eventId,
): TrafficControlTelemetryEvent {
  const sequence = Math.max(prior.sequence, ...fixture.events.filter((event) => event.correlation.runId === run.fact.correlation.runId && event.correlation.analysisRunId === undefined).map((event) => event.sequence)) + 1;
  const correction = projectTrafficControlTelemetry({
    sequence, buildId: requireSyntheticValue(run.fact.correlation.buildId, "the correction build identity"), taskId: null, type: "outcome.reviewed",
    payload: { ...prior.payload, correctDisposition, reviewedAt: syntheticTime(sequence) }, occurredAt: syntheticTime(sequence),
    correctionOfEventId: targetEventId, correctionReason: "Synthetic correction from the existing outcome authority record",
  }, { correlation: run.fact.correlation, recordedAt: syntheticTime(2 * 24 * 60 * 60 + sequence), environment: "synthetic" });
  fixture.events.push(correction);
  const binding = run.fact.reviews.find((review) => review.reviewEventId === prior.eventId);
  if (binding !== undefined) binding.reviewEventId = correction.eventId;
  return correction;
}

function syntheticSupersessionFixture(mode: "valid" | "missing approval" | "missing verification" | "unlinked handoff" | "unverified digest" = "valid") {
  const fixture = syntheticMetricFixture(); const run = fixture.addRun(`supersession-${mode}`);
  const concern = run.add("structural.concern_recorded", { reason: "Synthetic source-bound structural concern", sourceEvidenceIds: ["structural-proof"] }, 0);
  const supersession = run.add("contract.superseded", { priorHandoffId: run.fact.correlation.handoffId, newHandoffId: "synthetic-approved-next-handoff", ...(mode === "missing approval" ? {} : { approvalId: "synthetic-existing-approved-supersession" }) }, 120);
  run.fact.structuralClosures = [{ concernEventId: concern.eventId, supersessionEventId: supersession.eventId }];
  const nextCorrelation = { ...run.fact.correlation, buildId: "synthetic-superseded-build", handoffId: mode === "unlinked handoff" ? "synthetic-unlinked-handoff" : "synthetic-approved-next-handoff", contractSha256: syntheticDigest(400) };
  let sequence = supersession.sequence;
  const addNext = (type: string, payload: Record<string, unknown>, at: number, changedDigest = false) => {
    sequence += 1;
    const event = projectTrafficControlTelemetry({ sequence, buildId: nextCorrelation.buildId, taskId: null, type, payload, occurredAt: syntheticTime(at) }, {
      correlation: changedDigest ? { ...nextCorrelation, contractSha256: syntheticDigest(401) } : nextCorrelation, recordedAt: syntheticTime(at + 1), environment: "synthetic",
    });
    fixture.events.push(event); return event;
  };
  if (mode !== "missing verification") addNext("contract.verification_completed", { result: "PASSED", violationCode: null, baseCommit: syntheticCommit, authoritySourceDigests: { "governance/authority.md": syntheticDigest(90) } }, 121);
  addNext("execution.started", { maxAttempts: 20, planId: "synthetic-next-plan", runtimeVersion: "synthetic-runtime-2" }, 122);
  const terminal = addNext("intervention.completed", { action: "REQUEST_RECONSIDER", status: "APPLIED", triggerRecordHash: syntheticDigest(1), latencyMs: 50 }, 130, mode === "unverified digest");
  run.fact.closedEventId = terminal.eventId;
  const reviewed = addNext("outcome.reviewed", { correctDisposition: true, invalidEscape: false, outcomeClass: "synthetic-protective-disposition", reviewerAuthority: "SYNTHETIC_REPOSITORY_FIXTURE", reviewedAt: syntheticTime(131) }, 131, mode === "unverified digest");
  run.fact.reviews = [{ reviewEventId: reviewed.eventId, targetEventId: terminal.eventId, kind: "run" }];
  fixture.seal();
  return { ...fixture, run, concern, supersession, nextCorrelation };
}

describe("Traffic Control append-only corrections, supersession, and clock quality", () => {
  it("recomputes an appended source correction without removing or editing historical review rows", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("corrected-review"); const terminal = run.close(); const originalReview = run.review(terminal, "run", { correctDisposition: false });
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-01"], 0, 1);
    const originalHistory = structuredClone(fixture.events);
    const correction = appendSyntheticReviewCorrection(fixture, run, originalReview, true); fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-01"], 1, 1);
    expect(correction.correctionOfEventId).toBe(originalReview.eventId);
    expect(correction.correctionReason).toBe("Synthetic correction from the existing outcome authority record");
    expect(correction.sequence).toBeGreaterThan(originalReview.sequence);
    expect(correction.eventId).not.toBe(originalReview.eventId);
    expect(fixture.events.slice(0, originalHistory.length)).toEqual(originalHistory);
    expect(originalReview.payload.correctDisposition).toBe(false);
    expect(summarizeTrafficControlMetrics(fixture.events, fixture.context).populations.synthetic?.sourceEventCount).toBe(originalHistory.length + 1);
    const second = appendSyntheticReviewCorrection(fixture, run, correction, false); fixture.seal();
    expect(second.correctionOfEventId).toBe(correction.eventId);
    expectSyntheticRate(fixture.metrics()["M-01"], 0, 1);
    expect(fixture.events.slice(0, originalHistory.length)).toEqual(originalHistory);
  });

  it("refuses an orphaned correction even when the supplied source map verifies the new record", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("orphaned-correction"); const terminal = run.close(); const originalReview = run.review(terminal, "run", { correctDisposition: false });
    appendSyntheticReviewCorrection(fixture, run, originalReview, true, "synthetic-missing-original-event"); fixture.seal();
    expect(fixture.metrics()["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()["M-01"]).not.toHaveProperty("value", 1);
  });

  it("refuses a correction that crosses governed runs", () => {
    const fixture = syntheticMetricFixture(); const first = fixture.addRun("cross-correction-first"); const firstClosed = first.close(); const review = first.review(firstClosed, "run", { correctDisposition: false });
    const other = fixture.addRun("cross-correction-other"); const otherClosed = other.close();
    const correction = appendSyntheticReviewCorrection(fixture, other, review, true); other.fact.reviews.push({ reviewEventId: correction.eventId, targetEventId: otherClosed.eventId, kind: "run" }); fixture.seal();
    expect(fixture.metrics()["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("refuses two branches correcting the same original source fact", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("branched-correction"); const terminal = run.close(); const review = run.review(terminal, "run", { correctDisposition: false });
    const first = appendSyntheticReviewCorrection(fixture, run, review, true);
    const second = appendSyntheticReviewCorrection(fixture, run, review, true);
    requireSyntheticValue(run.fact.reviews[0], "the branched correction review target").reviewEventId = second.eventId; fixture.seal();
    expect(first.correctionOfEventId).toBe(second.correctionOfEventId);
    expect(fixture.metrics()["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
  });

  it("joins an approved same-run supersession to its actual new contract verification and build", () => {
    const fixture = syntheticSupersessionFixture();
    expect(fixture.nextCorrelation.runId).toBe(fixture.run.fact.correlation.runId);
    expect(fixture.nextCorrelation.handoffId).not.toBe(fixture.run.fact.correlation.handoffId);
    expect(fixture.nextCorrelation.buildId).not.toBe(fixture.run.fact.correlation.buildId);
    expectSyntheticRate(fixture.metrics()["M-01"], 1, 1);
    expectSyntheticRate(fixture.metrics()["M-17"], 1, 1);
    expect(fixture.metrics()["M-15"]).toMatchObject({ status: "AVAILABLE", denominator: 1, value: 120000, samples: [120000] });
  });

  it.each(["missing approval", "missing verification", "unlinked handoff", "unverified digest"] as const)("does not pool supersession lifecycle facts with %s", (mode) => {
    const fixture = syntheticSupersessionFixture(mode);
    for (const id of ["M-01", "M-15", "M-17"]) {
      expect(fixture.metrics()[id]).toMatchObject({ status: "UNAVAILABLE" });
      expect(fixture.metrics()[id]).not.toHaveProperty("value");
    }
  });

  it.each([0, 999, 1000])("accepts an explicitly allowed %ims recording clock skew", (skewMs) => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun(`clock-boundary-${skewMs}`); const terminal = run.close(); run.review(terminal, "run");
    terminal.recordedAt = new Date(Date.parse(terminal.occurredAt) - skewMs).toISOString(); fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-01"], 1, 1);
  });

  it("refuses a source event beyond the explicitly configured clock-skew bound", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("clock-beyond-boundary"); const terminal = run.close(); run.review(terminal, "run");
    terminal.recordedAt = new Date(Date.parse(terminal.occurredAt) - 1001).toISOString(); fixture.seal();
    for (const id of ["M-01", "M-13", "M-14", "M-17"]) expect(fixture.metrics()[id]).toMatchObject({ status: "UNAVAILABLE" });
  });
});

describe("Traffic Control native rename and block ordering evidence", () => {
  it("preserves an escaped rename's previous path even when its new path is owned", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("renamed-ownership-escape");
    const changed = run.add("files.changed", { taskId: "SYNTHETIC-TASK", paths: ["src/renamed.ts"], commit: syntheticCommit });
    run.fact.ownershipAssessments = [{ source: fixture.sourceRef(), filesChangedEventId: changed.eventId, evaluation: {
      passed: false, ownedRoots: ["src"], forbiddenRoots: [],
      changedFiles: [{ path: "src/renamed.ts", changeType: "renamed", previousPath: "outside/original.ts", withinOwnership: false }],
      violations: [{ path: "outside/original.ts", changePath: "src/renamed.ts", previousPath: "outside/original.ts", reason: "outside_ownership" }],
    } }];
    const integration = fixture.integrate(run); fixture.receipt(run); run.review(integration, "run", { correctDisposition: true }); fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-05"], 0, 1);
    expect(fixture.metrics()["M-01"]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()["M-01"]).not.toHaveProperty("value", 1);
  });

  it("does not count an unrelated block that occurred before the ownership violation", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("unrelated-earlier-block"); run.close("BLOCK_INTEGRATION");
    const changed = run.add("files.changed", { taskId: "SYNTHETIC-TASK", paths: ["outside.ts"], commit: syntheticCommit });
    run.fact.ownershipAssessments = [{ source: fixture.sourceRef(), filesChangedEventId: changed.eventId, evaluation: {
      passed: false, ownedRoots: ["src"], forbiddenRoots: [],
      changedFiles: [{ path: "outside.ts", changeType: "modified", previousPath: null, withinOwnership: false }],
      violations: [{ path: "outside.ts", changePath: "outside.ts", previousPath: null, reason: "outside_ownership" }],
    } }];
    run.close("PAUSE_FOR_REVIEW"); fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-05"], 0, 1);
  });
});

describe("Traffic Control measurement dimensions and counting-unit segmentation", () => {
  it("preserves supplied contract, policy, adapter, exposure, and reviewed-decision dimensions", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("retained-dimensions");
    run.fact.dimensions = {
      consumingProject: "synthetic-consuming-project", contractSchemaVersion: "2.1.0", failureClassification: "DETERMINISTIC_IMPLEMENTATION",
      failureFingerprint: syntheticDigest(510), ownershipDomain: "synthetic-ownership-domain", executionAdapter: "synthetic-native-adapter",
      runtimeVersion: "synthetic-runtime-exact", releaseExposure: "synthetic-release", experimentExposure: "synthetic-experiment",
    };
    const decision = fixture.decision(run, {}, undefined, "REQUEST_REPAIR", "synthetic-specific-rule"); run.close("REQUEST_REPAIR"); run.review(decision, "disposition"); fixture.seal();
    const metric = fixture.metrics()["M-19"];
    expect(metric?.dimensions).toEqual(expect.arrayContaining([expect.objectContaining({
      ...run.fact.dimensions, repositoryId: run.fact.correlation.repositoryId, runId: run.fact.correlation.runId,
      policyVersion: "governor.v1", action: "REQUEST_REPAIR", ruleId: "synthetic-specific-rule", taskId: null, reviewStatus: "reviewed",
    })]));
    expect(metric?.dimensions?.[0]?.contractSchemaVersion).not.toBe("1.0.0");
  });

  it("keeps unknown contract-schema and exposure dimensions explicit rather than substituting telemetry schema", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("unknown-dimensions"); const terminal = run.close(); run.review(terminal, "run"); fixture.seal();
    const row = fixture.metrics()["M-01"]?.dimensions?.[0];
    expect(row).toMatchObject({ contractSchemaVersion: null, consumingProject: null, releaseExposure: null, experimentExposure: null, executionAdapter: null, reviewStatus: "reviewed" });
    expect(row?.runtimeVersion).toBe("synthetic-runtime-1");
    expect(fixture.events[0]?.schemaVersion).toBe("1.0.0");
    expect(row?.contractSchemaVersion).not.toBe(fixture.events[0]?.schemaVersion);
  });

  it("segments reviewed intervention units by their own Governor rule within the same run", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("two-rules-one-run");
    const first = fixture.decision(run, {}, undefined, "PAUSE_FOR_REVIEW", "synthetic-rule-A");
    const interventionA = run.add("intervention.completed", { action: "PAUSE_FOR_REVIEW", status: "APPLIED", triggerRecordHash: first.payload.recordHash, latencyMs: 50 });
    run.review(interventionA, "intervention", { correctDisposition: true });
    const second = fixture.decision(run, {}, undefined, "PAUSE_FOR_REVIEW", "synthetic-rule-B");
    const interventionB = run.add("intervention.completed", { action: "PAUSE_FOR_REVIEW", status: "APPLIED", triggerRecordHash: second.payload.recordHash, latencyMs: 50 });
    run.fact.closedEventId = interventionB.eventId; run.review(interventionB, "intervention", { correctDisposition: false }); fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-08"], 1, 2);
    fixture.context.segment = { ruleId: "synthetic-rule-A" }; fixture.seal(); expectSyntheticRate(fixture.metrics()["M-08"], 1, 1);
    fixture.context.segment = { ruleId: "synthetic-rule-B" }; fixture.seal(); expectSyntheticRate(fixture.metrics()["M-08"], 0, 1);
    expect(fixture.events).toContain(first); expect(fixture.events).toContain(second);
  });

  it("does not exclude unknown adapter units to improve a segmented rate", () => {
    const fixture = syntheticMetricFixture();
    const known = fixture.addRun("known-segment-adapter"); known.fact.dimensions = { executionAdapter: "synthetic-adapter-A" };
    const knownDecision = fixture.decision(known); const knownIntervention = known.add("intervention.completed", { action: "PAUSE_FOR_REVIEW", status: "APPLIED", triggerRecordHash: knownDecision.payload.recordHash, latencyMs: 50 });
    known.fact.closedEventId = knownIntervention.eventId; known.review(knownIntervention, "intervention", { correctDisposition: true });
    const unknown = fixture.addRun("unknown-segment-adapter"); const unknownDecision = fixture.decision(unknown);
    const unknownIntervention = unknown.add("intervention.completed", { action: "PAUSE_FOR_REVIEW", status: "APPLIED", triggerRecordHash: unknownDecision.payload.recordHash, latencyMs: 50 });
    unknown.fact.closedEventId = unknownIntervention.eventId; unknown.review(unknownIntervention, "intervention", { correctDisposition: false });
    fixture.context.segment = { executionAdapter: "synthetic-adapter-A" }; fixture.seal();
    expect(fixture.metrics()["M-08"]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()["M-08"]).not.toHaveProperty("value", 1);
  });
});

describe("Traffic Control validation command privacy boundary", () => {
  it.each([
    "node -e 'console.log(\"SYNTHETIC_PRIVATE_CODE\")'",
    "node --eval 'console.log(\"SYNTHETIC_PRIVATE_CODE\")'",
    "node --eval='console.log(\"SYNTHETIC_PRIVATE_CODE\")'",
    "node -p 'process.env.SYNTHETIC_PRIVATE_VALUE'",
    "python -c 'print(\"SYNTHETIC_PRIVATE_CODE\")'",
    "python3 -c 'print(\"SYNTHETIC_PRIVATE_CODE\")'",
    "sh -c 'printf SYNTHETIC_PRIVATE_CODE'",
    "bash -c 'printf SYNTHETIC_PRIVATE_CODE'",
    "bash -lc 'printf SYNTHETIC_PRIVATE_CODE'",
    "powershell -Command 'Write-Output SYNTHETIC_PRIVATE_CODE'",
    "pwsh -Command 'Write-Output SYNTHETIC_PRIVATE_CODE'",
    "npm test -- --password=SYNTHETIC_ONLY_SENTINEL",
  ])("refuses selected validation command containing an inline program or recognized credential: %s", (command) => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("private-command");
    expect(() => run.add("validation.completed", { taskId: "SYNTHETIC-TASK", command, status: "PASSED", evidenceId: "synthetic-validation-proof", artifactSha256: syntheticDigest(600) })).toThrow();
  });

  it.each(["npm test", "npm run typecheck", "python -m pytest", "node --test"])("preserves ordinary bounded validation command %s", (command) => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("ordinary-command");
    const event = run.add("validation.completed", { taskId: "SYNTHETIC-TASK", command, status: "PASSED", evidenceId: "synthetic-validation-proof", artifactSha256: syntheticDigest(600) });
    expect(event.payload.command).toBe(command);
  });
});

describe("Traffic Control manual-override segmentation source fidelity", () => {
  it("keeps a valid rule-B override outside rule-A units without invalidating rule-A coverage", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("override-segment-two-rules");
    const ruleA = fixture.decision(run, {}, undefined, "PAUSE_FOR_REVIEW", "synthetic-rule-A"); run.review(ruleA, "disposition");
    const ruleB = fixture.decision(run, {}, undefined, "REQUEST_REPAIR", "synthetic-rule-B"); run.review(ruleB, "disposition"); run.close();
    fixture.context.overrides.push({ source: fixture.sourceRef(), dispositionEventId: ruleB.eventId, occurredAt: syntheticTime(100), direction: "REPAIR_TO_PAUSE" });
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-19"], 1, 2);
    fixture.context.segment = { ruleId: "synthetic-rule-A" }; fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-19"], 0, 1);
    expect(fixture.metrics()["M-19"]?.segments).toEqual({});
    fixture.context.segment = { ruleId: "synthetic-rule-B" }; fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-19"], 1, 1);
    expect(fixture.metrics()["M-19"]?.segments).toEqual({ "synthetic-rule-B:REPAIR_TO_PAUSE": 1 });
    fixture.context.overrides.push({ source: fixture.sourceRef(), dispositionEventId: ruleA.eventId, occurredAt: syntheticTime(101), direction: "PAUSE_TO_CONTINUE" });
    fixture.context.segment = { ruleId: "synthetic-rule-A" }; fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-19"], 1, 1);
    expect(fixture.metrics()["M-19"]?.segments).toEqual({ "synthetic-rule-A:PAUSE_TO_CONTINUE": 1 });
  });
});

describe("Traffic Control combined interpreter privacy admission", () => {
  it.each([
    "python3 -Ic 'print(\"SYNTHETIC_INLINE_SOURCE\")'",
    "ruby -e 'puts(\"SYNTHETIC_INLINE_SOURCE\")'",
  ])("refuses inline source at projection and incoming-envelope admission: %s", (command) => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("combined-interpreter-command");
    const ordinary = { taskId: "SYNTHETIC-TASK", command: "npm test", status: "PASSED", evidenceId: "synthetic-validation-proof", artifactSha256: syntheticDigest(610) };
    expect(() => run.add("validation.completed", { ...ordinary, command })).toThrow();
    const incoming = run.add("validation.completed", ordinary);
    incoming.payload.command = command;
    expect(() => summarizeTrafficControlMetrics([incoming])).toThrow();
  });
});

describe("Traffic Control effective contract-verification corrections", () => {
  it("refuses a correction whose prior source fact was not visible at the calculation snapshot", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("future-prior-verification");
    const prior = requireSyntheticValue(fixture.events.find((event) => event.eventId === run.fact.verificationEventId), "the corrected verification source");
    prior.recordedAt = "2026-09-29T00:00:00Z";
    const correction = projectTrafficControlTelemetry({
      sequence: 3, buildId: requireSyntheticValue(run.fact.correlation.buildId, "the verification build"), taskId: null, type: "contract.verification_completed",
      payload: { ...prior.payload }, occurredAt: syntheticTime(3), correctionOfEventId: prior.eventId,
      correctionReason: "Synthetic correction whose referenced source is outside the as-of snapshot",
    }, { correlation: run.fact.correlation, recordedAt: syntheticTime(4), environment: "synthetic" });
    fixture.events.push(correction); run.fact.verificationEventId = correction.eventId; fixture.seal();
    expect(Date.parse(prior.recordedAt)).toBeGreaterThan(Date.parse(fixture.context.asOf));
    expect(fixture.metrics()["M-16"]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()["M-16"]).not.toHaveProperty("value");
  });

  it("recomputes native ingestion from the effective verification while retaining original source history", () => {
    const fixture = syntheticMetricFixture(); const run = fixture.addRun("corrected-contract-verification");
    fixture.seal(); expectSyntheticRate(fixture.metrics()["M-16"], 1, 1);
    const prior = requireSyntheticValue(fixture.events.find((event) => event.eventId === run.fact.verificationEventId), "the original contract verification");
    const originalHistory = structuredClone(fixture.events);
    const sequence = Math.max(...fixture.events.map((event) => event.sequence)) + 1;
    const correction = projectTrafficControlTelemetry({
      sequence, buildId: requireSyntheticValue(run.fact.correlation.buildId, "the corrected verification build"), taskId: null, type: "contract.verification_completed",
      payload: { ...prior.payload, result: "REJECTED", violationCode: "NATIVE_INGESTION_REJECTED" }, occurredAt: syntheticTime(sequence),
      correctionOfEventId: prior.eventId, correctionReason: "Synthetic native ingestion finding corrected by the existing verifier",
    }, { correlation: run.fact.correlation, recordedAt: syntheticTime(2 * 24 * 60 * 60 + sequence), environment: "synthetic" });
    fixture.events.push(correction); run.fact.verificationEventId = correction.eventId; fixture.seal();
    expectSyntheticRate(fixture.metrics()["M-16"], 0, 1);
    expect(correction.correctionOfEventId).toBe(prior.eventId);
    expect(correction.sequence).toBeGreaterThan(prior.sequence);
    expect(fixture.events.slice(0, originalHistory.length)).toEqual(originalHistory);
    expect(prior.payload.result).toBe("PASSED");
    expect(summarizeTrafficControlMetrics(fixture.events, fixture.context).populations.synthetic?.sourceEventCount).toBe(originalHistory.length + 1);
    run.fact.verificationEventId = prior.eventId; fixture.seal();
    expect(fixture.metrics()["M-16"]).toMatchObject({ status: "UNAVAILABLE" });
    expect(fixture.metrics()["M-16"]).not.toHaveProperty("value", 1);
  });
});
