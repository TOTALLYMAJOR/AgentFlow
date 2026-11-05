// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildMetrics, BuildSummary } from "../src/api/types.js";

// Keep ResultsScreen, ResultBuildCard, SWR and apiFetch real. Adapt only the
// existing Primer CSS boundary and request transport for this jsdom suite.
vi.mock("@primer/react", () => ({
  Flash: ({ children }: { children: React.ReactNode }) => <div role="status">{children}</div>,
  SkeletonBox: () => <div aria-hidden="true" />,
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>,
}));
vi.mock("../src/components/StatusBadge.js", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

import { ResultsScreen } from "../src/screens/ResultsScreen.js";

const listPath = "/api/builds?scope=terminal&limit=50";
const build: BuildSummary = {
  id: "build_completed_list_readback", repositoryId: "repo_fixture", repositoryName: "Fixture project",
  status: "completed", integrationBranch: "agent-integration/fixture", workerLimit: 1,
  startedAt: "2026-11-03T12:00:00Z", completedAt: "2026-11-03T12:00:01Z",
  createdAt: "2026-11-03T12:00:00Z", actualElapsedSeconds: 1,
  estimates: { sequentialHours: 1, criticalPathHours: 1, expectedElapsedHours: 1, expectedSavingsPercent: null },
  tasks: [], workers: [],
};
const metrics: BuildMetrics = {
  estimatedSequentialHours: 1, criticalPathHours: 1, expectedElapsedHours: 1,
  expectedSavingsPercent: null, actualElapsedSeconds: 1, totalTasks: 1,
  integratedTasks: 1, failedTasks: 0, ownershipViolations: 0, pushStatus: null,
};
interface Reply { body: BuildSummary[]; status?: number; hold?: Promise<void>; }
let root: Root | null;
let container: HTMLDivElement;
let cache: Cache<unknown>;
let reply: Reply;
let requests: string[];
let releases: Array<() => void>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cache = new Map();
  reply = { body: [] };
  requests = [];
  releases = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    if (input === listPath) {
      const response = reply;
      await response.hold;
      return response.status === 503
        ? Response.json({ error: { code: "FIXTURE_READ_FAILED", message: "Terminal list readback failed" } }, { status: 503 })
        : Response.json(response.body);
    }
    if (input.endsWith("/metrics")) return Response.json(metrics);
    return Response.json([]);
  }));
});

afterEach(async () => {
  for (const release of releases) release();
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function render(completed: boolean, strict = false): Promise<void> {
  await act(async () => {
    const screen = <SWRConfig value={{ provider: () => cache, dedupingInterval: 2_000, shouldRetryOnError: false }}>
      {completed ? <ResultsScreen /> : <span>Activity fixture</span>}
    </SWRConfig>;
    root?.render(strict ? <StrictMode>{screen}</StrictMode> : screen);
  });
}
async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function waitForText(text: string): Promise<void> {
  await vi.waitFor(async () => { await flush(); expect(container.textContent).toContain(text); });
}
const listRequests = (): number => requests.filter((path) => path === listPath).length;
async function warmEmpty(strict = false): Promise<number> {
  await render(true, strict);
  await waitForText("No completed work yet");
  expect(listRequests()).toBeGreaterThanOrEqual(1);
  return Date.now();
}
function holdReply(body: BuildSummary[], status?: number): () => void {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  reply = { body, hold, ...(status === undefined ? {} : { status }) };
  releases.push(release);
  return release;
}

describe("Completed list entry readback", () => {
  it("fetches native-shaped terminal records after a fast return to an empty cached list", async () => {
    const warmedAt = await warmEmpty();
    await render(false);
    const before = listRequests();
    reply = { body: [build] };
    await render(true);
    expect(Date.now() - warmedAt).toBeLessThan(2_000);
    await waitForText(build.id);
    expect(listRequests()).toBeGreaterThan(before);
    expect(container.textContent).not.toContain("No completed work yet");
  });

  it("shows a pending fresh read instead of claiming cached empty is current", async () => {
    await warmEmpty();
    await render(false);
    const release = holdReply([build]);
    await render(true);
    await waitForText("Loading completed work");
    expect(container.textContent).not.toContain("No completed work yet");
    release();
    await waitForText(build.id);
  });

  it("reports a failed fresh list read instead of reusing a cached empty claim", async () => {
    await warmEmpty();
    await render(false);
    reply = { body: [], status: 503 };
    await render(true);
    await waitForText("Completed work could not be loaded");
    expect(container.textContent).not.toContain("No completed work yet");
  });

  it.each(["before current read", "after current read"] as const)("ignores an older empty response completing %s", async (order) => {
    await warmEmpty();
    await render(false);
    const previousCount = listRequests();
    const finishPrevious = holdReply([]);
    await render(true);
    await vi.waitFor(() => { expect(listRequests()).toBeGreaterThan(previousCount); });

    await render(false);
    const currentCount = listRequests();
    const finishCurrent = holdReply([build]);
    await render(true);
    await vi.waitFor(() => { expect(listRequests()).toBeGreaterThan(currentCount); });
    await waitForText("Loading completed work");
    if (order === "before current read") {
      finishPrevious();
      await flush();
      expect(container.textContent).toContain("Loading completed work");
      expect(container.textContent).not.toContain("No completed work yet");
    }
    finishCurrent();
    await waitForText(build.id);
    if (order === "after current read") {
      finishPrevious();
      await flush();
      expect(container.textContent).toContain(build.id);
      expect(container.textContent).not.toContain("No completed work yet");
    }
  });

  it("preserves last confirmed results when their fresh entry read is pending or fails", async () => {
    reply = { body: [build] };
    await render(true);
    await waitForText(build.id);
    await render(false);
    const release = holdReply([], 503);
    await render(true);
    await waitForText("Loading completed work");
    expect(container.textContent).toContain(build.id);
    release();
    await waitForText("Completed work could not be loaded");
    expect(container.textContent).toContain(build.id);
    expect(container.textContent).not.toContain("No completed work yet");
  });

  it("shows genuine empty only after the native-shaped list read succeeds", async () => {
    await render(true);
    await waitForText("No completed work yet");
    expect(container.textContent).not.toContain("Completed work could not be loaded");
  });

  it("keeps the fast-return readback correct under StrictMode effect replay", async () => {
    const warmedAt = await warmEmpty(true);
    await render(false, true);
    const before = listRequests();
    reply = { body: [build] };
    await render(true, true);
    expect(Date.now() - warmedAt).toBeLessThan(2_000);
    await waitForText(build.id);
    expect(listRequests()).toBeGreaterThan(before);
    expect(container.textContent).not.toContain("No completed work yet");
  });
});
