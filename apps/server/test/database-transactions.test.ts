import { afterEach, describe, expect, it } from "vitest";
import {
  createDatabaseRepositories,
  openDatabase,
} from "../src/db/index.js";
import {
  createDatabaseFixture,
  type DatabaseFixture,
} from "./helpers/database-fixture.js";

describe("database transactions and durable events", () => {
  let fixture: DatabaseFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("rolls back build, tasks, and events when graph persistence fails", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    store.repositories.create({
      id: "repository_a",
      name: "A",
      localPath: "/tmp/repository-a",
      configPath: "/tmp/repository-a/.agentflow.yaml",
      baseBranch: "main",
    });

    expect(() =>
      store.createBuild({
        id: "build_invalid",
        repositoryId: "repository_a",
        backlogPath: "BACKLOG.md",
        baseCommit: "abc123",
        integrationBranch: "agentflow/invalid",
        tasks: [
          {
            id: "task_a",
            title: "Task A",
            description: "Cannot persist an invalid dependency.",
            acceptanceCriteria: ["No partial state remains."],
            dependencies: [{ dependencyTaskId: "task_missing" }],
          },
        ],
      }),
    ).toThrow(/FOREIGN KEY constraint failed/i);

    expect(
      fixture.database
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM builds",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      fixture.database
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM tasks",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      fixture.database
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM build_events",
        )
        .get()?.count,
    ).toBe(0);
  });

  it("persists state-change events across reconnects", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(
      fixture.database,
      () => "2026-07-24T12:00:00.000Z",
    );
    store.repositories.create({
      id: "repository_a",
      name: "A",
      localPath: "/tmp/repository-a",
      configPath: "/tmp/repository-a/.agentflow.yaml",
      baseBranch: "main",
    });
    store.createBuild({
      id: "build_1",
      repositoryId: "repository_a",
      backlogPath: "BACKLOG.md",
      baseCommit: "abc123",
      integrationBranch: "agentflow/build-1",
    });
    store.transitionBuild("build_1", "ready");
    fixture.database.close();

    const reopened = openDatabase(fixture.databasePath);
    try {
      const reopenedStore = createDatabaseRepositories(reopened);
      expect(
        reopenedStore.events
          .listForBuild("build_1")
          .map(({ sequence, type }) => ({ sequence, type })),
      ).toEqual([
        { sequence: 1, type: "build.created" },
        { sequence: 2, type: "build.status_changed" },
      ]);
      expect(reopenedStore.builds.getById("build_1").status).toBe("ready");
    } finally {
      reopened.close();
    }
  });

  it("assigns a worker and task attempt atomically", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    store.repositories.create({
      id: "repository_a",
      name: "A",
      localPath: "/tmp/repository-a",
      configPath: "/tmp/repository-a/.agentflow.yaml",
      baseBranch: "main",
    });
    store.createBuild({
      id: "build_1",
      repositoryId: "repository_a",
      backlogPath: "BACKLOG.md",
      baseCommit: "abc123",
      integrationBranch: "agentflow/build-1",
      status: "ready",
      tasks: [
        {
          id: "task_a",
          title: "Task A",
          description: "Exercise worker assignment.",
          acceptanceCriteria: ["Assignment is atomic."],
          state: "ready",
        },
      ],
    });
    store.workers.create({ id: "worker_1", buildId: "build_1" });

    expect(store.workers.listForBuild("build_1")).toHaveLength(1);
    const assigned = store.assignWorker({
      workerId: "worker_1",
      taskId: "task_a",
      processId: 1234,
      attemptId: "attempt_1",
    });

    expect(assigned).toMatchObject({
      taskId: "task_a",
      processId: 1234,
      status: "running",
    });
    expect(store.tasks.getById("task_a")).toMatchObject({
      state: "running",
      attempt: 1,
    });
    expect(store.tasks.getAttempt("task_a", 1)).toMatchObject({
      id: "attempt_1",
      workerId: "worker_1",
      status: "running",
    });
  });

  it("rejects illegal task transitions without changing state or appending an event", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    store.repositories.create({
      id: "repository_a",
      name: "A",
      localPath: "/tmp/repository-a",
      configPath: "/tmp/repository-a/.agentflow.yaml",
      baseBranch: "main",
    });
    store.createBuild({
      id: "build_1",
      repositoryId: "repository_a",
      backlogPath: "BACKLOG.md",
      baseCommit: "abc123",
      integrationBranch: "agentflow/build-1",
      tasks: [
        {
          id: "task_a",
          title: "Task A",
          description: "Remain pending after an illegal transition.",
          acceptanceCriteria: ["State and events are unchanged."],
        },
      ],
    });

    expect(() => store.transitionTask("task_a", "integrated")).toThrow(
      /Illegal task state transition/i,
    );
    expect(store.tasks.getById("task_a").state).toBe("pending");
    expect(store.events.listForBuild("build_1")).toHaveLength(1);
  });

  it("publishes and integrates artifacts with durable events", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    store.repositories.create({
      id: "repository_a",
      name: "A",
      localPath: "/tmp/repository-a",
      configPath: "/tmp/repository-a/.agentflow.yaml",
      baseBranch: "main",
    });
    store.createBuild({
      id: "build_1",
      repositoryId: "repository_a",
      backlogPath: "BACKLOG.md",
      baseCommit: "abc123",
      integrationBranch: "agentflow/build-1",
      tasks: [
        {
          id: "task_a",
          title: "Task A",
          description: "Publish a contract.",
          acceptanceCriteria: ["The artifact is integrated."],
          state: "integrating",
        },
      ],
    });

    store.publishArtifact({
      id: "artifact_1",
      buildId: "build_1",
      producerTaskId: "task_a",
      name: "api-contract",
      artifactType: "openapi",
      version: "1.0.0",
      sha256: "abc123",
    });
    store.recordIntegrationSuccess("task_a", {
      integrationCommit: "def456",
    });

    const integratedArtifact = store.artifacts.getById("artifact_1");
    expect(integratedArtifact.status).toBe("integrated");
    expect(integratedArtifact.integratedAt).toMatch(/\S/u);
    expect(store.tasks.getById("task_a")).toMatchObject({
      state: "integrated",
      integrationCommit: "def456",
    });
    expect(
      store.events.listForBuild("build_1").map(({ type }) => type),
    ).toEqual([
      "build.created",
      "artifact.published",
      "task.integration_succeeded",
    ]);
  });
});
