import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDatabaseRepositories } from "../src/db/index.js";
import { createDatabaseFixture } from "./helpers/database-fixture.js";
import { resolveEnvironment } from "../src/config/environment.js";
import { registerWaleRunLabRoutes } from "../src/http/routes/wale-run-lab.js";
import type { AgentFlowContext } from "../src/http/context.js";
import { verifyWaleReceiptEvidence } from "../src/integration/wale-run-lab-receipt-bundle.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BuildEventEntity, PlanEntity } from "../src/db/index.js";
import { canonicalJsonSha256 } from "../src/integration/design-intelligence.js";
import type { GovernedTaskHandoff } from "../src/integration/design-intelligence.js";
import {
  appendWaleExperimentBinding,
  loadBoundWaleExperiment,
  validateWaleExperimentAdmission,
  verifyWaleExperimentGitTree,
  type WaleRunLabExperiment,
} from "../src/integration/wale-run-lab.js";

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

const tasks = [
  {
    id: "AF-100",
    title: "Implement the governed change",
    description: "Implement it.",
    acceptanceCriteria: ["Focused tests pass.", "Authority remains explicit."],
    estimateHours: 1,
    dependsOn: [],
    owns: ["src/"],
    validate: ["npm test"],
    consumes: [],
    produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }],
    allowNoChanges: false,
    riskScore: 1,
    requiresApproval: true,
    epicId: "EPIC-1",
    epicTitle: "Governed execution",
    epicOutcome: "Safe delivery",
    architectureDecisions: [],
  },
];

const snapshotSha256 = "b".repeat(64);
const executionBaseCommit = "a".repeat(40);
const authorityStateSha256 = "c".repeat(64);

const plan = {
  id: "plan-1",
  repositoryId: "repository-1",
  backlogPath: "BACKLOG.md",
  backlogSha256: "d".repeat(64),
  backlogContents: "# backlog",
  repositoryConfig: {},
  normalizedPlan: {
    id: "plan-1",
    repositoryId: "repository-1",
    backlogPath: "BACKLOG.md",
    backlogSha256: "d".repeat(64),
    tasks,
    waves: [["AF-100"]],
    epics: [],
    adrDrafts: [],
    ownershipConflicts: [],
    estimates: {
      sequentialHours: 1,
      criticalPathHours: 1,
      expectedElapsedHours: 1,
      expectedSavingsPercent: 0,
      maximumTheoreticalConcurrency: 1,
      criticalPathTaskIds: ["AF-100"],
      workerEfficiency: 1,
      overheadPercent: 0,
    },
    governedHandoff: {
      id: "DI-AF-001",
      sha256: "e".repeat(64),
      path: "artifacts/handoff.json",
      governedBaseCommit: executionBaseCommit,
      executionBaseCommit,
      carrierPaths: ["artifacts/handoff.json", "BACKLOG.md"],
      proofBoundary: "Local evidence only.",
    },
    createdAt: "2026-10-06T00:00:00.000Z",
  },
  sequentialEstimateHours: 1,
  criticalPathHours: 1,
  expectedElapsedHours: 1,
  expectedSavingsPercent: 0,
  maximumTheoreticalConcurrency: 1,
  workerEfficiency: 1,
  overheadPercent: 0,
  lockedAt: "2026-10-06T00:00:00.000Z",
  createdAt: "2026-10-06T00:00:00.000Z",
} satisfies PlanEntity;

const handoff = {
  schemaVersion: "2.1.0",
  kind: "design-intelligence/governed-task-handoff",
  handoffId: "DI-AF-001",
  createdAt: "2026-10-06T00:00:00.000Z",
  repository: {
    baseCommit: executionBaseCommit,
    snapshotSha256,
    worktreeState: "clean",
  },
  objective: "Deliver a governed execution slice.",
  authority: {
    status: "APPROVED",
    approvedBy: "human:owner",
    approvedAt: "2026-10-06T00:00:00.000Z",
    approvalReceipt: {} as never,
    stateSha256: authorityStateSha256,
    governanceReportSha256: "f".repeat(64),
    sources: [{ path: "AGENTS.md", sha256: "1".repeat(64) }],
  },
  tasks: [{
    id: "AF-100",
    title: "Implement the governed change",
    description: "Implement it.",
    estimateHours: 1,
    dependsOn: [],
    owns: ["src/"],
    acceptanceCriteria: ["Focused tests pass.", "Authority remains explicit."],
    validate: ["npm test"],
    produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }],
    consumes: [],
  }],
  proof: { requiredEvidence: ["focused tests"], claimBoundary: "Local evidence only." },
} as unknown as GovernedTaskHandoff;

