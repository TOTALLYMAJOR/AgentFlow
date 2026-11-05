import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerErrorHandling } from "../src/http/errors.js";
import { registerDesignIntelligenceRoutes } from "../src/http/routes/design-intelligence.js";
import type { AgentFlowContext } from "../src/http/context.js";
import { createDatabaseRepositories } from "../src/db/index.js";
import { resolveEnvironment } from "../src/config/environment.js";
import { DEFAULT_ORGANIZATION_POLICY } from "../src/governance/organization-policy.js";
import { HandoffManifestService } from "../src/artifacts/index.js";
import { evaluateGovernedBuild } from "../src/governor/build-control.js";
import { GovernorControlService } from "../src/governor/control-service.js";
import { canonicalJsonSha256, renderBacklog, NATIVE_VALIDATION_EVIDENCE_TYPE, NATIVE_VALIDATION_EVIDENCE_VERSION } from "../src/integration/design-intelligence.js";
import { fingerprintFailure } from "../src/integration/traffic-control.js";
import { GitCommandRunner } from "../src/git/index.js";
import { BuildCoordinator } from "../src/orchestration/coordinator.js";
import { planBacklogMarkdown } from "../src/planning/planner.js";
import { createDatabaseFixture, type DatabaseFixture } from "./helpers/database-fixture.js";
import { approvedGovernedHandoff } from "./helpers/governed-handoff.js";

