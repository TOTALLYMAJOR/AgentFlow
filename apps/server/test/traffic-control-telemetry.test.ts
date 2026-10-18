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
