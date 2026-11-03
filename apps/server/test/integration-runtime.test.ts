import { BuildCoordinator } from "../src/orchestration/coordinator.js";
import * as governedAuthority from "../src/integration/design-intelligence.js";
import type { GovernedTaskHandoff } from "../src/integration/design-intelligence.js";
import type { WaleRunLabExperiment } from "../src/integration/wale-run-lab.js";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDatabaseRepositories,
  openDatabase,
  type BuildEntity,
  type DatabaseRepositories,
} from "../src/db/index.js";
import { GitWorktreeManager } from "../src/git/index.js";
import {
  IntegrationManager,
  type IntegrationValidationRequest,
  type IntegrationValidationRunner,
  type IntegrationValidationSummary,
} from "../src/integration/index.js";

const execFileAsync = promisify(execFile);
const fixtures = new Set<IntegrationFixture>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...fixtures].map(async (fixture) => {
      if (fixture.store.database.open) {
        fixture.store.database.close();
      }
      await rm(fixture.root, { recursive: true, force: true });
      fixtures.delete(fixture);
    }),
  );
});

describe("Run Lab authority overlay compatibility", () => {
  it("preserves unbound native governed legacy builds without new snapshot or handoff requirements", async () => {
    const fixture = await createFixture("unbound-legacy", []);
    const getPlan = vi.fn(() => ({ normalizedPlan: { governedHandoff: { id: "legacy", path: "moved-away.json", carrierPaths: [], sha256: "a".repeat(64) } } }));
    const getRepository = vi.fn(() => { throw new Error("must not recheck unbound native authority"); });
    const coordinator = { store: { events: fixture.store.events, plans: { getById: getPlan } }, repositoryService: { get: getRepository } } as unknown as BuildCoordinator;
    const build = { ...fixture.store.builds.getById(fixture.buildId), planId: "legacy-plan" };
    await expect(BuildCoordinator.prototype.validateExecutionAuthority.call(coordinator, build)).resolves.toBeUndefined();
    expect(getPlan).not.toHaveBeenCalled();
    expect(getRepository).not.toHaveBeenCalled();
  });

  it("still refuses a bound experiment with no governed plan", async () => {
    const fixture = await createFixture("bound-ungoverned", []);
    fixture.store.events.appendExperimentBinding(fixture.buildId, boundExperiment());
    const coordinator = { store: fixture.store } as unknown as BuildCoordinator;
    await expect(BuildCoordinator.prototype.validateExecutionAuthority.call(coordinator, fixture.store.builds.getById(fixture.buildId))).rejects.toMatchObject({ code: "WALE_EXPERIMENT_REQUIRES_GOVERNED_PLAN" });
  });

  it("requires the exact execution snapshot for a bound legacy experiment after current handoff recheck", async () => {
    const fixture = await createFixture("bound-legacy", []);
    fixture.store.events.appendExperimentBinding(fixture.buildId, boundExperiment());
    await writeFile(path.join(fixture.repository, "retained-handoff.json"), "fixture carrier");
    const handoff = { handoffId: "legacy" } as unknown as GovernedTaskHandoff;
    vi.spyOn(governedAuthority, "loadGovernedTaskHandoff").mockResolvedValue(handoff);
    const verify = vi.spyOn(governedAuthority, "verifyGovernedHandoffForExecution").mockResolvedValue({ errors: [], currentHead: "a".repeat(40) });
    const getPlan = vi.fn(() => ({ normalizedPlan: { governedHandoff: { id: "legacy", path: "retained-handoff.json", carrierPaths: [], sha256: governedAuthority.canonicalJsonSha256(handoff) } } }));
    const coordinator = { store: { events: fixture.store.events, plans: { getById: getPlan } }, repositoryService: { get: async () => ({ localPath: fixture.repository }) } } as unknown as BuildCoordinator;
    const build = { ...fixture.store.builds.getById(fixture.buildId), planId: "legacy-plan" };
    await expect(BuildCoordinator.prototype.validateExecutionAuthority.call(coordinator, build)).rejects.toMatchObject({ code: "GOVERNED_EXECUTION_SNAPSHOT_STALE" });
    expect(verify).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "missing execution marker", execution: undefined, snapshot: "captured", digest: "current", contents: "" },
    { name: "null execution marker", execution: null, snapshot: "captured", digest: "current", contents: "" },
    { name: "malformed execution marker", execution: "not-a-commit", snapshot: "captured", digest: "current", contents: "" },
    { name: "retained digest with an emptied plan snapshot", execution: undefined, snapshot: "empty", digest: "current", contents: "" },
    { name: "retained plan snapshot without a backlog digest", execution: undefined, snapshot: "captured", digest: "null", contents: "" },
    { name: "retained backlog contents with other snapshot markers lost", execution: undefined, snapshot: "empty", digest: "null", contents: "# Retained current backlog\n" },
    { name: "an array instead of the legacy plan object", execution: undefined, snapshot: "array", digest: "null", contents: "" },
    { name: "null instead of the legacy plan object", execution: undefined, snapshot: "null", digest: "null", contents: "" },
    { name: "a missing digest instead of the exact legacy null", execution: undefined, snapshot: "empty", digest: "missing", contents: "" },
  ])("does not reinterpret $name as an unsnapshotted legacy build", async ({ execution, snapshot, digest, contents }) => {
    const fixture = await createFixture("current-binding-refusal", []);
    await writeFile(path.join(fixture.repository, "retained-handoff.json"), "fixture carrier");
    const handoff = { handoffId: "current" } as unknown as GovernedTaskHandoff;
    vi.spyOn(governedAuthority, "loadGovernedTaskHandoff").mockResolvedValue(handoff);
    const verify = vi.spyOn(governedAuthority, "verifyGovernedHandoffForExecution").mockResolvedValue({ errors: [], currentHead: "a".repeat(40) });
    const binding = { id: "current", path: "retained-handoff.json", carrierPaths: [], sha256: governedAuthority.canonicalJsonSha256(handoff), ...(execution === undefined ? {} : { executionBaseCommit: execution }) };
    const getPlan = vi.fn(() => ({ normalizedPlan: { governedHandoff: binding } }));
    const coordinator = { store: { events: fixture.store.events, plans: { getById: getPlan } }, repositoryService: { get: async () => ({ localPath: fixture.repository }) } } as unknown as BuildCoordinator;
    const normalizedPlan = snapshot === "captured" ? { governedHandoff: binding } : snapshot === "array" ? [] : snapshot === "null" ? null : {};
    const build = {
      ...fixture.store.builds.getById(fixture.buildId),
      planId: "current-plan",
      backlogSha256: digest === "current" ? "b".repeat(64) : digest === "null" ? null : undefined,
      backlogContents: contents,
      normalizedPlan,
    } as unknown as BuildEntity;

    await expect(BuildCoordinator.prototype.validateExecutionAuthority.call(coordinator, build)).rejects.toMatchObject({ code: "GOVERNED_EXECUTION_SNAPSHOT_STALE", statusCode: 409 });
    expect(getPlan).toHaveBeenCalledExactlyOnceWith("current-plan");
    expect(verify).toHaveBeenCalledOnce();
  });

  it.each(["current-plan", null])("refuses a missing immutable-plan binding when the build retains current governed authority (%s)", async (planId) => {
    const fixture = await createFixture("missing-current-plan-binding", []);
    const getPlan = vi.fn(() => ({ normalizedPlan: {} }));
    const getRepository = vi.fn(() => { throw new Error("missing immutable binding must refuse before source inspection"); });
    const coordinator = { store: { events: fixture.store.events, plans: { getById: getPlan } }, repositoryService: { get: getRepository } } as unknown as BuildCoordinator;
    const build = {
      ...fixture.store.builds.getById(fixture.buildId),
      planId,
      backlogSha256: "b".repeat(64),
      backlogContents: "# Captured governed backlog\n",
      normalizedPlan: { governedHandoff: { id: "current", executionBaseCommit: "a".repeat(40) } },
    };

    await expect(BuildCoordinator.prototype.validateExecutionAuthority.call(coordinator, build)).rejects.toMatchObject({ code: "GOVERNED_HANDOFF_DRIFT", statusCode: 409 });
    if (planId === null) expect(getPlan).not.toHaveBeenCalled();
    else expect(getPlan).toHaveBeenCalledExactlyOnceWith(planId);
    expect(getRepository).not.toHaveBeenCalled();
  });
});

