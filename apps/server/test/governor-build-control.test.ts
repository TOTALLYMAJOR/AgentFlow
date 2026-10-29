import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseRepositories } from "../src/db/index.js";
import { resolveEnvironment } from "../src/config/environment.js";
import { DEFAULT_ORGANIZATION_POLICY } from "../src/governance/organization-policy.js";
import { evaluateGovernedBuild } from "../src/governor/build-control.js";
import { GovernorControlService } from "../src/governor/control-service.js";
import { canonicalJsonSha256 } from "../src/integration/design-intelligence.js";
import { createDatabaseFixture, type DatabaseFixture } from "./helpers/database-fixture.js";
import { approvedGovernedHandoff } from "./helpers/governed-handoff.js";

describe("current native Governor failure attribution", () => {
  let fixture: DatabaseFixture | undefined;
  afterEach(() => { vi.restoreAllMocks(); fixture?.cleanup(); fixture = undefined; });

  async function setup() {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    const root = path.join(fixture.directory, "repository");
    await mkdir(root);
    const handoff = approvedGovernedHandoff({
      handoffId: "recovery-failure-test", baseCommit: "a".repeat(40),
      objective: "Unit-only native failure attribution.", requiredEvidence: ["focused-tests"], claimBoundary: "Unit test only; no execution approval.",
      tasks: [{ id: "AF-001", title: "Task", description: "Task", estimateHours: 1, dependsOn: [], owns: ["src"], acceptanceCriteria: ["Passes"], validate: ["npm test"], produces: [], consumes: [] }],
    });
    const handoffPath = path.join(root, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(handoff));
    store.repositories.create({ id: "repo", name: "test", localPath: root, configPath: ".agentflow.yaml", baseBranch: "main" });
    store.builds.create({
      id: "build", repositoryId: "repo", backlogPath: "BACKLOG.md", baseCommit: handoff.repository.baseCommit,
      integrationBranch: "integration", status: "running",
      normalizedPlan: { governedHandoff: { id: handoff.handoffId, sha256: canonicalJsonSha256(handoff), path: "handoff.json", governedBaseCommit: handoff.repository.baseCommit, carrierPaths: ["handoff.json", "BACKLOG.md"], proofBoundary: handoff.proof.claimBoundary } },
      tasks: [{ id: "task", backlogTaskId: "AF-001", title: "Task", description: "Task", acceptanceCriteria: ["Passes"], state: "running", attempt: 1 }],
    });
    store.tasks.createAttempt({ id: "attempt-1", taskId: "task", buildId: "build", attempt: 1, status: "running" });
    const dependencies = {
      store, environment: resolveEnvironment({ AGENTFLOW_HOME: path.join(fixture.directory, "runtime"), AGENTFLOW_RETRY_MAX_ATTEMPTS: "10" }),
      repositoryService: { get: async () => store.repositories.getById("repo") },
      organizationPolicy: DEFAULT_ORGANIZATION_POLICY,
    } as unknown as Parameters<typeof evaluateGovernedBuild>[0];
    const observed = vi.spyOn(GovernorControlService.prototype, "evaluate");
    return { store, dependencies, observed, handoffPath, handoff };
  }

  it.each(["VALIDATION_FAILED", "PROVIDER_UNAVAILABLE"])("retains %s history after successful retry without reviving repair/retry", async (code) => {
    const { store, dependencies, observed } = await setup();
    store.tasks.transition("task", "failed", { errorCode: code, errorMessage: "old failure" });
    store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: code, errorMessage: "old failure" });
    store.tasks.retry("task");
    store.tasks.transition("task", "running");
    store.tasks.transition("task", "validating");
    store.tasks.transition("task", "validated", { resultCommit: "b".repeat(40) });
    store.tasks.updateAttempt("task", 2, { status: "succeeded", resultCommit: "b".repeat(40) });
    // Legacy evidence is a bounded unit input, not a native-certificate journey.
    store.events.append({ buildId: "build", type: "evidence.recorded", payload: { satisfied: ["focused-tests"] } });
    const result = await evaluateGovernedBuild(dependencies, "build");
    expect(result?.decision.action).toBe("CONTINUE");
    expect(observed.mock.calls.at(-1)?.[0].observation).toMatchObject({ failure: null, failureRepeatCount: 0, failureHistory: [expect.objectContaining({ code })] });
    expect(store.tasks.listAttempts("task")).toHaveLength(2);
    expect(store.tasks.getAttempt("task", 1).errorCode).toBe(code);
    expect(store.events.listForBuild("build").filter((event) => event.type === "governor.decision")).toHaveLength(1);
  });

  it.each(["running", "interrupted"] as const)("does not revive historical failure while the current retry is %s", async (state) => {
    const { store, dependencies, observed } = await setup();
    store.tasks.transition("task", "failed", { errorCode: "VALIDATION_FAILED" });
    store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: "VALIDATION_FAILED" });
    store.tasks.retry("task");
    store.tasks.transition("task", "running");
    store.tasks.updateAttempt("task", 2, { status: "running" });
    if (state === "interrupted") {
      store.tasks.transition("task", "interrupted", { errorCode: "WORKER_PROCESS_MISSING" });
      store.tasks.updateAttempt("task", 2, { status: "interrupted", errorCode: "WORKER_PROCESS_MISSING" });
    }
    expect((await evaluateGovernedBuild(dependencies, "build"))?.decision.action).toBe("CONTINUE");
    const observation = observed.mock.calls.at(-1)?.[0].observation;
    expect(observation?.failure).toBeNull();
    expect(observation?.failureHistory).toHaveLength(state === "interrupted" ? 2 : 1);
  });

  it.each(["VALIDATION_FAILED", "PROVIDER_UNAVAILABLE"])("preserves the existing guarded response to current failed attempt %s", async (code) => {
    const { store, dependencies, observed } = await setup();
    store.tasks.transition("task", "failed", { errorCode: code, errorMessage: "current failure" });
    store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: code, errorMessage: "current failure" });
    const result = await evaluateGovernedBuild(dependencies, "build");
    expect(result?.decision.action).toBe(code === "PROVIDER_UNAVAILABLE" ? "DELEGATE_RETRY" : "REQUEST_REPAIR");
    expect(observed.mock.calls.at(-1)?.[0].observation).toMatchObject({ failure: { code, signature: "current failure" }, failureRepeatCount: 1 });
  });

  it("requires both the current failed task and the matching failed attempt", async () => {
    const { store, dependencies } = await setup();
    store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: "VALIDATION_FAILED" });
    expect((await evaluateGovernedBuild(dependencies, "build"))?.decision.action).toBe("CONTINUE");
    store.tasks.transition("task", "failed", { errorCode: "VALIDATION_FAILED" });
    store.tasks.updateAttempt("task", 1, { status: "succeeded" });
    expect((await evaluateGovernedBuild(dependencies, "build"))?.decision.action).toBe("CONTINUE");
  });

  it("counts repeated current fingerprints without erasing previous attempts", async () => {
    const { store, dependencies, observed } = await setup();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      store.tasks.transition("task", "failed", { errorCode: "VALIDATION_FAILED", errorMessage: "same" });
      store.tasks.updateAttempt("task", attempt, { status: "failed", errorCode: "VALIDATION_FAILED", errorMessage: "same" });
      if (attempt < 3) { store.tasks.retry("task"); store.tasks.transition("task", "running"); }
    }
    expect((await evaluateGovernedBuild(dependencies, "build"))?.decision.action).toBe("PROPOSE_REPLAN");
    expect(observed.mock.calls.at(-1)?.[0].observation).toMatchObject({ failureRepeatCount: 3, failureHistory: [expect.anything(), expect.anything(), expect.anything()] });
    expect(store.tasks.listAttempts("task")).toHaveLength(3);
  });

  it("retains handoff binding tamper and missing-proof refusals", async () => {
    const { dependencies, handoff, handoffPath } = await setup();
    await writeFile(handoffPath, JSON.stringify({ ...handoff, objective: "tampered" }));
    await expect(evaluateGovernedBuild(dependencies, "build")).rejects.toThrow();
    await writeFile(handoffPath, "{}");
    await expect(evaluateGovernedBuild(dependencies, "build")).rejects.toThrow();
  });
});
