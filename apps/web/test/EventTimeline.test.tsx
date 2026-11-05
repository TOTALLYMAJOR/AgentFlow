// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildEvent } from "../src/api/types.js";
import nativeCases from "./fixtures/governor-native-events.json";
import { EventTimeline } from "../src/components/EventTimeline.js";

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

function nativeCase(name: string) {
  const value = nativeCases.find((item) => item.name === name);
  if (value === undefined) throw new Error("Missing retained native test case");
  return structuredClone(value);
}
function render(events: BuildEvent[], connected = true): void {
  act(() => root?.render(<EventTimeline events={events} connected={connected} />));
}
function openDecision(): HTMLDetailsElement {
  const summary = [...container.querySelectorAll("summary")].find((item) => item.textContent === "Inspect Governor decision");
  expect(summary, "native decision must be inspectable in the existing event row").toBeDefined();
  act(() => summary?.click());
  const details = summary?.closest("details");
  expect(details?.open).toBe(true);
  return details as HTMLDetailsElement;
}
function field(scope: HTMLElement, label: string): string | null {
  return [...scope.querySelectorAll("dt")].find((item) => item.textContent === label)?.parentElement?.querySelector("dd")?.textContent ?? null;
}

describe("recorded Governor event inspection", () => {
  it("exposes recorded bindings and rule without inventing current proof or authority", () => {
    const sample = nativeCase("http-after-effect");
    render([sample.decision, sample.outcome]);
    const details = openDecision();
    for (const key of ["policyVersion", "contractHash", "observationHash", "recordHash"] as const) {
      expect(details.textContent).toContain(sample.decision.payload[key]);
    }
    expect(details.textContent).toContain("REQUEST_REPAIR");
    expect(details.textContent).toContain("bounded-implementation-failure");
    expect(details.textContent).toContain(sample.decision.payload.decision.signals.failureFingerprint);
    expect(field(details, "Current authority")).toContain("Unknown");
    expect(field(details, "Proof boundary")).toContain("Unknown");
    expect(field(details, "Record-chain verification")).toContain("Unverified");
    expect(container.textContent).toContain("Recent event window");
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps a missing ACK distinct from native effects in the retained after-effect case", () => {
    const sample = nativeCase("http-after-effect");
    render([sample.decision, sample.outcome]);
    const details = openDecision();
    expect(field(details, "Acknowledgement availability")).toBe("Unavailable");
    expect(field(details, "Acknowledgement value")).toContain("Unknown");
    expect(field(details, "Applied effect")).toContain("Unknown");
    expect(field(details, "Catch-time readback after")).toBe("paused");
    expect(details.textContent).toContain("not the final build state");
  });

  it("preserves a returned ACK while distinguishing later receipt persistence failure", () => {
    const sample = nativeCase("http-receipt-persistence");
    render([sample.decision, sample.outcome]);
    const details = openDecision();
    expect(field(details, "Acknowledgement availability")).toBe("Available");
    expect(field(details, "Acknowledgement value")).toBe("Received");
    expect(field(details, "Receipt write attempt")).toBe("Attempted");
    expect(field(details, "Durable ACK write")).toContain("Not confirmed");
    expect(field(details, "Applied effect")).toContain("Unknown");
  });

  it("does not turn catch-time readback into the later final state", () => {
    const sample = nativeCase("coordinator-readback");
    expect(sample.finalBuildStatus).toBe("paused");
    render([sample.decision, sample.outcome]);
    const details = openDecision();
    expect(field(details, "Catch-time readback after")).toBe("running");
    expect(details.textContent).not.toContain("Final build state");
  });

  it.each(["different hash", "different build"] as const)("does not attach a result with a %s", (mismatch) => {
    const sample = nativeCase("http-after-effect");
    if (mismatch === "different hash") sample.outcome.payload.decisionRecordHash = "f".repeat(64);
    else sample.outcome.buildId = "another-build";
    render([sample.decision, sample.outcome]);
    const details = openDecision();
    expect(details.textContent).toContain("No matching result is present in this recent window");
    expect(field(details, "Acknowledgement availability")).toBeNull();
  });

  it("keeps multiple linked native facts instead of selecting an applied-effect verdict", () => {
    const sample = nativeCase("http-after-effect");
    const later = structuredClone(sample.outcome);
    later.sequence += 20;
    later.payload.acknowledged = true;
    later.payload.details.acknowledgementAvailable = true;
    render([sample.decision, sample.outcome, later]);
    const details = openDecision();
    expect(details.querySelectorAll(".governor-result")).toHaveLength(2);
    expect(details.textContent).toContain("Unavailable");
    expect(details.textContent).toContain("Available");
    expect(field(details, "Applied effect")).toContain("Unknown");
  });

  it("presents a structural display fixture as proposal-only without approval or execution controls", () => {
    const sample = nativeCase("http-after-effect");
    // A deliberately unverified display fixture, not a new native approval or
    // cryptographic producer assertion. The three retained cases above remain unchanged.
    const decision: BuildEvent = { ...sample.decision, payload: {
      ...sample.decision.payload,
      decision: { policyVersion: "governor.v1", action: "PROPOSE_REPLAN", ruleId: "repeated-no-progress-failure", authorityEffect: "PROPOSAL_ONLY", requiresApproval: true, signals: { repeatCount: 3, evidenceDelta: "ZERO" } },
    } };
    render([decision]);
    const details = openDecision();
    expect(details.textContent).toContain("Proposal only");
    expect(details.textContent).toContain("does not authorize execution");
    expect(details.querySelector("button")).toBeNull();
    expect(field(details, "Record-chain verification")).toContain("Unverified");
  });

  it("does not dump arbitrary payloads, log messages or unsupported secret-shaped signals", () => {
    const sample = nativeCase("http-after-effect");
    const marker = "PRIVATE_TOKEN_MUST_NOT_APPEAR";
    const decision: BuildEvent = { ...sample.decision, payload: { ...sample.decision.payload, apiKey: marker, decision: {
      ...sample.decision.payload.decision, signals: { ...sample.decision.payload.decision.signals, concern: marker, unexpectedImpactedPaths: [marker], arbitrary: { secret: marker } },
    } } };
    const outcome: BuildEvent = { ...sample.outcome, payload: { ...sample.outcome.payload, message: marker } };
    render([decision, outcome]);
    const details = openDecision();
    expect(details.textContent).not.toContain(marker);
    expect(container.textContent).not.toContain(marker);
    expect(details.textContent).toContain("failureFingerprint");
  });

  it("renders malformed or unsupported decision payloads as unknown without a raw dump", () => {
    const sample = nativeCase("http-after-effect");
    render([{ ...sample.decision, payload: { policyVersion: "unknown-policy", decision: ["PRIVATE_TOKEN_MUST_NOT_APPEAR"], recordHash: "invalid" } }]);
    const details = openDecision();
    expect(details.textContent).toContain("Unsupported or incomplete native decision");
    expect(details.textContent).toContain("Unknown");
    expect(details.textContent).not.toContain("PRIVATE_TOKEN_MUST_NOT_APPEAR");
  });

  it("keeps waiting and reconnection distinct from confirmed empty native history", () => {
    render([], false);
    expect(container.textContent).toContain("Waiting for native events");
    expect(container.textContent).not.toContain("No durable events have been recorded");
    const sample = nativeCase("http-after-effect");
    render([sample.decision], false);
    expect(container.textContent).toContain("Reconnecting");
    expect(openDecision().textContent).toContain(sample.decision.payload.recordHash);
  });

  it("uses a focusable native disclosure and preserves ordinary event rows", () => {
    const sample = nativeCase("http-after-effect");
    render([sample.decision, { sequence: 99, buildId: "build", taskId: "task", type: "task.started", payload: {}, occurredAt: "2026-11-03T12:00:00Z" }]);
    const details = openDecision();
    const summary = details.querySelector("summary");
    summary?.focus();
    expect(document.activeElement).toBe(summary);
    expect(container.textContent).toContain("task.started");
    expect(container.textContent).toContain("#99");
  });
});
