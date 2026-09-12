import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEnvironment } from "../src/config/environment.js";
import { buildApp } from "../src/http/app.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map(async (root) => {
      temporaryRoots.delete(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("AgentFlow API smoke", () => {
  it("runs three repositories sharing one resource in a deterministic sequence", async () => {
    const runtimeHome = await temporaryRoot("runtime-initiative-shared-resource");
    const repositories = await Promise.all([createFixtureRepository(), createFixtureRepository(), createFixtureRepository()]);
    const { app, context } = await buildApp({ environment: resolveEnvironment({ AGENTFLOW_HOME: runtimeHome, AGENTFLOW_LOG_LEVEL: "silent" }), staticRoot: false, logger: false });
    vi.spyOn(context.coordinator, "start").mockImplementation(async (buildId) => context.store.builds.transition(buildId, "running", { eventType: "test.build_started" }));
    try {
      const members: Array<{ planId: string; baseCommit: string }> = [];
      for (const repositoryPath of repositories) {
        const registered = await app.inject({ method: "POST", url: "/api/repositories", payload: { path: repositoryPath } });
        const planned = await app.inject({ method: "POST", url: "/api/plans", payload: { repositoryId: registered.json<{ id: string }>().id } });
        members.push({ planId: planned.json<{ id: string }>().id, baseCommit: (await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim() });
      }
      const orderedPlans = members.map((member) => member.planId).sort();
      const created = await app.inject({ method: "POST", url: "/api/initiatives", payload: { title: "Shared staging", objective: "Serialize access", members, dependencies: [{ producerPlanId: members[0]?.planId, consumerPlanId: members[1]?.planId, dependencyType: "shared_resource", sharedResource: "staging" }, { producerPlanId: members[0]?.planId, consumerPlanId: members[2]?.planId, dependencyType: "shared_resource", sharedResource: "staging" }] } });
      const initiativeId = created.json<{ id: string }>().id;
      await app.inject({ method: "POST", url: `/api/initiatives/${initiativeId}/approve` });
      let state = (await app.inject({ method: "POST", url: `/api/initiatives/${initiativeId}/start` })).json<{ builds: Array<{ id: string; planId: string }> }>();
      expect(state.builds.map((build) => build.planId)).toEqual([orderedPlans[0]]);
      for (let index = 1; index < orderedPlans.length; index += 1) {
        const current = state.builds.find((build) => build.planId === orderedPlans[index - 1]);
        context.store.builds.transition(current?.id ?? "", "completed", { eventType: "test.build_completed" });
        state = (await app.inject({ method: "POST", url: `/api/initiatives/${initiativeId}/reconcile` })).json<typeof state>();
        expect(state.builds.map((build) => build.planId).sort()).toEqual(orderedPlans.slice(0, index + 1));
      }
      expect(state.builds).toHaveLength(3);
    } finally { await app.close(); }
  });

  it("fails closed for active, forced, and remote Git cleanup requests with durable evidence", async () => {
    const { app, build } = await createReadyBuildApplication("cleanup-policy");
    try {
      const active = await app.inject({ method: "POST", url: `/api/builds/${build.id}/cleanup`, payload: { deleteMergedBranches: true } });
      expect(active.statusCode).toBe(409);
      expect(active.json()).toMatchObject({ error: { code: "BUILD_NOT_CLEANUP_ELIGIBLE" } });
      const receipts = await app.inject({ method: "GET", url: `/api/builds/${build.id}/cleanup-receipts` });
      expect(receipts.json<Array<{ action: string; reason: string }>>().some((receipt) => receipt.action === "preserved" && receipt.reason.includes("only completed builds"))).toBe(true);

      const forced = await app.inject({ method: "POST", url: `/api/builds/${build.id}/cleanup`, payload: { force: true } });
      expect(forced.json()).toMatchObject({ error: { code: "DESTRUCTIVE_CLEANUP_DISABLED" } });
      const remote = await app.inject({ method: "POST", url: `/api/builds/${build.id}/cleanup`, payload: { deleteRemoteBranches: true } });
      expect(remote.json()).toMatchObject({ error: { code: "REMOTE_BRANCH_DELETION_DISABLED" } });
    } finally { await app.close(); }
  });

  it("keeps an artifact consumer blocked until the exact upstream artifact is integrated", async () => {
    const runtimeHome = await temporaryRoot("runtime-initiative-artifact");
    const repositories = await Promise.all([createFixtureRepository(), createFixtureRepository()]);
    const { app, context } = await buildApp({ environment: resolveEnvironment({ AGENTFLOW_HOME: runtimeHome, AGENTFLOW_LOG_LEVEL: "silent" }), staticRoot: false, logger: false });
    const start = vi.spyOn(context.coordinator, "start").mockImplementation(async (buildId) => context.store.builds.transition(buildId, "running", { eventType: "test.build_started" }));
    try {
      const members: Array<{ planId: string; baseCommit: string }> = [];
      for (const repositoryPath of repositories) {
        const registered = await app.inject({ method: "POST", url: "/api/repositories", payload: { path: repositoryPath } });
        const planned = await app.inject({ method: "POST", url: "/api/plans", payload: { repositoryId: registered.json<{ id: string }>().id } });
        members.push({ planId: planned.json<{ id: string }>().id, baseCommit: (await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim() });
      }
      const created = await app.inject({ method: "POST", url: "/api/initiatives", payload: { title: "Artifact rollout", objective: "Do not start the consumer early", members, dependencies: [{ producerPlanId: members[0]?.planId, consumerPlanId: members[1]?.planId, dependencyType: "artifact", artifactName: "example-contract", artifactVersion: "1.0.0" }] } });
      const initiativeId = created.json<{ id: string }>().id;
      await app.inject({ method: "POST", url: `/api/initiatives/${initiativeId}/approve` });
      const started = await app.inject({ method: "POST", url: `/api/initiatives/${initiativeId}/start` });
      const producerBuild = started.json<{ builds: Array<{ id: string }> }>().builds[0];
      expect(producerBuild).toBeDefined();
      context.store.builds.transition(producerBuild?.id ?? "", "completed", { eventType: "test.build_completed" });

      const blocked = await app.inject({ method: "POST", url: `/api/initiatives/${initiativeId}/reconcile` });
      expect(blocked.json()).toMatchObject({ builds: [{ id: producerBuild?.id }], blockers: [{ planId: members[1]?.planId, code: "ARTIFACT_NOT_INTEGRATED" }] });
      expect(start).toHaveBeenCalledTimes(1);

      const producerTask = context.store.tasks.listForBuild(producerBuild?.id ?? "")[0];
      context.store.artifacts.publish({ id: "artifact_integrated_contract", buildId: producerBuild?.id ?? "", producerTaskId: producerTask?.id ?? "", name: "example-contract", artifactType: "json-schema", version: "1.0.0", status: "integrated", integratedAt: "2026-09-12T18:00:00.000Z" });
      const released = await app.inject({ method: "POST", url: `/api/initiatives/${initiativeId}/reconcile` });
      expect(released.json<{ builds: unknown[]; blockers: unknown[] }>().builds).toHaveLength(2);
      expect(released.json<{ builds: unknown[]; blockers: unknown[] }>().blockers).toEqual([]);
      expect(start).toHaveBeenCalledTimes(2);
    } finally { await app.close(); }
  });

  it("creates and approves an immutable multi-repository initiative", async () => {
    const runtimeHome = await temporaryRoot("runtime-initiative");
    const repositories = await Promise.all([createFixtureRepository(), createFixtureRepository()]);
    const { app } = await buildApp({ environment: resolveEnvironment({ AGENTFLOW_HOME: runtimeHome, AGENTFLOW_LOG_LEVEL: "silent" }), staticRoot: false, logger: false });
    try {
      const members: Array<{ planId: string; baseCommit: string }> = [];
      for (const repositoryPath of repositories) {
        const registered = await app.inject({ method: "POST", url: "/api/repositories", payload: { path: repositoryPath } });
        const repository = registered.json<{ id: string }>();
        const planned = await app.inject({ method: "POST", url: "/api/plans", payload: { repositoryId: repository.id } });
        const plan = planned.json<{ id: string }>();
        const commit = (await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim();
        members.push({ planId: plan.id, baseCommit: commit });
      }
      const created = await app.inject({ method: "POST", url: "/api/initiatives", payload: { title: "Contract rollout", objective: "Coordinate a provider and consumer release", members, dependencies: [{ producerPlanId: members[0]?.planId, consumerPlanId: members[1]?.planId, dependencyType: "hard" }] } });
      expect(created.statusCode).toBe(201);
      const initiative = created.json<{ id: string; status: string; waves: string[][] }>();
      expect(initiative).toMatchObject({ status: "proposed", waves: [[members[0]?.planId], [members[1]?.planId]] });
      const approved = await app.inject({ method: "POST", url: `/api/initiatives/${initiative.id}/approve` });
      const approvedInitiative = approved.json<{ status: string; digest: string }>();
      expect(approvedInitiative.status).toBe("approved");
      expect(approvedInitiative.digest).toMatch(/^[0-9a-f]{64}$/);
      const started = await app.inject({ method: "POST", url: `/api/initiatives/${initiative.id}/start` });
      expect(started.statusCode).toBe(200);
      const running = started.json<{ status: string; builds: Array<{ id: string; status: string }> }>();
      expect(running.status).toBe("running");
      expect(running.builds).toHaveLength(1);
      expect(running.builds[0]?.status).toBe("running");
    } finally { await app.close(); }
  });

  it("generates a review-only backlog through Codex for a clean repository", async () => {
    const runtimeHome = await temporaryRoot("runtime-backlog");
    const repositoryPath = await createFixtureRepository();
    const fakeCodexRoot = await temporaryRoot("fake-codex");
    const fakeCodexPath = path.join(fakeCodexRoot, "codex");
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const arguments_ = process.argv.slice(2);
const directoryIndex = arguments_.indexOf("--cd");
const repository = arguments_[directoryIndex + 1];
const prompt = arguments_.at(-1);
if (!prompt.includes("do not stop after choosing one next program") ||
    !prompt.includes("Backlog Coverage") ||
    !prompt.includes("explicit exclusions") ||
    !prompt.includes("unresolved questions")) {
  throw new Error("auto backlog prompt did not require repository-wide coverage");
}
require("node:fs").writeFileSync(
  repository + "/BACKLOG.md",
  "# Generated backlog\\n\\n## AUTO-001 - Deliver selected program\\n\\n\\\`\\\`\\\`yaml\\nestimate_hours: 2\\ndepends_on: []\\nowns:\\n  - src/\\nvalidate:\\n  - npm run typecheck\\n\\\`\\\`\\\`\\n\\nImplement the selected program.\\n\\n### Acceptance Criteria\\n\\n- Focused validation passes.\\n",
);
require("node:fs").writeSync(
  1,
  "Selected the repository-grounded program.",
);
`,
    );
    await chmod(fakeCodexPath, 0o755);
    const environment = resolveEnvironment({
      AGENTFLOW_HOME: runtimeHome,
      AGENTFLOW_LOG_LEVEL: "silent",
      AGENTFLOW_CODEX_BIN: fakeCodexPath,
    });
    const { app } = await buildApp({
      environment,
      staticRoot: false,
      logger: false,
    });

    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/repositories",
        payload: { path: repositoryPath },
      });
      const repository = registered.json<{ id: string }>();
      const generated = await app.inject({
        method: "POST",
        url: `/api/repositories/${repository.id}/backlog/generate`,
        payload: { mode: "auto" },
      });

      expect(generated.statusCode).toBe(200);
      expect(generated.json()).toMatchObject({
        repositoryId: repository.id,
        backlogPath: "BACKLOG.md",
        mode: "auto",
        changed: true,
        summary: "Selected the repository-grounded program.",
      });
      const status = await execFileAsync("git", [
        "-C",
        repositoryPath,
        "status",
        "--porcelain",
      ]);
      expect(status.stdout.trim()).toBe("M BACKLOG.md");
    } finally {
      await app.close();
    }
  });

  it("serves health, repository registration, planning, and build creation", async () => {
    const runtimeHome = await temporaryRoot("runtime");
    const repositoryPath = await createFixtureRepository();
    const environment = resolveEnvironment({
      AGENTFLOW_HOME: runtimeHome,
      AGENTFLOW_LOG_LEVEL: "silent",
      AGENTFLOW_CODEX_BIN: "/definitely/missing/agentflow-test-codex",
    });
    const { app, context } = await buildApp({
      environment,
      staticRoot: false,
      logger: false,
    });

    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        status: "ok",
        host: "127.0.0.1:4782",
        runtime: {
          home: runtimeHome,
          pid: process.pid,
        },
        database: { status: "ok", journalMode: "wal" },
        resources: {
          workerCapacity: 4,
          busyWorkers: 0,
          availableWorkers: 4,
        },
        agentProviders: {
          default: "codex",
          configured: [{ id: "codex", execution: "local" }],
        },
        runners: { total: 0, online: 0, availableSlots: 0 },
      });

      const runnerRegistration = await app.inject({
        method: "POST",
        url: "/api/runners/register",
        payload: {
          name: "remote-linux-1",
          providerId: "codex",
          capacity: 3,
          capabilities: { os: "linux", browser: true },
        },
      });
      expect(runnerRegistration.statusCode).toBe(201);
      const registeredRunner = runnerRegistration.json<{
        runner: { id: string; status: string };
        token: string;
      }>();
      expect(registeredRunner.runner.status).toBe("online");
      expect(registeredRunner.token.length).toBeGreaterThan(32);

      const unauthorizedHeartbeat = await app.inject({
        method: "POST",
        url: "/api/runners/heartbeat",
        payload: { busySlots: 1 },
      });
      expect(unauthorizedHeartbeat.statusCode).toBe(401);

      const heartbeat = await app.inject({
        method: "POST",
        url: "/api/runners/heartbeat",
        headers: { authorization: `Bearer ${registeredRunner.token}` },
        payload: { busySlots: 1 },
      });
      expect(heartbeat.statusCode).toBe(200);
      expect(heartbeat.json()).toMatchObject({
        id: registeredRunner.runner.id,
        busySlots: 1,
        capacity: 3,
      });

      const registered = await app.inject({
        method: "POST",
        url: "/api/repositories",
        payload: { path: repositoryPath },
      });
      expect(registered.statusCode).toBe(201);
      const repository = registered.json<{
        id: string;
        localPath: string;
        status: string;
      }>();
      expect(repository).toMatchObject({
        localPath: repositoryPath,
        status: "ready",
      });

      const knowledgeScan = await app.inject({
        method: "POST",
        url: `/api/repositories/${repository.id}/knowledge/scan`,
      });
      expect(knowledgeScan.statusCode).toBe(201);
      const knowledgePayload = knowledgeScan.json<{
        snapshot: {
          repositoryId: string;
          nodeCount: number;
          edgeCount: number;
        };
      }>();
      expect(knowledgePayload).toMatchObject({
        snapshot: {
          repositoryId: repository.id,
        },
      });
      expect(knowledgePayload.snapshot.nodeCount).toBeGreaterThan(0);
      expect(knowledgePayload.snapshot.edgeCount).toBeGreaterThanOrEqual(0);
      const impact = await app.inject({
        method: "POST",
        url: `/api/repositories/${repository.id}/knowledge/impact`,
        payload: { changedPaths: ["src/index.js"] },
      });
      expect(impact.statusCode).toBe(200);
      expect(impact.json()).toMatchObject({
        summary: {
          directFiles: 1,
          transitiveFiles: 0,
          activeTasks: 0,
          maximumDistance: 0,
        },
        impactedFiles: [{ path: "src/index.js", distance: 0 }],
      });

      const planned = await app.inject({
        method: "POST",
        url: "/api/plans",
        payload: { repositoryId: repository.id },
      });
      expect(planned.statusCode).toBe(201);
      const plan = planned.json<{
        id: string;
        waves: string[][];
        estimates: { criticalPathHours: number };
      }>();
      expect(plan.waves).toEqual([["BL-100"], ["BL-101"]]);
      expect(plan.estimates.criticalPathHours).toBe(5);

      const buildResponse = await app.inject({
        method: "POST",
        url: "/api/builds",
        payload: { planId: plan.id },
      });
      expect(buildResponse.statusCode).toBe(201);
      const build = buildResponse.json<{
        id: string;
        status: string;
        tasks: Array<{ id: string; state: string }>;
      }>();
      expect(build.status).toBe("ready");
      expect(build.tasks.map((task) => task.state)).toEqual([
        "ready",
        "blocked",
      ]);
      const remoteTask = build.tasks[0];
      expect(remoteTask).toBeDefined();
      context.store.remoteJobs.queue({
        id: "remote_job_api_1",
        buildId: build.id,
        taskId: remoteTask?.id ?? "",
        attempt: 1,
        providerId: "codex",
        payload: { prompt: "Fixture remote task" },
      });
      const claim = await app.inject({
        method: "POST",
        url: "/api/remote-jobs/claim",
        headers: { authorization: `Bearer ${registeredRunner.token}` },
      });
      expect(claim.statusCode).toBe(200);
      const claimed = claim.json<{
        job: { id: string; status: string };
        leaseToken: string;
      }>();
      expect(claimed.job).toMatchObject({
        id: "remote_job_api_1",
        status: "leased",
      });
      const jobHeartbeat = await app.inject({
        method: "POST",
        url: "/api/remote-jobs/remote_job_api_1/heartbeat",
        headers: {
          authorization: `Bearer ${registeredRunner.token}`,
          "x-agentflow-lease-token": claimed.leaseToken,
        },
      });
      expect(jobHeartbeat.statusCode).toBe(200);
      const remoteCompletion = vi.spyOn(
        context.coordinator,
        "completeRemoteJob",
      );
      const completedRemoteJob = await app.inject({
        method: "POST",
        url: "/api/remote-jobs/remote_job_api_1/complete",
        headers: {
          authorization: `Bearer ${registeredRunner.token}`,
          "x-agentflow-lease-token": claimed.leaseToken,
          "idempotency-key": "fixture-result-1",
        },
        payload: {
          status: "completed",
          result: { outcome: "completed", patchSha256: "fixture-patch" },
        },
      });
      expect(completedRemoteJob.statusCode).toBe(200);
      expect(completedRemoteJob.json()).toMatchObject({
        status: "completed",
        result: { patchSha256: "fixture-patch" },
      });
      expect(remoteCompletion).toHaveBeenCalledOnce();
      expect(remoteCompletion.mock.calls[0]?.[0]).toMatchObject({
        id: "remote_job_api_1",
        status: "completed",
      });

      const secondBuild = await app.inject({
        method: "POST",
        url: "/api/builds",
        payload: { planId: plan.id },
      });
      expect(secondBuild.statusCode).toBe(409);

      const secondRepositoryPath = await createFixtureRepository();
      const secondRegistration = await app.inject({
        method: "POST",
        url: "/api/repositories",
        payload: { path: secondRepositoryPath },
      });
      const secondRepository = secondRegistration.json<{ id: string }>();
      const secondPlanResponse = await app.inject({
        method: "POST",
        url: "/api/plans",
        payload: { repositoryId: secondRepository.id },
      });
      const secondPlan = secondPlanResponse.json<{ id: string }>();
      const parallelBuild = await app.inject({
        method: "POST",
        url: "/api/builds",
        payload: { planId: secondPlan.id },
      });
      expect(parallelBuild.statusCode).toBe(201);
      expect(parallelBuild.json()).toMatchObject({
        repositoryId: secondRepository.id,
        status: "ready",
      });
      const activeBuilds = await app.inject({
        method: "GET",
        url: "/api/builds?scope=active&limit=1",
      });
      expect(activeBuilds.statusCode).toBe(200);
      expect(activeBuilds.json<Array<{ status: string }>>()).toHaveLength(1);
      expect(activeBuilds.json<Array<{ status: string }>>()[0]?.status).toBe(
        "ready",
      );
      const terminalBuilds = await app.inject({
        method: "GET",
        url: "/api/builds?scope=terminal",
      });
      expect(terminalBuilds.statusCode).toBe(200);
      expect(terminalBuilds.json()).toEqual([]);

      const started = await app.inject({
        method: "POST",
        url: `/api/builds/${build.id}/start`,
      });
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({ status: "running" });
    } finally {
      await app.close();
    }
  });

  it("rejects retry races before reactivating a terminal failed build", async () => {
    const { app, context, build } =
      await createReadyBuildApplication("retry");
    const failedTask = build.tasks[0];
    const dependentTask = build.tasks[1];
    expect(failedTask).toBeDefined();
    expect(dependentTask).toBeDefined();

    try {
      context.store.builds.transition(build.id, "running", {
        eventType: "test.build_started",
      });
      context.store.tasks.transition(failedTask?.id ?? "", "running");
      context.store.tasks.transition(failedTask?.id ?? "", "failed", {
        errorCode: "TEST_FAILURE",
        errorMessage: "The first attempt failed.",
      });
      context.store.tasks.transition(
        dependentTask?.id ?? "",
        "blocked_failed",
      );
      context.store.builds.transition(build.id, "failed", {
        eventType: "test.build_failed",
        actualElapsedSeconds: 73,
      });
      const internals = context.coordinator as unknown as {
        closed: boolean;
        taskOperations: Map<string, Promise<void>>;
      };
      internals.closed = true;
      internals.taskOperations.set(
        failedTask?.id ?? "",
        Promise.resolve(),
      );

      const racingRetry = await app.inject({
        method: "POST",
        url: `/api/builds/${build.id}/tasks/${failedTask?.id ?? ""}/retry`,
      });

      expect(racingRetry.statusCode).toBe(409);
      expect(racingRetry.json()).toMatchObject({
        error: { code: "TASK_OPERATION_IN_PROGRESS" },
      });
      expect(context.store.builds.getById(build.id)).toMatchObject({
        status: "failed",
        actualElapsedSeconds: 73,
      });
      expect(context.store.tasks.getById(failedTask?.id ?? "")).toMatchObject({
        state: "failed",
        attempt: 0,
      });

      internals.taskOperations.delete(failedTask?.id ?? "");
      const retried = await app.inject({
        method: "POST",
        url: `/api/builds/${build.id}/tasks/${failedTask?.id ?? ""}/retry`,
      });

      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toMatchObject({
        state: "ready",
        attempt: 1,
        resultCommit: null,
        integrationCommit: null,
        errorCode: null,
        errorMessage: null,
      });
      expect(context.store.builds.getById(build.id)).toMatchObject({
        status: "running",
        actualElapsedSeconds: null,
        completedAt: null,
      });
      expect(
        context.store.tasks.listAttempts(failedTask?.id ?? ""),
      ).toEqual([
        expect.objectContaining({
          attempt: 1,
          status: "queued",
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("automatically retries transient worker failures up to policy limit", async () => {
    const { app, context, build } = await createReadyBuildApplication(
      "automatic-retry",
      {
        AGENTFLOW_RETRY_MAX_ATTEMPTS: "2",
        AGENTFLOW_RETRY_BASE_DELAY_MS: "100",
        AGENTFLOW_RETRY_MAX_DELAY_MS: "100",
      },
    );
    const task = build.tasks[0];
    expect(task).toBeDefined();

    try {
      const started = await app.inject({
        method: "POST",
        url: `/api/builds/${build.id}/start`,
      });
      expect(started.statusCode).toBe(200);
      await waitUntil(
        () => {
          const current = context.store.tasks.getById(task?.id ?? "");
          return current.attempt === 2 && current.state === "failed";
        },
        5_000,
      );
      expect(context.store.retrySchedules.get(task?.id ?? "")).toBeUndefined();
      const eventTypes = context.store.events
        .listForBuild(build.id)
        .map((event) => event.type);
      expect(eventTypes).toContain("task.retry_scheduled");
      expect(eventTypes).toContain("task.automatic_retry_started");
      expect(eventTypes).toContain("task.retry_not_scheduled");
    } finally {
      await app.close();
    }
  });

  it("recycles a recovered worker slot when its process disappears", async () => {
    const { app, context, build } =
      await createReadyBuildApplication("dead-worker");
    const task = build.tasks[0];
    expect(task).toBeDefined();

    try {
      context.store.builds.transition(build.id, "running", {
        eventType: "test.build_started",
      });
      const idleWorker = context.store.workers.listForBuild(build.id)[0];
      expect(idleWorker).toBeDefined();
      const assigned = context.store.workers.assign({
        workerId: idleWorker?.id ?? "",
        taskId: task?.id ?? "",
        processId: 2_147_483_647,
      });
      (
        context.coordinator as unknown as { closed: boolean }
      ).closed = true;
      vi.useFakeTimers();

      context.coordinator.monitorExistingProcess(
        context.store.builds.getById(build.id),
        context.store.tasks.getById(task?.id ?? ""),
        assigned,
      );
      await vi.advanceTimersByTimeAsync(5_000);

      expect(context.store.tasks.getById(task?.id ?? "")).toMatchObject({
        state: "interrupted",
        errorCode: "WORKER_PROCESS_DISAPPEARED",
      });
      expect(context.store.tasks.getAttempt(task?.id ?? "", 1)).toMatchObject({
        status: "interrupted",
        errorCode: "WORKER_PROCESS_DISAPPEARED",
      });
      expect(context.store.workers.getById(assigned.id)).toMatchObject({
        status: "idle",
        taskId: null,
        processId: null,
      });
      expect(
        context.store.events
          .listForBuild(build.id)
          .map((event) => event.type),
      ).toEqual(
        expect.arrayContaining([
          "recovery.monitored_process_ended",
          "worker.failed",
          "worker.recycled",
        ]),
      );
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it("aborts registered task operations and cancels active pipeline states", async () => {
    const { app, context, build } =
      await createReadyBuildApplication("cancel-active");
    const validatingTask = build.tasks[0];
    const integratingTask = build.tasks[1];
    expect(validatingTask).toBeDefined();
    expect(integratingTask).toBeDefined();

    try {
      context.store.builds.transition(build.id, "running", {
        eventType: "test.build_started",
      });
      context.store.tasks.transition(validatingTask?.id ?? "", "running");
      context.store.tasks.transition(validatingTask?.id ?? "", "validating");
      context.store.tasks.transition(integratingTask?.id ?? "", "ready");
      context.store.tasks.transition(integratingTask?.id ?? "", "running");
      context.store.tasks.transition(integratingTask?.id ?? "", "validating");
      context.store.tasks.transition(integratingTask?.id ?? "", "validated");
      context.store.tasks.transition(integratingTask?.id ?? "", "integrating");
      const validatingController = new AbortController();
      const integratingController = new AbortController();
      const internals = context.coordinator as unknown as {
        taskAbortControllers: Map<string, AbortController>;
      };
      internals.taskAbortControllers.set(
        validatingTask?.id ?? "",
        validatingController,
      );
      internals.taskAbortControllers.set(
        integratingTask?.id ?? "",
        integratingController,
      );

      const cancelled = await app.inject({
        method: "POST",
        url: `/api/builds/${build.id}/cancel`,
      });

      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ status: "cancelled" });
      expect(validatingController.signal.aborted).toBe(true);
      expect(integratingController.signal.aborted).toBe(true);
      expect(
        context.store.tasks.getById(validatingTask?.id ?? "").state,
      ).toBe("cancelled");
      expect(
        context.store.tasks.getById(integratingTask?.id ?? "").state,
      ).toBe("cancelled");
    } finally {
      await app.close();
    }
  });

  it("serves the built application from the production server", async () => {
    const runtimeHome = await temporaryRoot("runtime-static");
    const staticRoot = await temporaryRoot("static");
    await writeFile(
      path.join(staticRoot, "index.html"),
      "<!doctype html><title>AgentFlow control plane</title>",
    );
    const environment = resolveEnvironment({
      AGENTFLOW_HOME: runtimeHome,
      AGENTFLOW_LOG_LEVEL: "silent",
    });
    const { app } = await buildApp({
      environment,
      staticRoot,
      logger: false,
    });

    try {
      const response = await app.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("AgentFlow control plane");
    } finally {
      await app.close();
    }
  });

  it("reports database diagnostics and creates a consistent backup", async () => {
    const runtimeHome = await temporaryRoot("runtime-backup");
    const environment = resolveEnvironment({
      AGENTFLOW_HOME: runtimeHome,
      AGENTFLOW_LOG_LEVEL: "silent",
    });
    const { app } = await buildApp({
      environment,
      staticRoot: false,
      logger: false,
    });

    try {
      const diagnostics = await app.inject({
        method: "GET",
        url: "/api/system/database",
      });
      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json()).toMatchObject({
        ok: true,
        foreignKeysEnabled: true,
        journalMode: "wal",
      });

      const backup = await app.inject({
        method: "POST",
        url: "/api/system/database/backup",
      });
      expect(backup.statusCode).toBe(201);
      const backupResult = backup.json<{ path: string }>();
      expect(backupResult.path).toContain(environment.backupsPath);
    } finally {
      await app.close();
    }
  });
});

async function createReadyBuildApplication(
  label: string,
  environmentOverrides: NodeJS.ProcessEnv = {},
) {
  const runtimeHome = await temporaryRoot(`runtime-${label}`);
  const repositoryPath = await createFixtureRepository();
  const environment = resolveEnvironment({
    AGENTFLOW_HOME: runtimeHome,
    AGENTFLOW_LOG_LEVEL: "silent",
    AGENTFLOW_CODEX_BIN: "/definitely/missing/agentflow-test-codex",
    ...environmentOverrides,
  });
  const application = await buildApp({
    environment,
    staticRoot: false,
    logger: false,
  });

  try {
    const registered = await application.app.inject({
      method: "POST",
      url: "/api/repositories",
      payload: { path: repositoryPath },
    });
    if (registered.statusCode !== 201) {
      throw new Error(`Repository registration failed: ${registered.body}`);
    }
    const repository = registered.json<{ id: string }>();
    const planned = await application.app.inject({
      method: "POST",
      url: "/api/plans",
      payload: { repositoryId: repository.id },
    });
    if (planned.statusCode !== 201) {
      throw new Error(`Planning failed: ${planned.body}`);
    }
    const plan = planned.json<{ id: string }>();
    const buildResponse = await application.app.inject({
      method: "POST",
      url: "/api/builds",
      payload: { planId: plan.id },
    });
    if (buildResponse.statusCode !== 201) {
      throw new Error(`Build creation failed: ${buildResponse.body}`);
    }
    return {
      ...application,
      build: buildResponse.json<{
        id: string;
        tasks: Array<{
          id: string;
          backlogTaskId: string;
          state: string;
          attempt: number;
        }>;
      }>(),
    };
  } catch (error) {
    await application.app.close();
    throw error;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function createFixtureRepository(): Promise<string> {
  const root = await temporaryRoot("repository");
  await execFileAsync("git", ["init", "--initial-branch=main", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "AgentFlow Test"]);
  await execFileAsync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "agentflow@example.test",
  ]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "agentflow-api-fixture",
        private: true,
        scripts: {
          lint: "node --check src/index.js",
          typecheck: "node --check src/index.js",
          test: "node --test",
          build: "node --check src/index.js",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(root, "src", "index.js"), "export const ok = true;\n");
  await writeFile(
    path.join(root, "BACKLOG.md"),
    `# Fixture backlog

## BL-100 - Define local contract

\`\`\`yaml
estimate_hours: 2
depends_on: []
owns:
  - contracts/example/
validate:
  - npm run typecheck
produces:
  - name: example-contract
    type: json-schema
    version: 1.0.0
    path: contracts/example/schema.json
\`\`\`

Create the contract.

### Acceptance Criteria

- The schema is versioned.

## BL-101 - Implement consumer

\`\`\`yaml
estimate_hours: 3
depends_on:
  - BL-100
owns:
  - src/
consumes:
  - task: BL-100
    artifact: example-contract
    version: 1.0.0
\`\`\`

Implement the consumer.

### Acceptance Criteria

- The consumer validates the example.
`,
  );
  await writeFile(
    path.join(root, ".agentflow.yaml"),
    `version: 1
repository:
  name: agentflow-api-fixture
  base_branch: main
backlog:
  path: BACKLOG.md
workers:
  maximum: 4
contracts:
  roots:
    - contracts/
validation:
  task_default:
    - npm run typecheck
  integration:
    - npm run typecheck
docker:
  enabled: false
  compose_file: compose.yaml
git:
  remote: origin
  push_task_branches: false
  push_integration_branch: false
  open_integration_pull_request: false
`,
  );
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "fixture"]);
  return root;
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `agentflow-${label}-`));
  temporaryRoots.add(root);
  return root;
}
