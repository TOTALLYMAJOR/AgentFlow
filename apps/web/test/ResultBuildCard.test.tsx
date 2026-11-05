// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import useSWR, { SWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/api/client.js";
import type { BuildMetrics, BuildSummary, TaskManifest } from "../src/api/types.js";

// Preserve the real component, SWR lifecycle/cache and client. Only the Primer
// CSS boundary and request transport are adapted for the existing jsdom suite.
vi.mock("@primer/react", () => ({
  Flash: ({ children }: { children: React.ReactNode }) => <div role="status">{children}</div>,
}));
vi.mock("../src/components/StatusBadge.js", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

import { ResultBuildCard } from "../src/components/ResultBuildCard.js";

const build: BuildSummary = {
  id: "build_terminal_readback", repositoryId: "repo_fixture", repositoryName: "Fixture project",
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
const paths = {
  artifacts: `/api/builds/${build.id}/artifacts`,
  manifests: `/api/builds/${build.id}/manifests`,
};
const terminalManifests: TaskManifest[] = ["validated", "integrated"].map((status) => ({
  id: `manifest_${status}`, buildId: build.id, taskId: "task_fixture", attempt: 1,
  status, schemaVersion: "1.0.0", manifestPath: `/tmp/fixture/${status}.json`,
  sha256: "a".repeat(64), manifest: { status }, createdAt: "2026-11-03T12:00:01Z",
}));

let root: Root | null;
let container: HTMLDivElement;
let manifests: TaskManifest[];
let manifestFailure: boolean;
let releaseManifest: (() => void) | undefined;
let holdManifest: Promise<void> | undefined;
let requests: string[];
let cache: Cache<unknown>;
let releases: Array<() => void>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  cache = new Map();
  requests = [];
  manifests = [];
  manifestFailure = false;
  releaseManifest = undefined;
  holdManifest = undefined;
  releases = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    if (input.endsWith("/manifests")) {
      const responseManifests = manifests;
      const responseFailure = manifestFailure;
      await holdManifest;
      return responseFailure
        ? Response.json({ error: { code: "FIXTURE_READ_FAILED", message: "Manifest readback failed" } }, { status: 503 })
        : Response.json(responseManifests);
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

// Match Activity's existing shared URL keys and its three-second polling. The
// fast terminal navigation occurs inside SWR's ordinary two-second dedup window.
function RunningEvidence(): React.JSX.Element {
  const artifacts = useSWR<unknown[]>(paths.artifacts, apiFetch, { refreshInterval: 3_000 });
  const result = useSWR<TaskManifest[]>(paths.manifests, apiFetch, { refreshInterval: 3_000 });
  return <span>{artifacts.data !== undefined && result.data !== undefined ? "Running evidence loaded" : "Loading running evidence"}</span>;
}

async function render(completed: boolean, result = build): Promise<void> {
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 2_000, shouldRetryOnError: false }}>
        {completed ? <ResultBuildCard build={result} /> : <RunningEvidence />}
      </SWRConfig>,
    );
  });
}

async function waitForText(text: string): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain(text);
  });
}

function holdReadback(): () => void {
  let release!: () => void;
  holdManifest = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return release;
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function warmRunningCache(): Promise<void> {
  await render(false);
  await waitForText("Running evidence loaded");
  expect(requests.filter((path) => path === paths.manifests)).toHaveLength(1);
}

describe("terminal result evidence readback", () => {
  it("reloads native-shaped manifests after fast running-to-completed navigation", async () => {
    await warmRunningCache();
    manifests = terminalManifests;
    await render(true);
    await waitForText("2 confirmed records");
    expect(container.textContent).toContain("2 manifests");
    expect(container.textContent).toContain("0 artifacts");
    expect(container.textContent).toContain("Publication unknown; no record");
    expect(requests.filter((path) => path === paths.manifests)).toHaveLength(2);
  });

  it("shows readback in progress instead of cached zero while native results are pending", async () => {
    await warmRunningCache();
    manifests = terminalManifests;
    releaseManifest = holdReadback();
    await render(true);
    await waitForText("Loading durable result evidence");
    expect(container.textContent).not.toContain("0 confirmed records");
    releaseManifest();
    await waitForText("2 confirmed records");
  });

  it("keeps failed terminal readback distinct from a cached confirmed zero", async () => {
    await warmRunningCache();
    manifestFailure = true;
    await render(true);
    await waitForText("Record count unavailable");
    expect(container.textContent).toContain("Manifests unavailable");
    expect(container.textContent).not.toContain("0 confirmed records");
    expect(container.textContent).not.toContain("0 manifests");
  });

  it.each(["different build", "same-build terminal retry"] as const)(
    "keeps the current readback isolated from a late previous %s result",
    async (change) => {
      await warmRunningCache();
      manifests = terminalManifests;
      const finishPrevious = holdReadback();
      await render(true, { ...build, status: "failed", completedAt: "2026-11-03T12:00:00Z" });
      await waitForText("Loading durable result evidence");

      const current = change === "different build"
        ? { ...build, id: "build_current" }
        : { ...build, status: "failed" };
      manifests = [];
      const finishCurrent = holdReadback();
      await render(true, current);
      await vi.waitFor(async () => {
        await flush();
        const expectedRequests = change === "different build" ? 1 : 3;
        expect(requests.filter((path) => path === `/api/builds/${current.id}/manifests`).length).toBeGreaterThanOrEqual(expectedRequests);
      });

      if (change === "same-build terminal retry") {
        finishPrevious();
        await flush();
        expect(container.textContent).toContain("Loading durable result evidence");
        expect(container.textContent).not.toContain("2 confirmed records");
      }
      finishCurrent();
      await waitForText("0 confirmed records");
      if (change === "different build") {
        finishPrevious();
        await flush();
        expect(container.textContent).toContain("0 confirmed records");
        expect(container.textContent).not.toContain("Loading durable result evidence");
      }
      expect(container.textContent).toContain(current.id);
    },
  );

  it("preserves genuine zero only after the terminal native readback succeeds", async () => {
    await warmRunningCache();
    await render(true);
    await waitForText("0 confirmed records");
    expect(container.textContent).toContain("0 manifests");
    expect(requests.filter((path) => path === paths.manifests)).toHaveLength(2);
  });
});
