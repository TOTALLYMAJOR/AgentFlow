// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("swr", () => ({ default: () => ({ data: [{ id: "initiative_1", title: "Coordinated release", objective: "Ship provider and consumer", status: "partial", digest: "abc123", supersedesInitiativeId: null, updatedAt: "now", dependencies: [{ producerPlanId: "plan_a", consumerPlanId: "plan_b", dependencyType: "artifact", artifactName: "api", artifactVersion: "1.0.0" }], members: [{ repositoryId: "repo_a", planId: "plan_a", baseCommit: "aaa", buildId: "build_a" }, { repositoryId: "repo_b", planId: "plan_b", baseCommit: "bbb", buildId: null }], builds: [{ id: "build_a", status: "completed" }], blockers: [{ planId: "plan_b", code: "ARTIFACT_NOT_INTEGRATED", message: "Required artifact api@1.0.0 is not integrated", recovery: "Integrate the exact upstream artifact" }] }], isLoading: false, error: undefined, mutate: vi.fn() }) }));
vi.mock("@primer/react", () => ({ Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children}</button>, Flash: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../src/components/StatusBadge.js", () => ({ StatusBadge: ({ status }: { status: string }) => <span>{status}</span> }));
vi.mock("../src/components/PageTitle.js", () => ({ PageTitle: ({ title, description }: { title: string; description: string }) => <header><h1>{title}</h1><p>{description}</p></header> }));
vi.mock("../src/components/EmptyState.js", () => ({ EmptyState: () => <div /> }));
vi.mock("../src/components/LoadingState.js", () => ({ LoadingState: () => <div /> }));

import { InitiativesScreen } from "../src/screens/InitiativesScreen.js";
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null; });

describe("initiative supervision", () => {
  it("keeps partial state, waiting repositories, digest, and proof boundary visible", () => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    act(() => { root?.render(<InitiativesScreen />); });
    expect(container.textContent).toContain("partial");
    expect(container.textContent).toContain("waiting for an eligible wave");
    expect(container.textContent).toContain("abc123");
    expect(container.textContent).toContain("Required artifact api@1.0.0 is not integrated");
    expect(container.textContent).toContain("Recovery: Integrate the exact upstream artifact");
    expect(container.textContent).toContain("Reconcile now");
    expect(container.textContent).toContain("Cancel initiative");
    expect(container.textContent).toContain("Integrated work is not represented as published, deployed, or externally operational.");
  });
});
