import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseRepositories } from "../src/db/index.js";
import { resolveEnvironment } from "../src/config/environment.js";
import { DEFAULT_ORGANIZATION_POLICY } from "../src/governance/organization-policy.js";
import { HandoffManifestService } from "../src/artifacts/index.js";
import { GitWorktreeManager } from "../src/git/index.js";
import { IntegrationManager } from "../src/integration/index.js";
import { BuildCoordinator } from "../src/orchestration/coordinator.js";
import { RecoveryService } from "../src/recovery/index.js";
import { canonicalJsonSha256, renderBacklog } from "../src/integration/design-intelligence.js";
import { planBacklogMarkdown } from "../src/planning/planner.js";
import { createDatabaseFixture, type DatabaseFixture } from "./helpers/database-fixture.js";
import { approvedGovernedHandoff } from "./helpers/governed-handoff.js";
import { evaluateGovernedBuild } from "../src/governor/build-control.js";
import { GovernorControlService } from "../src/governor/control-service.js";

// These tests keep the real coordinator, Governor, SQLite, recovery and manifests.
// Git merge/runtime and worker ports are explicit fakes; this is not provider proof.
describe("actual coordinator recovered integration governance", () => {
  let fixture: DatabaseFixture | undefined;
  let coordinator: BuildCoordinator | undefined;
  afterEach(async () => { await coordinator?.shutdown(); vi.restoreAllMocks(); fixture?.cleanup(); fixture = undefined; coordinator = undefined; });

  async function setup(allow: boolean, integrationBarrier?: Promise<void>, ownership?: "valid" | "cross-task") {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    const root = path.join(fixture.directory, "repository");
    const integrationPath = path.join(fixture.directory, "integration");
    await mkdir(root); await mkdir(integrationPath);
    const environment = resolveEnvironment({ AGENTFLOW_HOME: path.join(fixture.directory, "runtime") });
    const handoff = approvedGovernedHandoff({
      handoffId: "coordinator-recovery-unit", baseCommit: "a".repeat(40), objective: "Unit-only recovered integration.",
      requiredEvidence: ["focused-tests"], claimBoundary: "Unit test only; fake Git and worker ports.",
      tasks: (ownership === undefined ? ["AF-001"] : ["AF-001", "AF-002"]).map((id, index) => ({ id, title: "Task", description: "Task", estimateHours: 1, dependsOn: [], owns: [ownership === undefined ? "src" : index === 0 ? "src/a" : "src/b"], acceptanceCriteria: ["Passes"], validate: ["npm test"], produces: [], consumes: [] })),
    });
    await writeFile(path.join(root, "handoff.json"), JSON.stringify(handoff));
    const backlogContents = renderBacklog(handoff, "handoff.json", "BACKLOG.md");
    const plan = planBacklogMarkdown(backlogContents).plan;
    if (plan === undefined) throw new Error("Expected unit fixture native plan");
    store.repositories.create({ id: "repo", name: "test", localPath: root, configPath: ".agentflow.yaml", baseBranch: "main" });
    // Persist and lock the native plan through BuildRepository rather than
    // constructing a planless governed snapshot; retain the fake Git boundary.
    const backlogSha256 = createHash("sha256").update(backlogContents).digest("hex");
    const repositoryConfig = { version: 1, repository: { name: "test", base_branch: "main" }, backlog: { path: "BACKLOG.md" }, workers: { maximum: 1 }, contracts: { roots: [] }, validation: { task_default: ["npm test"], integration: ["npm test"] }, docker: { enabled: false, compose_file: "compose.yaml" }, git: { remote: "origin", push_task_branches: false, push_integration_branch: false } };
    const normalizedPlan = { ...plan, id: "plan", repositoryId: "repo", backlogPath: "BACKLOG.md", backlogSha256, createdAt: new Date().toISOString(), governedHandoff: { id: handoff.handoffId, sha256: canonicalJsonSha256(handoff), path: "handoff.json", governedBaseCommit: handoff.repository.baseCommit, carrierPaths: ["handoff.json", "BACKLOG.md"], proofBoundary: handoff.proof.claimBoundary } };
    store.plans.create({ id: "plan", repositoryId: "repo", backlogPath: "BACKLOG.md", backlogSha256, backlogContents, repositoryConfig, normalizedPlan });
    store.builds.create({
      id: "build", planId: "plan", repositoryId: "repo", backlogPath: "BACKLOG.md", baseCommit: handoff.repository.baseCommit,
      integrationBranch: "integration", integrationWorktree: integrationPath, status: "running",
      tasks: handoff.tasks.map((task, index) => ({ id: index === 0 ? "task" : "task-b", backlogTaskId: task.id, title: "Task", description: "Task", acceptanceCriteria: ["Passes"], state: "running", attempt: 1, baseCommit: handoff.repository.baseCommit, branchName: index === 0 ? "task-branch" : "task-b-branch", worktreePath: root })),
    });
    store.tasks.createAttempt({ id: "attempt", taskId: "task", buildId: "build", attempt: 1, status: "running" });
    const manifests = new HandoffManifestService(store, environment.artifactsPath);
    const validateFirstTask = async () => {
      store.tasks.transition("task", "validating");
      store.tasks.transition("task", "validated", { resultCommit: "b".repeat(40) });
      store.tasks.updateAttempt("task", 1, { status: "succeeded", resultCommit: "b".repeat(40) });
      // Native rows are manual fixture inputs; no validation process or Git
      // commit is claimed by these coordinator-boundary tests.
      store.validations.create({ id: "validation", buildId: "build", taskId: "task", validationType: "task", command: "npm test", status: "passed" });
      await manifests.publish({ buildId: "build", taskId: "task", backlogTaskId: "AF-001", attempt: 1, status: "validated", baseCommit: handoff.repository.baseCommit, resultCommit: "b".repeat(40), branch: "task-branch", worktreePath: root, changedFiles: store.tasks.listChangedFiles("task", 1).map((file) => file.path), consumes: [], produces: [] });
    };
    if (ownership === undefined) await validateFirstTask();
    else {
      store.tasks.createAttempt({ id: "attempt-b", taskId: "task-b", buildId: "build", attempt: 1, status: "running" });
      store.tasks.recordChangedFiles("task", 1, [{ path: ownership === "valid" ? "src/a/index.ts" : "src/b/from-a.ts", changeType: "modified", withinOwnership: ownership === "valid" }]);
      store.tasks.recordChangedFiles("task-b", 1, [{ path: "src/b/index.ts", changeType: "modified", withinOwnership: true }]);
    }
    if (allow) store.events.append({ buildId: "build", type: "evidence.recorded", payload: { satisfied: ["focused-tests"] } });
    const fakeGit = { integrationPath: () => integrationPath, reconcileBuild: vi.fn(async () => ({ requiresHumanReview: false, integration: { safeToReuse: true, path: integrationPath } })) } as unknown as GitWorktreeManager;
    vi.spyOn(GitWorktreeManager, "create").mockResolvedValue(fakeGit);
    const integrate = vi.spyOn(IntegrationManager.prototype, "integrate").mockImplementation(async () => {
      store.tasks.transition("task", "integrating", { eventType: "unit.fake_git_integration_started" });
      await integrationBarrier;
      store.recordIntegrationSuccess("task", { integrationCommit: "c".repeat(40) });
      return { buildId: "build", taskId: "task", status: "integrated", previousHead: "a".repeat(40), integrationCommit: "c".repeat(40), mergePerformed: true, conflictPaths: [], validation: null, releasedTaskIds: [], pushes: { task: { branch: "task-branch", attempted: false, succeeded: false, error: null }, integration: { branch: "integration", attempted: false, succeeded: false, error: null } }, errorCode: null, errorMessage: null };
    });
    const getProvider = vi.fn(() => { throw new Error("Unit test must never dispatch a worker"); });
    const dependencies = { store, environment, organizationPolicy: DEFAULT_ORGANIZATION_POLICY, repositoryService: { get: async () => store.repositories.getById("repo") } } as unknown as Parameters<typeof evaluateGovernedBuild>[0];
    const activeCoordinator = new BuildCoordinator({ ...dependencies, handoffService: manifests, agentProviders: { get: getProvider } } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
    coordinator = activeCoordinator;
    const recovery = new RecoveryService({ store, resolveRepositoryPath: async () => root, pathExists: async () => true, commitExists: async () => true, queueIntegration: (build, task) => activeCoordinator.queueIntegration(build, task), recoveredIntegration: (build, task) => activeCoordinator.recoverIntegratedManifest(build, task) });
    const snapshots = { build: store.builds.getById("build"), task: store.tasks.getById("task") };
    return { store, integrate, getProvider, recovery, snapshots, activeCoordinator, dependencies, handoff, validateFirstTask };
  }

  async function drain() {
    const operations = coordinator as unknown as { taskOperations: Map<string, Promise<void>>; tickOperations: Map<string, Promise<void>> };
    await Promise.all([...operations.taskOperations.values()]);
    await Promise.all([...operations.tickOperations.values()]);
  }

  function nativeOwnershipRecords(store: ReturnType<typeof createDatabaseRepositories>) {
    return {
      plan: store.plans.getById("plan"), build: store.builds.getById("build"),
      tasks: store.tasks.listForBuild("build").map((task) => ({ task, attempts: store.tasks.listAttempts(task.id).map((attempt) => ({ attempt, changedFiles: store.tasks.listChangedFiles(task.id, attempt.attempt) })) })),
      validations: store.validations.listForBuild("build"), manifests: store.manifests.listForBuild("build"),
      artifacts: store.artifacts.listForBuild("build"), events: store.events.listForBuild("build"),
    };
  }

  async function retainNativeOwnershipCase(name: string, evidence: unknown) {
    const output = process.env.AFI002_OWNERSHIP_OUTPUT_ROOT;
    if (output === undefined) return;
    await mkdir(output, { recursive: true });
    const directory = await mkdtemp(path.join(output, name + "-"));
    const sourceBindings = await Promise.all(["apps/server/test/coordinator-governed-recovery.test.ts", "apps/server/src/governor/build-control.ts", "apps/server/src/governor/control-service.ts", "apps/server/src/governor/runtime-adapter.ts", "apps/server/src/integration/traffic-control.ts", "apps/server/src/orchestration/coordinator.ts"].map(async (filePath) => ({ filePath, sha256: createHash("sha256").update(await readFile(path.resolve(filePath))).digest("hex") })));
    await writeFile(path.join(directory, "case.actual.json"), JSON.stringify({
      classification: "ACTUAL_NATIVE_SQLITE_LEGACY_TWO_TASK_COORDINATOR_UNIT_QA",
      limitations: ["Manual native plan/task/attempt/validation/changed-file fixture records; inert Git and worker ports", "No actual two-worker/Git build, validation execution, native certificate, provider, authorized retry or acceptance proof"],
      sourceBindings, evidence,
    }, null, 2), { flag: "wx", mode: 0o600 });
  }

  it("joins two native legacy task sources without converting missing proof into satisfaction", async () => {
    const { store, dependencies, integrate, getProvider } = await setup(false, undefined, "valid");
    const before = nativeOwnershipRecords(store);
    const observed = vi.spyOn(GovernorControlService.prototype, "evaluate"); // Call-through observation only.
    const result = await evaluateGovernedBuild(dependencies, "build");
    const input = observed.mock.calls.at(-1)?.[0];
    if (result === undefined || input === undefined) throw new Error("Missing actual native evaluation");
    expect(before.plan.lockedAt).not.toBeNull();
    expect(before.build.planId).toBe(before.plan.id);
    expect(before.build.repositoryId).toBe(before.plan.repositoryId);
    expect(before.plan.normalizedPlan).toEqual(before.build.normalizedPlan);
    expect(before.tasks.map(({ task }) => [task.id, task.backlogTaskId])).toEqual([["task", "AF-001"], ["task-b", "AF-002"]]);
    expect(input.observation).toMatchObject({ phase: "RUNNING", changedPaths: ["src/a/index.ts", "src/b/index.ts"], evidence: { items: [], satisfied: [], contradictory: [] }, impactDelta: { unexpectedChangedPaths: [], activeTaskCollisions: [], expanded: false } });
    expect(input.nativeSources).toMatchObject({ tasks: before.tasks.map(({ task, attempts }) => ({ id: task.id, buildId: task.buildId, backlogTaskId: task.backlogTaskId, sha256: canonicalJsonSha256(task), attempts: attempts.map(({ attempt, changedFiles }) => ({ id: attempt.id, buildId: attempt.buildId, taskId: attempt.taskId, sha256: canonicalJsonSha256(attempt), changedFilesSha256: canonicalJsonSha256(changedFiles) })) })) });
    expect(result.decision).toMatchObject({ action: "CONTINUE", ruleId: "entitled-to-continue" });
    expect(nativeOwnershipRecords(store).tasks).toEqual(before.tasks);
    expect(integrate).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
    await retainNativeOwnershipCase("valid-attribution", { before, after: nativeOwnershipRecords(store), observation: input.observation, nativeSources: input.nativeSources, decision: result.decision, calls: { integration: integrate.mock.calls.length, provider: getProvider.mock.calls.length } });
  });

  it("blocks a native task's change inside another task's owned root and leaves replay inert", async () => {
    const { store, activeCoordinator, validateFirstTask, integrate, getProvider, handoff } = await setup(false, undefined, "cross-task");
    await validateFirstTask();
    const before = nativeOwnershipRecords(store);
    expect(handoff.tasks.map(({ id, owns }) => ({ id, owns }))).toEqual([{ id: "AF-001", owns: ["src/a"] }, { id: "AF-002", owns: ["src/b"] }]);
    const build = store.builds.getById("build");
    const task = store.tasks.getById("task");
    await activeCoordinator.queueIntegration(build, task);
    await drain();
    const after = nativeOwnershipRecords(store);
    const decision = after.events.find((event) => event.type === "governor.decision");
    const pause = after.events.find((event) => event.type === "build.paused");
    const acknowledgements = after.events.filter((event) => event.type === "governor.intervention_acknowledged");
    expect(decision?.payload.decision).toMatchObject({ action: "BLOCK_INTEGRATION", ruleId: "ownership-violation", signals: { unauthorizedPaths: ["src/b/from-a.ts"] } });
    expect(after.build.status).toBe("paused");
    expect(after.tasks).toEqual(before.tasks);
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]?.payload).toMatchObject({ decisionRecordHash: decision?.payload.recordHash, action: "BLOCK_INTEGRATION", acknowledged: true, details: { runtimeApplyInvoked: true, observedBuildStatusBefore: "running", observedBuildStatusAfter: "paused" } });
    expect(decision?.sequence).toBeLessThan(pause?.sequence ?? 0);
    expect(pause?.sequence).toBeLessThan(acknowledgements[0]?.sequence ?? 0);
    expect(after.events.some((event) => event.type === "evidence.recorded")).toBe(false);
    expect(integrate).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
    await activeCoordinator.queueIntegration(build, task); // Deliberately stale running snapshots.
    await drain();
    const replayed = nativeOwnershipRecords(store);
    expect(replayed).toEqual(after);
    await retainNativeOwnershipCase("cross-task-block", { before, after, replayed, calls: { integration: integrate.mock.calls.length, provider: getProvider.mock.calls.length }, replayMutationCount: replayed.events.length - after.events.length });
  });

  it("persists an actual refusal and acknowledged native pause before integration, then ignores replay", async () => {
    const { store, integrate, getProvider, recovery, snapshots, activeCoordinator } = await setup(false);
    await activeCoordinator.queueIntegration(snapshots.build, snapshots.task);
    await drain();
    expect(integrate).not.toHaveBeenCalled();
    expect(store.builds.getById("build").status).toBe("paused");
    const decision = store.events.listForBuild("build").find((event) => event.type === "governor.decision");
    const decisionHash: unknown = decision?.payload.recordHash;
    expect(decision?.payload.decision).toMatchObject({ action: "BLOCK_INTEGRATION" });
    const acknowledgements = () => store.events.listForBuild("build").filter((event) => event.type === "governor.intervention_acknowledged");
    expect(acknowledgements()).toHaveLength(1);
    expect(acknowledgements()[0]?.payload).toMatchObject({ acknowledged: true, decisionRecordHash: decisionHash });
    await activeCoordinator.queueIntegration(snapshots.build, snapshots.task);
    await recovery.reconcileActiveBuilds();
    await drain();
    expect(acknowledgements()).toHaveLength(1);
    expect(integrate).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
    expect(store.tasks.getById("task").state).toBe("validated");
  });

  it("allows recovered integration once with native manifests and no duplicate acknowledgement on replay", async () => {
    const { store, integrate, getProvider, recovery, snapshots, activeCoordinator } = await setup(true);
    await Promise.all([recovery.reconcileActiveBuilds(), activeCoordinator.queueIntegration(snapshots.build, snapshots.task)]);
    await drain();
    expect(integrate).toHaveBeenCalledOnce();
    expect(store.tasks.getById("task").state).toBe("integrated");
    const manifest = store.manifests.findForTask("task", "integrated", 1);
    expect(manifest).toBeDefined();
    const acknowledgements = () => store.events.listForBuild("build").filter((event) => event.type === "governor.intervention_acknowledged");
    expect(acknowledgements()).toHaveLength(1);
    await activeCoordinator.queueIntegration(snapshots.build, snapshots.task);
    await recovery.reconcileActiveBuilds();
    await drain();
    expect(integrate).toHaveBeenCalledOnce();
    expect(acknowledgements()).toHaveLength(1);
    expect(store.manifests.findForTask("task", "integrated", 1)).toEqual(manifest);
    expect(getProvider).not.toHaveBeenCalled();
  });

  it("uses current paused build records instead of stale running snapshots", async () => {
    const { store, integrate, snapshots, activeCoordinator } = await setup(true);
    store.builds.transition("build", "paused");
    await activeCoordinator.queueIntegration(snapshots.build, snapshots.task); await drain();
    expect(integrate).not.toHaveBeenCalled();
    expect(store.events.listForBuild("build").filter((event) => event.type === "governor.intervention_acknowledged")).toHaveLength(0);
  });

  it("deduplicates queued recovery while the native task is integrating in flight", async () => {
    let releaseIntegration = () => {};
    const barrier = new Promise<void>((resolve) => { releaseIntegration = resolve; });
    const { store, integrate, getProvider, snapshots, activeCoordinator } = await setup(true, barrier);
    try {
      await activeCoordinator.queueIntegration(snapshots.build, snapshots.task);
      await vi.waitFor(() => expect(store.tasks.getById("task").state).toBe("integrating"));
      await activeCoordinator.queueIntegration(snapshots.build, snapshots.task);
      expect(integrate).toHaveBeenCalledOnce();
      expect(store.events.listForBuild("build").filter((event) => event.type === "governor.intervention_acknowledged")).toHaveLength(1);
      expect(getProvider).not.toHaveBeenCalled();
    } finally { releaseIntegration(); await drain(); }
  });
});