describe("IntegrationManager", () => {

  it("enforces cumulative churn under the mutex before acceptance and rolls back overflow", async () => {
    const fixture = await createFixture("delivery-cumulative", [
      { id: "A", files: { "a.txt": "one\ntwo\n" } },
      { id: "B", files: { "b.txt": "three\n" } },
    ]);
    const experiment = boundExperiment();
    experiment.parameters.deliverySize = 2;
    fixture.store.events.appendExperimentBinding(fixture.buildId, experiment);
    const manager = createIntegrationManager(fixture, passingRunner());
    const [first, second] = await Promise.all([manager.integrate({ taskId: "A" }), manager.integrate({ taskId: "B" })]);
    expect(first.status).toBe("integrated");
    expect(second).toMatchObject({ status: "delivery_size_exceeded", errorCode: "WALE_DELIVERY_SIZE_EXCEEDED" });
    expect(await gitOutput(fixture.integrationPath, ["rev-parse", "HEAD"])).toBe(first.integrationCommit);
    expect(fixture.store.tasks.getById("B").state).toBe("failed");
    const measurement = fixture.store.events.listForBuild(fixture.buildId).find((event) => event.type === "wale.delivery_size_evaluated" && event.taskId === "B");
    expect(measurement?.payload).toMatchObject({ priorTextChurn: 2, incrementalTextChurn: 1, cumulativeTextChurn: 3, accepted: false, eligibleSourceLoc: null, metric: "CUMULATIVE_ALL_TEXT_CHURN_PROXY" });
  });

  it("does not hide earlier churn when a later delivery removes the earlier text", async () => {
    const fixture = await createFixture("delivery-removal", [{ id: "A", files: { "a.txt": "one\ntwo\n" } }]);
    const experiment = boundExperiment();
    experiment.parameters.deliverySize = 3;
    fixture.store.events.appendExperimentBinding(fixture.buildId, experiment);
    const manager = createIntegrationManager(fixture, passingRunner());
    const first = await manager.integrate({ taskId: "A" });
    expect(first.status).toBe("integrated");
    if (first.integrationCommit === null) throw new Error("Expected integration commit");
    const worktree = await fixture.worktrees.createTaskWorktree({ taskId: "B", integrationCommit: first.integrationCommit });
    await git(worktree.path, ["rm", "a.txt"]);
    await git(worktree.path, ["commit", "-m", "fixture removal"]);
    fixture.store.tasks.create({ id: "B", buildId: fixture.buildId, title: "Remove prior text", description: "Fixture", acceptanceCriteria: ["Removed"], state: "validated", branchName: worktree.branchName, worktreePath: worktree.path, baseCommit: first.integrationCommit, resultCommit: await gitOutput(worktree.path, ["rev-parse", "HEAD"]) });
    const second = await manager.integrate({ taskId: "B" });
    expect(second.status).toBe("delivery_size_exceeded");
    expect(fixture.store.events.listForBuild(fixture.buildId).find((event) => event.type === "wale.delivery_size_evaluated" && event.taskId === "B")?.payload).toMatchObject({ incrementalTextChurn: 2, priorTextChurn: 2, cumulativeTextChurn: 4 });
    expect(await readFile(path.join(fixture.integrationPath, "a.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("fails closed when a prior accepted delivery measurement is missing", async () => {
    const fixture = await createFixture("delivery-missing", [{ id: "A", files: { "a.txt": "one\n" } }, { id: "B", files: { "b.txt": "two\n" } }]);
    fixture.store.events.appendExperimentBinding(fixture.buildId, boundExperiment());
    const manager = createIntegrationManager(fixture, passingRunner());
    expect((await manager.integrate({ taskId: "A" })).status).toBe("integrated");
    fixture.store.database.prepare("DELETE FROM build_events WHERE event_type = 'wale.delivery_size_evaluated'").run();
    const second = await manager.integrate({ taskId: "B" });
    expect(second.status).toBe("delivery_size_unmeasurable");
    expect(fixture.store.events.listForBuild(fixture.buildId).find((event) => event.type === "wale.delivery_size_evaluated")?.payload).toMatchObject({ incrementalTextChurn: null, cumulativeTextChurn: null, accepted: false, reason: "UNMEASURABLE" });
    expect(await gitOutput(fixture.integrationPath, ["rev-parse", "HEAD"])).toBe(second.previousHead);
  });

  it("refuses binary delivery and retains a failed evaluation", async () => {
    const fixture = await createFixture("delivery-binary", [{ id: "A", files: { "binary.bin": "a\u0000b" } }]);
    fixture.store.events.appendExperimentBinding(fixture.buildId, boundExperiment());
    const result = await createIntegrationManager(fixture, passingRunner()).integrate({ taskId: "A" });
    expect(result.status).toBe("delivery_size_unmeasurable");
    expect(await gitOutput(fixture.integrationPath, ["rev-parse", "HEAD"])).toBe(result.previousHead);
    expect(fixture.store.events.listForBuild(fixture.buildId).find((event) => event.type === "wale.delivery_size_evaluated")?.payload).toMatchObject({ accepted: false, binaryFileCount: 1 });
  });

  it("rolls back if delivery evidence persistence fails", async () => {
    const fixture = await createFixture("delivery-persistence", [{ id: "A", files: { "a.txt": "one\n" } }]);
    fixture.store.events.appendExperimentBinding(fixture.buildId, boundExperiment());
    const append = fixture.store.events.append.bind(fixture.store.events);
    vi.spyOn(fixture.store.events, "append").mockImplementation((input) => {
      if (input.type === "wale.delivery_size_evaluated") throw new Error("fixture evidence failure");
      return append(input);
    });
    const result = await createIntegrationManager(fixture, passingRunner()).integrate({ taskId: "A" });
    expect(result).toMatchObject({ status: "persistence_failed", errorCode: "INTEGRATION_EVIDENCE_PERSISTENCE_FAILED" });
    expect(await gitOutput(fixture.integrationPath, ["rev-parse", "HEAD"])).toBe(result.previousHead);
    expect(fixture.store.tasks.getById("A").state).toBe("failed");
  });

  it("creates a no-ff merge and transactionally integrates artifacts while releasing dependents", async () => {
    const fixture = await createFixture("success", [
      {
        id: "BL-101",
        files: { "producer.txt": "integrated output\n" },
      },
    ]);
    fixture.store.tasks.create({
      id: "BL-102",
      buildId: fixture.buildId,
      title: "Consume output",
      description: "Wait for the producer.",
      acceptanceCriteria: ["Producer artifact is integrated."],
      state: "blocked",
      dependencies: [
        {
          dependencyTaskId: "BL-101",
          dependencyType: "artifact",
          requiredArtifactName: "producer-contract",
          requiredArtifactVersion: "1.0.0",
        },
      ],
    });
    fixture.store.artifacts.publish({
      id: "artifact-producer",
      buildId: fixture.buildId,
      producerTaskId: "BL-101",
      name: "producer-contract",
      artifactType: "contract",
      version: "1.0.0",
      status: "validated",
    });
    const requests: IntegrationValidationRequest[] = [];
    const manager = createIntegrationManager(
      fixture,
      passingRunner((request) => requests.push(request)),
    );

    const result = await manager.integrate({ taskId: "BL-101" });

    expect(result).toMatchObject({
      status: "integrated",
      mergePerformed: true,
      errorCode: null,
      releasedTaskIds: ["BL-102"],
    });
    expect(result.integrationCommit).not.toBe(result.previousHead);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.commands).toEqual(["configured-integration-check"]);
    expect(
      (
        await gitOutput(fixture.integrationPath, [
          "rev-list",
          "--parents",
          "-n",
          "1",
          "HEAD",
        ])
      ).split(" "),
    ).toHaveLength(3);
    expect(fixture.store.tasks.getById("BL-101")).toMatchObject({
      state: "integrated",
      integrationCommit: result.integrationCommit,
    });
    expect(fixture.store.artifacts.getById("artifact-producer").status).toBe(
      "integrated",
    );
    expect(fixture.store.tasks.getById("BL-102").state).toBe("ready");
    expect(
      fixture.store.events
        .listForBuild(fixture.buildId)
        .map((event) => event.type),
    ).toEqual(
      expect.arrayContaining([
        "integration.validation_passed",
        "artifact.status_changed",
        "task.integration_succeeded",
        "task.dependencies_released",
        "integration.completed",
      ]),
    );
  });

  it("aborts a conflict and preserves the task branch and worktree", async () => {
    const fixture = await createFixture(
      "conflict",
      [
        { id: "BL-201", files: { "shared.txt": "first task\n" } },
        { id: "BL-202", files: { "shared.txt": "second task\n" } },
      ],
      { "shared.txt": "base\n" },
    );
    const manager = createIntegrationManager(fixture, passingRunner());
    const first = await manager.integrate({ taskId: "BL-201" });
    const taskBranchHead = await gitOutput(fixture.repository, [
      "rev-parse",
      "refs/heads/agent/build-test/BL-202",
    ]);

    const second = await manager.integrate({ taskId: "BL-202" });

    expect(second).toMatchObject({
      status: "merge_conflict",
      previousHead: first.integrationCommit,
      integrationCommit: null,
      conflictPaths: ["shared.txt"],
      errorCode: "INTEGRATION_MERGE_CONFLICT",
    });
    expect(await gitOutput(fixture.integrationPath, ["rev-parse", "HEAD"])).toBe(
      first.integrationCommit,
    );
    expect(
      await gitOutput(fixture.integrationPath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ).toBe("");
    expect(await gitOutput(fixture.repository, [
      "rev-parse",
      "refs/heads/agent/build-test/BL-202",
    ])).toBe(taskBranchHead);
    const conflictedTaskPath = fixture.taskPaths.get("BL-202");
    expect(conflictedTaskPath).toBeDefined();
    expect(await readFile(path.join(conflictedTaskPath ?? "", "shared.txt"), "utf8"))
      .toBe("second task\n");
    expect(fixture.store.tasks.getById("BL-202")).toMatchObject({
      state: "failed",
      errorCode: "INTEGRATION_MERGE_CONFLICT",
    });
  });

  it("hard-resets and cleans the integration worktree after validation failure", async () => {
    const fixture = await createFixture("validation-failure", [
      { id: "BL-301", files: { "merged.txt": "must be rolled back\n" } },
    ]);
    const runner: IntegrationValidationRunner = {
      async run(request) {
        await writeFile(
          path.join(request.worktreePath, "generated.tmp"),
          "validation residue\n",
        );
        await writeFile(
          path.join(request.worktreePath, "README.md"),
          "validation mutated tracked content\n",
        );
        return summary("failed", "integration test failed");
      },
    };
    const manager = createIntegrationManager(fixture, runner);
    let evidencePersistedBeforeFailure = false;

    const result = await manager.integrate({
      taskId: "BL-301",
      onValidationCompleted(validation) {
        expect(validation.status).toBe("failed");
        expect(fixture.store.tasks.getById("BL-301").state).toBe(
          "integrating",
        );
        evidencePersistedBeforeFailure = true;
      },
    });

    expect(result).toMatchObject({
      status: "validation_failed",
      errorCode: "INTEGRATION_VALIDATION_FAILED",
    });
    expect(evidencePersistedBeforeFailure).toBe(true);
    expect(await gitOutput(fixture.integrationPath, ["rev-parse", "HEAD"])).toBe(
      result.previousHead,
    );
    expect(
      await gitOutput(fixture.integrationPath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ).toBe("");
    await expect(access(path.join(fixture.integrationPath, "merged.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(fixture.integrationPath, "generated.tmp")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(fixture.integrationPath, "README.md"), "utf8"))
      .toBe("# fixture\n");
    expect(await readFile(
      path.join(fixture.taskPaths.get("BL-301") ?? "", "merged.txt"),
      "utf8",
    )).toBe("must be rolled back\n");
    expect(fixture.store.tasks.getById("BL-301")).toMatchObject({
      state: "failed",
      errorCode: "INTEGRATION_VALIDATION_FAILED",
    });
  });

  it("rolls back when durable integration evidence cannot be persisted", async () => {
    const fixture = await createFixture("evidence-failure", [
      { id: "BL-302", files: { "evidence.txt": "must not integrate\n" } },
    ]);
    const manager = createIntegrationManager(fixture, passingRunner());

    const result = await manager.integrate({
      taskId: "BL-302",
      onValidationCompleted() {
        throw new Error("evidence store unavailable");
      },
    });

    expect(result).toMatchObject({
      status: "persistence_failed",
      errorCode: "INTEGRATION_EVIDENCE_PERSISTENCE_FAILED",
    });
    expect(await gitOutput(fixture.integrationPath, ["rev-parse", "HEAD"])).toBe(
      result.previousHead,
    );
    await expect(
      access(path.join(fixture.integrationPath, "evidence.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.store.tasks.getById("BL-302")).toMatchObject({
      state: "failed",
      errorCode: "INTEGRATION_EVIDENCE_PERSISTENCE_FAILED",
    });
  });

  it("serializes concurrent requests for one build while allowing both real merges", async () => {
    const fixture = await createFixture("serialized", [
      { id: "BL-401", files: { "first.txt": "first\n" } },
      { id: "BL-402", files: { "second.txt": "second\n" } },
    ]);
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let releaseFirst = (): void => undefined;
    const firstStarted = deferredSignal();
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const runner: IntegrationValidationRunner = {
      async run(request) {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        order.push(`start:${request.taskId}`);
        if (request.taskId === "BL-401") {
          firstStarted.resolve();
          await firstRelease;
        }
        order.push(`end:${request.taskId}`);
        active -= 1;
        return summary("passed");
      },
    };
    const manager = createIntegrationManager(fixture, runner);

    const firstPromise = manager.integrate({ taskId: "BL-401" });
    await firstStarted.promise;
    const secondPromise = manager.integrate({ taskId: "BL-402" });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(calls).toBe(1);
    releaseFirst();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      "start:BL-401",
      "end:BL-401",
      "start:BL-402",
      "end:BL-402",
    ]);
    expect(first.status).toBe("integrated");
    expect(second).toMatchObject({
      status: "integrated",
      previousHead: first.integrationCommit,
    });
    expect(await readFile(path.join(fixture.integrationPath, "first.txt"), "utf8"))
      .toBe("first\n");
    expect(await readFile(path.join(fixture.integrationPath, "second.txt"), "utf8"))
      .toBe("second\n");
  });

  it("integrates an explicitly allowed no-change task at the current integration HEAD without merging", async () => {
    const fixture = await createFixture("no-changes", [
      { id: "BL-501", files: { "advance.txt": "advance integration\n" } },
      { id: "BL-502", allowNoChanges: true },
    ]);
    const validatedHeads: string[] = [];
    const runner: IntegrationValidationRunner = {
      async run(request) {
        validatedHeads.push(
          await gitOutput(request.worktreePath, ["rev-parse", "HEAD"]),
        );
        return summary("passed");
      },
    };
    const manager = createIntegrationManager(fixture, runner);
    const advanced = await manager.integrate({ taskId: "BL-501" });

    const noChanges = await manager.integrate({ taskId: "BL-502" });

    expect(noChanges).toMatchObject({
      status: "integrated",
      previousHead: advanced.integrationCommit,
      integrationCommit: advanced.integrationCommit,
      mergePerformed: false,
    });
    expect(validatedHeads).toEqual([
      advanced.integrationCommit,
      advanced.integrationCommit,
    ]);
    expect(fixture.store.tasks.getById("BL-502")).toMatchObject({
      state: "integrated",
      integrationCommit: advanced.integrationCommit,
    });
  });

  it("pushes task and integration branches only after integration validation passes", async () => {
    const fixture = await createFixture("push", [
      { id: "BL-601", files: { "publish.txt": "validated before push\n" } },
    ]);
    const remote = path.join(fixture.root, "remote.git");
    await git(fixture.root, ["init", "--bare", remote]);
    await git(fixture.repository, ["remote", "add", "origin", remote]);
    let remoteWasEmptyDuringValidation = false;
    const runner: IntegrationValidationRunner = {
      async run() {
        const remoteReferences = await execFileAsync(
          "git",
          ["ls-remote", "--heads", remote],
          { encoding: "utf8" },
        );
        remoteWasEmptyDuringValidation =
          remoteReferences.stdout.trim().length === 0;
        return summary("passed");
      },
    };
    const manager = createIntegrationManager(fixture, runner);

    const result = await manager.integrate({
      taskId: "BL-601",
      push: {
        remote: "origin",
        taskBranch: true,
        integrationBranch: true,
      },
    });

    expect(remoteWasEmptyDuringValidation).toBe(true);
    expect(result.pushes).toEqual({
      task: {
        branch: "agent/build-test/BL-601",
        attempted: true,
        succeeded: true,
        error: null,
      },
      integration: {
        branch: "agent-integration/build-test",
        attempted: true,
        succeeded: true,
        error: null,
      },
    });
    expect(
      await gitOutput(remote, [
        "rev-parse",
        "refs/heads/agent/build-test/BL-601",
      ]),
    ).toBe(fixture.store.tasks.getById("BL-601").resultCommit);
    expect(
      await gitOutput(remote, [
        "rev-parse",
        "refs/heads/agent-integration/build-test",
      ]),
    ).toBe(result.integrationCommit);
  });

  it("rolls back a cancelled integration and does not push either branch", async () => {
    const fixture = await createFixture("cancelled", [
      { id: "BL-701", files: { "cancelled.txt": "must be rolled back\n" } },
    ]);
    const remote = path.join(fixture.root, "remote.git");
    await git(fixture.root, ["init", "--bare", remote]);
    await git(fixture.repository, ["remote", "add", "origin", remote]);
    const validationStarted = deferredSignal();
    const controller = new AbortController();
    const runner: IntegrationValidationRunner = {
      async run(request) {
        validationStarted.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted === true) {
            resolve();
            return;
          }
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return summary("cancelled", "integration validation was cancelled");
      },
    };
    const manager = createIntegrationManager(fixture, runner);

    const integration = manager.integrate({
      taskId: "BL-701",
      signal: controller.signal,
      push: {
        remote: "origin",
        taskBranch: true,
        integrationBranch: true,
      },
    });
    await validationStarted.promise;
    controller.abort();
    const result = await integration;

    expect(result).toMatchObject({
      status: "cancelled",
      errorCode: "INTEGRATION_CANCELLED",
      mergePerformed: true,
      pushes: {
        task: { attempted: false },
        integration: { attempted: false },
      },
    });
    expect(await gitOutput(fixture.integrationPath, ["rev-parse", "HEAD"])).toBe(
      result.previousHead,
    );
    expect(
      await gitOutput(fixture.integrationPath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ).toBe("");
    await expect(
      access(path.join(fixture.integrationPath, "cancelled.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.store.tasks.getById("BL-701")).toMatchObject({
      state: "cancelled",
      errorCode: "INTEGRATION_CANCELLED",
    });
    const remoteReferences = await execFileAsync(
      "git",
      ["ls-remote", "--heads", remote],
      { encoding: "utf8" },
    );
    expect(remoteReferences.stdout.trim()).toBe("");
  });
});

interface TaskFixtureInput {
  id: string;
  files?: Readonly<Record<string, string>>;
  allowNoChanges?: boolean;
}

interface IntegrationFixture {
  root: string;
  repository: string;
  integrationPath: string;
  taskPaths: Map<string, string>;
  buildId: string;
  store: DatabaseRepositories;
  worktrees: GitWorktreeManager;
}

async function createFixture(
  label: string,
  taskInputs: readonly TaskFixtureInput[],
  baseFiles: Readonly<Record<string, string>> = {},
): Promise<IntegrationFixture> {
  const root = await mkdtemp(
    path.join(tmpdir(), `agentflow-integration-${label}-`),
  );
  const repository = path.join(root, "repository");
  const worktreesRoot = path.join(root, "runtime", "worktrees");
  await mkdir(repository, { recursive: true });
  await git(root, ["init", "--initial-branch=main", repository]);
  await git(repository, ["config", "user.name", "AgentFlow Test"]);
  await git(repository, ["config", "user.email", "agentflow@example.test"]);
  await writeFile(path.join(repository, "README.md"), "# fixture\n");
  for (const [relativePath, contents] of Object.entries(baseFiles)) {
    const target = path.join(repository, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "initial fixture"]);

  const buildId = "build-test";
  const worktrees = await GitWorktreeManager.create({
    repositoryRoot: repository,
    worktreesRoot,
    repositoryId: "repository-test",
    buildId,
  });
  const integration = await worktrees.createIntegrationWorktree({
    baseBranch: "main",
  });
  const taskPaths = new Map<string, string>();
  const taskRecords = [];
  for (const input of taskInputs) {
    const task = await worktrees.createTaskWorktree({
      taskId: input.id,
      integrationCommit: integration.headCommit,
    });
    taskPaths.set(input.id, task.path);
    if (input.files !== undefined) {
      for (const [relativePath, contents] of Object.entries(input.files)) {
        const target = path.join(task.path, relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
      }
      await git(task.path, ["add", "."]);
      await git(task.path, ["commit", "-m", `implement ${input.id}`]);
    }
    taskRecords.push({
      id: input.id,
      backlogTaskId: input.id,
      title: input.id,
      description: `Implement ${input.id}.`,
      acceptanceCriteria: [`${input.id} is complete.`],
      state: "validated" as const,
      branchName: task.branchName,
      worktreePath: task.path,
      baseCommit: integration.headCommit,
      resultCommit: await gitOutput(task.path, ["rev-parse", "HEAD"]),
      allowNoChanges: input.allowNoChanges ?? false,
    });
  }

  const database = openDatabase(path.join(root, "agentflow.db"));
  const store = createDatabaseRepositories(database);
  store.repositories.create({
    id: "repository-test",
    name: "Integration Test",
    localPath: repository,
    configPath: path.join(repository, ".agentflow.yaml"),
    baseBranch: "main",
  });
  store.builds.create({
    id: buildId,
    repositoryId: "repository-test",
    backlogPath: "BACKLOG.md",
    baseCommit: integration.headCommit,
    integrationBranch: integration.branchName,
    integrationWorktree: integration.path,
    repositoryConfig: {
      validation: { integration: ["configured-integration-check"] },
      git: {
        push_task_branches: false,
        push_integration_branch: false,
      },
    },
    status: "running",
    tasks: taskRecords,
  });

  const fixture = {
    root,
    repository,
    integrationPath: integration.path,
    taskPaths,
    buildId,
    store,
    worktrees,
  };
  fixtures.add(fixture);
  return fixture;
}

function createIntegrationManager(
  fixture: IntegrationFixture,
  runner: IntegrationValidationRunner,
): IntegrationManager {
  return new IntegrationManager({
    store: fixture.store,
    worktrees: fixture.worktrees,
    validationRunner: runner,
  });
}

function passingRunner(
  onRequest?: (request: IntegrationValidationRequest) => void,
): IntegrationValidationRunner {
  return {
    run(request) {
      onRequest?.(request);
      return Promise.resolve(summary("passed"));
    },
  };
}

function summary(
  status: IntegrationValidationSummary["status"],
  errorMessage: string | null = null,
): IntegrationValidationSummary {
  return {
    status,
    commands: [],
    errorMessage,
    startedAt: "2026-07-24T00:00:00.000Z",
    completedAt: "2026-07-24T00:00:01.000Z",
    durationMs: 1_000,
  };
}

function deferredSignal(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function git(cwd: string, arguments_: readonly string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
  });
}

async function gitOutput(
  cwd: string,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function boundExperiment(): WaleRunLabExperiment {
  return {
    experimentId: `exp_${"2".repeat(64)}`,
    runId: "run_A1",
    repositorySnapshot: {
      state: "VERIFIED",
      commit: "a".repeat(40),
      tree: "b".repeat(64),
      reason: null,
    },
    frozenTask: {
      state: "VERIFIED",
      ids: ["sha256:" + "a".repeat(16)],
      titleFingerprints: ["sha256:" + "b".repeat(16)],
    },
    frozenRequirements: {
      state: "UNKNOWN",
      items: [],
      reason: "FROZEN_REQUIREMENTS_NOT_RETAINED_SEPARATELY",
    },
    acceptanceCriteria: {
      state: "VERIFIED",
      count: 1,
      items: [{ id: "sha256:" + "a".repeat(16), fingerprint: "sha256:" + "b".repeat(16) }],
    },
    parameters: {
      deliverySize: 100,
      overflowBehavior: "SPLIT_OR_REPLAN",
      humanInterruptionBudget: 0,
      authorityEscalationRequired: true,
      strategy: "MINIMUM_WORKING_STATE",
      verificationProfile: "design-standard",
      verificationProfileReference: "devctl-design-standard",
      requiredCheckBindings: [{ id: "unit", retainedReference: "npm-test" }],
      requiredChecksCannotBeBypassed: true,
      agentModel: null,
    },
    authorityStateReference: "authority-" + "c".repeat(24),
    strategy: "MINIMUM_WORKING_STATE",
    executionResult: {
      status: "UNKNOWN",
      completionState: "UNKNOWN",
      reason: "EXPERIMENT_NOT_EXECUTED",
    },
    verificationEvidence: { state: "UNKNOWN", reason: "EXPERIMENT_NOT_EXECUTED" },
    comparisonEligibility: { state: "UNKNOWN", reason: "EXACT_CASE_COMPARISON_NOT_BOUND" },
    candidateApplication: { authorized: false, reason: "SEPARATE_AUTHORITY_BOUND_STEP_REQUIRED" },
    claimBoundary: "Result applies to this exact run.",
  };
}