plan.normalizedPlan.governedHandoff.sha256 = canonicalJsonSha256(handoff);

function experiment(): WaleRunLabExperiment {
  return {
    experimentId: `exp_${"2".repeat(64)}`,
    runId: "run_A1",
    repositorySnapshot: {
      state: "VERIFIED",
      commit: executionBaseCommit,
      tree: snapshotSha256,
      reason: null,
    },
    frozenTask: {
      state: "VERIFIED",
      ids: tasks.map((task) => fingerprint(task.id)),
      titleFingerprints: tasks.map((task) => fingerprint(task.title)),
    },
    frozenRequirements: {
      state: "UNKNOWN",
      items: [],
      reason: "FROZEN_REQUIREMENTS_NOT_RETAINED_SEPARATELY",
    },
    acceptanceCriteria: {
      state: "VERIFIED",
      count: 2,
      items: tasks.flatMap((task) => task.acceptanceCriteria.map((criterion, index) => ({
        id: fingerprint(`${task.id}:acceptance:${index + 1}`),
        fingerprint: fingerprint(criterion),
      }))),
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
    authorityStateReference: `authority-${authorityStateSha256.slice(0, 24)}`,
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

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = value[key];
  if (typeof child !== "object" || child === null || Array.isArray(child)) throw new Error(`Expected ${key} object`);
  return child as Record<string, unknown>;
}

describe("Wale Run Lab experiment admission", () => {
  it("accepts the exact prepared experiment bound to the immutable governed plan", () => {
    expect(validateWaleExperimentAdmission(experiment(), { plan, handoff })).toEqual(experiment());
  });

  it.each([
    ["unknown field", (value: Record<string, unknown>) => { value.extra = true; }],
    ["non-null agent model", (value: Record<string, unknown>) => { nested(value, "parameters").agentModel = { agent: "codex", model: "x" }; }],
    ["unsupported strategy", (value: Record<string, unknown>) => { nested(value, "parameters").strategy = "FAST"; value.strategy = "FAST"; }],
    ["unsupported overflow", (value: Record<string, unknown>) => { nested(value, "parameters").overflowBehavior = "IGNORE"; }],
    ["forged snapshot", (value: Record<string, unknown>) => { nested(value, "repositorySnapshot").commit = "9".repeat(40); }],
    ["forged authority", (value: Record<string, unknown>) => { value.authorityStateReference = "authority-forged"; }],
    ["task mismatch", (value: Record<string, unknown>) => { nested(value, "frozenTask").ids = [fingerprint("AF-999")]; }],
    ["title mismatch", (value: Record<string, unknown>) => { nested(value, "frozenTask").titleFingerprints = [fingerprint("forged")]; }],
    ["criterion mismatch", (value: Record<string, unknown>) => {
      const items = nested(value, "acceptanceCriteria").items as Array<Record<string, unknown>>;
      const first = items[0];
      if (first === undefined) throw new Error("Expected criterion fixture");
      first.fingerprint = fingerprint("forged");
    }],
  ])("rejects %s without reflecting supplied values", (_label, mutate) => {
    const value = structuredClone(experiment()) as unknown as Record<string, unknown>;
    mutate(value);
    expect(() => validateWaleExperimentAdmission(value, { plan, handoff })).toThrow(
      expect.objectContaining({ code: "WALE_EXPERIMENT_INVALID" }),
    );
    try {
      validateWaleExperimentAdmission(value, { plan, handoff });
    } catch (error) {
      expect(String(error)).not.toContain("forged");
    }
  });

  it("rejects experiments for an ungoverned plan", () => {
    const ungoverned = structuredClone(plan) as PlanEntity;
    delete ungoverned.normalizedPlan.governedHandoff;
    expect(() => validateWaleExperimentAdmission(experiment(), { plan: ungoverned })).toThrow(
      expect.objectContaining({ code: "WALE_EXPERIMENT_REQUIRES_GOVERNED_PLAN" }),
    );
  });

  it("persists exactly one binding and fails closed on duplicate or malformed retained events", () => {
    const events: BuildEventEntity[] = [];
    const repository = {
      append(input: { buildId: string; type: string; payload: Record<string, unknown> }) {
        const event = {
          sequence: events.length + 1,
          buildId: input.buildId,
          taskId: null,
          type: input.type,
          payload: input.payload,
          occurredAt: "2026-10-06T00:00:00.000Z",
        } satisfies BuildEventEntity;
        events.push(event);
        return event;
      },
      listForBuild() { return events; },
    };

    appendWaleExperimentBinding(repository, "build-1", experiment());
    expect(loadBoundWaleExperiment(repository, "build-1")).toEqual(experiment());
    expect(() => appendWaleExperimentBinding(repository, "build-1", experiment())).toThrow(
      expect.objectContaining({ code: "WALE_EXPERIMENT_BINDING_CONFLICT" }),
    );

    const retained = events[0];
    if (retained === undefined) throw new Error("Expected retained binding fixture");
    events[0] = { ...retained, payload: { malformed: true } };
    expect(() => loadBoundWaleExperiment(repository, "build-1")).toThrow(
      expect.objectContaining({ code: "WALE_EXPERIMENT_BINDING_INVALID" }),
    );
  });
});

describe("Wale bridge bounded refusals", () => {
  it("authenticates before malformed JSON and disables the bridge by default", async () => {
    const token = "a".repeat(43);
    for (const enabled of [false, true]) {
      const app = Fastify();
      const environment = resolveEnvironment(enabled ? { AGENTFLOW_WALE_BRIDGE_TOKEN_SHA256: createHash("sha256").update(token).digest("hex") } : {});
      registerWaleRunLabRoutes(app, { environment } as AgentFlowContext);
      try {
        const url = "/api/wale/run-lab/experiments";
        const denied = await app.inject({ method: "POST", url, headers: { "content-type": "application/json", authorization: `Bearer ${"b".repeat(43)}` }, payload: "{" });
        expect(denied.statusCode).toBe(enabled ? 401 : 503);
        expect(denied.headers["cache-control"]).toBe("no-store");
        expect(denied.body).not.toContain(token);
        if (enabled) {
          const malformed = await app.inject({ method: "POST", url, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, payload: "{" });
          expect(malformed.statusCode).toBe(400);
          expect(malformed.headers["cache-control"]).toBe("no-store");
        }
      } finally { await app.close(); }
    }
    expect(() => resolveEnvironment({ AGENTFLOW_WALE_BRIDGE_TOKEN_SHA256: "raw-token" })).toThrow();
  });

  it("allows schema-valid native-sized requests beyond 32KiB while preserving authority refusal and the 1MiB cap", async () => {
    const fixture = createDatabaseFixture();
    const app = Fastify();
    try {
      const token = "a".repeat(43);
      const store = createDatabaseRepositories(fixture.database);
      const environment = resolveEnvironment({ AGENTFLOW_WALE_BRIDGE_TOKEN_SHA256: createHash("sha256").update(token).digest("hex") });
      registerWaleRunLabRoutes(app, { environment, store } as AgentFlowContext);
      const incoming = experiment();
      incoming.frozenTask.ids = Array.from({ length: 1024 }, () => fingerprint("unbound-task"));
      incoming.frozenTask.titleFingerprints = Array.from({ length: 1024 }, () => fingerprint("unbound-title"));
      const body = { sourceBuildId: "unknown-source", experiment: incoming };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(32 * 1024);
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(128 * 1024);
      const refused = await app.inject({ method: "POST", url: "/api/wale/run-lab/experiments", headers: { authorization: `Bearer ${token}` }, payload: body });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: "WALE_BRIDGE_ADMISSION_REJECTED" } });
      const oversized = await app.inject({ method: "POST", url: "/api/wale/run-lab/experiments", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: "x".repeat(1024 * 1024 + 1) });
      expect(oversized.statusCode, oversized.body).toBe(413);
      expect(oversized.json()).toMatchObject({ error: { code: "WALE_BRIDGE_REQUEST_TOO_LARGE" } });
      const malformed = await app.inject({ method: "POST", url: "/api/wale/run-lab/experiments", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: "{" });
      expect(malformed.statusCode, malformed.body).toBe(400);
      expect(store.builds.list()).toEqual([]);
    } finally { await app.close(); fixture.cleanup(); }
  });

  it("replays seeded B0 experiments against their exact native B1 build and refuses substitutions without dispatch", async () => {
    const fixture = createDatabaseFixture();
    const app = Fastify();
    let dispatches = 0;
    try {
      const store = createDatabaseRepositories(fixture.database);
      store.repositories.create({ id: "repository-1", name: "fixture", localPath: fixture.directory, configPath: ".agentflow.yaml", baseBranch: "main" });
      const nativePlan = structuredClone(plan);
      const physicalBase = "8".repeat(40);
      nativePlan.normalizedPlan.governedHandoff.executionBaseCommit = physicalBase;
      store.plans.create({ ...nativePlan, normalizedPlan: nativePlan.normalizedPlan });
      const otherPlan = structuredClone(nativePlan);
      otherPlan.id = "plan-other";
      otherPlan.normalizedPlan.id = otherPlan.id;
      store.plans.create(otherPlan);
      const create = (id: string, planId = nativePlan.id, baseCommit = physicalBase) => store.builds.create({ id, repositoryId: "repository-1", planId, backlogPath: "BACKLOG.md", baseCommit, integrationBranch: `integration/${id}`, status: "completed" });
      // Seed prior history solely to test route replay, not native execution success.
      create("source-build");
      create("bound-build");
      create("other-plan-source", otherPlan.id);
      create("other-base-source", nativePlan.id, "9".repeat(40));
      store.events.appendExperimentBinding("bound-build", experiment());
      const token = "a".repeat(43);
      const environment = resolveEnvironment({ AGENTFLOW_WALE_BRIDGE_TOKEN_SHA256: createHash("sha256").update(token).digest("hex") });
      const context = { store, environment, coordinator: { start: async () => { dispatches += 1; throw new Error("Unexpected dispatch"); } } } as unknown as AgentFlowContext;
      registerWaleRunLabRoutes(app, context);
      const before = store.builds.list({ limit: 100 }).map((build) => build.id);
      const post = (sourceBuildId: string, incoming = experiment()) => app.inject({ method: "POST", url: "/api/wale/run-lab/experiments", headers: { authorization: `Bearer ${token}` }, payload: { sourceBuildId, experiment: incoming } });
      const replay = await post("source-build");
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({ experimentId: experiment().experimentId, bridgeBuildReference: "bound-build" });
      expect((await post("source-build")).json()).toEqual(replay.json());
      const changed = experiment();
      changed.parameters.deliverySize += 1;
      expect((await post("source-build", changed)).statusCode).toBe(409);
      expect((await post("other-plan-source")).statusCode).toBe(409);
      expect((await post("other-base-source")).statusCode).toBe(409);
      expect(store.builds.list({ limit: 100 }).map((build) => build.id)).toEqual(before);
      expect(dispatches).toBe(0);
    } finally { await app.close(); fixture.cleanup(); }
  });

  it("retains exact binding identity and rolls back conflicting admission atomically", () => {
    const fixture = createDatabaseFixture();
    try {
      const store = createDatabaseRepositories(fixture.database);
      store.repositories.create({ id: "repository-1", name: "fixture", localPath: fixture.directory, configPath: ".agentflow.yaml", baseBranch: "main" });
      const create = (id: string) => store.builds.create({ id, repositoryId: "repository-1", backlogPath: "BACKLOG.md", baseCommit: executionBaseCommit, integrationBranch: `integration/${id}`, status: "completed" });
      store.transaction(() => { create("build-1"); store.events.appendExperimentBinding("build-1", experiment()); });
      const first = store.events.findByExperimentId(experiment().experimentId);
      expect(first?.buildId).toBe("build-1");
      expect(store.events.appendExperimentBinding("build-1", experiment()).sequence).toBe(first?.sequence);
      expect(() => store.transaction(() => { create("build-2"); store.events.appendExperimentBinding("build-2", experiment()); })).toThrow();
      expect(store.builds.findById("build-2")).toBeUndefined();
      expect(() => store.events.appendExperimentBinding("build-1", { ...experiment(), experimentId: `exp_${"3".repeat(64)}` })).toThrow();
      expect(() => store.events.listForBuild("build-1", { afterSequence: -1 })).toThrow();
      expect(loadBoundWaleExperiment(store.events, "build-1")).toEqual(experiment());
    } finally { fixture.cleanup(); }
  });

  it("refuses missing, tampered, traversing and symlink evidence and returns exact bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wale-evidence-"));
    try {
      await mkdir(path.join(root, "artifacts"));
      const sourcePath = path.join(root, "artifacts", "one.json");
      const bytes = Buffer.from('{"native":"fixture"}\n');
      await writeFile(sourcePath, bytes);
      const source = { sourcePath, relativePath: "artifacts/one.json", sha256: createHash("sha256").update(bytes).digest("hex") };
      const verified = await verifyWaleReceiptEvidence([source], 0);
      expect(verified.selectedBytes).toEqual(bytes);
      await expect(verifyWaleReceiptEvidence([{ ...source, relativePath: "artifacts/../one.json" }])).rejects.toThrow();
      await expect(verifyWaleReceiptEvidence([{ ...source, sha256: null }])).rejects.toThrow();
      await writeFile(sourcePath, "tamper");
      await expect(verifyWaleReceiptEvidence([source])).rejects.toThrow();
      await rm(sourcePath);
      await expect(verifyWaleReceiptEvidence([source])).rejects.toThrow();
      await writeFile(path.join(root, "outside.json"), bytes);
      await symlink(path.join(root, "outside.json"), sourcePath);
      await expect(verifyWaleReceiptEvidence([source])).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("maps the declared governed base separately from the verified carrier execution base", () => {
    const carrierExecutionBase = "8".repeat(40);
    const carrierPlan = structuredClone(plan);
    carrierPlan.normalizedPlan.governedHandoff.executionBaseCommit = carrierExecutionBase;
    // The frozen consumer declares B0. Native admission has separately verified
    // the carrier-only B0 -> B1 ancestry before calling this binding comparator.
    expect(validateWaleExperimentAdmission(experiment(), { plan: carrierPlan, handoff, buildBaseCommit: carrierExecutionBase })).toEqual(experiment());
    const wrongGovernedBase = structuredClone(carrierPlan);
    wrongGovernedBase.normalizedPlan.governedHandoff.governedBaseCommit = "9".repeat(40);
    expect(() => validateWaleExperimentAdmission(experiment(), { plan: wrongGovernedBase, handoff, buildBaseCommit: carrierExecutionBase })).toThrow(expect.objectContaining({ code: "WALE_EXPERIMENT_INVALID" }));
    expect(() => validateWaleExperimentAdmission(experiment(), { plan: carrierPlan, handoff, buildBaseCommit: executionBaseCommit })).toThrow(expect.objectContaining({ code: "WALE_EXPERIMENT_INVALID" }));
    const substitutedExperiment = experiment();
    substitutedExperiment.repositorySnapshot.commit = carrierExecutionBase;
    expect(() => validateWaleExperimentAdmission(substitutedExperiment, { plan: carrierPlan, handoff, buildBaseCommit: carrierExecutionBase })).toThrow(expect.objectContaining({ code: "WALE_EXPERIMENT_INVALID" }));
  });

  it("refuses Run Lab evidence without an explicit supported profile", () => {
    const unbound = structuredClone(handoff);
    const task = unbound.tasks[0];
    if (task === undefined) throw new Error("Expected fixture task");
    task.produces = [];
    expect(() => validateWaleExperimentAdmission(experiment(), { plan, handoff: unbound })).toThrow(expect.objectContaining({ code: "WALE_EVIDENCE_BINDING_UNSUPPORTED" }));
  });

  it("refuses a supplied Git tree without trusted native verification", () => {
    const native = experiment();
    native.repositorySnapshot.gitTree = "4".repeat(40);
    expect(() => validateWaleExperimentAdmission(native, { plan, handoff })).toThrow(expect.objectContaining({ code: "WALE_EXPERIMENT_INVALID" }));
    expect(() => validateWaleExperimentAdmission(native, { plan, handoff, governedGitTree: "5".repeat(40) })).toThrow(expect.objectContaining({ code: "WALE_EXPERIMENT_INVALID" }));
    expect(validateWaleExperimentAdmission(native, { plan, handoff, governedGitTree: "4".repeat(40) }).repositorySnapshot.gitTree).toBe("4".repeat(40));
  });

  it.skipIf(!process.env.AFI003_NATIVE_ROOT)("retains the actual frozen native Git-tree vector and verifies B0 tree bytes independently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wale-git-tree-"));
    const execute = promisify(execFile);
    try {
      await execute("git", ["init", "--initial-branch=main", root]);
      await execute("git", ["-C", root, "-c", "user.name=Tree fixture", "-c", "user.email=tree@example.test", "commit", "--allow-empty", "-m", "governed B0"]);
      const base = (await execute("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
      const gitTree = (await execute("git", ["-C", root, "rev-parse", `${base}^{tree}`])).stdout.trim();
      const native = experiment();
      native.repositorySnapshot.commit = base;
      const nativeRoot = process.env.AFI003_NATIVE_ROOT;
      if (nativeRoot === undefined) throw new Error("Explicit frozen native root required");
      const run = { runIdentity: { id: native.runId }, repository: { fingerprint: fingerprint(base) }, startingSnapshot: { fingerprint: fingerprint(snapshotSha256) } };
      const binding = { runId: native.runId, commit: base, tree: snapshotSha256, gitTree, verified: true, authorityReference: "fixture-current-snapshot" };
      const vector = await execute("python3", ["-c", "import json,sys;from design_intelligence.run_lab import _bound_snapshot;print(json.dumps(_bound_snapshot(json.loads(sys.argv[1]),json.loads(sys.argv[2]))))", JSON.stringify(run), JSON.stringify(binding)], { cwd: nativeRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
      native.repositorySnapshot = JSON.parse(vector.stdout) as WaleRunLabExperiment["repositorySnapshot"];
      expect(native.repositorySnapshot).toEqual({ state: "VERIFIED", commit: base, tree: snapshotSha256, gitTree, reason: null });
      const governed = structuredClone(handoff);
      governed.repository.baseCommit = base;
      const boundPlan = structuredClone(plan);
      boundPlan.normalizedPlan.governedHandoff.governedBaseCommit = base;
      boundPlan.normalizedPlan.governedHandoff.executionBaseCommit = base;
      boundPlan.normalizedPlan.governedHandoff.sha256 = canonicalJsonSha256(governed);
      const verifiedTree = await verifyWaleExperimentGitTree(native, root, governed);
      expect(validateWaleExperimentAdmission(native, { plan: boundPlan, handoff: governed, buildBaseCommit: base, governedGitTree: verifiedTree })).toEqual(native);
      const wrong = structuredClone(native);
      wrong.repositorySnapshot.gitTree = "f".repeat(40);
      await expect(verifyWaleExperimentGitTree(wrong, root, governed)).rejects.toMatchObject({ code: "WALE_EXPERIMENT_INVALID" });
      expect(() => validateWaleExperimentAdmission(wrong, { plan: boundPlan, handoff: governed, governedGitTree: verifiedTree })).toThrow(expect.objectContaining({ code: "WALE_EXPERIMENT_INVALID" }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a substituted immutable handoff digest", () => {
    const substituted = structuredClone(plan);
    substituted.normalizedPlan.governedHandoff.sha256 = "f".repeat(64);
    expect(() => validateWaleExperimentAdmission(experiment(), { plan: substituted, handoff })).toThrow(expect.objectContaining({ code: "WALE_EXPERIMENT_INVALID" }));
  });
});
