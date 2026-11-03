// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildEvent, BuildSummary } from "../src/api/types.js";
import nativeCases from "./fixtures/governor-native-events.json";

// Keep the real screen, SWR, native client and useBuildEvents. Only the existing
// jsdom presentation boundary and browser request/EventSource transport are adapted.
vi.mock("@primer/react", () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
  Flash: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
  Label: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SkeletonBox: () => <span>Loading</span>,
}));
import { BuildScreen } from "../src/screens/BuildScreen.js";

class NativeEventTransport extends EventTarget {
  static instances: NativeEventTransport[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    NativeEventTransport.instances.push(this);
  }
  close(): void { this.closed = true; }
  open(): void { this.dispatchEvent(new Event("open")); }
  send(event: BuildEvent): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
  disconnect(): void { this.dispatchEvent(new Event("error")); }
}

const currentBuild: BuildSummary = {
  id: "build", repositoryId: "repo", repositoryName: "Native fixture",
  status: "paused", integrationBranch: "integration", workerLimit: 1,
  startedAt: "2026-11-03T12:00:00Z", completedAt: null, createdAt: "2026-11-03T12:00:00Z",
  estimates: { sequentialHours: null, criticalPathHours: null, expectedElapsedHours: null, expectedSavingsPercent: null },
  tasks: [{ id: "task", backlogTaskId: "AF-001", title: "Validated task", state: "validated", attempt: 1, estimateHours: 1, branchName: null, workerId: null, errorCode: null, errorMessage: null }],
  workers: [],
};
let container: HTMLDivElement;
let root: Root | null = null;
let requests: Array<{ path: string; method: string }>;
let buildReadFails = false;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  NativeEventTransport.instances = [];
  vi.stubGlobal("EventSource", NativeEventTransport);
  requests = [];
  buildReadFails = false;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requests.push({ path: input, method: init?.method ?? "GET" });
    if (input === "/api/builds?scope=active") return buildReadFails
      ? Response.json({ error: { code: "FIXTURE_READ_FAILURE", message: "Native state unavailable" } }, { status: 503 })
      : Response.json([currentBuild]);
    return Response.json([]);
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  expect(NativeEventTransport.instances.every((stream) => stream.closed)).toBe(true);
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => root?.render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <BuildScreen preferredBuildId="build" />
    </SWRConfig>,
  ));
}
async function settled(): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("Native fixture");
  });
}
function stream(): NativeEventTransport {
  const value = NativeEventTransport.instances.findLast((candidate) => !candidate.closed);
  if (value === undefined) throw new Error("Native event transport was not opened");
  return value;
}

describe("paused Activity truth", () => {
  it("describes actual pause and task states without claiming readiness or no overall blockers", async () => {
    await render(); await settled();
    expect(container.textContent).toContain("Work is paused");
    expect(container.textContent).not.toContain("Ready when you are");
    expect(container.textContent).not.toContain("No blockers need your attention");
    expect(container.textContent).not.toContain("Resume when you want");
    expect(container.textContent).toContain("No task is marked failed or awaiting approval");
    expect(container.textContent).toContain("Review recorded decisions, evidence and native controls");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Resume")).toBe(true);
  });

  it("keeps native readback, recorded decision and reconnect state distinct with actual hooks", async () => {
    await render(); await settled();
    const sample = nativeCases.find((item) => item.name === "coordinator-readback");
    if (sample === undefined) throw new Error("Missing actual native readback fixture");
    await act(async () => { stream().open(); stream().send(sample.decision); stream().send(sample.outcome); });
    const summary = [...container.querySelectorAll("summary")].find((item) => item.textContent === "Inspect Governor decision");
    expect(summary).toBeDefined();
    act(() => summary?.click());
    expect(container.textContent).toContain("Recent recorded decision");
    expect(container.textContent).toContain("Work is paused");
    expect(summary?.closest("details")?.textContent).toContain("running");
    expect(summary?.closest("details")?.textContent).toContain("not the final build state");
    await act(async () => { stream().disconnect(); });
    expect(container.textContent).toContain("Reconnecting");
    expect(container.textContent).toContain(sample.decision.payload.recordHash);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("does not infer controls or a Governor result when the native build read fails", async () => {
    buildReadFails = true;
    await render();
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(container.textContent).toContain("No control state has been inferred");
    });
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toContain("Inspect Governor");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });
});