describe("current native Governor failure attribution", () => {
  let fixture: DatabaseFixture | undefined;
  let coordinator: BuildCoordinator | undefined;
  afterEach(async () => { await coordinator?.shutdown(); vi.restoreAllMocks(); vi.useRealTimers(); fixture?.cleanup(); fixture = undefined; coordinator = undefined; });


  it.each([false, true])("retains the original observation state across runtime limit changes (strict=%s)", async (strict) => {
    const { store, dependencies, observed } = await setup(true, strict);
    const originalLimit = dependencies.environment.retryMaximumAttempts;
    try {
      dependencies.environment.retryMaximumAttempts = 1;
      const first = await evaluateGovernedBuild(dependencies, "build");
      const firstInput = observed.mock.calls.at(-1)?.[0];
      if (first === undefined || firstInput === undefined) throw new Error("First native evaluation was not observed");
      const firstObservation = structuredClone(firstInput.observation);
      dependencies.environment.retryMaximumAttempts = 2;
      const second = await evaluateGovernedBuild(dependencies, "build");
      const secondInput = observed.mock.calls.at(-1)?.[0];
      if (second === undefined || secondInput === undefined) throw new Error("Second native evaluation was not observed");
      const secondObservation = structuredClone(secondInput.observation);
      const events = store.events.listForBuild("build").filter((event) => event.type === "governor.decision");
      expect(events).toHaveLength(2);
      const [firstEvent, secondEvent] = events;
      if (firstEvent === undefined || secondEvent === undefined) throw new Error("Native decisions were not retained");
      expect(first.decision).toEqual(second.decision);
      expect(first.record.observationHash).not.toBe(second.record.observationHash);
      expect(firstEvent.payload.observationState).toEqual({ phase: "RUNNING", attempt: 1, maxAttempts: 1 });
      expect(secondEvent.payload.observationState).toEqual({ phase: "RUNNING", attempt: 1, maxAttempts: 2 });
      const retainedFirst = firstEvent.payload.observationState as Record<string, unknown>;
      expect(canonicalJsonSha256({ ...secondObservation, ...retainedFirst })).toBe(first.record.observationHash);
      expect(canonicalJsonSha256(firstObservation)).toBe(first.record.observationHash);
      expect(secondEvent.payload.previousRecordHash).toBe(first.record.recordHash);
      // A digest match is required; the later live retry limit is not historical proof.
      expect(canonicalJsonSha256({ ...firstObservation, maxAttempts: 2 })).not.toBe(first.record.observationHash);
      expect(firstEvent.payload).not.toHaveProperty("observation");
      expect(store.builds.getById("build").status).toBe("running");
      expect(store.tasks.getById("task").state).toBe("running");
    } finally {
      dependencies.environment.retryMaximumAttempts = originalLimit;
    }
  });

  it.each([false, true])("retains exact native source lineage without inventing task revisions (strict=%s)", async (strict) => {
    const { store, dependencies, observed, handoff } = await setup(true, strict);
    const build = store.builds.getById("build");
    const task = store.tasks.getById("task");
    const attempt = store.tasks.getAttempt("task", 1);
    const priorEvents = store.events.listForBuild("build");
    const first = await evaluateGovernedBuild(dependencies, "build");
    if (first === undefined) throw new Error("Expected native evaluation");
    const firstEvent = store.events.listForBuild("build").find((event) => event.type === "governor.decision");
    if (firstEvent === undefined) throw new Error("Expected retained native decision");
    const sources = firstEvent.payload.nativeSources as Record<string, unknown>;
    expect(sources).toMatchObject({
      build: { id: "build", repositoryId: "repo", planId: "plan", baseCommit: build.baseCommit, sha256: canonicalJsonSha256(build) },
      handoff: { id: handoff.handoffId, sha256: canonicalJsonSha256(handoff), governedBaseCommit: handoff.repository.baseCommit },
      tasks: [{ id: "task", backlogTaskId: "AF-001", buildId: "build", baseCommit: null, resultCommit: null, integrationCommit: null, sha256: canonicalJsonSha256(task), attempts: [{ id: attempt.id, taskId: "task", buildId: "build", attempt: 1, resultCommit: null, sha256: canonicalJsonSha256(attempt), changedFilesSha256: canonicalJsonSha256([]) }] }],
      events: { throughSequence: priorEvents.at(-1)?.sequence ?? 0, count: priorEvents.length, sha256: canonicalJsonSha256(priorEvents) },
      certificates: [],
    });
    expect(firstEvent.payload.observationHash).toBe(first.record.observationHash);
    expect(canonicalJsonSha256(observed.mock.calls.at(-1)?.[0].observation)).toBe(first.record.observationHash);
    // A new attempt result must not rewrite the retained older source context.
    store.tasks.updateAttempt("task", 1, { status: "running", resultCommit: "c".repeat(40), errorMessage: "private-lineage-sentinel" });
    const second = await evaluateGovernedBuild(dependencies, "build");
    const secondEvent = store.events.listForBuild("build").filter((event) => event.type === "governor.decision").at(-1);
    if (second === undefined || secondEvent === undefined) throw new Error("Expected second native decision");
    const secondSources = secondEvent.payload.nativeSources as { tasks: Array<{ attempts: Array<{ resultCommit: string | null; sha256: string }> }> };
    expect(secondSources.tasks[0]?.attempts[0]).toMatchObject({ resultCommit: "c".repeat(40), sha256: canonicalJsonSha256(store.tasks.getAttempt("task", 1)) });
    expect(first.record.observationHash).toBe(second.record.observationHash);
    expect(firstEvent.payload.nativeSources).toEqual(sources);
    expect(JSON.stringify(secondSources)).not.toContain("private-lineage-sentinel");
    expect(JSON.stringify(secondSources)).not.toContain(dependencies.environment.runsPath);
    expect(store.builds.getById("build").status).toBe("running");
  });

  it.each(["attempt", "changed-files"])("refuses %s drift across native evidence reads before retaining a decision", async (defect) => {
    const { store, dependencies, observed } = await setup(true, true);
    const nativeList = store.tasks.listForBuild.bind(store.tasks);
    let reads = 0;
    vi.spyOn(store.tasks, "listForBuild").mockImplementation((id) => {
      reads += 1;
      if (reads === 2) {
        if (defect === "attempt") store.tasks.updateAttempt("task", 1, { status: "running", resultCommit: "d".repeat(40) });
        else store.tasks.recordChangedFiles("task", 1, [{ path: "outside/ownership.ts", changeType: "modified", withinOwnership: false }]);
      }
      return nativeList(id);
    });
    await expect(evaluateGovernedBuild(dependencies, "build")).rejects.toThrow("GOVERNED_OBSERVATION_SOURCE_CHANGED");
    expect(observed).not.toHaveBeenCalled();
    expect(store.events.listForBuild("build").filter((event) => event.type === "governor.decision")).toEqual([]);
    expect(store.builds.getById("build").status).toBe("running");
    expect(store.tasks.getById("task").state).toBe("running");
  });

  async function setup(withNativePlan = false, strictNativeEvidence = false, buildStatus: "running" | "ready" = "running") {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    const root = path.join(fixture.directory, "repository");
    await mkdir(root);
    const handoff = approvedGovernedHandoff({
      handoffId: "recovery-failure-test", baseCommit: "a".repeat(40),
      objective: "Unit-only native failure attribution.", requiredEvidence: ["focused-tests"], claimBoundary: "Unit test only; no execution approval.",
      tasks: [{ id: "AF-001", title: "Task", description: "Task", estimateHours: 1, dependsOn: [], owns: ["src"], acceptanceCriteria: ["Passes"], validate: ["npm test"], produces: strictNativeEvidence ? [{ name: "focused-tests", type: NATIVE_VALIDATION_EVIDENCE_TYPE, version: NATIVE_VALIDATION_EVIDENCE_VERSION }] : [], consumes: [] }],
    });
    const handoffPath = path.join(root, "handoff.json");
    await writeFile(handoffPath, JSON.stringify(handoff));
    store.repositories.create({ id: "repo", name: "test", localPath: root, configPath: ".agentflow.yaml", baseBranch: "main" });
    const binding = { id: handoff.handoffId, sha256: canonicalJsonSha256(handoff), path: "handoff.json", governedBaseCommit: handoff.repository.baseCommit, carrierPaths: ["handoff.json", "BACKLOG.md"], proofBoundary: handoff.proof.claimBoundary };
    let nativePlan;
    if (withNativePlan) {
      const backlogContents = renderBacklog(handoff, "handoff.json", "BACKLOG.md");
      const planned = planBacklogMarkdown(backlogContents).plan;
      if (planned === undefined) throw new Error("Expected the existing native governed fixture plan");
      nativePlan = { ...planned, id: "plan", repositoryId: "repo", backlogPath: "BACKLOG.md", backlogSha256: createHash("sha256").update(backlogContents).digest("hex"), createdAt: new Date().toISOString(), governedHandoff: binding };
      store.plans.create({ id: nativePlan.id, repositoryId: "repo", backlogPath: "BACKLOG.md", backlogSha256: nativePlan.backlogSha256, backlogContents, repositoryConfig: {}, normalizedPlan: nativePlan });
      store.plans.lock(nativePlan.id);
    }
    store.builds.create({
      id: "build", repositoryId: "repo", backlogPath: "BACKLOG.md", baseCommit: handoff.repository.baseCommit,
      ...(nativePlan === undefined ? {} : { planId: nativePlan.id }),
      integrationBranch: "integration", status: buildStatus,
      normalizedPlan: nativePlan ?? { governedHandoff: binding },
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



  describe("AFI-002 native intervention provenance", () => {
    const scenarios = ["continue", "repair", "retry", "exhausted", "missing-proof", "replan"] as const;
    const cases = (["http", "coordinator"] as const).flatMap((boundary) =>
      scenarios.map((scenario) => ({ boundary, scenario })),
    );

    async function exerciseProvenance(
      boundary: "http" | "coordinator",
      scenario: typeof scenarios[number],
      loseReadback = false,
    ) {
      const { store, dependencies } = await setup(true);
      if (scenario === "missing-proof") {
        store.tasks.transition("task", "validating");
        store.tasks.transition("task", "validated", { resultCommit: "b".repeat(40) });
        store.tasks.updateAttempt("task", 1, { status: "succeeded", resultCommit: "b".repeat(40) });
      } else if (scenario !== "continue") {
        const code = scenario === "retry" || scenario === "exhausted" ? "PROVIDER_UNAVAILABLE" : "VALIDATION_FAILED";
        const attempts = scenario === "replan" ? 3 : 1;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          store.tasks.transition("task", "failed", { errorCode: code, errorMessage: "same inert failure" });
          store.tasks.updateAttempt("task", attempt, { status: "failed", errorCode: code, errorMessage: "same inert failure" });
          if (attempt < attempts) { store.tasks.retry("task"); store.tasks.transition("task", "running"); }
        }
        if (scenario === "exhausted") dependencies.environment.retryMaximumAttempts = 1;
      }
      const getProvider = vi.fn(() => { throw new Error("Provenance qualification must not dispatch"); });
      coordinator = new BuildCoordinator({
        ...dependencies,
        handoffService: new HandoffManifestService(store, dependencies.environment.artifactsPath),
        agentProviders: { get: getProvider },
      } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
      if (loseReadback) {
        let pendingReadback = false;
        const nativeGet = store.builds.getById.bind(store.builds);
        vi.spyOn(store.builds, "getById").mockImplementation((...args) => {
          if (pendingReadback) { pendingReadback = false; throw new Error("inert post-action readback unavailable"); }
          return nativeGet(...args);
        });
        const nativePause = coordinator.pause.bind(coordinator);
        vi.spyOn(coordinator, "pause").mockImplementation((id) => {
          const result = nativePause(id);
          pendingReadback = true;
          return result;
        });
      }
      const app = Fastify({ logger: false });
      registerErrorHandling(app);
      registerDesignIntelligenceRoutes(app, { ...dependencies, coordinator } as unknown as AgentFlowContext);
      try {
        if (boundary === "http") {
          const response = await app.inject({ method: "POST", url: "/api/builds/build/governor/evaluate" });
          expect(response.statusCode).toBe(200);
        } else {
          const native = coordinator as unknown as { governBuild(id: string): Promise<unknown> };
          await native.governBuild("build");
        }
        const actions = {
          continue: "CONTINUE", repair: "REQUEST_REPAIR", retry: "DELEGATE_RETRY",
          exhausted: "PAUSE_FOR_REVIEW", "missing-proof": "BLOCK_INTEGRATION", replan: "PROPOSE_REPLAN",
        };
        const shouldPause = !["continue", "retry"].includes(scenario) && !(boundary === "http" && scenario === "replan");
        const expectedState = shouldPause ? "paused" : "running";
        const expectedAck = boundary === "coordinator" || !["retry", "replan"].includes(scenario);
        const events = store.events.listForBuild("build");
        const decision = events.find((event) => event.type === "governor.decision");
        const outcomes = events.filter((event) => event.type === "governor.intervention_acknowledged");
        const outcome = outcomes[0];
        if (decision === undefined || outcome === undefined) throw new Error("Expected native decision and acknowledgement");
        expect(outcomes).toHaveLength(1);
        expect(events.some((event) => event.type === "governor.evaluation_failed")).toBe(false);
        expect(decision.payload.decision).toMatchObject({ action: actions[scenario] });
        expect(outcome.payload).toMatchObject({
          invocationSource: boundary === "http" ? "local-http-api" : "agentflow-coordinator",
          decisionRecordHash: decision.payload.recordHash,
          action: actions[scenario],
          acknowledged: expectedAck,
          details: {
            runtimeApplyInvoked: boundary === "http" || shouldPause,
            acknowledgementAvailable: true,
            receiptPersistAttempted: true,
            observedBuildStatusBefore: "running",
          },
        });
        const details = outcome.payload.details as Record<string, unknown>;
        if (loseReadback) expect(details).not.toHaveProperty("observedBuildStatusAfter");
        else expect(details.observedBuildStatusAfter).toBe(expectedState);
        expect(outcome.sequence).toBeGreaterThan(decision.sequence);
        expect(Number.isFinite(Date.parse(outcome.occurredAt))).toBe(true);
        expect(store.builds.getById("build").status).toBe(expectedState);
        expect(store.tasks.listAttempts("task")).toHaveLength(scenario === "replan" ? 3 : 1);
        expect(store.retrySchedules.list()).toEqual([]);
        expect(getProvider).not.toHaveBeenCalled();
        // A service entry point is not an authenticated human or causal proof.
        expect(outcome.payload).not.toHaveProperty("actor");
        expect(details).not.toHaveProperty("appliedEffect");
      } finally { await app.close(); }
    }

    it.each(cases)("$boundary records native $scenario source and observed state", async ({ boundary, scenario }) => {
      await exerciseProvenance(boundary, scenario);
    });

    it.each(["http", "coordinator"] as const)("%s keeps returned acknowledgement when optional post-action readback fails", async (boundary) => {
      await exerciseProvenance(boundary, "repair", true);
    });
  });

  describe("TCP-003 durable intervention errors", () => {
    type Boundary = "http" | "coordinator";

    async function exercise(boundary: Boundary, afterEffect: boolean, receiptFailure = false, readbackFailure = false) {
      const commitsEffect = afterEffect || receiptFailure || (readbackFailure && boundary === "coordinator");
      const { store, dependencies } = await setup(true, false, !commitsEffect && boundary === "coordinator" ? "ready" : "running");
      store.tasks.transition("task", "failed", { errorCode: "VALIDATION_FAILED", errorMessage: "inert current failure" });
      store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: "VALIDATION_FAILED", errorMessage: "inert current failure" });
      if (!commitsEffect && !readbackFailure && boundary === "http") store.builds.transition("build", "paused");

      let providerCalls = 0;
      coordinator = new BuildCoordinator({
        ...dependencies,
        handoffService: new HandoffManifestService(store, dependencies.environment.artifactsPath),
        agentProviders: { get: () => { providerCalls += 1; throw new Error("TCP-003 QA must never dispatch a provider"); } },
      } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
      const nativePause = coordinator.pause.bind(coordinator);
      if (receiptFailure || readbackFailure) {
        const nativeAppend = store.events.append.bind(store.events);
        let failAcknowledgement = true;
        let pendingReadback = false;
        if (readbackFailure && boundary === "http") {
          const nativeList = store.tasks.listForBuild.bind(store.tasks);
          vi.spyOn(store.tasks, "listForBuild").mockImplementation((...args) => {
            if (pendingReadback) { pendingReadback = false; throw new Error("inert native task readback failure before runtime apply"); }
            return nativeList(...args);
          });
        } else if (readbackFailure) {
          const nativeGet = store.builds.getById.bind(store.builds);
          vi.spyOn(store.builds, "getById").mockImplementation((...args) => {
            if (pendingReadback) { pendingReadback = false; throw new Error("inert native build readback failure before runtime apply"); }
            return nativeGet(...args);
          });
        }
        vi.spyOn(store.events, "append").mockImplementation((input) => {
          if (receiptFailure && input.type === "governor.intervention_acknowledged" && failAcknowledgement) {
            failAcknowledgement = false;
            throw new Error("inert journal failure after runtime acknowledgement returned");
          }
          const event = nativeAppend(input);
          if (readbackFailure && input.type === "governor.decision") pendingReadback = true;
          return event;
        });
      }
      if (afterEffect) {
        // Keep the real native transaction and build.paused event. Only its
        // returned result is lost, as a caller can observe after a boundary error.
        vi.spyOn(coordinator, "pause").mockImplementation((id) => {
          nativePause(id);
          throw new Error("inert error after native pause committed");
        });
      }
      const native = coordinator as unknown as {
        governBuild(buildId: string): Promise<{ continue: boolean; delegateRetry: boolean } | undefined>;
      };
      const app = Fastify({ logger: false });
      registerErrorHandling(app);
      registerDesignIntelligenceRoutes(app, { ...dependencies, coordinator } as unknown as AgentFlowContext);
      const initialStatus = store.builds.getById("build").status;
      const initialPauseCount = store.events.listForBuild("build").filter((event) => event.type === "build.paused").length;
      const responses: unknown[] = [];
      try {
        for (let number = 0; number < 2; number += 1) {
          if (boundary === "http") {
            const response = await app.inject({ method: "POST", url: "/api/builds/build/governor/evaluate" });
            responses.push({ status: response.statusCode, body: response.json<unknown>() });
          } else {
            try { responses.push(await native.governBuild("build")); }
            catch (error) {
              responses.push({ rejected: true, name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) });
            }
          }
        }
        const events = store.events.listForBuild("build");
        const decisions = events.filter((event) => event.type === "governor.decision");
        const pauseCount = events.filter((event) => event.type === "build.paused").length;
        const firstHash = decisions[0]?.payload.recordHash;
        const outcomes = events.filter((event) => event.type !== "governor.decision" && event.type.startsWith("governor.") && event.payload.decisionRecordHash === firstHash);

        // State and replay assertions are independent of the missing receipt.
        expect(decisions).toHaveLength(2);
        expect(decisions[0]?.payload.decision).toMatchObject({ action: "REQUEST_REPAIR" });
        expect(store.builds.getById("build").status).toBe(commitsEffect ? "paused" : initialStatus);
        expect(pauseCount - initialPauseCount).toBe(commitsEffect ? 1 : 0);
        expect(store.tasks.listAttempts("task")).toHaveLength(1);
        expect(store.retrySchedules.list()).toEqual([]);
        expect(providerCalls).toBe(0);
        if (boundary === "http") {
          expect(responses).toMatchObject([
            { status: commitsEffect || readbackFailure ? 500 : 409, body: { error: { code: commitsEffect || readbackFailure ? "INTERNAL_ERROR" : "STATE_CONFLICT" } } },
            { status: readbackFailure ? 500 : 409, body: { error: { code: readbackFailure ? "INTERNAL_ERROR" : "STATE_CONFLICT" } } },
          ]);
        } else expect(responses).toEqual([{ continue: false, delegateRetry: false }, { continue: false, delegateRetry: false }]);
        // This catches an omitted durable result for a persisted decision.
        // It does not equate an exception with no effect or invent an outcome enum.
        expect(outcomes, "first persisted decision needs a hash-correlated durable handler outcome").toHaveLength(1);
        expect(outcomes[0]?.payload).toMatchObject({ invocationSource: boundary === "http" ? "local-http-api" : "agentflow-coordinator", decisionRecordHash: firstHash, action: "REQUEST_REPAIR", acknowledged: receiptFailure });
        if (commitsEffect && !readbackFailure) {
          expect(outcomes[0]?.payload.details).toMatchObject({ acknowledgementAvailable: receiptFailure, receiptPersistAttempted: receiptFailure, observedBuildStatusBefore: "running", observedBuildStatusAfter: "paused" });
        } else if (readbackFailure) {
          expect(outcomes[0]?.payload.details).toMatchObject({ runtimeApplyInvoked: false, acknowledgementAvailable: false, receiptPersistAttempted: false, observedBuildStatusAfter: "running" });
        }
      } finally { await app.close(); }
    }

    it.each(["http", "coordinator"] as const)("%s retains the decision binding when native state protection refuses before mutation", async (boundary) => {
      await exercise(boundary, false);
    });

    it.each(["http", "coordinator"] as const)("%s retains the decision binding when a native pause commits before the returned outcome is lost", async (boundary) => {
      await exercise(boundary, true);
    });

    it.each(["http", "coordinator"] as const)("%s preserves a returned runtime acknowledgement when journal persistence fails", async (boundary) => {
      await exercise(boundary, false, true);
    });

    it.each(["http", "coordinator"] as const)("%s binds native readback failure without claiming a runtime acknowledgement", async (boundary) => {
      await exercise(boundary, false, false, true);
    });
  });

  it("uses native failure-relative evidence ordering when final task and attempt rows are identical", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T20:00:00Z"));
    const snapshots = [];
    for (const evidenceBefore of [true, false]) {
      const { store, dependencies, observed } = await setup();
      const getProvider = vi.fn(() => { throw new Error("History proof must never dispatch a worker"); });
      coordinator = new BuildCoordinator({ ...dependencies, handoffService: new HandoffManifestService(store, dependencies.environment.artifactsPath), agentProviders: { get: getProvider } } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
      const native = coordinator as unknown as { failTask(taskId: string, eventType: string, errorCode: string, errorMessage: string): unknown };
      const evidence = () => store.events.append({ buildId: "build", type: "evidence.recorded", payload: { items: ["cause:inert"] } });
      if (evidenceBefore) evidence();
      for (let number = 1; number <= 3; number += 1) {
        const failure = { code: "VALIDATION_FAILED", classification: "deterministic" as const, retryable: false, signature: "same", files: [] };
        store.tasks.updateAttempt("task", number, { status: "failed", errorCode: failure.code, errorMessage: failure.signature, completedAt: new Date().toISOString() });
        // Actual coordinator producer captures explicit native source facts;
        // no timestamp/path guess or invented evidence snapshot in the fixture.
        native.failTask("task", "task.validation_failed", failure.code, failure.signature);
        if (number < 3) {
          store.tasks.retry("task", { attemptId: `attempt-${number + 1}` });
          store.tasks.transition("task", "running");
        }
      }
      if (!evidenceBefore) evidence();
      const result = await evaluateGovernedBuild(dependencies, "build");
      expect(store.events.listForBuild("build").filter((event) => event.type === "task.validation_failed")).toHaveLength(3);
      expect(getProvider).not.toHaveBeenCalled();
      snapshots.push({ task: store.tasks.getById("task"), attempts: store.tasks.listAttempts("task"), observation: observed.mock.calls.at(-1)?.[0].observation, action: result?.decision.action });
      await coordinator.shutdown(); coordinator = undefined;
      fixture?.cleanup(); fixture = undefined; vi.restoreAllMocks();
    }
    expect(snapshots[0]?.task).toEqual(snapshots[1]?.task);
    expect(snapshots[0]?.attempts).toEqual(snapshots[1]?.attempts);
    expect(snapshots[0]?.observation?.evidence).toEqual(snapshots[1]?.observation?.evidence);
    expect(snapshots[0]?.action).toBe("PROPOSE_REPLAN");
    expect(snapshots[0]?.observation?.evidenceDelta).toMatchObject({ score: 0, direction: "ZERO" });
    expect(snapshots[1]?.action).toBe("REQUEST_REPAIR");
    expect(snapshots[1]?.observation?.evidenceDelta).toMatchObject({ score: 1, direction: "POSITIVE" });
  });

  it("refuses incomplete strict native failure history instead of fabricating an empty baseline", async () => {
    const { store, dependencies } = await setup(false, true);
    store.tasks.transition("task", "failed", { errorCode: "VALIDATION_FAILED", errorMessage: "old failure" });
    store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: "VALIDATION_FAILED", errorMessage: "old failure" });
    await expect(evaluateGovernedBuild(dependencies, "build")).rejects.toThrow("GOVERNED_FAILURE_HISTORY_UNAVAILABLE");
  });

  it("preserves supported legacy failure behavior without upgrading it to sourced history proof", async () => {
    const { store, dependencies } = await setup();
    store.tasks.transition("task", "failed", { errorCode: "VALIDATION_FAILED", errorMessage: "old failure" });
    store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: "VALIDATION_FAILED", errorMessage: "old failure" });
    expect((await evaluateGovernedBuild(dependencies, "build"))?.decision.action).toBe("REQUEST_REPAIR");
  });

  it.each(["duplicate-boundary", "rewritten-attempt"])("refuses a claimed native failure source with %s", async (defect) => {
    const { store, dependencies } = await setup();
    coordinator = new BuildCoordinator({ ...dependencies, handoffService: new HandoffManifestService(store, dependencies.environment.artifactsPath), agentProviders: { get: () => { throw new Error("No provider permitted"); } } } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
    const native = coordinator as unknown as { failTask(taskId: string, eventType: string, code: string, message: string): unknown };
    store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: "VALIDATION_FAILED", errorMessage: "same" });
    native.failTask("task", "task.validation_failed", "VALIDATION_FAILED", "same");
    const boundary = store.events.listForBuild("build").find((event) => event.type === "task.validation_failed");
    if (boundary === undefined) throw new Error("Expected actual native failure boundary");
    if (defect === "duplicate-boundary") store.events.append({ buildId: "build", taskId: "task", type: boundary.type, payload: boundary.payload });
    else store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: "VALIDATION_FAILED", errorMessage: "rewritten after failure" });
    await expect(evaluateGovernedBuild(dependencies, "build")).rejects.toThrow("GOVERNED_FAILURE_HISTORY_UNAVAILABLE");
  });

  it.each(["evidence.recorded", "task.state_changed"])("refuses an unsupported %s event masquerading as a native failure boundary", async (type) => {
    const { store, dependencies } = await setup();
    const attempt = store.tasks.getAttempt("task", 1);
    store.tasks.transition("task", "failed", { errorCode: "VALIDATION_FAILED", errorMessage: "same" });
    store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: "VALIDATION_FAILED", errorMessage: "same" });
    store.events.append({
      buildId: "build", taskId: "task", type,
      payload: { to: "failed", governorFailure: { attempt: 1, attemptId: attempt.id, fingerprint: fingerprintFailure({ code: "VALIDATION_FAILED", classification: "deterministic", retryable: false, signature: "same", files: [] }) } },
    });
    await expect(evaluateGovernedBuild(dependencies, "build")).rejects.toThrow("GOVERNED_FAILURE_HISTORY_UNAVAILABLE");
  });

  it("refuses the strict pipeline crash window between failed-state capture and attempt outcome persistence", async () => {
    const { store, dependencies, handoffPath } = await setup(true, true);
    const getProvider = vi.fn(() => { throw new Error("Crash qualification must not dispatch a provider"); });
    coordinator = new BuildCoordinator({ ...dependencies, handoffService: new HandoffManifestService(store, dependencies.environment.artifactsPath), agentProviders: { get: getProvider } } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
    const native = coordinator as unknown as {
      ensureRuntime(...args: unknown[]): Promise<unknown>;
      buildPromptContext(...args: unknown[]): Promise<unknown>;
      stopAndRecycleWorker(...args: unknown[]): void;
      executeTask(buildId: string, taskId: string, workerId: string, signal: AbortSignal): Promise<void>;
    };
    // Begin after modeled admission and replace only runtime/worker ports. The
    // real executeTask catch, failed-state capture and SQLite records remain.
    vi.spyOn(coordinator, "validateExecutionAuthority").mockResolvedValue();
    vi.spyOn(native, "ensureRuntime").mockResolvedValue({ integrationPath: () => path.dirname(handoffPath), createTaskWorktree: async () => ({ path: path.dirname(handoffPath), branchName: "inert-task", baseCommit: "a".repeat(40) }) });
    vi.spyOn(GitCommandRunner.prototype, "run").mockResolvedValue({ stdout: "a".repeat(40) } as Awaited<ReturnType<GitCommandRunner["run"]>>);
    vi.spyOn(store.workers, "assign").mockReturnValue(undefined as unknown as ReturnType<typeof store.workers.assign>);
    vi.spyOn(native, "buildPromptContext").mockRejectedValue(new Error("inert pipeline failure"));
    vi.spyOn(native, "stopAndRecycleWorker").mockImplementation(() => {});
    vi.spyOn(store.tasks, "updateAttempt").mockImplementationOnce(() => { throw new Error("inert crash before attempt outcome"); });
    await expect(native.executeTask("build", "task", "inert-worker", new AbortController().signal)).rejects.toThrow("inert crash before attempt outcome");
    expect(store.tasks.getById("task")).toMatchObject({ state: "failed", errorCode: "EXECUTION_PIPELINE_FAILED" });
    expect(store.tasks.getAttempt("task", 1)).toMatchObject({ status: "running", errorCode: null });
    expect(store.events.listForBuild("build").find((event) => event.type === "task.execution_pipeline_failed")?.payload.governorFailure).toMatchObject({ attempt: 1, attemptId: "attempt-1" });
    await expect(evaluateGovernedBuild(dependencies, "build")).rejects.toThrow("GOVERNED_FAILURE_HISTORY_UNAVAILABLE");
    expect(getProvider).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps strict native evidence current with historical certificate present=%s", async (historicalCertificate) => {
    const { store, dependencies, handoff, observed } = await setup(false, true);
    coordinator = new BuildCoordinator({ ...dependencies, handoffService: new HandoffManifestService(store, dependencies.environment.artifactsPath), agentProviders: { get: () => { throw new Error("No provider permitted"); } } } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
    const native = coordinator as unknown as { failTask(taskId: string, eventType: string, code: string, message: string): unknown };
    store.events.append({ buildId: "build", type: "evidence.recorded", payload: { items: ["free-label"], satisfied: ["focused-tests"] } });
    if (historicalCertificate) store.events.append({ buildId: "build", taskId: "task", type: "evidence.native_validation_certified", payload: { handoffSha256: canonicalJsonSha256(handoff), attempt: 1, artifactName: "focused-tests", certificateId: "f".repeat(64) } });
    store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: "VALIDATION_FAILED", errorMessage: "same" });
    native.failTask("task", "task.validation_failed", "VALIDATION_FAILED", "same");
    if (historicalCertificate) await expect(evaluateGovernedBuild(dependencies, "build")).rejects.toThrow("historical native certificate snapshot is not qualified");
    else {
      expect((await evaluateGovernedBuild(dependencies, "build"))?.decision.action).toBe("REQUEST_REPAIR");
      expect(observed.mock.calls.at(-1)?.[0].observation.evidence).toEqual({ items: [], satisfied: [], contradictory: [] });
      expect(observed.mock.calls.at(-1)?.[0].observation.evidenceDelta.score).toBe(0);
    }
  });

  it("records received retry delegation and the actual native scheduling refusal without authorizing a new attempt", async () => {
    const { store, dependencies } = await setup(true);
    store.tasks.transition("task", "failed", { errorCode: "PROVIDER_UNAVAILABLE", errorMessage: "inert transient failure" });
    store.tasks.updateAttempt("task", 1, { status: "failed", errorCode: "PROVIDER_UNAVAILABLE", errorMessage: "inert transient failure" });
    const getProvider = vi.fn(() => { throw new Error("Qualification must not dispatch a real or simulated worker"); });
    coordinator = new BuildCoordinator({
      ...dependencies,
      handoffService: new HandoffManifestService(store, dependencies.environment.artifactsPath),
      agentProviders: { get: getProvider },
    } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
    // Exercise real coordinator boundaries without starting its dispatch loop.
    const native = coordinator as unknown as {
      governBuild(buildId: string): Promise<{ continue: boolean; delegateRetry: boolean } | undefined>;
      scheduleAutomaticRetry(buildId: string, taskId: string, failureCode: string): void;
    };
    expect(store.plans.getById("plan").lockedAt).not.toBeNull();
    expect(store.builds.getById("build").planId).toBe("plan");
    expect(await native.governBuild("build")).toEqual({ continue: false, delegateRetry: true });
    native.scheduleAutomaticRetry("build", "task", "PROVIDER_UNAVAILABLE");
    await expect(coordinator.retry("build", "task")).rejects.toThrow("does not authorize retry");

    const events = store.events.listForBuild("build");
    const decision = events.find((event) => event.type === "governor.decision");
    const acknowledgement = events.find((event) => event.type === "governor.intervention_acknowledged");
    const refusal = events.find((event) => event.type === "task.retry_not_scheduled");
    if (decision === undefined || acknowledgement === undefined || refusal === undefined) throw new Error("Expected the durable decision, delegation and refusal chain");
    expect(decision.payload.decision).toMatchObject({ action: "DELEGATE_RETRY" });
    expect(decision.payload.recordHash).toMatch(/^[0-9a-f]{64}$/);
    // Acknowledgement means delegation received, not a successfully scheduled retry.
    expect(acknowledgement.payload).toMatchObject({ decisionRecordHash: decision.payload.recordHash, action: "DELEGATE_RETRY", acknowledged: true, delegatedTo: "agentflow-existing-retry-policy" });
    expect(refusal.taskId).toBe("task");
    expect(refusal.payload).toMatchObject({ failureCode: "PROVIDER_UNAVAILABLE", reason: "governed handoff does not authorize retry" });
    expect(decision.sequence).toBeLessThan(acknowledgement.sequence);
    expect(acknowledgement.sequence).toBeLessThan(refusal.sequence);
    expect(events.filter((event) => event.type === "governor.intervention_acknowledged")).toHaveLength(1);
    expect(store.tasks.listAttempts("task")).toHaveLength(1);
    expect(store.tasks.getById("task")).toMatchObject({ state: "failed", attempt: 1 });
    expect(getProvider).not.toHaveBeenCalled();
  });

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
