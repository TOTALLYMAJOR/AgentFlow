import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseRepositories } from "../src/db/index.js";
import {
  createDatabaseFixture,
  type DatabaseFixture,
} from "./helpers/database-fixture.js";

describe("remote job leases", () => {
  let fixture: DatabaseFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("claims atomically and accepts only an idempotent fenced result", () => {
    fixture = createDatabaseFixture();
    let now = "2026-07-26T12:00:00.000Z";
    const store = createDatabaseRepositories(fixture.database, () => now);
    store.repositories.create({
      id: "repository_1",
      name: "Repository",
      localPath: "/tmp/remote-job-repository",
      configPath: "/tmp/remote-job-repository/.agentflow.yaml",
      baseBranch: "main",
    });
    store.createBuild({
      id: "build_1",
      repositoryId: "repository_1",
      backlogPath: "BACKLOG.md",
      baseCommit: "abc123",
      integrationBranch: "agentflow/build-1",
      status: "running",
      tasks: [
        {
          id: "task_1",
          title: "Remote task",
          description: "Run on a registered machine.",
          acceptanceCriteria: ["Result is lease fenced."],
          state: "ready",
        },
      ],
    });
    store.runners.create({
      id: "runner_1",
      name: "remote-1",
      providerId: "codex",
      transport: "remote",
      capacity: 1,
    });
    store.remoteJobs.queue({
      id: "job_1",
      buildId: "build_1",
      taskId: "task_1",
      attempt: 1,
      providerId: "codex",
      payload: { prompt: "Implement task_1" },
    });
    store.remoteJobs.queue({
      id: "job_2",
      buildId: "build_1",
      taskId: "task_1",
      attempt: 2,
      providerId: "codex",
      payload: { prompt: "Retry task_1" },
    });

    const claimed = store.remoteJobs.claim({
      runnerId: "runner_1",
      providerId: "codex",
      leaseTokenSha256: "lease-digest",
      leaseExpiresAt: "2026-07-26T12:05:00.000Z",
    });
    expect(claimed).toMatchObject({
      id: "job_1",
      runnerId: "runner_1",
      status: "leased",
    });
    expect(
      store.remoteJobs.claim({
        runnerId: "runner_1",
        providerId: "codex",
        leaseTokenSha256: "other-lease",
        leaseExpiresAt: "2026-07-26T12:05:00.000Z",
      }),
    ).toBeUndefined();

    now = "2026-07-26T12:01:00.000Z";
    expect(
      store.remoteJobs.heartbeat(
        "job_1",
        "runner_1",
        "lease-digest",
        "2026-07-26T12:06:00.000Z",
      ),
    ).toMatchObject({ leaseExpiresAt: "2026-07-26T12:06:00.000Z" });
    const completion = {
      id: "job_1",
      runnerId: "runner_1",
      leaseTokenSha256: "lease-digest",
      idempotencyKey: "result-key-1",
      resultSha256: "result-digest",
      status: "completed" as const,
      result: { outcome: "completed", patchSha256: "patch-digest" },
    };
    expect(store.remoteJobs.complete(completion)).toMatchObject({
      status: "completed",
      result: { outcome: "completed", patchSha256: "patch-digest" },
    });
    expect(store.remoteJobs.complete(completion)).toMatchObject({
      status: "completed",
    });
    expect(
      store.remoteJobs.claim({
        runnerId: "runner_1",
        providerId: "codex",
        leaseTokenSha256: "second-lease",
        leaseExpiresAt: "2026-07-26T12:07:00.000Z",
      }),
    ).toMatchObject({ id: "job_2", status: "leased" });
    expect(() =>
      store.remoteJobs.complete({
        ...completion,
        idempotencyKey: "different-key",
      }),
    ).toThrow("already has a different result");
  });

  it("rejects an expired lease", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(
      fixture.database,
      () => "2026-07-26T12:10:00.000Z",
    );
    store.repositories.create({
      id: "repository_1",
      name: "Repository",
      localPath: "/tmp/expired-remote-job-repository",
      configPath: "/tmp/expired-remote-job-repository/.agentflow.yaml",
      baseBranch: "main",
    });
    store.createBuild({
      id: "build_1",
      repositoryId: "repository_1",
      backlogPath: "BACKLOG.md",
      baseCommit: "abc123",
      integrationBranch: "agentflow/build-1",
      status: "running",
      tasks: [
        {
          id: "task_1",
          title: "Remote task",
          description: "Run remotely.",
          acceptanceCriteria: ["Expired result is rejected."],
          state: "ready",
        },
      ],
    });
    store.runners.create({
      id: "runner_1",
      name: "remote-1",
      providerId: "codex",
      transport: "remote",
      capacity: 1,
    });
    store.remoteJobs.queue({
      id: "job_1",
      buildId: "build_1",
      taskId: "task_1",
      attempt: 1,
      providerId: "codex",
      payload: {},
    });
    store.remoteJobs.claim({
      runnerId: "runner_1",
      providerId: "codex",
      leaseTokenSha256: "lease-digest",
      leaseExpiresAt: "2026-07-26T12:05:00.000Z",
    });

    expect(() =>
      store.remoteJobs.heartbeat(
        "job_1",
        "runner_1",
        "lease-digest",
        "2026-07-26T12:15:00.000Z",
      ),
    ).toThrow("does not have a current lease");
  });
});
