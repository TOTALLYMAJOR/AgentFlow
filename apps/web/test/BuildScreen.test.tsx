// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildEvent, BuildSummary, TaskDetail } from "../src/api/types.js";
import nativeCases from "./fixtures/governor-native-events.json";

// Keep the real screen, SWR, native client and useBuildEvents. Only the existing
// jsdom presentation boundary and browser request/EventSource transport are adapted.
vi.mock("@primer/react", () => ({
  Button: ({ children, onClick, disabled, title, "aria-label": label }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled} title={title} aria-label={label}>{children}</button>,
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
let buildFixture: BuildSummary;
let taskFixtures: Map<string, TaskDetail>;
let retryFailure: { code: string; message: string } | null;
let deferredRetry: Promise<Response> | null;
let retryMakesTaskReady = false;
let extraBuilds: BuildSummary[];
let authorityReads: Map<string, () => Promise<Response>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  NativeEventTransport.instances = [];
  vi.stubGlobal("EventSource", NativeEventTransport);
  requests = [];
  buildReadFails = false;
  buildFixture = currentBuild;
  taskFixtures = new Map();
  retryFailure = null;
  deferredRetry = null;
  retryMakesTaskReady = false;
  extraBuilds = [];
  authorityReads = new Map();
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requests.push({ path: input, method: init?.method ?? "GET" });
    if (input === "/api/builds?scope=active") return buildReadFails
      ? Response.json({ error: { code: "FIXTURE_READ_FAILURE", message: "Native state unavailable" } }, { status: 503 })
      : Response.json([buildFixture, ...extraBuilds]);
    const authorityPath = /^\/api\/builds\/([^/]+)\/execution-authority$/u.exec(input);
    if (authorityPath?.[1] !== undefined) {
      const handler = authorityReads.get(authorityPath[1]);
      return handler === undefined
        ? Response.json({ buildId: authorityPath[1], checkedAt: "2026-11-05T10:00:00.000Z", status: "unknown" })
        : handler();
    }
    for (const [id, detail] of taskFixtures) {
      if (input === `/api/builds/build/tasks/${id}`) return Response.json(detail);
      if (input === `/api/builds/build/tasks/${id}/diff`) return Response.json({ available: false, reason: "No fixture diff" });
      if (input === `/api/builds/build/tasks/${id}/retry`) {
        if (deferredRetry !== null) return deferredRetry;
        if (retryFailure !== null) return Response.json({ error: retryFailure }, { status: 409 });
        if (retryMakesTaskReady) {
          const readyTask = { ...detail, state: "ready" };
          taskFixtures.set(id, readyTask);
          buildFixture = { ...buildFixture, tasks: buildFixture.tasks?.map((task) => task.id === id ? readyTask : task) ?? [] };
        }
        return Response.json({ queued: true });
      }
    }
    return Response.json([]);
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

const checkedAt = "2026-11-05T10:00:00.000Z";
function authorityResult(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { buildId: "build", checkedAt, status, ...overrides };
}
function readAuthority(body: unknown, buildId = "build"): void {
  authorityReads.set(buildId, async () => Response.json(body));
}
async function showGovernor(buildId = "build", mount = true): Promise<HTMLDetailsElement> {
  if (mount) { await render(); await settled(); }
  const sample = nativeCases.find((item) => item.name === "coordinator-readback");
  if (sample === undefined) throw new Error("Missing actual native Governor fixture");
  // Preserve the retained native payload. Cross-build cases explicitly adapt only
  // the browser transport envelope, without claiming new native producer proof.
  await act(async () => {
    stream().open();
    stream().send({ ...sample.decision, buildId });
    stream().send({ ...sample.outcome, buildId });
  });
  const summary = [...container.querySelectorAll("summary")].find((item) => item.textContent === "Inspect Governor decision");
  if (summary === undefined) throw new Error("Governor disclosure missing");
  await act(async () => summary.click());
  const detail = summary.closest("details");
  if (detail === null) throw new Error("Governor detail missing");
  return detail;
}
function fact(detail: HTMLElement, label: string): HTMLElement {
  const term = [...detail.querySelectorAll("dt")].find((candidate) => candidate.textContent === label);
  const value = term?.parentElement?.querySelector("dd");
  if (value === null || value === undefined) throw new Error(`Missing ${label} fact`);
  return value;
}

describe("current native execution-authority readback", () => {
  it("shows a matching successful check as-of without upgrading recorded authority, chain or control permissions", async () => {
    recoveryFixture("paused", true);
    readAuthority(authorityResult("passed"));
    const detail = await showGovernor();
    await vi.waitFor(() => expect(fact(detail, "Current authority").textContent).toContain("Native execution checks passed"));
    expect(fact(detail, "Current authority").textContent).toContain(checkedAt);
    expect(fact(detail, "Current authority").textContent).toContain("Execution controls recheck before acting.");
    expect(fact(detail, "Recorded authority digest").textContent).not.toBe("Unknown");
    expect(fact(detail, "Proof boundary").textContent).toContain("Unknown");
    expect(fact(detail, "Record-chain verification").textContent).toContain("Unverified");
    const resume = [...container.querySelectorAll("button")].find((button) => button.textContent === "Resume");
    expect(resume?.disabled).toBe(false);
    const inspector = await openTask();
    expect(retryButton(inspector).disabled).toBe(true);
    expect(requests.some((request) => request.path === "/api/builds/build/execution-authority" && request.method === "GET")).toBe(true);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("shows a blocked native check and safe reason as-of without disabling an existing Resume control", async () => {
    readAuthority(authorityResult("blocked", { code: "GOVERNED_SOURCE_CHANGED", message: "The approved source snapshot changed." }));
    const detail = await showGovernor();
    await vi.waitFor(() => expect(fact(detail, "Current authority").textContent).toContain("Native execution checks blocked"));
    expect(fact(detail, "Current authority").textContent).toContain(checkedAt);
    expect(fact(detail, "Current authority").textContent).toContain("GOVERNED_SOURCE_CHANGED");
    expect(fact(detail, "Current authority").textContent).toContain("The approved source snapshot changed.");
    expect([...container.querySelectorAll("button")].find((button) => button.textContent === "Resume")?.disabled).toBe(false);
    expect(fact(detail, "Record-chain verification").textContent).toContain("Unverified");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it.each(["not_applicable", "unknown"])("keeps %s distinct from native checks passed", async (status) => {
    readAuthority(authorityResult(status));
    const detail = await showGovernor();
    await vi.waitFor(() => expect(fact(detail, "Current authority").textContent).toContain(checkedAt));
    expect(fact(detail, "Current authority").textContent).not.toContain("Native execution checks passed");
    expect(fact(detail, "Current authority").textContent).toMatch(status === "unknown" ? /Unknown/u : /not applicable.*ordinary plan/iu);
  });

  const malformedReadbacks = [
    ["foreign build", authorityResult("passed", { buildId: "other-build" })],
    ["unknown status", authorityResult("approved")],
    ["invalid date", authorityResult("passed", { checkedAt: "not a time" })],
    ["impossible date", authorityResult("passed", { checkedAt: "2026-02-30T10:00:00.000Z" })],
    ["missing date", { buildId: "build", status: "passed" }],
    ["missing build", { checkedAt, status: "passed" }],
    ["array body", [authorityResult("passed")]],
    ["null body", null],
    ["malformed code", authorityResult("passed", { code: { status: "passed" } })],
    ["malformed reason", authorityResult("passed", { message: ["passed"] })],
  ] as const;
  it.each(malformedReadbacks)("keeps current authority Unknown for %s", async (_name, body) => {
    readAuthority(body);
    const detail = await showGovernor();
    expect(fact(detail, "Current authority").textContent).toContain("Unknown");
    expect(fact(detail, "Current authority").textContent).not.toContain("Native execution checks passed");
    expect(fact(detail, "Record-chain verification").textContent).toContain("Unverified");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("masks a cached successful check when the next native read fails", async () => {
    readAuthority(authorityResult("passed"));
    const detail = await showGovernor();
    await vi.waitFor(() => expect(fact(detail, "Current authority").textContent).toContain("Native execution checks passed"));
    authorityReads.set("build", async () => Response.json({ error: { code: "QA_READ_FAILED", message: "Controlled read failure" } }, { status: 503 }));
    await act(async () => window.dispatchEvent(new Event("online")));
    await vi.waitFor(() => expect(fact(detail, "Current authority").textContent).toContain("latest native check could not be read"));
    expect(fact(detail, "Current authority").textContent).not.toContain("Native execution checks passed");
    expect(fact(detail, "Record-chain verification").textContent).toContain("Unverified");
  });

  it.each([
    ["a foreign build", authorityResult("passed", { buildId: "other-build" })],
    ["an impossible date", authorityResult("passed", { checkedAt: "2026-02-30T10:00:00.000Z" })],
    ["an unsupported status", authorityResult("approved")],
  ])("masks a cached successful check when a new envelope has %s", async (_name, invalid) => {
    readAuthority(authorityResult("passed"));
    const detail = await showGovernor();
    await vi.waitFor(() => expect(fact(detail, "Current authority").textContent).toContain("Native execution checks passed"));
    readAuthority(invalid);
    await act(async () => window.dispatchEvent(new Event("online")));
    await vi.waitFor(() => expect(fact(detail, "Current authority").textContent).toContain("Unknown"));
    expect(fact(detail, "Current authority").textContent).not.toContain("Native execution checks passed");
  });

  it("keeps a cached check explicitly as-of while a new read is outstanding", async () => {
    readAuthority(authorityResult("passed"));
    const detail = await showGovernor();
    await vi.waitFor(() => expect(fact(detail, "Current authority").textContent).toContain("Native execution checks passed"));
    let resolveRead: (value: Response) => void = () => { throw new Error("Deferred read not initialized"); };
    const pending = new Promise<Response>((resolve) => { resolveRead = resolve; });
    authorityReads.set("build", () => pending);
    await act(async () => window.dispatchEvent(new Event("online")));
    await vi.waitFor(() => expect(fact(detail, "Current authority").textContent).toContain("Rechecking"));
    expect(fact(detail, "Current authority").textContent).toContain(checkedAt);
    await act(async () => resolveRead(Response.json(authorityResult("blocked", { checkedAt: "2026-11-05T10:00:01.000Z" }))));
    await vi.waitFor(() => expect(fact(detail, "Current authority").textContent).toContain("Native execution checks blocked"));
    expect(fact(detail, "Current authority").textContent).not.toContain("Native execution checks passed");
  });

  it("does not transfer a late successful check to a newly selected build", async () => {
    let resolveOld: (value: Response) => void = () => { throw new Error("Deferred read not initialized"); };
    const pending = new Promise<Response>((resolve) => { resolveOld = resolve; });
    authorityReads.set("build", () => pending);
    extraBuilds = [{ ...currentBuild, id: "other-build", repositoryId: "other-repo", repositoryName: "Other fixture" }];
    await render(); await settled();
    const choice = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Other fixture"));
    if (choice === undefined) throw new Error("Other build choice missing");
    await act(async () => choice.click());
    await vi.waitFor(() => expect(stream().url).toContain("/api/builds/other-build/events/stream"));
    const detail = await showGovernor("other-build", false);
    await act(async () => resolveOld(Response.json(authorityResult("passed"))));
    expect(fact(detail, "Current authority").textContent).toContain("Unknown");
    expect(fact(detail, "Current authority").textContent).not.toContain("Native execution checks passed");
    expect(fact(detail, "Record-chain verification").textContent).toContain("Unverified");
    expect(requests.some((request) => request.path === "/api/builds/other-build/execution-authority" && request.method === "GET")).toBe(true);
  });
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

function recoveryFixture(status: string, governed: boolean): void {
  const detail: TaskDetail = {
    id: "task", buildId: "build", backlogTaskId: "AF-001", title: "Recovery task",
    state: "failed", attempt: 1, estimateHours: 1, branchName: null,
    workerId: null, errorCode: null, errorMessage: null,
    description: "Controlled recovery fixture", acceptanceCriteria: [],
    dependencies: [], ownership: [], validationCommands: [], attempts: [],
    approvals: [], artifacts: [], manifests: [], validations: [], changedFiles: [], events: [],
  };
  taskFixtures.set(detail.id, detail);
  buildFixture = {
    ...currentBuild, status, tasks: [detail],
    ...(governed ? { normalizedPlan: { governedHandoff: { handoffId: "fixture-handoff" } } } : {}),
  };
}

async function openTask(title = "Recovery task"): Promise<HTMLElement> {
  const trigger = [...container.querySelectorAll("button")].find((button) => button.textContent.includes(title));
  expect(trigger, `Task trigger for ${title}`).toBeDefined();
  await act(async () => trigger?.click());
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector(".task-inspector h2")?.textContent).toBe(title);
  });
  const inspector = container.querySelector<HTMLElement>(".task-inspector");
  if (inspector === null) throw new Error("Task inspector did not open");
  return inspector;
}

function retryButton(inspector: HTMLElement): HTMLButtonElement {
  const button = [...inspector.querySelectorAll("button")].find((candidate) => candidate.textContent === "Retry");
  if (button === undefined) throw new Error("Retry button missing");
  return button;
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

describe("Activity recovery controls", () => {
  it.each(["paused", "interrupted"])("disables known governed retry and distinguishes existing-work Resume when %s", async (status) => {
    recoveryFixture(status, true);
    await render(); await settled();
    const inspector = await openTask();
    expect(retryButton(inspector).disabled).toBe(true);
    expect(inspector.textContent).toContain("This governed build does not authorize a new task attempt.");
    expect(inspector.textContent).toContain("Resume continues existing work");
    expect(inspector.textContent).toContain("does not create a new task attempt");
    expect(inspector.textContent).toContain("new plan with current approval");
    expect(retryButton(inspector).title).not.toContain("Queue a new durable attempt");
    expect(document.activeElement).toBe(inspector);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("does not suggest Resume for a running governed build", async () => {
    recoveryFixture("running", true);
    await render(); await settled();
    const inspector = await openTask();
    expect(retryButton(inspector).disabled).toBe(true);
    expect(inspector.textContent).not.toContain("Resume continues existing work");
    expect(inspector.textContent).toContain("after this build has ended");
    expect(inspector.textContent).toContain("new plan with current approval");
  });

  it("uses the native refusal code rather than its message and prevents another unsupported retry", async () => {
    recoveryFixture("paused", false);
    retryFailure = { code: "GOVERNED_RECOVERY_NOT_AUTHORIZED", message: "Fixture refusal with no retry keywords" };
    await render(); await settled();
    const inspector = await openTask();
    expect(retryButton(inspector).disabled).toBe(false);
    await act(async () => retryButton(inspector).click());
    await vi.waitFor(() => expect(inspector.textContent).toContain("This governed build does not authorize a new task attempt."));
    expect(inspector.textContent).toContain("Resume continues existing work");
    expect(inspector.textContent).toContain("Fixture refusal with no retry keywords");
    expect(retryButton(inspector).disabled).toBe(true);
    expect(requests.filter((request) => request.method === "POST")).toEqual([
      { path: "/api/builds/build/tasks/task/retry", method: "POST" },
    ]);
  });

  it("preserves ordinary retry and revalidation without adding governed guidance", async () => {
    recoveryFixture("paused", false);
    await render(); await settled();
    const inspector = await openTask();
    await act(async () => retryButton(inspector).click());
    await vi.waitFor(() => expect(requests.filter((request) => request.path === "/api/builds/build/tasks/task" && request.method === "GET").length).toBeGreaterThan(1));
    expect(requests.filter((request) => request.method === "POST")).toEqual([
      { path: "/api/builds/build/tasks/task/retry", method: "POST" },
    ]);
    expect(inspector.textContent).not.toContain("This governed build does not authorize");
    expect(retryButton(inspector).disabled).toBe(false);
  });

  it("keeps unrelated errors generic even when the message resembles a governed refusal", async () => {
    recoveryFixture("paused", false);
    retryFailure = { code: "ANOTHER_NATIVE_FAILURE", message: "Governed build does not authorize retry: fixture storage unavailable" };
    await render(); await settled();
    const inspector = await openTask();
    await act(async () => retryButton(inspector).click());
    await vi.waitFor(() => expect(inspector.textContent).toContain(retryFailure?.message));
    expect(inspector.textContent).not.toContain("This governed build does not authorize a new task attempt.");
    expect(retryButton(inspector).disabled).toBe(false);
  });

  it("does not carry a late native refusal into a different task", async () => {
    recoveryFixture("paused", false);
    const first = taskFixtures.get("task");
    if (first === undefined) throw new Error("Missing first task fixture");
    const second = { ...first, id: "other-task", backlogTaskId: "AF-002", title: "Other recovery task" };
    taskFixtures.set(second.id, second);
    buildFixture = { ...buildFixture, tasks: [first, second] };
    retryFailure = { code: "GOVERNED_RECOVERY_NOT_AUTHORIZED", message: "Refusal scoped to the selected task" };
    await render(); await settled();
    const inspector = await openTask();
    await act(async () => retryButton(inspector).click());
    await vi.waitFor(() => expect(inspector.textContent).toContain("This governed build does not authorize a new task attempt."));
    const nextInspector = await openTask(second.title);
    expect(nextInspector.textContent).not.toContain("Refusal scoped to the selected task");
    expect(retryButton(nextInspector).disabled).toBe(false);
  });

  it("isolates an outstanding retry response when the selected task changes", async () => {
    recoveryFixture("paused", false);
    const first = taskFixtures.get("task");
    if (first === undefined) throw new Error("Missing first task fixture");
    const second = { ...first, id: "other-task", backlogTaskId: "AF-002", title: "Other recovery task" };
    taskFixtures.set(second.id, second);
    buildFixture = { ...buildFixture, tasks: [first, second] };
    let resolveRetry: (response: Response) => void = () => { throw new Error("Deferred response not initialized"); };
    deferredRetry = new Promise((resolve) => { resolveRetry = resolve; });
    await render(); await settled();
    const inspector = await openTask();
    await act(async () => retryButton(inspector).click());
    const nextInspector = await openTask(second.title);
    await act(async () => resolveRetry(Response.json({ error: {
      code: "GOVERNED_RECOVERY_NOT_AUTHORIZED", message: "Old task refusal arrived after selection changed",
    } }, { status: 409 })));
    expect(nextInspector.textContent).not.toContain("Old task refusal arrived after selection changed");
    expect(nextInspector.textContent).not.toContain("This governed build does not authorize a new task attempt.");
    expect(retryButton(nextInspector).disabled).toBe(false);
  });

  it("returns focus to the replacement task row after ordinary retry moves it between queues", async () => {
    recoveryFixture("paused", false);
    retryMakesTaskReady = true;
    await render(); await settled();
    const originalTrigger = container.querySelector<HTMLButtonElement>(".work-board button.task-row");
    if (originalTrigger === null) throw new Error("Original task trigger missing");
    expect(originalTrigger.closest("article")?.querySelector("h2")?.textContent).toBe("Needs you");
    const inspector = await openTask();
    await act(async () => retryButton(inspector).click());
    await vi.waitFor(() => expect(inspector.querySelector(".metadata-grid")?.textContent).toContain("ready"));
    const replacementTrigger = container.querySelector<HTMLButtonElement>(".work-board button.task-row[aria-pressed='true']");
    if (replacementTrigger === null) throw new Error("Replacement task trigger missing");
    expect(replacementTrigger.closest("article")?.querySelector("h2")?.textContent).toBe("Queued");
    expect(originalTrigger.isConnected).toBe(false);
    const close = inspector.querySelector<HTMLButtonElement>("button[aria-label='Close task inspector']");
    if (close === null) throw new Error("Inspector Close missing");
    await act(async () => close.click());
    expect(container.querySelector(".task-inspector")).toBeNull();
    expect(document.activeElement).toBe(replacementTrigger);
    expect(replacementTrigger.getAttribute("aria-pressed")).toBe("false");
  });
});
