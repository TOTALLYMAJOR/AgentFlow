import { describe, expect, it } from "vitest";
import { projectTrafficControlTelemetry, summarizeTrafficControlMetrics } from "../src/telemetry/traffic-control-projection.js";

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
    const event = projectTrafficControlTelemetry({ ...reviewedSource(1, true), payload: { correctDisposition: true } }, {
      correlation, recordedAt: "2026-09-17T12:00:01Z", environment: "local",
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
