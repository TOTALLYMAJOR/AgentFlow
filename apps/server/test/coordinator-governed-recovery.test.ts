import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
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

// These tests keep the real coordinator, Governor, SQLite, recovery and manifests.
// Git merge/runtime and worker ports are explicit fakes; this is not provider proof.
describe("actual coordinator recovered integration governance", () => {
  let fixture: DatabaseFixture | undefined;
  let coordinator: BuildCoordinator | undefined;
  afterEach(async () => { await coordinator?.shutdown(); vi.restoreAllMocks(); fixture?.cleanup(); fixture = undefined; coordinator = undefined; });

  async function setup(allow: boolean, integrationBarrier?: Promise<void>) {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    const root = path.join(fixture.directory, "repository");
    const integrationPath = path.join(fixture.directory, "integration");
    await mkdir(root); await mkdir(integrationPath);
    const environment = resolveEnvironment({ AGENTFLOW_HOME: path.join(fixture.directory, "runtime") });
    const handoff = approvedGovernedHandoff({
      handoffId: "coordinator-recovery-unit", baseCommit: "a".repeat(40), objective: "Unit-only recovered integration.",
      requiredEvidence: ["focused-tests"], claimBoundary: "Unit test only; fake Git and worker ports.",
      tasks: [{ id: "AF-001", title: "Task", description: "Task", estimateHours: 1, dependsOn: [], owns: ["src"], acceptanceCriteria: ["Passes"], validate: ["npm test"], produces: [], consumes: [] }],
    });
    await writeFile(path.join(root, "handoff.json"), JSON.stringify(handoff));
    const plan = planBacklogMarkdown(renderBacklog(handoff, "handoff.json", "BACKLOG.md")).plan;
    if (plan === undefined) throw new Error("Expected unit fixture native plan");
    store.repositories.create({ id: "repo", name: "test", localPath: root, configPath: ".agentflow.yaml", baseBranch: "main" });
    store.builds.create({
      id: "build", repositoryId: "repo", backlogPath: "BACKLOG.md", baseCommit: handoff.repository.baseCommit,
      integrationBranch: "integration", integrationWorktree: integrationPath, status: "running",
      repositoryConfig: { version: 1, repository: { name: "test", base_branch: "main" }, backlog: { path: "BACKLOG.md" }, workers: { maximum: 1 }, contracts: { roots: [] }, validation: { task_default: ["npm test"], integration: ["npm test"] }, docker: { enabled: false, compose_file: "compose.yaml" }, git: { remote: "origin", push_task_branches: false, push_integration_branch: false } },
      normalizedPlan: { ...plan, createdAt: new Date().toISOString(), governedHandoff: { id: handoff.handoffId, sha256: canonicalJsonSha256(handoff), path: "handoff.json", governedBaseCommit: handoff.repository.baseCommit, carrierPaths: ["handoff.json", "BACKLOG.md"], proofBoundary: handoff.proof.claimBoundary } },
      tasks: [{ id: "task", backlogTaskId: "AF-001", title: "Task", description: "Task", acceptanceCriteria: ["Passes"], state: "running", attempt: 1, baseCommit: handoff.repository.baseCommit, branchName: "task-branch", worktreePath: root }],
    });
    store.tasks.createAttempt({ id: "attempt", taskId: "task", buildId: "build", attempt: 1, status: "running" });
    store.tasks.transition("task", "validating");
    store.tasks.transition("task", "validated", { resultCommit: "b".repeat(40) });
    store.tasks.updateAttempt("task", 1, { status: "succeeded", resultCommit: "b".repeat(40) });
    store.validations.create({ id: "validation", buildId: "build", taskId: "task", validationType: "task", command: "npm test", status: "passed" });
    const manifests = new HandoffManifestService(store, environment.artifactsPath);
    await manifests.publish({ buildId: "build", taskId: "task", backlogTaskId: "AF-001", attempt: 1, status: "validated", baseCommit: handoff.repository.baseCommit, resultCommit: "b".repeat(40), branch: "task-branch", worktreePath: root, changedFiles: [], consumes: [], produces: [] });
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
    const activeCoordinator = new BuildCoordinator({ store, environment, handoffService: manifests, organizationPolicy: DEFAULT_ORGANIZATION_POLICY, repositoryService: { get: async () => store.repositories.getById("repo") }, agentProviders: { get: getProvider } } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
    coordinator = activeCoordinator;
    const recovery = new RecoveryService({ store, resolveRepositoryPath: async () => root, pathExists: async () => true, commitExists: async () => true, queueIntegration: (build, task) => activeCoordinator.queueIntegration(build, task), recoveredIntegration: (build, task) => activeCoordinator.recoverIntegratedManifest(build, task) });
    const snapshots = { build: store.builds.getById("build"), task: store.tasks.getById("task") };
    return { store, integrate, getProvider, recovery, snapshots, activeCoordinator };
  }

  async function drain() {
    const operations = coordinator as unknown as { taskOperations: Map<string, Promise<void>>; tickOperations: Map<string, Promise<void>> };
    await Promise.all([...operations.taskOperations.values()]);
    await Promise.all([...operations.tickOperations.values()]);
  }

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
