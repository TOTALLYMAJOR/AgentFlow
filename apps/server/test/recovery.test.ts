import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseRepositories } from "../src/db/index.js";
import { RecoveryService } from "../src/recovery/index.js";
import { HandoffManifestService } from "../src/artifacts/index.js";
import {
  createDatabaseFixture,
  type DatabaseFixture,
} from "./helpers/database-fixture.js";

describe("startup recovery", () => {
  let fixture: DatabaseFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("monitors live workers, interrupts missing workers, and resumes durable stages", async () => {
    fixture = createDatabaseFixture();
    const store = createStore(fixture);
    store.validations.create({
      id: "validation_integrate",
      buildId: "build_1",
      taskId: "task_integrate",
      validationType: "task",
      command: "npm test",
      status: "passed",
    });
    store.workers.create({
      id: "worker_live",
      buildId: "build_1",
      taskId: "task_live",
      processId: 111,
      status: "running",
    });
    store.manifests.create({
      id: "manifest_integrated_evidence",
      buildId: "build_1",
      taskId: "task_integrated_evidence",
      attempt: 1,
      status: "integrated",
      schemaVersion: "1.0.0",
      manifestPath: "runs/build_1/task_integrated_evidence/attempt-1/integrated.json",
      sha256: "integrated-evidence",
      manifest: { taskId: "task_integrated_evidence", attempt: 1 },
    });
    store.manifests.create({
      id: "manifest_integrated_stale",
      buildId: "build_1",
      taskId: "task_integrated_missing_manifest",
      attempt: 1,
      status: "integrated",
      schemaVersion: "1.0.0",
      manifestPath:
        "runs/build_1/task_integrated_missing_manifest/attempt-1/integrated.json",
      sha256: "stale-integrated-evidence",
      manifest: { taskId: "task_integrated_missing_manifest", attempt: 1 },
    });
    store.workers.create({
      id: "worker_missing",
      buildId: "build_1",
      taskId: "task_missing",
      processId: 222,
      status: "running",
    });
    const monitor = vi.fn();
    const resumeValidation = vi.fn();
    const queueIntegration = vi.fn();
    const recoveredIntegration = vi.fn();
    const recovery = new RecoveryService({
      store,
      resolveRepositoryPath: async () => fixture?.directory ?? "",
      isProcessAlive: (processId) => processId === 111,
      pathExists: async () => true,
      commitExists: async () => true,
      monitorExistingProcess: monitor,
      resumeValidation,
      queueIntegration,
      recoveredIntegration,
    });

    const decisions = await recovery.reconcileActiveBuilds();

    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "task_live",
          action: "monitor_existing_process",
        }),
        expect.objectContaining({
          taskId: "task_missing",
          action: "mark_interrupted",
        }),
        expect.objectContaining({
          taskId: "task_validate",
          action: "resume_validation",
        }),
        expect.objectContaining({
          taskId: "task_integrate",
          action: "queue_integration",
        }),
        expect.objectContaining({
          taskId: "task_integrated_evidence",
          action: "mark_integrated",
        }),
        expect.objectContaining({
          taskId: "task_integrated_missing_manifest",
          action: "recover_integrated_manifest",
        }),
      ]),
    );
    expect(monitor).toHaveBeenCalledOnce();
    expect(resumeValidation).toHaveBeenCalledOnce();
    expect(queueIntegration).toHaveBeenCalledOnce();
    expect(recoveredIntegration).toHaveBeenCalledOnce();
    expect(recoveredIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ id: "build_1" }),
      expect.objectContaining({
        id: "task_integrated_missing_manifest",
        attempt: 2,
      }),
    );
    expect(store.tasks.getById("task_missing").state).toBe("interrupted");
    expect(store.tasks.getById("task_validate").state).toBe("validating");
    expect(store.tasks.getById("task_integrate").state).toBe("validated");
    expect(store.tasks.getById("task_integrated_evidence").state).toBe(
      "integrated",
    );
    expect(store.workers.getById("worker_missing")).toMatchObject({
      status: "idle",
      taskId: null,
      processId: null,
    });
  });

  it("pauses the build and requests review when commit evidence is unsafe", async () => {
    fixture = createDatabaseFixture();
    const store = createStore(fixture);
    const recovery = new RecoveryService({
      store,
      resolveRepositoryPath: async () => fixture?.directory ?? "",
      isProcessAlive: () => false,
      pathExists: async () => true,
      commitExists: async (_workingDirectory, commit) => commit !== "unsafe",
    });
    store.tasks.transition("task_validate", "failed", {
      resultCommit: "unsafe",
    });
    store.tasks.retry("task_validate");
    store.tasks.transition("task_validate", "running", {
      resultCommit: "unsafe",
    });

    const decisions = await recovery.reconcileActiveBuilds();

    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "task_validate",
          action: "pause_for_review",
        }),
      ]),
    );
    expect(store.builds.getById("build_1").status).toBe("paused");
    expect(store.approvals.listPending("build_1", "task_validate")).toEqual([
      expect.objectContaining({ approvalType: "manual" }),
    ]);
  });

  async function durableStageFixture() {
    fixture = createDatabaseFixture();
    const directory = fixture.directory;
    const store = createDatabaseRepositories(fixture.database);
    store.repositories.create({ id: "repo", name: "recovery", localPath: fixture.directory, configPath: ".agentflow.yaml", baseBranch: "main" });
    store.builds.create({ id: "build", repositoryId: "repo", backlogPath: "BACKLOG.md", baseCommit: "base", integrationBranch: "integration", integrationWorktree: fixture.directory, status: "running", tasks: [{ id: "task", backlogTaskId: "AF-001", title: "task", description: "task", acceptanceCriteria: ["durable"], state: "running", attempt: 1, resultCommit: "result", baseCommit: "base", branchName: "task-branch", worktreePath: fixture.directory }] });
    store.tasks.createAttempt({ id: "attempt", taskId: "task", buildId: "build", attempt: 1, status: "succeeded", resultCommit: "result" });
    store.tasks.transition("task", "validating");
    store.tasks.transition("task", "validated", { resultCommit: "result" });
    store.validations.create({ id: "validation", buildId: "build", taskId: "task", validationType: "task", command: "npm test", status: "passed" });
    const manifests = new HandoffManifestService(store, path.join(fixture.directory, "artifacts"));
    const publication = { buildId: "build", taskId: "task", backlogTaskId: "AF-001", attempt: 1, baseCommit: "base", resultCommit: "result", branch: "task-branch", worktreePath: fixture.directory, changedFiles: [], consumes: [], produces: [] };
    await manifests.publish({ ...publication, status: "validated" });
    const queueIntegration = vi.fn();
    const recoveredIntegration = vi.fn(async () => { await manifests.publish({ ...publication, status: "integrated", integrationCommit: "integration-result" }); });
    const recovery = new RecoveryService({ store, resolveRepositoryPath: async () => directory, pathExists: async () => true, commitExists: async () => true, queueIntegration, recoveredIntegration });
    return { store, recovery, queueIntegration, recoveredIntegration, directory };
  }

  it("reconciles already validated records repeatedly without downgrading or losing durable proof", async () => {
    const { store, recovery, queueIntegration } = await durableStageFixture();
    const taskBefore = store.tasks.getById("task");
    const manifestBefore = store.manifests.findForTask("task", "validated", 1);
    await recovery.reconcileActiveBuilds();
    await recovery.reconcileActiveBuilds();
    expect(store.tasks.getById("task")).toEqual(taskBefore);
    expect(store.manifests.findForTask("task", "validated", 1)).toEqual(manifestBefore);
    expect(queueIntegration).toHaveBeenCalledTimes(2);
    expect(store.events.listForBuild("build").filter((event) => event.type === "recovery.validation_confirmed")).toHaveLength(0);
  });

  it("pauses unfinished integrating recovery for review without downgrade or silent deadlock", async () => {
    const { store, recovery, queueIntegration } = await durableStageFixture();
    store.tasks.transition("task", "integrating");
    const taskBefore = store.tasks.getById("task");
    const manifestBefore = store.manifests.findForTask("task", "validated", 1);
    for (let index = 0; index < 2; index += 1) {
      expect(await recovery.reconcileActiveBuilds()).toContainEqual(expect.objectContaining({ taskId: "task", action: "pause_for_review" }));
    }
    expect(store.builds.getById("build").status).toBe("paused");
    expect(store.approvals.listPending("build", "task")).toHaveLength(1);
    expect(store.tasks.getById("task")).toEqual(taskBefore);
    expect(store.manifests.findForTask("task", "validated", 1)).toEqual(manifestBefore);
    expect(queueIntegration).not.toHaveBeenCalled();
  });

  it("recovers verified recorded integration through existing native hooks once, retaining current manifests", async () => {
    const { store, recovery, queueIntegration, recoveredIntegration } = await durableStageFixture();
    store.tasks.transition("task", "integrating", { integrationCommit: "integration-result" });
    expect(await recovery.reconcileActiveBuilds()).toContainEqual(expect.objectContaining({ action: "recover_integrated_manifest" }));
    const integrated = store.tasks.getById("task");
    const manifest = store.manifests.findForTask("task", "integrated", 1);
    expect(integrated).toMatchObject({ state: "integrated", resultCommit: "result", integrationCommit: "integration-result" });
    expect(manifest).toBeDefined();
    await recovery.reconcileActiveBuilds();
    expect(store.tasks.getById("task")).toEqual(integrated);
    expect(store.manifests.findForTask("task", "integrated", 1)).toEqual(manifest);
    expect(queueIntegration).not.toHaveBeenCalled();
    expect(recoveredIntegration).toHaveBeenCalledOnce();
  });

  it("keeps missing result-commit proof fail-closed for an already validated task", async () => {
    const { store, queueIntegration, directory } = await durableStageFixture();
    const recovery = new RecoveryService({ store, resolveRepositoryPath: async () => directory, pathExists: async () => true, commitExists: async () => false, queueIntegration });
    expect(await recovery.reconcileActiveBuilds()).toContainEqual(expect.objectContaining({ action: "pause_for_review" }));
    expect(store.builds.getById("build").status).toBe("paused");
    expect(queueIntegration).not.toHaveBeenCalled();
    expect(store.tasks.getById("task").state).toBe("validated");
  });
});

function createStore(fixture: DatabaseFixture) {
  const store = createDatabaseRepositories(fixture.database);
  const repositoryPath = path.join(fixture.directory, "repository");
  store.repositories.create({
    id: "repository_1",
    name: "Repository",
    localPath: repositoryPath,
    configPath: path.join(repositoryPath, ".agentflow.yaml"),
    baseBranch: "main",
  });
  store.builds.create({
    id: "build_1",
    repositoryId: "repository_1",
    backlogPath: "BACKLOG.md",
    baseCommit: "base",
    integrationBranch: "agent-integration/build_1",
    integrationWorktree: path.join(fixture.directory, "integration"),
    status: "running",
    tasks: [
      task("task_live"),
      task("task_missing"),
      task("task_validate", { resultCommit: "result-validate" }),
      task("task_integrate", { resultCommit: "result-integrate" }),
      task("task_integrated_evidence", {
        resultCommit: "result-integrated",
        integrationCommit: "integration",
        attempt: 1,
      }),
      task("task_integrated_missing_manifest", {
        resultCommit: "result-integrated-current-attempt",
        integrationCommit: "integration-current-attempt",
        state: "integrated",
        attempt: 2,
      }),
    ],
  });
  return store;
}

function task(
  id: string,
  commits: {
    resultCommit?: string;
    integrationCommit?: string;
    state?: "running" | "integrated";
    attempt?: number;
  } = {},
) {
  return {
    id,
    backlogTaskId: id,
    title: id,
    description: id,
    acceptanceCriteria: ["recovered"],
    state: commits.state ?? ("running" as const),
    ...(commits.attempt === undefined ? {} : { attempt: commits.attempt }),
    ...(commits.resultCommit === undefined
      ? {}
      : { resultCommit: commits.resultCommit }),
    ...(commits.integrationCommit === undefined
      ? {}
      : { integrationCommit: commits.integrationCommit }),
  };
}
