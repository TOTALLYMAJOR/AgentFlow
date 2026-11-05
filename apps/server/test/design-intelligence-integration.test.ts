import * as nativeEvidenceControl from "../src/governor/build-control.js";
import { GovernorControlService } from "../src/governor/control-service.js";
import Fastify from "fastify";
import { registerWaleRunLabRoutes } from "../src/http/routes/wale-run-lab.js";
import { loadBoundWaleExperiment, WaleRunLabExperimentSchema } from "../src/integration/wale-run-lab.js";
import { makeWaleRunLabReceiptBundle } from "../src/integration/wale-run-lab-receipt-bundle.js";
import { createDatabaseRepositories } from "../src/db/index.js";
import { createDatabaseFixture } from "./helpers/database-fixture.js";
import { HandoffManifestService } from "../src/artifacts/index.js";
import { TaskCommitService } from "../src/orchestration/task-commit.js";
import { BuildCoordinator } from "../src/orchestration/coordinator.js";
import { IntegrationManager } from "../src/integration/manager.js";
import { DEFAULT_RETRYABLE_FAILURE_CODES } from "../src/orchestration/retry-policy.js";
import { validateTask } from "../src/validation/index.js";
import { publishNativeValidationEvidence, readVerifiedNativeValidationEvidence, evaluateGovernedBuild } from "../src/governor/build-control.js";
import { makeDesignIntelligenceReceipt } from "../src/integration/design-intelligence-receipt.js";
import { DEFAULT_ORGANIZATION_POLICY } from "../src/governance/organization-policy.js";
import type { AgentFlowContext } from "../src/http/context.js";
import { AgentFlowError } from "../src/http/errors.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { resolveEnvironment } from "../src/config/environment.js";
import { buildApp } from "../src/http/app.js";
import { GitWorktreeManager } from "../src/git/index.js";
import { backlogHandoffErrors, canonicalJsonSha256, GovernedTaskHandoffSchema, parseHandoffBinding, renderBacklog, verifyGovernedHandoffForExecution, verifyHandoffAuthoritySources } from "../src/integration/design-intelligence.js";
import { planBacklogMarkdown } from "../src/planning/planner.js";

const governedTasks = [
  { id: "AF-001", title: "Implement", description: "Implement the approved task.", estimateHours: 1, dependsOn: [], owns: ["src/"], acceptanceCriteria: ["Tests pass"], validate: ["npm test"], produces: [], consumes: [] },
] as const;

function approvedHandoff(baseCommit: string, sourceSha256: string, snapshotSha256Override?: string, pathCase = { scope: "src/", owned: "src/" }, evidenceCase?: { produces: Array<{ name: string; type: string; version: string; path?: string }>; requiredEvidence?: string[]; validate?: string[]; duplicateTask?: boolean }) {
  const sources = [{ path: "AGENTS.md", sha256: sourceSha256 }];
  const authorityStateSha256 = "c".repeat(64);
  const governanceReportSha256 = "d".repeat(64);
  const snapshotSha256 = canonicalJsonSha256({ baseCommit, worktreeState: "clean", authorityStateSha256, governanceReportSha256, sources });
  const proposed = {
    schemaVersion: "2.1.0", kind: "design-intelligence/governed-task-handoff", handoffId: "DI-AF-001", createdAt: "2026-09-12T12:00:00Z",
    programId: "program_01measurementsuccess",
    repository: { baseCommit, snapshotSha256: snapshotSha256Override ?? snapshotSha256, worktreeState: "clean" }, objective: "Deliver a verified contract-first integration.",
    authority: { status: "PROPOSED", stateSha256: authorityStateSha256, governanceReportSha256, sources },
    tasks: (evidenceCase?.duplicateTask ? [...governedTasks, { ...governedTasks[0], id: "AF-002" }] : governedTasks).map((task) => ({ ...task, owns: [pathCase.owned], produces: evidenceCase?.produces ?? task.produces, validate: evidenceCase?.validate ?? [...task.validate] })),
    proof: { requiredEvidence: evidenceCase?.requiredEvidence ?? ["focused tests"], claimBoundary: "Local integration only." },
  } as const;
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const validUntil = new Date(Date.now() + 60 * 60_000).toISOString();
  const receiptWithoutId = {
    schemaVersion: 1,
    kind: "proofloom/execution-approval-receipt",
    receiptType: "EXECUTION_APPROVAL",
    policyVersion: "human-authority/v1",
    decision: "APPROVED",
    sessionId: "test-session",
    authority: { actorId: "human:test-owner", role: "repository-owner", basis: "test approval" },
    repositoryRevision: baseCommit,
    artifact: { kind: "design-intelligence/governed-task-handoff-scope", id: proposed.handoffId, sha256: canonicalJsonSha256(proposed) },
    scope: { repository: ".", paths: [pathCase.scope], actions: ["execute-governed-handoff"] },
    governingSources: sources,
    issuedAt,
    validUntil,
    supersedes: null,
    transition: { handoffId: proposed.handoffId },
    constraints: {
      allowedActions: ["execute-governed-handoff"],
      requiredEvidence: ["focused tests"],
      escalationConditions: ["authority drift"],
      resourceCeilings: { wallClockMinutes: 60 },
      iterationCeiling: 1,
      revocationAuthorityRoles: ["repository-owner"],
    },
    mutationPerformed: false,
  } as const;
  const approvalReceipt = { ...receiptWithoutId, receiptId: `HAR-${canonicalJsonSha256(receiptWithoutId).slice(0, 20).toUpperCase()}` };
  return {
    ...proposed,
    authority: { ...proposed.authority, status: "APPROVED", approvedBy: "human:test-owner", approvedAt: issuedAt, approvalReceipt },
  } as const;
}

const handoff = approvedHandoff("a".repeat(40), "b".repeat(64));

const legacyHandoff = {
  schemaVersion: "1.0.0", kind: "design-intelligence/governed-task-handoff", handoffId: "DI-AF-001", createdAt: "2026-09-12T12:00:00Z",
  repository: { baseCommit: "a".repeat(40) }, objective: "Deliver a verified contract-first integration.",
  authority: { status: "APPROVED", approvedBy: "owner", approvedAt: "2026-09-12T12:01:00Z", sources: [{ path: "AGENTS.md", sha256: "b".repeat(64) }] },
  tasks: [{ id: "AF-001", title: "Implement", description: "Implement the approved task.", estimateHours: 1, dependsOn: [], owns: ["src/"], acceptanceCriteria: ["Tests pass"], validate: ["npm test"], produces: [], consumes: [] }],
  proof: { requiredEvidence: ["focused tests"], claimBoundary: "Local integration only." },
} as const;
const execFileAsync = promisify(execFile);

describe("Design Intelligence integration", () => {
  it("matches Proofloom canonical JSON ordering for mixed-case path keys", () => {
    expect(canonicalJsonSha256({
      "AGENTS.md": 2,
      "adapters/a": 3,
      ".dev/a": 1,
    })).toBe("8438ea312d4aae72209a83ad1179647a8fc7b1524e4043d957db0260953793de");
  });

  it("matches the shared public canonical corpus and rejects deferred runtime fields", async () => {
    const corpus = JSON.parse(await readFile(new URL("../../../tests/fixtures/proofloom-agentflow-traffic-control/wale-run-lab-contract.json", import.meta.url), "utf8")) as { canonicalVectors: Array<{ input: unknown; canonicalUtf8: string; sha256: string }> };
    for (const vector of corpus.canonicalVectors) {
      expect(canonicalJsonSha256(vector.input)).toBe(vector.sha256);
      expect(createHash("sha256").update(vector.canonicalUtf8, "utf8").digest("hex")).toBe(vector.sha256);
    }
    expect(() => GovernedTaskHandoffSchema.parse({ ...handoff, taskValidationRuntime: { enabled: true } })).toThrow();
    expect(() => GovernedTaskHandoffSchema.parse({ ...handoff, runtime: true })).toThrow();
  });

  it.each([
    ["recursive subtree root", "src/**", "src"],
    ["recursive subtree descendant", "src/**", "src/deep/file.ts"],
    ["recursive subtree trailing root slash", "src/**", "src/"],
    ["legacy single-star root", "src/*", "src"],
    ["legacy single-star descendant", "src/*", "src/deep/file.ts"],
    ["case and Unicode retained", "Sourcé/**", "Sourcé/子.ts"],
    ["literal owned glob retained", "src/**", "src/**/*.ts"],
    ["literal single-star root retained without double collapse", "src/*/**", "src/*"],
  ])("admits a legitimately bound approval for %s", (_label, scope, owned) => {
    const approved = approvedHandoff("a".repeat(40), "b".repeat(64), undefined, { scope, owned });
    const parsed = GovernedTaskHandoffSchema.parse(approved);
    expect(parsed.tasks[0]?.owns).toEqual([owned]);
    expect(parsed.authority.approvalReceipt.scope.paths).toEqual([scope]);
  });

  it.each([
    ["sibling", "src/**", "src-other/file.ts"],
    ["broader ownership", "src/child/**", "src"],
    ["nested recursive scope is not collapsed twice", "src/**/**", "src/child.ts"],
    ["nested single-star scope is not collapsed twice", "src/*/**", "src/"],
    ["star adjacent to root remains literal", "src*/**", "src/"],
    ["case differs", "Src/**", "src/child.ts"],
    ["Unicode differs", "Sourcé/**", "Source/子.ts"],
    ["parent scope", "../src/**", "src/file.ts"],
    ["parent owned", "src/**", "src/../other/file.ts"],
    ["absolute scope", "/src/**", "src/file.ts"],
    ["absolute owned", "src/**", "/src/file.ts"],
    ["drive scope", "C:src/**", "src/file.ts"],
    ["drive owned", "src/**", "C:src/file.ts"],
    ["backslash scope", "src\\child/**", "src/child/file.ts"],
    ["backslash owned", "src/**", "src\\child.ts"],
    ["NUL scope", "src\0/**", "src/file.ts"],
    ["NUL owned", "src/**", "src/file\0.ts"],
    ["empty scope", "", "src/file.ts"],
    ["empty owned", "src/**", ""],
  ])("refuses authority scope %s through the public handoff schema", (_label, scope, owned) => {
    // The existing fixture receipt algorithm binds these inputs before parsing;
    // refusals therefore exercise scope semantics, not a stale mutated digest.
    const approved = approvedHandoff("a".repeat(40), "b".repeat(64), undefined, { scope, owned });
    expect(GovernedTaskHandoffSchema.safeParse(approved).success).toBe(false);
  });

  it("admits the exact pathless single-task native validation evidence declaration", () => {
    const approved = approvedHandoff("a".repeat(40), "b".repeat(64), undefined, undefined, { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }] });
    expect(GovernedTaskHandoffSchema.parse(approved).tasks[0]?.produces).toEqual([{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }]);
  });
  it.each([
    ["unknown version", { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "2.0.0" }] }],
    ["worker repository path", { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0", path: "proof.json" }] }],
    ["missing required label", { produces: [{ name: "other", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }] }],
    ["duplicate mapping", { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }, { name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }] }],
    ["conflicting mapping", { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }, { name: "focused tests", type: "worker/assertion", version: "1.0.0" }] }],
    ["duplicate required label", { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }], requiredEvidence: ["focused tests", "focused tests"] }],
    ["empty check list", { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }], validate: [] }],
    ["future task topology", { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }], duplicateTask: true }],
  ])("refuses native evidence profile %s with a legitimately bound receipt", (_label, evidenceCase) => {
    const approved = approvedHandoff("a".repeat(40), "b".repeat(64), undefined, undefined, evidenceCase);
    expect(GovernedTaskHandoffSchema.safeParse(approved).success).toBe(false);
  });

  it.each(["consumes", "dependsOn"])("refuses omitted %s before native profile defaults can change declared identity", (field) => {
    const approved = approvedHandoff("a".repeat(40), "b".repeat(64), undefined, undefined, { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }] });
    const raw = structuredClone(approved) as unknown as { tasks: Array<Record<string, unknown>> };
    const task = raw.tasks[0];
    if (task === undefined) throw new Error("Expected approved fixture task");
    if (field === "consumes") delete task.consumes;
    else delete task.dependsOn;
    const parsed = GovernedTaskHandoffSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.message.includes("explicit canonical handoff fields"))).toBe(true);
  });

  it("preserves legacy non-profile sparse defaults and canonical profile key-order/format freedom", () => {
    const legacy = structuredClone(handoff) as unknown as { tasks: Array<Record<string, unknown>> };
    const task = legacy.tasks[0];
    if (task === undefined) throw new Error("Expected legacy fixture task");
    delete task.consumes; delete task.produces;
    expect(GovernedTaskHandoffSchema.parse(legacy).tasks[0]).toMatchObject({ consumes: [], produces: [] });
    const explicit = approvedHandoff("a".repeat(40), "b".repeat(64), undefined, undefined, { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }] });
    const reordered = Object.fromEntries(Object.entries(explicit).reverse());
    const formatted = JSON.parse(JSON.stringify(reordered, null, 5)) as unknown;
    expect(canonicalJsonSha256(GovernedTaskHandoffSchema.parse(formatted))).toBe(canonicalJsonSha256(explicit));
  });

  it.skipIf(!process.env.AFI003_NATIVE_ROOT)("matches actual native canonical normalization for an explicit profile and refuses raw omission", async () => {
    const explicit = approvedHandoff("a".repeat(40), "b".repeat(64), undefined, undefined, { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }] });
    const omitted = structuredClone(explicit) as unknown as { tasks: Array<Record<string, unknown>> };
    const task = omitted.tasks[0];
    if (task === undefined) throw new Error("Expected declared profile task");
    delete task.consumes;
    const nativeRoot = process.env.AFI003_NATIVE_ROOT;
    if (nativeRoot === undefined) throw new Error("Explicit frozen native root required");
    const checked = await execFileAsync("python3", ["-c", "import json,sys;from design_intelligence.handoff_scope import canonical_json_sha256,canonical_governed_handoff_sha256;docs=json.loads(sys.argv[1]);print(json.dumps([{'raw':canonical_json_sha256(doc),'normalized':canonical_governed_handoff_sha256(doc)} for doc in docs]))", JSON.stringify([explicit, omitted])], { cwd: nativeRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    const vectors = JSON.parse(checked.stdout) as Array<{ raw: string; normalized: string }>;
    const expected = canonicalJsonSha256(GovernedTaskHandoffSchema.parse(explicit));
    expect(vectors[0]).toEqual({ raw: expected, normalized: expected });
    expect(vectors[1]?.normalized).toBe(expected);
    expect(vectors[1]?.raw).not.toBe(expected);
    expect(() => GovernedTaskHandoffSchema.parse(omitted)).toThrow("explicit canonical handoff fields");
  });

  it("rejects handoff v1 instead of silently falling back", () => expect(() => GovernedTaskHandoffSchema.parse(legacyHandoff)).toThrow());
  it("rejects proposed authority", () => expect(() => GovernedTaskHandoffSchema.parse({ ...handoff, authority: { ...handoff.authority, status: "PROPOSED" } })).toThrow());
  it("rejects approved authority with an unverified receipt", () => expect(() => GovernedTaskHandoffSchema.parse({ ...handoff, authority: { ...handoff.authority, approvalReceipt: { ...handoff.authority.approvalReceipt, receiptId: `HAR-${"A".repeat(20)}` } } })).toThrow());
  it("rejects dirty and non-carrier repository drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentflow-di-currency-"));
    try {
      await execFileAsync("git", ["init", "--initial-branch=main", root]);
      await execFileAsync("git", ["-C", root, "config", "user.name", "AgentFlow Test"]);
      await execFileAsync("git", ["-C", root, "config", "user.email", "agentflow@example.test"]);
      await mkdir(path.join(root, "src"));
      await mkdir(path.join(root, "artifacts"));
      await writeFile(path.join(root, "src", "index.js"), "export const ok = true;\n");
      await writeFile(path.join(root, "AGENTS.md"), "# Repository authority\n");
      await execFileAsync("git", ["-C", root, "add", "."]);
      await execFileAsync("git", ["-C", root, "commit", "-m", "base"]);
      const baseCommit = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
      const authority = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "AGENTS.md")));
      const approved = GovernedTaskHandoffSchema.parse(approvedHandoff(baseCommit, createHash("sha256").update(authority).digest("hex")));
      await writeFile(path.join(root, "artifacts", "handoff.json"), JSON.stringify(approved, null, 2));
      await execFileAsync("git", ["-C", root, "add", "artifacts/handoff.json"]);
      await execFileAsync("git", ["-C", root, "commit", "-m", "add governed handoff"]);
      await expect(verifyGovernedHandoffForExecution(root, approved, ["artifacts/handoff.json"])).resolves.toMatchObject({ errors: [] });
      await writeFile(path.join(root, "src", "index.js"), "export const ok = false;\n");
      const dirty = await verifyGovernedHandoffForExecution(root, approved, ["artifacts/handoff.json"]);
      expect(dirty.errors).toContain("repository worktree is not clean");
      await execFileAsync("git", ["-C", root, "add", "src/index.js"]);
      await execFileAsync("git", ["-C", root, "commit", "-m", "unauthorized source change"]);
      const stale = await verifyGovernedHandoffForExecution(root, approved, ["artifacts/handoff.json"]);
      expect(stale.errors).toContain("src/index.js: intervening change is outside the authorized handoff carriers");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("renders a digest-bound AgentFlow backlog", () => {
    const parsed = GovernedTaskHandoffSchema.parse(handoff);
    const backlog = renderBacklog(parsed, "artifacts/handoff.json", "BACKLOG.design-intelligence.proposed.md");
    expect(parseHandoffBinding(backlog)).toEqual(expect.objectContaining({ id: handoff.handoffId, programId: handoff.programId, sha256: canonicalJsonSha256(handoff) }));
    expect(backlog).toContain("## AF-001: Implement");
    const plan = planBacklogMarkdown(backlog);
    expect(plan.errors).toEqual([]);
    expect(plan.valid).toBe(true);
    expect(backlogHandoffErrors(plan.plan?.tasks ?? [], parsed)).toEqual([]);
  });
  it("detects backlog scope drift after import", () => {
    const parsed = GovernedTaskHandoffSchema.parse(handoff);
    const plan = planBacklogMarkdown(renderBacklog(parsed, "artifacts/handoff.json", "BACKLOG.design-intelligence.proposed.md").replace("src/", "other/"));
    expect(backlogHandoffErrors(plan.plan?.tasks ?? [], parsed)).toContain("AF-001.owns differs from the governed handoff");
  });
  it("detects authority source drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentflow-di-authority-"));
    await writeFile(path.join(root, "AGENTS.md"), "current authority\n");
    const parsed = GovernedTaskHandoffSchema.parse(handoff);
    await expect(verifyHandoffAuthoritySources(root, parsed)).resolves.toEqual(["AGENTS.md: authority source hash mismatch"]);
  });
  it("detects governed repository snapshot drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentflow-di-snapshot-"));
    try {
      await execFileAsync("git", ["init", "--initial-branch=main", root]);
      await execFileAsync("git", ["-C", root, "config", "user.name", "AgentFlow Test"]);
      await execFileAsync("git", ["-C", root, "config", "user.email", "agentflow@example.test"]);
      await writeFile(path.join(root, "AGENTS.md"), "current authority\n");
      await execFileAsync("git", ["-C", root, "add", "AGENTS.md"]);
      await execFileAsync("git", ["-C", root, "commit", "-m", "base"]);
      const baseCommit = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
      const authority = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "AGENTS.md")));
      const parsed = GovernedTaskHandoffSchema.parse(approvedHandoff(baseCommit, createHash("sha256").update(authority).digest("hex"), "0".repeat(64)));
      const verification = await verifyGovernedHandoffForExecution(root, parsed, []);
      expect(verification.errors).toContain("repository snapshot digest does not match the governed authority snapshot");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("round trips an approved handoff through planning and a build receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentflow-di-roundtrip-"));
    const runtime = await mkdtemp(path.join(tmpdir(), "agentflow-di-runtime-"));
    try {
      await execFileAsync("git", ["init", "--initial-branch=main", root]);
      await execFileAsync("git", ["-C", root, "config", "user.name", "AgentFlow Test"]);
      await execFileAsync("git", ["-C", root, "config", "user.email", "agentflow@example.test"]);
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src", "index.js"), "export const ok = true;\n");
      await writeFile(path.join(root, "AGENTS.md"), "# Repository authority\n");
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "di-roundtrip", private: true, scripts: { typecheck: "node --check src/index.js" } }, null, 2));
      await writeFile(path.join(root, ".agentflow.yaml"), "version: 1\nrepository:\n  name: di-roundtrip\n  base_branch: main\nbacklog:\n  path: BACKLOG.design-intelligence.proposed.md\nworkers:\n  maximum: 1\ncontracts:\n  roots:\n    - contracts/\nvalidation:\n  task_default:\n    - npm run typecheck\n  integration:\n    - npm run typecheck\ndocker:\n  enabled: false\n  compose_file: compose.yaml\ngit:\n  remote: origin\n  push_task_branches: false\n  push_integration_branch: false\n  open_integration_pull_request: false\n");
      await execFileAsync("git", ["-C", root, "add", "."]);
      await execFileAsync("git", ["-C", root, "commit", "-m", "base"]);
      const baseCommit = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
      const authority = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "AGENTS.md")));
      const approved = GovernedTaskHandoffSchema.parse(approvedHandoff(baseCommit, createHash("sha256").update(authority).digest("hex")));
      await mkdir(path.join(root, "artifacts"));
      await writeFile(path.join(root, "artifacts", "handoff.json"), JSON.stringify(approved, null, 2));
      await execFileAsync("git", ["-C", root, "add", "artifacts/handoff.json"]);
      await execFileAsync("git", ["-C", root, "commit", "-m", "approve handoff"]);
      const { app, context } = await buildApp({ environment: resolveEnvironment({ AGENTFLOW_HOME: runtime, AGENTFLOW_LOG_LEVEL: "silent" }), staticRoot: false, logger: false });
      try {
        const registered = await app.inject({ method: "POST", url: "/api/repositories", payload: { path: root } });
        expect(registered.statusCode, registered.body).toBe(201);
        const repositoryId = registered.json<{ id: string }>().id;
        const noncanonical = approvedHandoff(baseCommit, createHash("sha256").update(authority).digest("hex"), undefined, undefined, { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }] });
        const rawProfile = structuredClone(noncanonical) as unknown as { tasks: Array<Record<string, unknown>> };
        const rawTask = rawProfile.tasks[0];
        if (rawTask === undefined) throw new Error("Expected raw native profile task");
        delete rawTask.consumes;
        const rawPath = path.join(root, "artifacts", "noncanonical-profile.json");
        await writeFile(rawPath, JSON.stringify(rawProfile));
        const refusedRaw = await app.inject({ method: "POST", url: "/api/design-intelligence/handoffs/import", payload: { repositoryId, handoffPath: "artifacts/noncanonical-profile.json", backlogPath: "BACKLOG.rejected-profile.md" } });
        expect(refusedRaw.statusCode, refusedRaw.body).toBe(400);
        expect(context.store.plans.listForRepository(repositoryId)).toHaveLength(0);
        expect(context.store.builds.list({ repositoryId })).toHaveLength(0);
        await expect(readFile(path.join(root, "BACKLOG.rejected-profile.md"))).rejects.toMatchObject({ code: "ENOENT" });
        await rm(rawPath);

        const imported = await app.inject({ method: "POST", url: "/api/design-intelligence/handoffs/import", payload: { repositoryId, handoffPath: "artifacts/handoff.json" } });
        expect(imported.statusCode).toBe(200);
        await execFileAsync("git", ["-C", root, "add", "BACKLOG.design-intelligence.proposed.md"]);
        await execFileAsync("git", ["-C", root, "commit", "-m", "review execution packet"]);

        const planned = await app.inject({ method: "POST", url: "/api/plans", payload: { repositoryId, backlogPath: "BACKLOG.design-intelligence.proposed.md" } });
        expect(planned.statusCode).toBe(201);
        expect(planned.json()).toMatchObject({ governedHandoff: { id: approved.handoffId, programId: approved.programId, sha256: canonicalJsonSha256(approved), governedBaseCommit: baseCommit } });
        await execFileAsync("git", ["-C", root, "commit", "--allow-empty", "-m", "mechanical revision"]);
        const staleBuild = await app.inject({ method: "POST", url: "/api/builds", payload: { planId: planned.json<{ id: string }>().id } });
        expect(staleBuild.statusCode).toBe(409);
        expect(staleBuild.json()).toMatchObject({ error: { code: "GOVERNED_EXECUTION_SNAPSHOT_STALE" } });
        const refreshedPlan = await app.inject({ method: "POST", url: "/api/plans", payload: { repositoryId, backlogPath: "BACKLOG.design-intelligence.proposed.md" } });
        expect(refreshedPlan.statusCode).toBe(201);
        const created = await app.inject({ method: "POST", url: "/api/builds", payload: { planId: refreshedPlan.json<{ id: string }>().id } });
        expect(created.statusCode).toBe(201);
        const taskId = created.json<{ tasks: Array<{ id: string }> }>().tasks[0]?.id;
        expect(taskId).toBeDefined();
        const retry = await app.inject({ method: "POST", url: `/api/builds/${created.json<{ id: string }>().id}/tasks/${taskId}/retry` });
        expect(retry.statusCode).toBe(409);
        expect(retry.json()).toMatchObject({ error: { code: "GOVERNED_RECOVERY_NOT_AUTHORIZED" } });
        const governed = await app.inject({ method: "POST", url: `/api/builds/${created.json<{ id: string }>().id}/governor/evaluate` });
        expect(governed.statusCode, governed.body).toBe(200);
        expect(governed.json()).toMatchObject({ decision: { policyVersion: "governor.v1", action: "CONTINUE" }, acknowledgement: { acknowledged: true } });
        const receipt = await app.inject({ method: "GET", url: `/api/builds/${created.json<{ id: string }>().id}/design-intelligence-receipt` });
        expect(receipt.statusCode).toBe(200);
        expect(receipt.json()).toMatchObject({ schemaVersion: "1.1.0", kind: "agentflow/build-receipt", programId: approved.programId, handoff: { id: approved.handoffId, sha256: canonicalJsonSha256(approved) }, build: { status: "ready", governedBaseCommit: baseCommit } });
        expect(receipt.json<{ evidence: { events: Array<Record<string, unknown>> } }>().evidence.events.every((event) => Object.keys(event).every((key) => ["type", "payload", "sha256"].includes(key)))).toBe(true);
        expect(receipt.json<{ evidence: { events: Array<{ type: string }> } }>().evidence.events.every((event) => ["receipt.transition", "integration.completed", "build.completed"].includes(event.type))).toBe(true);
        const retainedReceipt = await makeDesignIntelligenceReceipt(context, created.json<{ id: string }>().id);
        const provenance = retainedReceipt.receipt.evidence.artifacts.find((artifact) => artifact.class === "agentflow:governor-provenance");
        const provenanceSource = retainedReceipt.sources.find((source) => source.relativePath === provenance?.path);
        if (provenance === undefined || provenanceSource === undefined) throw new Error("Expected retained native Governor provenance");
        const provenanceBytes = await readFile(provenanceSource.sourcePath);
        const nativeEvents = context.store.events.listForBuild(created.json<{ id: string }>().id).filter((event) => event.type.startsWith("governor."));
        const retainedGovernor = JSON.parse(provenanceBytes.toString("utf8")) as { events: typeof nativeEvents; sourceEventWatermark: number };
        expect(retainedGovernor.events).toEqual(nativeEvents);
        expect(retainedGovernor.sourceEventWatermark).toBe(context.store.events.getLatestSequence(created.json<{ id: string }>().id));
        const decisions = nativeEvents.filter((event) => event.type === "governor.decision");
        const acknowledgements = nativeEvents.filter((event) => event.type === "governor.intervention_acknowledged");
        expect(decisions.length).toBeGreaterThan(0);
        expect(acknowledgements.length).toBeGreaterThan(0);
        expect(acknowledgements.every((ack) => decisions.some((decision) => decision.payload.recordHash === ack.payload.decisionRecordHash))).toBe(true);
        expect(createHash("sha256").update(provenanceBytes).digest("hex")).toBe(provenance.sha256);
        expect((await makeDesignIntelligenceReceipt(context, created.json<{ id: string }>().id)).sources.find((source) => source.relativePath === provenance.path)?.sha256).toBe(provenance.sha256);
        await writeFile(provenanceSource.sourcePath, Buffer.concat([provenanceBytes, Buffer.from(" ")]));
        const provenanceTamper = await app.inject({ method: "GET", url: `/api/builds/${created.json<{ id: string }>().id}/design-intelligence-receipt` });
        expect(provenanceTamper.statusCode, provenanceTamper.body).toBe(409);
        await writeFile(provenanceSource.sourcePath, provenanceBytes);
        // Native route reads while active must not freeze the final native receipt.
        const buildId = created.json<{ id: string }>().id;
        type ReceiptEvidence = { evidence: { artifacts: Array<{ path: string; sha256: string }> }; tasks: Array<{ status: string }> };
        const provisional = receipt.json<ReceiptEvidence>().evidence.artifacts[0];
        expect(provisional).toBeDefined();
        if (provisional === undefined || taskId === undefined) throw new Error("Expected native task and provisional evidence");
        const provisionalBytes = await readFile(path.join(root, "artifacts", provisional.path), "utf8");
        expect(JSON.parse(provisionalBytes)).toMatchObject({ provisional: true, buildStatus: "ready" });
        const actualNativeRead = nativeEvidenceControl.readManagedNativeEvidenceBytes;
        let receiptStateChanged = false;
        const stateRace = vi.spyOn(nativeEvidenceControl, "readManagedNativeEvidenceBytes").mockImplementation(async (...args) => {
          const bytes = await actualNativeRead(...args);
          if (args[1].includes("governor-provenance") && !receiptStateChanged) {
            receiptStateChanged = true;
            context.store.builds.transition(buildId, "running");
            context.store.tasks.transition(taskId, "running");
          }
          return bytes;
        });
        const staleNativeState = await app.inject({ method: "GET", url: `/api/builds/${buildId}/design-intelligence-receipt` });
        stateRace.mockRestore();
        expect(receiptStateChanged).toBe(true);
        expect(staleNativeState.statusCode, staleNativeState.body).toBe(409);
        const running = await app.inject({ method: "GET", url: `/api/builds/${buildId}/design-intelligence-receipt` });
        expect(running.statusCode, running.body).toBe(200);
        expect(running.json<ReceiptEvidence>().tasks[0]?.status).toBe("running");
        expect(running.json<ReceiptEvidence>().evidence.artifacts[0]?.path).not.toBe(provisional.path);
        context.store.tasks.transition(taskId, "failed");
        context.store.builds.transition(buildId, "failed");
        const terminal = await app.inject({ method: "GET", url: `/api/builds/${buildId}/design-intelligence-receipt` });
        expect(terminal.statusCode, terminal.body).toBe(200);
        expect(terminal.json()).toMatchObject({ build: { status: "failed" }, tasks: [{ status: "failed" }] });
        const retained = terminal.json<ReceiptEvidence>().evidence.artifacts[0];
        expect(retained?.path).not.toBe(provisional.path);
        if (retained === undefined) throw new Error("Expected retained terminal evidence");
        const retainedPath = path.join(root, "artifacts", retained.path);
        const retainedBytes = await readFile(retainedPath, "utf8");
        expect(JSON.parse(retainedBytes)).toMatchObject({ provisional: false, buildStatus: "failed" });
        expect(createHash("sha256").update(retainedBytes).digest("hex")).toBe(retained.sha256);
        expect(await readFile(path.join(root, "artifacts", provisional.path), "utf8")).toBe(provisionalBytes);
        const repeated = await app.inject({ method: "GET", url: `/api/builds/${buildId}/design-intelligence-receipt` });
        expect(repeated.statusCode, repeated.body).toBe(200);
        expect(repeated.json()).toEqual(terminal.json());
        await writeFile(retainedPath, "tampered retained evidence");
        const tampered = await app.inject({ method: "GET", url: `/api/builds/${buildId}/design-intelligence-receipt` });
        expect(tampered.statusCode, tampered.body).toBe(409);
        expect(tampered.json()).toMatchObject({ error: { code: "RECEIPT_EVIDENCE_CHANGED" } });
        expect(await readFile(retainedPath, "utf8")).toBe("tampered retained evidence");
      } finally {
        await app.close();
      }
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(runtime, { recursive: true, force: true })]);
    }
  }, 20_000);
});

function firstCapturedTask(plan: Record<string, unknown>): Record<string, unknown> {
  const task = (plan.tasks as Array<Record<string, unknown>>)[0];
  if (task === undefined) throw new Error("Expected the fixture's captured task");
  return task;
}

describe("ordinary governed execution admission", () => {
  it("checks current captured data when recovery reuses an already constructed runtime", async () => {
    await withAdmissionFixture(true, async ({ app, context, buildId }) => {
      vi.spyOn(context.coordinator, "requestTick").mockImplementation(() => {});
      const started = await app.inject({ method: "POST", url: `/api/builds/${buildId}/start` });
      expect(started.statusCode, started.body).toBe(200);
      const staleBuild = context.store.builds.getById(buildId);
      const task = context.store.tasks.listForBuild(buildId)[0];
      if (task === undefined) throw new Error("Expected fixture task");
      context.store.database.prepare("UPDATE builds SET backlog_contents = 'changed' WHERE id = ?").run(buildId);
      const runtime = vi.spyOn(GitWorktreeManager, "create");
      await expect(context.coordinator.queueIntegration(staleBuild, task)).rejects.toMatchObject({ code: "GOVERNED_PLAN_SNAPSHOT_DRIFT" });
      expect(runtime).not.toHaveBeenCalled();
      expect(context.store.tasks.getById(task.id).state).toBe("ready");
    });
  });

  it.each(["paused", "interrupted"] as const)("resumes an unchanged %s governed build with scheduling disabled", async (status) => {
    await withAdmissionFixture(true, async ({ app, context, buildId }) => {
      context.store.builds.transition(buildId, "running");
      context.store.builds.transition(buildId, status);
      const scheduling = vi.spyOn(context.coordinator, "requestTick").mockImplementation(() => {});
      const provider = vi.spyOn(context.agentProviders, "get").mockImplementation(() => { throw new Error("TEST_PROVIDER_MUST_NOT_RUN"); });
      const response = await app.inject({ method: "POST", url: `/api/builds/${buildId}/resume` });
      expect(response.statusCode, response.body).toBe(200);
      expect(context.store.builds.getById(buildId).status).toBe("running");
      expect(scheduling).toHaveBeenCalledExactlyOnceWith(buildId);
      expect(provider).not.toHaveBeenCalled();
    });
  });

  it.each(["paused", "interrupted"] as const)("refuses %s recovery before constructing runtime from a changed snapshot", async (status) => {
    await withAdmissionFixture(true, async ({ app, context, buildId }) => {
      context.store.builds.transition(buildId, "running");
      context.store.builds.transition(buildId, status);
      context.store.database.prepare("UPDATE builds SET backlog_contents = 'changed' WHERE id = ?").run(buildId);
      const runtime = vi.spyOn(GitWorktreeManager, "create").mockRejectedValue(new Error("TEST_RUNTIME_MUST_NOT_START"));
      const response = await app.inject({ method: "POST", url: `/api/builds/${buildId}/resume` });
      expect(runtime).not.toHaveBeenCalled();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "GOVERNED_PLAN_SNAPSHOT_DRIFT" } });
      expect(context.store.builds.getById(buildId).status).toBe(status);
      expect(context.store.events.listForBuild(buildId).some((event) => event.type === "build.resumed")).toBe(false);
    });
  });

  it.each(["resumeValidation", "queueIntegration"] as const)("refuses captured drift before %s recovery creates runtime", async (entry) => {
    await withAdmissionFixture(true, async ({ context, buildId }) => {
      context.store.database.prepare("UPDATE builds SET backlog_contents = 'changed' WHERE id = ?").run(buildId);
      const task = context.store.tasks.listForBuild(buildId)[0];
      if (task === undefined) throw new Error("Expected fixture task");
      const runtime = vi.spyOn(GitWorktreeManager, "create").mockRejectedValue(new Error("TEST_RUNTIME_MUST_NOT_START"));
      await expect(context.coordinator[entry](context.store.builds.getById(buildId), task)).rejects.toMatchObject({ code: "GOVERNED_PLAN_SNAPSHOT_DRIFT" });
      expect(runtime).not.toHaveBeenCalled();
    });
  });

  it.each(["normalized_plan_json", "repository_config_json", "backlog_contents"])("refuses %s changes between verification and atomic build capture", async (column) => {
    await withAdmissionFixture(true, async ({ app, context, buildId }) => {
      const original = context.store.builds.getById(buildId);
      context.store.builds.transition(buildId, "cancelled");
      const planned = await app.inject({ method: "POST", url: "/api/plans", payload: { repositoryId: original.repositoryId } });
      expect(planned.statusCode, planned.body).toBe(201);
      const planId = planned.json<{ id: string }>().id;
      const transaction = context.store.transaction.bind(context.store);
      vi.spyOn(context.store, "transaction").mockImplementationOnce((operation) => {
        const current = context.store.plans.getById(planId);
        const value = column === "backlog_contents" ? "changed" : JSON.stringify({ ...(column === "normalized_plan_json" ? current.normalizedPlan : current.repositoryConfig), changed: true });
        context.store.database.prepare(`UPDATE plans SET ${column} = ? WHERE id = ?`).run(value, planId);
        return transaction(operation);
      });
      const created = await app.inject({ method: "POST", url: "/api/builds", payload: { planId } });
      expect(created.statusCode, created.body).toBe(409);
      expect(created.json()).toMatchObject({ error: { code: "GOVERNED_PLAN_SNAPSHOT_DRIFT" } });
      expect(context.store.builds.findActive(original.repositoryId)).toBeUndefined();
      expect(context.store.plans.getById(planId).lockedAt).toBeNull();
    });
  });

  it.each(["validate", "owns", "acceptanceCriteria"])("refuses build creation when the stored plan's %s no longer matches approval", async (field) => {
    await withAdmissionFixture(true, async ({ app, context, buildId }) => {
      const original = context.store.builds.getById(buildId);
      context.store.builds.transition(buildId, "cancelled");
      const planned = await app.inject({ method: "POST", url: "/api/plans", payload: { repositoryId: original.repositoryId } });
      expect(planned.statusCode, planned.body).toBe(201);
      const plan = planned.json<Record<string, unknown>>();
      firstCapturedTask(plan)[field] = ["different-reviewed-scope"];
      // Native plan immutability starts when a build is created. Simulate
      // pre-build corruption without removing that trigger or changing approval.
      context.store.database.prepare("UPDATE plans SET normalized_plan_json = ? WHERE id = ?").run(JSON.stringify(plan), plan.id);
      const created = await app.inject({ method: "POST", url: "/api/builds", payload: { planId: plan.id } });
      expect(created.statusCode, created.body).toBe(409);
      expect(created.json()).toMatchObject({ error: { code: "GOVERNED_HANDOFF_SCOPE_DRIFT" } });
      expect(context.store.builds.findActive(original.repositoryId)).toBeUndefined();
      expect(context.store.plans.getById(String(plan.id)).lockedAt).toBeNull();
    });
  });

  it("compares canonical snapshot contents without treating JSON property order as drift", async () => {
    await withAdmissionFixture(true, async ({ context, buildId }) => {
      const build = context.store.builds.getById(buildId);
      const reordered = Object.fromEntries(Object.entries(build.normalizedPlan).reverse());
      context.store.database.prepare("UPDATE builds SET normalized_plan_json = ? WHERE id = ?").run(JSON.stringify(reordered), buildId);
      await expect(context.coordinator.validateExecutionAuthority(context.store.builds.getById(buildId))).resolves.toBeUndefined();
    });
  });

  it("does not downgrade a current governed plan by clearing every captured snapshot marker", async () => {
    await withAdmissionFixture(true, async ({ app, context, buildId }) => {
      context.store.database.prepare("UPDATE builds SET normalized_plan_json = '{}', backlog_sha256 = NULL, backlog_contents = '' WHERE id = ?").run(buildId);
      const runtime = vi.spyOn(GitWorktreeManager, "create").mockRejectedValue(new Error("TEST_RUNTIME_MUST_NOT_START"));
      const response = await app.inject({ method: "POST", url: `/api/builds/${buildId}/start` });
      expect(runtime).not.toHaveBeenCalled();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "GOVERNED_PLAN_SNAPSHOT_DRIFT" } });
    });
  });

  it.each([
    { name: "task validation", column: "normalized_plan_json", change: (value: Record<string, unknown>) => { firstCapturedTask(value).validate = ["node -e 'process.exit(0)'"]; } },
    { name: "task acceptance", column: "normalized_plan_json", change: (value: Record<string, unknown>) => { firstCapturedTask(value).acceptanceCriteria = ["A different result"]; } },
    { name: "task ownership", column: "normalized_plan_json", change: (value: Record<string, unknown>) => { firstCapturedTask(value).owns = ["outside-reviewed-scope/"]; } },
    { name: "removed handoff binding", column: "normalized_plan_json", change: (value: Record<string, unknown>) => { delete value.governedHandoff; } },
    { name: "substituted handoff digest", column: "normalized_plan_json", change: (value: Record<string, unknown>) => { (value.governedHandoff as Record<string, unknown>).sha256 = "f".repeat(64); } },
    { name: "plan identity", column: "normalized_plan_json", change: (value: Record<string, unknown>) => { value.id = "substituted-plan"; } },
    { name: "repository configuration", column: "repository_config_json", change: (value: Record<string, unknown>) => { (value.validation as Record<string, unknown>).integration = ["node -e 'process.exit(0)'"]; } },
  ])("refuses Start when captured $name differs from the immutable plan", async ({ column, change }) => {
    await withAdmissionFixture(true, async ({ app, context, buildId }) => {
      const build = context.store.builds.getById(buildId);
      const captured = structuredClone(column === "normalized_plan_json" ? build.normalizedPlan : build.repositoryConfig);
      change(captured);
      // Fault injection into disposable SQLite only. The approved source and
      // locked plan stay intact; no real provider or runtime may be reached.
      context.store.database.prepare(`UPDATE builds SET ${column} = ? WHERE id = ?`).run(JSON.stringify(captured), buildId);
      const runtime = vi.spyOn(GitWorktreeManager, "create").mockRejectedValue(new Error("TEST_RUNTIME_MUST_NOT_START"));
      const provider = vi.spyOn(context.agentProviders, "get").mockImplementation(() => { throw new Error("TEST_PROVIDER_MUST_NOT_RUN"); });

      const response = await app.inject({ method: "POST", url: `/api/builds/${buildId}/start` });

      expect(runtime).not.toHaveBeenCalled();
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "GOVERNED_PLAN_SNAPSHOT_DRIFT" } });
      expect(context.store.builds.getById(buildId).status).toBe("ready");
      expect(runtime).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(context.store.events.listForBuild(buildId).some((event) => event.type === "build.started")).toBe(false);
    });
  });

  it.each([
    ["backlog_path", "different-backlog.md"],
    ["backlog_sha256", "f".repeat(64)],
    ["backlog_contents", "# Substituted backlog\n"],
  ])("refuses captured %s drift before starting a governed runtime", async (column, value) => {
    await withAdmissionFixture(true, async ({ app, context, buildId }) => {
      context.store.database.prepare(`UPDATE builds SET ${column} = ? WHERE id = ?`).run(value, buildId);
      const runtime = vi.spyOn(GitWorktreeManager, "create").mockRejectedValue(new Error("TEST_RUNTIME_MUST_NOT_START"));
      const response = await app.inject({ method: "POST", url: `/api/builds/${buildId}/start` });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "GOVERNED_PLAN_SNAPSHOT_DRIFT" } });
      expect(runtime).not.toHaveBeenCalled();
      expect(context.store.builds.getById(buildId).status).toBe("ready");
    });
  });

  it.each([
    {
      name: "authority source changes",
      change: async (root: string) => writeFile(path.join(root, "AGENTS.md"), "# Changed authority after build creation\n"),
      code: "GOVERNED_HANDOFF_NOT_EXECUTABLE",
    },
    {
      name: "tracked source changes without a commit",
      change: async (root: string) => writeFile(path.join(root, "src/index.js"), "export const changed = true;\n"),
      code: "GOVERNED_HANDOFF_NOT_EXECUTABLE",
    },
    {
      name: "tracked source changes in a later commit",
      change: async (root: string) => {
        await writeFile(path.join(root, "src/index.js"), "export const changed = true;\n");
        await admissionGit(root, ["add", "src/index.js"]);
        await admissionGit(root, ["commit", "-m", "fixture source drift"]);
      },
      code: "GOVERNED_HANDOFF_NOT_EXECUTABLE",
    },
    {
      name: "HEAD changes without changing any file",
      change: async (root: string) => { await admissionGit(root, ["commit", "--allow-empty", "-m", "fixture HEAD drift"]); },
      code: "GOVERNED_EXECUTION_SNAPSHOT_STALE",
    },
  ])("refuses Start after $name without a Wale experiment", async ({ change, code }) => {
    await withAdmissionFixture(true, async ({ root, app, context, buildId }) => {
      expect(loadBoundWaleExperiment(context.store.events, buildId)).toBeUndefined();
      await change(root);
      const runtime = vi.spyOn(GitWorktreeManager, "create").mockRejectedValue(new Error("TEST_RUNTIME_MUST_NOT_START"));
      const provider = vi.spyOn(context.agentProviders, "get").mockImplementation(() => { throw new Error("TEST_PROVIDER_MUST_NOT_RUN"); });

      const response = await app.inject({ method: "POST", url: `/api/builds/${buildId}/start` });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: { code } });
      expect(context.store.builds.getById(buildId).status).toBe("ready");
      expect(runtime).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(context.store.events.listForBuild(buildId).some((event) => event.type === "build.started")).toBe(false);
    });
  });

  it("admits an unchanged exact governed snapshot without requiring a Wale experiment", async () => {
    await withAdmissionFixture(true, async ({ context, buildId }) => {
      expect(loadBoundWaleExperiment(context.store.events, buildId)).toBeUndefined();
      const provider = vi.spyOn(context.agentProviders, "get").mockImplementation(() => { throw new Error("TEST_PROVIDER_MUST_NOT_RUN"); });

      await expect(context.coordinator.validateExecutionAuthority(context.store.builds.getById(buildId))).resolves.toBeUndefined();

      expect(provider).not.toHaveBeenCalled();
      expect(context.store.builds.getById(buildId).status).toBe("ready");
    });
  });

  it("preserves the ungoverned admission path without imposing a handoff", async () => {
    await withAdmissionFixture(false, async ({ root, context, buildId }) => {
      const build = context.store.builds.getById(buildId);
      const plan = context.store.plans.getById(build.planId ?? "");
      expect(plan.normalizedPlan.governedHandoff).toBeUndefined();
      expect(loadBoundWaleExperiment(context.store.events, buildId)).toBeUndefined();
      await writeFile(path.join(root, "src/index.js"), "export const ungoverned = true;\n");
      const repositoryLookup = vi.spyOn(context.repositoryService, "get");
      const provider = vi.spyOn(context.agentProviders, "get").mockImplementation(() => { throw new Error("TEST_PROVIDER_MUST_NOT_RUN"); });

      await expect(context.coordinator.validateExecutionAuthority(build)).resolves.toBeUndefined();

      expect(repositoryLookup).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
      expect(context.store.builds.getById(buildId).status).toBe("ready");
    });
  });

  it.each(["failed", "cancelled"] as const)("admits a fresh separately approved build after a %s build without rewriting its history", async (terminalStatus) => {
    await withAdmissionFixture(true, async ({ root, app, context, buildId }) => {
      // Admission qualification only: construct real native runtimes, but never
      // dispatch work or invoke a provider. Failure/attempt rows below are an
      // explicit test-harness setup, not evidence of a real worker failure.
      const scheduling = vi.spyOn(context.coordinator, "requestTick").mockImplementation(() => undefined);
      const provider = vi.spyOn(context.agentProviders, "get").mockImplementation(() => { throw new Error("TEST_PROVIDER_MUST_NOT_RUN"); });
      const initial = context.store.builds.getById(buildId);
      const initialTask = context.store.tasks.listForBuild(buildId)[0];
      if (initial.planId === null || initialTask === undefined) throw new Error("Expected the original native plan/task");
      const initialPlan = context.store.plans.getById(initial.planId);
      const firstApproval = GovernedTaskHandoffSchema.parse(JSON.parse(await readFile(path.join(root, "handoff.json"), "utf8")));
      const firstStart = await app.inject({ method: "POST", url: `/api/builds/${buildId}/start` });
      expect(firstStart.statusCode, firstStart.body).toBe(200);
      context.store.tasks.createAttempt({ id: `test-harness-${randomUUID()}`, taskId: initialTask.id, buildId, attempt: initialTask.attempt, status: "running", startedAt: new Date().toISOString() });
      context.store.tasks.transition(initialTask.id, "running", { eventType: "unit.fixture_task_running" });
      context.store.tasks.updateAttempt(initialTask.id, initialTask.attempt, { status: "failed", completedAt: new Date().toISOString(), errorCode: "TEST_HARNESS_FAILURE", errorMessage: "Synthetic admission fixture only" });
      context.store.tasks.transition(initialTask.id, "failed", { eventType: "unit.fixture_task_failed", errorCode: "TEST_HARNESS_FAILURE", errorMessage: "Synthetic admission fixture only" });
      if (terminalStatus === "cancelled") {
        const cancelled = await app.inject({ method: "POST", url: `/api/builds/${buildId}/cancel` });
        expect(cancelled.statusCode, cancelled.body).toBe(200);
      } else {
        context.store.builds.transition(buildId, "failed", { eventType: "unit.fixture_build_failed" });
      }
      expect(context.store.builds.getById(buildId).status).toBe(terminalStatus);
      const retry = await app.inject({ method: "POST", url: `/api/builds/${buildId}/tasks/${initialTask.id}/retry` });
      expect(retry.statusCode, retry.body).toBe(409);
      expect(retry.json()).toMatchObject({ error: { code: "GOVERNED_RECOVERY_NOT_AUTHORIZED" } });
      const priorDetail = await app.inject({ method: "GET", url: `/api/builds/${buildId}/tasks/${initialTask.id}` });
      expect(priorDetail.statusCode, priorDetail.body).toBe(200);
      const retained = {
        build: context.store.builds.getById(buildId),
        plan: context.store.plans.getById(initial.planId),
        tasks: context.store.tasks.listForBuild(buildId),
        detail: priorDetail.json<Record<string, unknown>>(),
        events: context.store.events.listForBuild(buildId),
      };
      expect(retained.detail.attempts).toEqual([expect.objectContaining({ taskId: initialTask.id, buildId, status: "failed", errorCode: "TEST_HARNESS_FAILURE" })]);

      // The first fixture approval has iterationCeiling=1. Create a distinct
      // synthetic approval for this exact new base; do not infer permission for
      // another iteration from the original receipt or the terminal build.
      const freshBase = await admissionGit(root, ["rev-parse", "HEAD"]);
      const authority = await readFile(path.join(root, "AGENTS.md"));
      const freshApproval = GovernedTaskHandoffSchema.parse(approvedHandoff(freshBase, createHash("sha256").update(authority).digest("hex")));
      expect(freshApproval.authority.approvalReceipt.receiptId).not.toBe(firstApproval.authority.approvalReceipt.receiptId);
      expect(freshApproval.authority.approvalReceipt.repositoryRevision).toBe(freshBase);
      expect(freshApproval.authority.approvalReceipt.constraints.iterationCeiling).toBe(1);
      expect(freshApproval.authority.approvalReceipt.supersedes).toBeNull();
      await writeFile(path.join(root, "handoff.json"), JSON.stringify(freshApproval));
      await writeFile(path.join(root, "BACKLOG.md"), renderBacklog(freshApproval, "handoff.json", "BACKLOG.md"));
      await admissionGit(root, ["add", "handoff.json", "BACKLOG.md"]);
      await admissionGit(root, ["commit", "-m", "fixture separately approved fresh execution packet"]);
      const executionBase = await admissionGit(root, ["rev-parse", "HEAD"]);
      expect(executionBase).not.toBe(initial.baseCommit);
      expect(await admissionGit(root, ["status", "--porcelain=v1"])).toBe("");
      const planned = await app.inject({ method: "POST", url: "/api/plans", payload: { repositoryId: initial.repositoryId } });
      expect(planned.statusCode, planned.body).toBe(201);
      const planId = planned.json<{ id: string }>().id;
      expect(planId).not.toBe(initial.planId);
      const created = await app.inject({ method: "POST", url: "/api/builds", payload: { planId } });
      expect(created.statusCode, created.body).toBe(201);
      const freshBuildId = created.json<{ id: string }>().id;
      expect(freshBuildId).not.toBe(buildId);
      const freshBuild = context.store.builds.getById(freshBuildId);
      expect(freshBuild).toMatchObject({ repositoryId: initial.repositoryId, planId, baseCommit: executionBase, status: "ready" });
      expect(freshBuild.integrationBranch).not.toBe(initial.integrationBranch);
      const freshPlan = context.store.plans.getById(planId);
      expect(freshPlan.lockedAt).not.toBeNull();
      expect(freshPlan.normalizedPlan.governedHandoff).toMatchObject({ id: freshApproval.handoffId, sha256: canonicalJsonSha256(freshApproval), governedBaseCommit: freshBase, executionBaseCommit: executionBase });
      expect(freshBuild.normalizedPlan).toEqual(freshPlan.normalizedPlan);
      const freshTask = context.store.tasks.listForBuild(freshBuildId)[0];
      if (freshTask === undefined) throw new Error("Expected a fresh native task");
      expect(freshTask.id).not.toBe(initialTask.id);
      expect(freshTask).toMatchObject({ buildId: freshBuildId, backlogTaskId: initialTask.backlogTaskId, state: "ready", resultCommit: null, integrationCommit: null });
      const freshStart = await app.inject({ method: "POST", url: `/api/builds/${freshBuildId}/start` });
      expect(freshStart.statusCode, freshStart.body).toBe(200);
      expect(context.store.builds.getById(freshBuildId).status).toBe("running");
      expect(context.store.builds.findActive(initial.repositoryId)?.id).toBe(freshBuildId);
      const freshDetail = await app.inject({ method: "GET", url: `/api/builds/${freshBuildId}/tasks/${freshTask.id}` });
      expect(freshDetail.statusCode, freshDetail.body).toBe(200);
      expect(freshDetail.json()).toMatchObject({ id: freshTask.id, state: "ready", attempts: [] });
      const freshEvents = context.store.events.listForBuild(freshBuildId);
      expect(freshEvents.some((event) => event.type === "build.started")).toBe(true);
      expect(freshEvents.some((event) => event.type === "task.started" || event.type === "evidence.native_validation_certified" || event.type === "integration.completed")).toBe(false);
      expect(scheduling.mock.calls).toEqual([[buildId], [freshBuildId]]);
      expect(provider).not.toHaveBeenCalled();
      expect(await admissionGit(root, ["rev-parse", "HEAD"])).toBe(executionBase);
      expect(await admissionGit(root, ["status", "--porcelain=v1"])).toBe("");
      expect(context.store.builds.getById(buildId)).toEqual(retained.build);
      expect(context.store.plans.getById(initial.planId)).toEqual(initialPlan);
      expect(context.store.plans.getById(initial.planId)).toEqual(retained.plan);
      expect(context.store.tasks.listForBuild(buildId)).toEqual(retained.tasks);
      expect(context.store.events.listForBuild(buildId)).toEqual(retained.events);
      const priorReadback = await app.inject({ method: "GET", url: `/api/builds/${buildId}/tasks/${initialTask.id}` });
      expect(priorReadback.statusCode, priorReadback.body).toBe(200);
      expect(priorReadback.json()).toEqual(retained.detail);
    });
  });

  it.each([
    { name: "governed", governed: true },
    { name: "ungoverned", governed: false },
  ])("allows an unchanged $name build to Start with worker scheduling disabled", async ({ governed }) => {
    await withAdmissionFixture(governed, async ({ root, app, context, buildId }) => {
      const head = await admissionGit(root, ["rev-parse", "HEAD"]);
      const scheduling = vi.spyOn(context.coordinator, "requestTick").mockImplementation(() => undefined);
      const provider = vi.spyOn(context.agentProviders, "get").mockImplementation(() => { throw new Error("TEST_PROVIDER_MUST_NOT_RUN"); });

      const response = await app.inject({ method: "POST", url: `/api/builds/${buildId}/start` });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: buildId, status: "running" });
      expect(context.store.builds.getById(buildId).integrationWorktree).not.toBeNull();
      expect(scheduling).toHaveBeenCalledExactlyOnceWith(buildId);
      expect(provider).not.toHaveBeenCalled();
      expect(await admissionGit(root, ["rev-parse", "HEAD"])).toBe(head);
      expect(await admissionGit(root, ["status", "--porcelain=v1"])).toBe("");
    });
  });
});

describe("native execution-authority readback", () => {
  async function snapshot(root: string, context: AgentFlowContext) {
    const tables = context.store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    const database = Object.fromEntries(tables.map(({ name }) => {
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Unexpected fixture table name");
      return [name, context.store.database.prepare('SELECT * FROM "' + name + '"').all().map(row => JSON.stringify(row)).sort()];
    }));
    async function runtimeFiles(directory: string, relative = ""): Promise<Record<string, string>> {
      const files: Record<string, string> = {};
      for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) Object.assign(files, await runtimeFiles(directory, name));
        else if (entry.isFile() && !/\.(?:db|sqlite3?)(?:-(?:wal|shm))?$/.test(name)) files[name] = createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex");
        else if (!entry.isFile()) files[name] = "non-file";
      }
      return files;
    }
    return {
      database,
      head: await admissionGit(root, ["rev-parse", "HEAD"]),
      status: await admissionGit(root, ["status", "--porcelain=v1"]),
      source: await Promise.all(["AGENTS.md", "BACKLOG.md", ".agentflow.yaml", "handoff.json", "src/index.js"].map(async file => [file, await readFile(path.join(root, file)).then(bytes => createHash("sha256").update(bytes).digest("hex"), () => null)])),
      // SQLite bytes/locks and Git's optional index metadata are not a logical
      // state invariant. Every native table and non-database runtime file is.
      runtimeFiles: await runtimeFiles(path.join(path.dirname(root), "runtime")),
    };
  }

  function actionTripwires(context: AgentFlowContext) {
    const action = () => { throw new Error("READBACK_MUST_NOT_ACT"); };
    return [
      vi.spyOn(context.coordinator, "start").mockImplementation(action),
      vi.spyOn(context.coordinator, "resume").mockImplementation(action),
      vi.spyOn(context.coordinator, "pause").mockImplementation(action),
      vi.spyOn(context.coordinator, "cancel").mockImplementation(action),
      vi.spyOn(context.coordinator, "retry").mockImplementation(action),
      vi.spyOn(context.coordinator, "requestTick").mockImplementation(action),
      vi.spyOn(context.agentProviders, "get").mockImplementation(action),
    ];
  }

  async function checkReadback(
    fixture: { root: string; app: Awaited<ReturnType<typeof buildApp>>["app"]; context: AgentFlowContext; buildId: string },
    expected: Record<string, unknown>,
  ) {
    const { root, app, context, buildId } = fixture;
    const forbidden = actionTripwires(context);
    const before = await snapshot(root, context);
    const started = Date.now();
    const response = await app.inject({ method: "GET", url: "/api/builds/" + buildId + "/execution-authority" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ buildId, ...expected });
    const checkedAt = response.json<{ checkedAt: string }>().checkedAt;
    expect(new Date(checkedAt).toISOString()).toBe(checkedAt);
    expect(Date.parse(checkedAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(checkedAt)).toBeLessThanOrEqual(Date.now());
    expect(await snapshot(root, context)).toEqual(before);
    for (const operation of forbidden) expect(operation).not.toHaveBeenCalled();
    return response;
  }

  it("reports current native checks without acting, and repeated reads stay inert", async () => {
    await withAdmissionFixture(true, async fixture => {
      const validate = vi.spyOn(fixture.context.coordinator, "validateExecutionAuthority");
      await checkReadback(fixture, { status: "passed" });
      await checkReadback(fixture, { status: "passed" });
      expect(validate).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["src/index.js", "AGENTS.md"])("reports actual %s drift through the unchanged native guard", async file => {
    await withAdmissionFixture(true, async fixture => {
      await writeFile(path.join(fixture.root, file), "// Changed synthetic source or authority\n");
      const validate = vi.spyOn(fixture.context.coordinator, "validateExecutionAuthority");
      await checkReadback(fixture, { status: "blocked", code: "GOVERNED_HANDOFF_NOT_EXECUTABLE" });
      expect(validate).toHaveBeenCalledExactlyOnceWith(fixture.context.store.builds.getById(fixture.buildId));
    });
  });

  it("checks an explicit ordinary linked plan before reporting non-applicability", async () => {
    await withAdmissionFixture(false, async fixture => {
      const validate = vi.spyOn(fixture.context.coordinator, "validateExecutionAuthority");
      await checkReadback(fixture, { status: "not_applicable" });
      expect(validate).toHaveBeenCalledOnce();
    });
  });

  it("retains native captured-governed drift refusal even for an ordinary linked plan", async () => {
    await withAdmissionFixture(false, async fixture => {
      const build = fixture.context.store.builds.getById(fixture.buildId);
      // Explicit corruption fixture, never a supported mutation path.
      fixture.context.store.database.prepare("UPDATE builds SET normalized_plan_json = ? WHERE id = ?").run(JSON.stringify({ ...build.normalizedPlan, governedHandoff: { id: "corrupted" } }), build.id);
      await checkReadback(fixture, { status: "blocked", code: "GOVERNED_HANDOFF_DRIFT" });
    });
  });

  it("keeps an unbound captured build unknown instead of certifying its client hint", async () => {
    await withAdmissionFixture(true, async fixture => {
      // Explicit orphaning fixture; a missing immutable plan is not authority.
      fixture.context.store.database.prepare("UPDATE builds SET plan_id = NULL WHERE id = ?").run(fixture.buildId);
      const validate = vi.spyOn(fixture.context.coordinator, "validateExecutionAuthority");
      await checkReadback(fixture, { status: "unknown" });
      expect(validate).not.toHaveBeenCalled();
    });
  });

  it("keeps a missing linked plan unknown without exposing its diagnostic", async () => {
    await withAdmissionFixture(true, async fixture => {
      vi.spyOn(fixture.context.store.plans, "getById").mockImplementation(() => { throw Object.assign(new Error("PRIVATE_PLAN_DIAGNOSTIC"), { name: "EntityNotFoundError" }); });
      const response = await checkReadback(fixture, { status: "unknown" });
      expect(response.body).not.toContain("PRIVATE_PLAN_DIAGNOSTIC");
    });
  });

  it("does not certify native pre-snapshot compatibility as current governed authority", async () => {
    await withAdmissionFixture(true, async fixture => {
      const build = fixture.context.store.builds.getById(fixture.buildId);
      if (build.planId === null) throw new Error("Expected a linked native plan");
      const plan = fixture.context.store.plans.getById(build.planId);
      if (plan.normalizedPlan.governedHandoff === undefined) throw new Error("Expected a governed native plan");
      const legacy = { ...plan.normalizedPlan.governedHandoff };
      delete legacy.executionBaseCommit;
      // Actual legacy compatibility shape. The execution validator deliberately
      // permits it, but that early return has not checked current authority.
      // Create a separate legacy plan before native build creation locks it;
      // never disable or bypass the immutable-plan trigger for fixture setup.
      await fixture.app.inject({ method: "POST", url: "/api/builds/" + build.id + "/cancel" });
      const legacyPlan = fixture.context.store.plans.create({ ...plan, id: "legacy-plan", normalizedPlan: { ...plan.normalizedPlan, governedHandoff: legacy } });
      const legacyBuild = fixture.context.store.builds.create({ id: "legacy-build", repositoryId: build.repositoryId, planId: legacyPlan.id, backlogPath: plan.backlogPath, baseCommit: build.baseCommit, integrationBranch: "fixture/legacy", status: "ready", tasks: [] });
      fixture.context.store.database.prepare("UPDATE builds SET backlog_sha256 = NULL, backlog_contents = '', normalized_plan_json = '{}' WHERE id = ?").run(legacyBuild.id);
      const validate = vi.spyOn(fixture.context.coordinator, "validateExecutionAuthority");
      await checkReadback({ ...fixture, buildId: legacyBuild.id }, { status: "unknown" });
      expect(validate).toHaveBeenCalledOnce();
    });
  });

  it("keeps malformed retained handoff schema diagnostics out of the readback", async () => {
    await withAdmissionFixture(true, async ({ root, app, context, buildId }) => {
      const file = path.join(root, "handoff.json");
      const handoff = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      handoff.PRIVATE_NATIVE_SCHEMA_DIAGNOSTIC = true;
      await writeFile(file, JSON.stringify(handoff));
      const forbidden = actionTripwires(context);
      const before = await snapshot(root, context);
      const response = await app.inject({ method: "GET", url: "/api/builds/" + buildId + "/execution-authority" });
      expect(response.statusCode, response.body).toBe(500);
      expect(response.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "AgentFlow could not complete the request" } });
      expect(response.body).not.toContain("PRIVATE_NATIVE_SCHEMA_DIAGNOSTIC");
      expect(await snapshot(root, context)).toEqual(before);
      for (const operation of forbidden) expect(operation).not.toHaveBeenCalled();
    });
  });

  it.each(["GOVERNED_HANDOFF_DRIFT", "NEW_NATIVE_AUTHORITY_REFUSAL"])("reports %s with bounded static text, never raw native diagnostics", async code => {
    await withAdmissionFixture(true, async fixture => {
      vi.spyOn(fixture.context.coordinator, "validateExecutionAuthority").mockRejectedValue(new AgentFlowError(code, "PRIVATE_NATIVE_DIAGNOSTIC", 409, { secret: "PRIVATE_DETAIL" }));
      const response = await checkReadback(fixture, { status: "blocked", code });
      expect(response.body).not.toContain("PRIVATE_NATIVE_DIAGNOSTIC");
      expect(response.body).not.toContain("PRIVATE_DETAIL");
      expect(response.json<{ message: string }>().message).not.toBe("");
    });
  });

  it.each([new Error("PRIVATE_UNEXPECTED_FAILURE"), new AgentFlowError("INVALID NATIVE CODE", "PRIVATE_INVALID_CODE", 409), Object.assign(new Error("PRIVATE_NATIVE_ENTITY_DIAGNOSTIC"), { name: "EntityNotFoundError" })])("keeps unexpected read failures unavailable with the existing sanitized response", async failure => {
    await withAdmissionFixture(true, async ({ root, app, context, buildId }) => {
      vi.spyOn(context.coordinator, "validateExecutionAuthority").mockRejectedValue(failure);
      const forbidden = actionTripwires(context);
      const before = await snapshot(root, context);
      const response = await app.inject({ method: "GET", url: "/api/builds/" + buildId + "/execution-authority" });
      expect(response.statusCode, response.body).toBe(500);
      expect(response.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "AgentFlow could not complete the request" } });
      expect(await snapshot(root, context)).toEqual(before);
      for (const operation of forbidden) expect(operation).not.toHaveBeenCalled();
    });
  });

  it("preserves native 404 for an unknown requested build", async () => {
    await withAdmissionFixture(true, async ({ app, context, root }) => {
      const before = await snapshot(root, context);
      const response = await app.inject({ method: "GET", url: "/api/builds/build_missing/execution-authority" });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(await snapshot(root, context)).toEqual(before);
    });
  });
});

// Real Git, native plan/build routes and SQLite; no provider is invoked. The
// existing synthetic approval helper binds fixture authority bytes and the base.
async function withAdmissionFixture(
  governed: boolean,
  check: (fixture: { root: string; app: Awaited<ReturnType<typeof buildApp>>["app"]; context: AgentFlowContext; buildId: string }) => Promise<void>,
): Promise<void> {
  const temporary = await mkdtemp(path.join(tmpdir(), "agentflow-governed-admission-"));
  const root = path.join(temporary, "repository");
  let application: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await admissionGit(root, ["init", "--initial-branch=main"]);
    await admissionGit(root, ["config", "user.name", "Native admission fixture"]);
    await admissionGit(root, ["config", "user.email", "native-admission@example.invalid"]);
    const authority = "# Synthetic admission test authority\n";
    await writeFile(path.join(root, "AGENTS.md"), authority);
    await writeFile(path.join(root, "src/index.js"), "export const original = true;\n");
    application = await buildApp({ environment: resolveEnvironment({ AGENTFLOW_HOME: path.join(temporary, "runtime"), AGENTFLOW_LOG_LEVEL: "silent", AGENTFLOW_CODEX_BIN: path.join(temporary, "never-invoke-provider") }), staticRoot: false, logger: false });
    const { app, context } = application;
    await context.repositoryService.initialize(root);
    await admissionGit(root, ["add", "."]);
    await admissionGit(root, ["commit", "-m", "fixture base"]);
    const baseCommit = await admissionGit(root, ["rev-parse", "HEAD"]);
    const handoff = GovernedTaskHandoffSchema.parse(approvedHandoff(baseCommit, createHash("sha256").update(authority).digest("hex")));
    const markdown = renderBacklog(handoff, "handoff.json", "BACKLOG.md");
    if (governed) await writeFile(path.join(root, "handoff.json"), JSON.stringify(handoff));
    await writeFile(path.join(root, "BACKLOG.md"), governed ? markdown : "# Native ungoverned test backlog\n\n" + markdown.slice(markdown.indexOf("## ")));
    await admissionGit(root, ["add", "."]);
    await admissionGit(root, ["commit", "-m", "fixture reviewed execution packet"]);
    const registered = await app.inject({ method: "POST", url: "/api/repositories", payload: { path: root } });
    expect(registered.statusCode, registered.body).toBe(201);
    const repositoryId = registered.json<{ id: string }>().id;
    const planned = await app.inject({ method: "POST", url: "/api/plans", payload: { repositoryId } });
    expect(planned.statusCode, planned.body).toBe(201);
    const created = await app.inject({ method: "POST", url: "/api/builds", payload: { planId: planned.json<{ id: string }>().id } });
    expect(created.statusCode, created.body).toBe(201);
    await check({ root, app, context, buildId: created.json<{ id: string }>().id });
  } finally {
    vi.restoreAllMocks();
    await application?.app.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function admissionGit(root: string, arguments_: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", root, ...arguments_], { encoding: "utf8" })).stdout.trim();
}

// This fixture executes native validation/commit/manifest producers, then exercises
// the evidence seam. It does not claim HTTP admission or a provider journey.
type NativePrefixFixture = {
  store: ReturnType<typeof createDatabaseRepositories>;
  environment: ReturnType<typeof resolveEnvironment>;
  context: AgentFlowContext;
  root: string;
  handoff: ReturnType<typeof GovernedTaskHandoffSchema.parse>;
  taskId: string;
  buildId: string;
  executionBase: string;
};
type NativePrefixObserver = (label: string, fixture: NativePrefixFixture) => Promise<void>;

async function nativeEvidenceFixture(capability = false, defect?: "wrong-task" | "unknown-check", integration = false, onPrefix?: NativePrefixObserver) {
  const database = createDatabaseFixture();
  const root = path.join(database.directory, "repository");
  const environment = resolveEnvironment({ AGENTFLOW_HOME: path.join(database.directory, "runtime") });
  const store = createDatabaseRepositories(database.database);
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main", root]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Native evidence fixture"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "native-evidence@example.test"]);
    await writeFile(path.join(root, "src", "index.js"), "export const ready = false;\n");
    const authorityBytes = "# Synthetic native evidence test authority\n";
    await writeFile(path.join(root, "AGENTS.md"), authorityBytes);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node --check src/index.js" } }));
    const semanticCheck = capability && defect === undefined && process.env.AFI003_NATIVE_ROOT !== undefined;
    if (semanticCheck) await writeFile(path.join(root, "src", "capability-check.mjs"), `import {spawnSync} from 'node:child_process';
const result=spawnSync('python3',['-B','-c',${JSON.stringify("import json,sys;sys.path.insert(0,sys.argv[1]);from design_intelligence.agentflow_contracts import bind_capability_plan_to_handoff;h=json.load(open('handoff.json'));p=json.load(open('src/capability-plan.json'));b=json.load(open('src/capability-binding.json'));h['authority']['status']='PROPOSED';[h['authority'].pop(k,None) for k in ('approvedBy','approvedAt','approvalReceipt')];actual=bind_capability_plan_to_handoff(h,p,repository_id=p['context']['repositoryId'],composition_sha256=p['bindings']['compositionSha256'],law_decision_sha256=p['bindings']['lawDecisionSha256']);assert actual['binding']==b,'exact binding mismatch';print('unchanged Proofloom plan/binding semantic validation PASS')")},${JSON.stringify(process.env.AFI003_NATIVE_ROOT)}],{encoding:'utf8'});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1);\n`);
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "fixture base"]);
    const baseCommit = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const commands = capability ? ["npm test", "node --check src/index.js", ...(semanticCheck ? ["node src/capability-check.mjs"] : [])] : ["npm test"];
    const labels = capability ? ["focused tests", "capability-plan", "capability-observation"] : ["focused tests"];
    const produces: Array<{ name: string; type: string; version: string; path?: string }> = labels.map((name) => ({ name, type: "agentflow/native-task-validation-evidence", version: "1.0.0" }));
    if (capability) produces.push({ name: "plan-document", type: "design-intelligence/capability-activation-plan", version: "1.0.0", path: "src/capability-plan.json" }, { name: "binding-document", type: "design-intelligence/capability-handoff-binding", version: "1.0.0", path: "src/capability-binding.json" });
    const handoff = GovernedTaskHandoffSchema.parse(approvedHandoff(baseCommit, createHash("sha256").update(authorityBytes).digest("hex"), undefined, undefined, { produces, requiredEvidence: labels, validate: commands }));
    await writeFile(path.join(root, "handoff.json"), JSON.stringify(handoff));
    await execFileAsync("git", ["-C", root, "add", "handoff.json"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "fixture approved carrier"]);
    const executionBase = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const plan = planBacklogMarkdown(renderBacklog(handoff, "handoff.json", "BACKLOG.md")).plan;
    if (plan === undefined) throw new Error("Expected native fixture plan");
    store.repositories.create({ id: "evidence-repo", name: "evidence fixture", localPath: root, configPath: ".agentflow.yaml", baseBranch: "main" });
    // Qualification retains the immutable native plan row as well as the
    // planner output. Ordinary fixtures keep their existing setup unchanged.
    const normalizedPlan = { ...plan, createdAt: new Date().toISOString(), governedHandoff: { id: handoff.handoffId, ...(handoff.programId === undefined ? {} : { programId: handoff.programId }), sha256: canonicalJsonSha256(handoff), path: "handoff.json", governedBaseCommit: baseCommit, executionBaseCommit: executionBase, carrierPaths: ["handoff.json", "BACKLOG.md"], proofBoundary: handoff.proof.claimBoundary } };
    const backlogContents = renderBacklog(handoff, "handoff.json", "BACKLOG.md");
    const persistedPlan = { ...normalizedPlan, id: "native-parity-plan", repositoryId: "evidence-repo", backlogPath: "BACKLOG.md", backlogSha256: createHash("sha256").update(backlogContents).digest("hex") };
    if (onPrefix !== undefined) {
      store.plans.create({ id: persistedPlan.id, repositoryId: persistedPlan.repositoryId, backlogPath: persistedPlan.backlogPath, backlogSha256: persistedPlan.backlogSha256, backlogContents, repositoryConfig: { version: 1, repository: { name: "evidence fixture", base_branch: "main" }, backlog: { path: "BACKLOG.md" }, workers: { maximum: 1 }, contracts: { roots: [] }, validation: { task_default: ["npm test"], integration: ["npm test"] }, docker: { enabled: false, compose_file: "compose.yaml" }, git: { remote: "origin", push_task_branches: false, push_integration_branch: false } }, normalizedPlan: persistedPlan });
      store.plans.lock("native-parity-plan");
    }
    store.builds.create({ id: "evidence-build", repositoryId: "evidence-repo", backlogPath: "BACKLOG.md", baseCommit: executionBase, integrationBranch: "fixture-integration", status: "running", ...(integration ? { integrationWorktree: root, repositoryConfig: { version: 1, repository: { name: "evidence fixture", base_branch: "main" }, backlog: { path: "BACKLOG.md" }, workers: { maximum: 1 }, contracts: { roots: [] }, validation: { task_default: ["npm test"], integration: ["npm test"] }, docker: { enabled: false, compose_file: "compose.yaml" }, git: { remote: "origin", push_task_branches: false, push_integration_branch: false } } } : {}), normalizedPlan: onPrefix === undefined ? normalizedPlan : persistedPlan, ...(onPrefix === undefined ? {} : { planId: "native-parity-plan" }), tasks: [{ id: "evidence-task", backlogTaskId: "AF-001", title: "Implement", description: "Synthetic native validation fixture", acceptanceCriteria: ["Tests pass"], state: "ready", attempt: 1, branchName: "main", worktreePath: root, baseCommit: executionBase, ownedPaths: ["src/"], validationCommands: commands }] });
    const taskId = "evidence-task"; const buildId = "evidence-build";
    const dependencies = { store, environment };
    const context = { ...dependencies, repositoryService: { get: async () => store.repositories.getById("evidence-repo") }, organizationPolicy: DEFAULT_ORGANIZATION_POLICY } as unknown as AgentFlowContext;
    const prefixFixture = { ...dependencies, context, root, handoff, taskId, buildId, executionBase };
    const attemptStartedAt = new Date().toISOString();
    store.tasks.createAttempt({ id: "evidence-attempt", taskId, buildId, attempt: 1, status: "running", startedAt: attemptStartedAt });
    await onPrefix?.("initial-ready", prefixFixture);
    store.tasks.transition(taskId, "running");
    await onPrefix?.("running", prefixFixture);
    await writeFile(path.join(root, "src", "index.js"), "export const ready = true;\n");
    const capabilityDocuments = capability ? fixtureCapabilityDocuments(handoff, commands, defect) : undefined;
    if (capabilityDocuments !== undefined) {
      await writeFile(path.join(root, "src", "capability-plan.json"), `${JSON.stringify(capabilityDocuments.plan, null, 2)}\n`);
      await writeFile(path.join(root, "src", "capability-binding.json"), `${JSON.stringify(capabilityDocuments.binding, null, 2)}\n`);
    }
    store.tasks.transition(taskId, "validating");
    await onPrefix?.("validating", prefixFixture);
    const validation = await validateTask({ buildId, taskId, attempt: 1, worktreePath: root, baseCommit: executionBase, ownedPaths: ["src/"], commands, workerCompletedSuccessfully: true });
    expect(validation.readyForCommit, JSON.stringify(validation)).toBe(true);
    const directory = path.join(environment.runsPath, buildId, taskId, "attempt-1");
    await mkdir(directory, { recursive: true });
    const logs = [];
    for (const [index, outcome] of validation.commands.entries()) {
      const id = capability ? `validation-${randomUUID()}` : `validation-${index}`; const logPath = path.join(directory, `${id}.json`);
      await writeFile(logPath, `${JSON.stringify(outcome, null, 2)}\n`);
      store.validations.create({ id, buildId, taskId, validationType: "task", command: outcome.command, status: "passed", exitCode: outcome.exitCode, startedAt: outcome.startedAt, completedAt: outcome.completedAt, logPath });
      logs.push(logPath);
    }
    const committed = await new TaskCommitService().commit({ worktreePath: root, baseCommit: executionBase, branchName: "main", backlogTaskId: "AF-001", title: "Implement", changedFiles: validation.ownership.changedFiles, allowNoChanges: false });
    store.tasks.recordChangedFiles(taskId, 1, committed.changedFiles);
    await onPrefix?.("validation-recorded", prefixFixture);
    const manifests = new HandoffManifestService(store, environment.artifactsPath);
    const publication = await manifests.publish({ buildId, taskId, backlogTaskId: "AF-001", attempt: 1, status: "validated", baseCommit: executionBase, resultCommit: committed.resultCommit, branch: "main", worktreePath: root, changedFiles: committed.changedFiles.map((item) => item.path), consumes: [], produces: handoff.tasks[0]?.produces.map(({ name, type, version, path: artifactPath }) => ({ name, type, version, ...(artifactPath === undefined ? {} : { path: artifactPath }) })) ?? [] });
    store.tasks.transition(taskId, "validated", { resultCommit: committed.resultCommit });
    store.tasks.updateAttempt(taskId, 1, { status: "succeeded", resultCommit: committed.resultCommit, completedAt: new Date().toISOString() });
    await onPrefix?.("validated-without-certificate", prefixFixture);
    return { ...dependencies, context, root, handoff, taskId, buildId, logs, publication, manifests, committed, executionBase, capabilityDocuments, cleanup: database.cleanup };
  } catch (error) { database.cleanup(); throw error; }
}

// Synthetic authority/law inputs exercise the existing contract shapes; this is
// not a real skill/law activation, native execution approval or lesson promotion.
function fixtureCapabilityDocuments(handoff: ReturnType<typeof GovernedTaskHandoffSchema.parse>, commands: string[], defect?: "wrong-task" | "unknown-check") {
  const context = { taskId: defect === "wrong-task" ? "other-task" : "AF-001", repositoryId: "evidence-repo", revision: handoff.repository.baseCommit, authorityStateSha256: handoff.authority.stateSha256 };
  const bindings = { lawProfileSha256: "1".repeat(64), lawCatalogSha256: "2".repeat(64), skillCatalogSha256: "3".repeat(64), skillRegistrySha256: "4".repeat(64), workflowSha256: "5".repeat(64), compositionSha256: "6".repeat(64), lawDecisionSha256: "" };
  const lawBody = { schemaVersion: 1, kind: "design-intelligence/no-applicable-domain-laws", status: "READY", decision: "NO_APPLICABLE_LAWS", ...context, profileSha256: bindings.lawProfileSha256, catalogSha256: bindings.lawCatalogSha256, evaluatedLawIds: ["PY-001"], evidence: [{ lawId: "PY-001", applicability: "NOT_APPLICABLE", exclusionReason: "CONTEXT_SCOPE_MISMATCH", evidenceSha256: "7".repeat(64) }], rationale: "Synthetic contract fixture only." };
  const lawEvidence = { ...lawBody, decisionSha256: canonicalJsonSha256(lawBody) }; bindings.lawDecisionSha256 = lawEvidence.decisionSha256;
  const subject = "member:fixture-checker"; const individual = defect === "unknown-check" ? "not a native command" : commands[0] ?? "missing"; const combined = commands.slice(1);
  const memberBody = { id: "fixture-checker", kind: "SKILL", sourceSha256: "8".repeat(64), inputs: [], outputs: [], dependsOn: [], requiredCapabilities: [], availableCapabilities: [], requiredPermissions: [], grantedPermissions: [], effects: [], availability: { status: "AVAILABLE", evidenceSha256: "9".repeat(64) }, checks: [{ id: individual, covers: [subject] }] };
  const approvalBody = { status: "APPROVED", ...context, memberSha256: canonicalJsonSha256(memberBody) };
  const planBody = { schemaVersion: 1, kind: "design-intelligence/capability-activation-plan", origin: "WALE_PROPOSED", status: "READY_FOR_HANDOFF", context, bindings,
    bindingSemantics: { lawProfileSha256: "EXACT_UPSTREAM_DIGEST", lawCatalogSha256: "EXACT_UPSTREAM_DIGEST", lawDecisionSha256: "EXACT_AUTHORITY_BOUND_DIGEST", skillCatalogSha256: "EXACT_UPSTREAM_DIGEST", skillRegistrySha256: "EXACT_UPSTREAM_DIGEST", workflowSha256: "EXACT_UPSTREAM_DIGEST", compositionSha256: "OPAQUE_UPSTREAM_ARTIFACT_DIGEST" }, lawEvidence,
    lawBinding: { kind: lawEvidence.kind, decisionSha256: lawEvidence.decisionSha256, status: "READY", profileSha256: bindings.lawProfileSha256, catalogSha256: bindings.lawCatalogSha256, includedLawIds: [], excludedLawIds: ["PY-001"], conflicts: [] },
    selectedMembers: [{ ...memberBody, approval: { ...approvalBody, approvalSha256: canonicalJsonSha256(approvalBody) } }],
    obligations: { laws: [], members: [{ id: subject, memberId: "fixture-checker", kind: "SKILL", individualCheckIds: [individual], combinedCheckIds: combined }], outputsAndEffects: [], combinedChecks: combined.map((id) => ({ id, covers: [subject] })) }, issues: [], activationPerformed: false, executionAuthorized: false, executable: false, claimBoundary: "This WALE_PROPOSED plan is detached and inspectable. READY_FOR_HANDOFF means only that it may be adapted to a separately governed AgentFlow handoff. Capability availability or installation is not activation or verified use; this plan performs no activation, execution, repository mutation, delivery, or acceptance. Law profile, catalog, and no-applicable evidence digests remain upstream provenance claims; this planner does not reconstruct their complete source inventories." };
  const plan = { ...planBody, planSha256: canonicalJsonSha256(planBody) };
  const proposedScope = { ...handoff, authority: { status: "PROPOSED", stateSha256: handoff.authority.stateSha256, governanceReportSha256: handoff.authority.governanceReportSha256, sources: handoff.authority.sources } };
  const bindingBody = { schemaVersion: "1.0.0", kind: "design-intelligence/capability-handoff-binding", planSha256: plan.planSha256, repositoryId: context.repositoryId, compositionSha256: bindings.compositionSha256, lawDecisionSha256: bindings.lawDecisionSha256, context, contextSha256: canonicalJsonSha256(context), obligationsSha256: canonicalJsonSha256(plan.obligations), handoff: { id: handoff.handoffId, revision: handoff.repository.baseCommit, scopeSha256: canonicalJsonSha256(proposedScope) }, activationPerformed: false, executionAuthorized: false, executable: false };
  return { plan, binding: { ...bindingBody, bindingSha256: canonicalJsonSha256(bindingBody) } };
}

async function retryCapabilityFixture(f: Awaited<ReturnType<typeof nativeEvidenceFixture>>, change: "none" | "format" | "malformed" = "none", onPrefix?: NativePrefixObserver) {
  if (f.store.tasks.getById(f.taskId).state !== "failed") f.store.tasks.transition(f.taskId, "failed", { eventType: "unit.fixture_retry_requested", errorCode: "UNIT_RETRY" });
  f.store.tasks.retry(f.taskId); const attempt = f.store.tasks.getById(f.taskId).attempt;
  await onPrefix?.("test-harness-created-native-attempt", f);
  f.store.tasks.updateAttempt(f.taskId, attempt, { status: "running", startedAt: new Date().toISOString() }); f.store.tasks.transition(f.taskId, "running");
  await onPrefix?.("retry-running", f);
  await writeFile(path.join(f.root, "src/index.js"), `export const ready = true; // retry ${attempt}\n`);
  if (change !== "none") {
    if (f.capabilityDocuments === undefined) throw new Error("Missing retry capability documents");
    const plan = structuredClone(f.capabilityDocuments.plan);
    if (change === "malformed") {
      // Preserve JSON and digest validity while removing the member's approval.
      // The unchanged semantic validator must refuse READY_FOR_HANDOFF, rather
      // than treating transport digests or a worker completion as activation.
      const member = plan.selectedMembers[0]; if (member === undefined) throw new Error("Missing fixture member");
      const { approvalSha256: oldApproval, ...approvalBody } = member.approval; void oldApproval;
      const pendingApproval = { ...approvalBody, status: "PENDING" }; member.approval = { ...pendingApproval, approvalSha256: canonicalJsonSha256(pendingApproval) };
      const { planSha256: oldPlan, ...planBody } = plan; void oldPlan; plan.planSha256 = canonicalJsonSha256(planBody);
      const { bindingSha256: oldBinding, ...bindingBody } = f.capabilityDocuments.binding; void oldBinding;
      const updatedBinding = { ...bindingBody, planSha256: plan.planSha256 };
      await writeFile(path.join(f.root, "src/capability-binding.json"), JSON.stringify({ ...updatedBinding, bindingSha256: canonicalJsonSha256(updatedBinding) }, null, 4));
    }
    await writeFile(path.join(f.root, "src/capability-plan.json"), JSON.stringify(plan, null, 4));
  }
  f.store.tasks.transition(f.taskId, "validating");
  await onPrefix?.("retry-validating", f);
  const commands = f.handoff.tasks[0]?.validate ?? [];
  const summary = await validateTask({ buildId: f.buildId, taskId: f.taskId, attempt, worktreePath: f.root, baseCommit: f.executionBase, ownedPaths: ["src/"], commands, workerCompletedSuccessfully: true });
  const directory = path.join(f.environment.runsPath, f.buildId, f.taskId, `attempt-${attempt}`); await mkdir(directory, { recursive: true });
  for (const outcome of summary.commands) {
    const id = `validation-${randomUUID()}`; const logPath = path.join(directory, `${id}.json`); await writeFile(logPath, `${JSON.stringify(outcome, null, 2)}\n`);
    f.store.validations.create({ id, buildId: f.buildId, taskId: f.taskId, validationType: "task", command: outcome.command, status: outcome.status === "spawn_error" ? "failed" : outcome.status, exitCode: outcome.exitCode, startedAt: outcome.startedAt, completedAt: outcome.completedAt, logPath });
  }
  if (!summary.readyForCommit) {
    f.store.tasks.updateAttempt(f.taskId, attempt, { status: "failed", errorCode: summary.errorCode, errorMessage: summary.errorMessage, completedAt: summary.completedAt });
    // Reuse the native validation-failure producer so its event sequence binds
    // the failed attempt. A generic state shortcut cannot establish chronology.
    const getProvider = vi.fn(() => { throw new Error("Retry evidence fixture must never dispatch a worker"); });
    const coordinator = new BuildCoordinator({ ...f.context, handoffService: f.manifests, agentProviders: { get: getProvider } } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
    try {
      const native = coordinator as unknown as { failTask(taskId: string, eventType: string, errorCode: string | null, errorMessage: string | null): unknown };
      native.failTask(f.taskId, "task.validation_failed", summary.errorCode, summary.errorMessage);
      expect(getProvider).not.toHaveBeenCalled();
    } finally { await coordinator.shutdown(); }
    return summary;
  }
  const committed = await new TaskCommitService().commit({ worktreePath: f.root, baseCommit: f.executionBase, branchName: "main", backlogTaskId: "AF-001", title: "Retry fixture", changedFiles: summary.ownership.changedFiles, allowNoChanges: false });
  f.store.tasks.recordChangedFiles(f.taskId, attempt, committed.changedFiles);
  await onPrefix?.("retry-validation-recorded", f);
  await f.manifests.publish({ buildId: f.buildId, taskId: f.taskId, backlogTaskId: "AF-001", attempt, status: "validated", baseCommit: f.executionBase, resultCommit: committed.resultCommit, branch: "main", worktreePath: f.root, changedFiles: committed.changedFiles.map((item) => item.path), consumes: [], produces: f.handoff.tasks[0]?.produces.map(({ name, type, version, path: artifactPath }) => ({ name, type, version, ...(artifactPath === undefined ? {} : { path: artifactPath }) })) ?? [] });
  f.store.tasks.transition(f.taskId, "validated", { resultCommit: committed.resultCommit }); f.store.tasks.updateAttempt(f.taskId, attempt, { status: "succeeded", resultCommit: committed.resultCommit, completedAt: new Date().toISOString(), errorCode: null, errorMessage: null });
  await onPrefix?.("retry-validated-without-certificate", f);
  return summary;
}

// Actual coordinator and integration failure producers; only Git/validation
// execution ports are inert. Native task validation, manifests and certificates
// above use real disposable Git/SQLite/files. No worker/provider is started.
async function failNativeIntegrationFixture(f: Awaited<ReturnType<typeof nativeEvidenceFixture>>, crash = false) {
  const task = f.store.tasks.getById(f.taskId);
  const build = f.store.builds.getById(f.buildId);
  if (task.resultCommit === null || task.branchName === null) throw new Error("Missing actual validated task result");
  const resultCommit = task.resultCommit;
  const worktrees = { buildId: f.buildId, integrationBranch: () => build.integrationBranch, taskBranch: () => task.branchName, taskPath: () => f.root } as unknown as GitWorktreeManager;
  const push = vi.fn(async () => { throw new Error("Historical context fixture must not push"); });
  const manager = new IntegrationManager({ store: f.store, worktrees, git: { integrationPath: f.root, verifyReady: async () => f.executionBase, merge: async () => ({ previousHead: f.executionBase, integrationCommit: resultCommit }), abortMerge: async () => {}, resetAndClean: async () => {}, push }, validationRunner: { run: async () => ({ status: "failed", commands: [], errorMessage: "inert integration check failed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 0 }) } });
  const getProvider = vi.fn(() => { throw new Error("Historical context fixture must not dispatch a worker"); });
  const coordinator = new BuildCoordinator({ ...f.context, handoffService: f.manifests, agentProviders: { get: getProvider } } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
  const native = coordinator as unknown as { integrations: Map<string, IntegrationManager>; integrateValidatedTask(buildId: string, taskId: string): Promise<void> };
  native.integrations.set(f.buildId, manager);
  const update = crash ? vi.spyOn(f.store.tasks, "updateAttempt").mockImplementationOnce(() => { throw new Error("inert crash after manager failure"); }) : undefined;
  try {
    if (crash) await expect(native.integrateValidatedTask(f.buildId, f.taskId)).rejects.toThrow("inert crash after manager failure");
    else await native.integrateValidatedTask(f.buildId, f.taskId);
    expect(getProvider).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  } finally { update?.mockRestore(); await coordinator.shutdown(); }
}

// Canonical-shape/native-provenance fixture, not a Traffic Control cumulative
// event-parity oracle. Every positive source comes from native producers above.
async function nativeIntegrationHistoryFixture(f: Awaited<ReturnType<typeof nativeEvidenceFixture>>, count: number) {
  const certificates: Awaited<ReturnType<typeof readVerifiedNativeValidationEvidence>> = [];
  const frames: ReturnType<typeof f.store.events.listForBuild> = [];
  const snapshots: Array<{ fingerprint: unknown; evidence: { items: string[]; satisfied: string[]; contradictory: string[] } }> = [];
  for (let attempt = 1; attempt <= count; attempt += 1) {
    if (attempt > 1) {
      const retry = await retryCapabilityFixture(f);
      expect(retry.readyForCommit, JSON.stringify(retry)).toBe(true);
    }
    await publishNativeValidationEvidence(f, f.buildId, f.handoff);
    const current = await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff);
    expect(current).toHaveLength(1);
    const certificate = current[0];
    if (certificate === undefined) throw new Error("Missing actual own-attempt native certificate");
    expect(certificate.body.producer).toMatchObject({ buildId: f.buildId, taskId: f.taskId, attempt });
    expect(certificates.map((item) => item.id)).not.toContain(certificate.id);
    const publication = f.store.events.listForBuild(f.buildId).find((event) => event.type === "evidence.native_validation_certified" && event.payload.certificateId === certificate.id);
    const priorFrame = frames.at(-1);
    if (publication === undefined) throw new Error("Missing actual certificate publication fence");
    if (priorFrame !== undefined) expect(publication.sequence).toBeGreaterThan(priorFrame.sequence);
    await failNativeIntegrationFixture(f);
    const frame = f.store.events.listForBuild(f.buildId).filter((event) => event.type === "integration.failed").at(-1);
    const nativeAttempt = f.store.tasks.getAttempt(f.taskId, attempt);
    if (frame === undefined) throw new Error("Missing actual manager failure frame");
    expect(frame.sequence).toBeGreaterThan(publication.sequence);
    expect(frame.payload.governorFailure).toMatchObject({ attempt, attemptId: nativeAttempt.id });
    expect((frame.payload.governorFailure as Record<string, unknown>).fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(nativeAttempt).toMatchObject({ status: "failed", errorCode: "INTEGRATION_VALIDATION_FAILED" });
    expect(f.store.tasks.getById(f.taskId)).toMatchObject({ state: "failed", attempt, errorCode: "INTEGRATION_VALIDATION_FAILED" });
    certificates.push(certificate); frames.push(frame);
    snapshots.push({ fingerprint: (frame.payload.governorFailure as Record<string, unknown>).fingerprint, evidence: { items: [certificate.id], satisfied: [certificate.body.artifact.name], contradictory: [] } });
  }
  return { certificates, frames, snapshots };
}

// Capture source rows and private fixture bytes BEFORE evaluating the native
// projector. Neither its observation nor its decision is an adapter input.
async function captureNativeParitySource(f: NativePrefixFixture) {
  const records = () => {
    const build = f.store.builds.getById(f.buildId);
    return {
      build,
      plan: build.planId === null ? null : f.store.plans.getById(build.planId),
      tasks: f.store.tasks.listForBuild(f.buildId).map((task) => ({ task, attempts: f.store.tasks.listAttempts(task.id).map((attempt) => ({ attempt, changedFiles: f.store.tasks.listChangedFiles(task.id, attempt.attempt) })) })),
      validations: f.store.validations.listForBuild(f.buildId),
      manifests: f.store.manifests.listForBuild(f.buildId),
      artifacts: f.store.artifacts.listForBuild(f.buildId),
      events: f.store.events.listForBuild(f.buildId, { limit: 10000 }),
    };
  };
  const before = records();
  const certificates = await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff);
  const files = new Map<string, string>();
  for (const row of before.validations) if (row.logPath !== null) files.set(row.logPath, await readFile(row.logPath, "utf8"));
  for (const row of before.manifests) files.set(row.manifestPath, await readFile(row.manifestPath, "utf8"));
  for (const certificate of certificates) files.set(certificate.sourcePath, await readFile(certificate.sourcePath, "utf8"));
  for (const relative of ["AGENTS.md", "handoff.json", "package.json", "src/index.js"]) files.set(path.join(f.root, relative), await readFile(path.join(f.root, relative), "utf8"));
  expect(records()).toEqual(before);
  const events = before.events;
  expect(events.length).toBeLessThan(10000);
  expect(events.map((event) => event.sequence)).toEqual([...new Set(events.map((event) => event.sequence))].sort((a, b) => a - b));
  return {
    ...before,
    handoff: f.handoff,
    maxAttempts: Math.min(f.environment.retryMaximumAttempts, f.context.organizationPolicy.retries.maximum_attempts),
    certificates,
    sourceFiles: [...files].map(([sourcePath, bytes]) => ({ sourcePath, bytes, sha256: createHash("sha256").update(bytes).digest("hex") })),
    sourceCutoff: { throughSequence: events.at(-1)?.sequence ?? 0, count: events.length, sha256: canonicalJsonSha256(events) },
    gitHead: (await execFileAsync("git", ["-C", f.root, "rev-parse", "HEAD"])).stdout.trim(),
  };
}

type NativeParitySource = Awaited<ReturnType<typeof captureNativeParitySource>>;

// This adapter uses only retained native input records. Its normalized sequence
// is observation order, with each event bound to an actual sampled source cut.
// Low-level retry-created attempts are test inputs, not coordinator authority.
function nativeParityEvents(sources: NativeParitySource[]) {
  const events: Array<Record<string, unknown>> = [];
  const bindings: Array<Record<string, unknown>> = [];
  const seenEvents = new Set<number>();
  const seenChanges = new Set<string>();
  const seenAttempts = new Set<string>();
  let priorState: string | undefined;
  let completed = false;
  let previousSource: NativeParitySource | undefined;
  let proof = { items: [] as string[], satisfied: [] as string[] };
  const contradictory: string[] = [];
  const append = (type: string, data: Record<string, unknown>, source: NativeParitySource, nativeSequence: number | null = null) => {
    const sequence = events.length + 1;
    events.push({ sequence, type, ...data });
    bindings.push({ sequence, type, sourceCutoff: source.sourceCutoff, nativeSequence });
  };
  const snapshot = (source: NativeParitySource, nativeSequence: number | null = null) => append("evidence.recorded", { ...proof, contradictory: [...new Set(contradictory)].sort() }, source, nativeSequence);
  for (const source of sources) {
    if (source.sourceCutoff.count !== source.events.length || source.sourceCutoff.sha256 !== canonicalJsonSha256(source.events) || source.sourceCutoff.throughSequence !== (source.events.at(-1)?.sequence ?? 0) || new Set(source.events.map((event) => event.sequence)).size !== source.events.length || source.events.some((event, index) => index > 0 && event.sequence <= (source.events[index - 1]?.sequence ?? 0))) throw new Error("Native parity source prefix is malformed");
    if (previousSource !== undefined && canonicalJsonSha256(source.events.slice(0, previousSource.events.length)) !== canonicalJsonSha256(previousSource.events)) throw new Error("Native parity source prefix was omitted or rewritten");
    if (source.plan === null || source.plan.lockedAt === null || source.plan.id !== source.build.planId || source.plan.repositoryId !== source.build.repositoryId || canonicalJsonSha256(source.plan.normalizedPlan) !== canonicalJsonSha256(source.build.normalizedPlan)) throw new Error("Native parity immutable plan source is missing");
    const entry = source.tasks[0];
    if (source.tasks.length !== 1 || entry === undefined || entry.task.buildId !== source.build.id || entry.task.backlogTaskId !== source.handoff.tasks[0]?.id) throw new Error("Native parity source attribution is incomplete");
    const { task, attempts } = entry;
    const current = attempts.find(({ attempt }) => attempt.attempt === task.attempt);
    if (current === undefined || current.attempt.taskId !== task.id || current.attempt.buildId !== source.build.id) throw new Error("Native parity current attempt is missing");
    if (previousSource !== undefined && task.attempt < (previousSource.tasks[0]?.task.attempt ?? 0)) throw new Error("Native parity attempt chronology moved backwards");
    for (const certificate of source.certificates) {
      const file = source.sourceFiles.find((item) => item.sourcePath === certificate.sourcePath);
      const publication = source.events.filter((event) => event.type === "evidence.native_validation_certified" && event.payload.certificateId === certificate.id);
      const producer = certificate.body.producer;
      if (certificate.id !== canonicalJsonSha256(certificate.body) || file === undefined || createHash("sha256").update(file.bytes).digest("hex") !== certificate.sha256 || file.sha256 !== certificate.sha256 || file.bytes !== JSON.stringify({ id: certificate.id, ...certificate.body }, null, 2) + "\n" || publication.length !== 1 || publication[0]?.taskId !== task.id || producer.buildId !== source.build.id || producer.taskId !== task.id || producer.backlogTaskId !== task.backlogTaskId || producer.attempt !== task.attempt || producer.resultCommit !== task.resultCommit || current.attempt.status !== "succeeded" || !source.handoff.proof.requiredEvidence.includes(certificate.body.artifact.name)) throw new Error("Native parity verified certificate source is incomplete");
    }
    if (events.length === 0) {
      const handoff = source.handoff;
      append("authority.observed", { authority: { approvalAuthority: "HUMAN_OR_REPOSITORY", handoffId: handoff.handoffId, handoffSha256: canonicalJsonSha256(handoff), repositoryId: handoff.repository.remote ?? null, baseCommit: handoff.repository.baseCommit, snapshotSha256: handoff.repository.snapshotSha256, worktreeState: handoff.repository.worktreeState, authorityStateSha256: handoff.authority.stateSha256, governanceReportSha256: handoff.authority.governanceReportSha256, authoritySources: handoff.authority.sources } }, source);
      append("execution.started", { buildId: source.build.id, maxAttempts: source.maxAttempts }, source);
    }
    if (!seenAttempts.has(current.attempt.id)) {
      seenAttempts.add(current.attempt.id);
      append("attempt.started", { attempt: current.attempt.attempt }, source);
      proof = { items: [], satisfied: [] };
    }
    for (const item of attempts) {
      if (item.attempt.taskId !== task.id || item.attempt.buildId !== source.build.id) throw new Error("Native parity foreign attempt");
      const key = canonicalJsonSha256({ id: item.attempt.id, changedFiles: item.changedFiles });
      if (!seenChanges.has(key) && item.changedFiles.length > 0) {
        seenChanges.add(key);
        append("files.changed", { taskId: task.backlogTaskId, paths: item.changedFiles.map((file) => file.path) }, source);
      }
    }
    for (const event of source.events) {
      if (seenEvents.has(event.sequence)) continue;
      seenEvents.add(event.sequence);
      if (event.buildId !== source.build.id) throw new Error("Native parity foreign build event");
      if (event.type === "evidence.recorded") {
        const values: unknown = event.payload.contradictory ?? [];
        if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new Error("Native parity malformed contradiction source");
        contradictory.push(...values as string[]);
        snapshot(source, event.sequence);
      }
      if (event.payload.governorFailure !== undefined) {
        const frame = event.payload.governorFailure as Record<string, unknown>;
        const failed = attempts.find(({ attempt }) => attempt.id === frame.attemptId);
        if (!["task.remote_worker_failed", "task.worker_failed", "task.execution_pipeline_failed", "task.validation_failed", "integration.failed"].includes(event.type) || failed === undefined || failed.attempt.status !== "failed" || failed.attempt.errorCode === null || event.taskId !== task.id || frame.attempt !== failed.attempt.attempt || event.payload.to !== "failed") throw new Error("Native parity failure chronology is incomplete");
        if (event.type === "integration.failed" && proof.items.length !== source.handoff.proof.requiredEvidence.length) throw new Error("Native parity prior verified publication prefix is missing");
        const retryable = DEFAULT_RETRYABLE_FAILURE_CODES.has(failed.attempt.errorCode);
        append("validation.failed", { failure: { code: failed.attempt.errorCode, classification: retryable ? "transient" : "deterministic", retryable, signature: failed.attempt.errorMessage ?? failed.attempt.errorCode, files: failed.changedFiles.map((file) => file.path) } }, source, event.sequence);
      }
    }
    if (["validated", "integrating", "integrated"].includes(task.state) && !["validated", "integrating", "integrated"].includes(priorState ?? "")) {
      if (current.attempt.status !== "succeeded" || current.attempt.resultCommit !== task.resultCommit || !source.manifests.some((manifest) => manifest.taskId === task.id && manifest.attempt === task.attempt && manifest.status === "validated")) throw new Error("Native parity successful validation source is missing");
      append("validation.passed", {}, source);
    }
    proof = { items: source.certificates.map((certificate) => certificate.id), satisfied: source.certificates.map((certificate) => certificate.body.artifact.name) };
    snapshot(source);
    if (source.build.status === "completed" && !completed) {
      if (task.state !== "integrated" || task.integrationCommit === null) throw new Error("Native parity completion source is missing");
      append("execution.integrated", {}, source);
      completed = true;
    }
    priorState = task.state;
    previousSource = source;
  }
  return { events, bindings };
}

describe("TCP-002 actual native source-prefix correspondence", () => {
  it.runIf(Boolean(process.env.TCP002_REFERENCE_ROOT) || process.env.TCP002_NATIVE_PARITY_REQUIRED === "1")("compares whole observations and actions from the same retained native history", async () => {
    const referenceRoot = process.env.TCP002_REFERENCE_ROOT;
    if (!referenceRoot) throw new Error("TCP002_REFERENCE_ROOT is required for native parity qualification");
    const outputParent = process.env.TCP002_EVIDENCE_OUTPUT_ROOT;
    let retainedRoot: string | undefined;
    if (outputParent !== undefined) {
      await mkdir(outputParent, { recursive: true });
      retainedRoot = await mkdtemp(path.join(outputParent, "native-prefix-"));
    }
    const sourceBindings = await Promise.all(["src/observations.js", "src/governor.js", "src/contracts.js"].map(async (relativePath) => ({ relativePath, sha256: createHash("sha256").update(await readFile(path.join(referenceRoot, relativePath))).digest("hex") })));
    const prefixes: Array<{ label: string; source: NativeParitySource; native: { observation: unknown; decision: unknown } }> = [];
    const observed = vi.spyOn(GovernorControlService.prototype, "evaluate");
    const onPrefix: NativePrefixObserver = async (label, fixture) => {
      const source = await captureNativeParitySource(fixture);
      const native = await evaluateGovernedBuild(fixture.context, fixture.buildId);
      const input = observed.mock.calls.at(-1)?.[0];
      if (native === undefined || input === undefined) throw new Error("Missing actual native evaluation");
      expect(input.nativeSources).toMatchObject({
        build: { id: source.build.id, sha256: canonicalJsonSha256(source.build) },
        events: source.sourceCutoff,
        tasks: source.tasks.map(({ task, attempts }) => ({ id: task.id, sha256: canonicalJsonSha256(task), attempts: attempts.map(({ attempt, changedFiles }) => ({ id: attempt.id, sha256: canonicalJsonSha256(attempt), changedFilesSha256: canonicalJsonSha256(changedFiles) })) })),
      });
      prefixes.push({ label, source, native: { observation: structuredClone(input.observation), decision: native.decision } });
    };
    let f: Awaited<ReturnType<typeof nativeEvidenceFixture>> | undefined;
    let reference: unknown;
    let failure: string | null = null;
    try {
      f = await nativeEvidenceFixture(false, undefined, true, onPrefix);
      f.store.events.append({ buildId: f.buildId, type: "evidence.recorded", payload: { items: ["arbitrary-unit-label"], satisfied: ["focused tests"] } });
      await onPrefix("untrusted-positive-labels", f);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (attempt > 1) expect((await retryCapabilityFixture(f, "none", onPrefix)).readyForCommit).toBe(true);
        await publishNativeValidationEvidence(f, f.buildId, f.handoff);
        await onPrefix(`certificate-${attempt}`, f);
        if (attempt < 3) {
          await failNativeIntegrationFixture(f);
          await onPrefix(`integration-failure-${attempt}`, f);
        }
      }
      f.store.tasks.transition(f.taskId, "integrating");
      await onPrefix("integrating", f);
      f.store.tasks.transition(f.taskId, "integrated", { integrationCommit: f.store.tasks.getById(f.taskId).resultCommit });
      const artifact = f.store.artifacts.listForBuild(f.buildId)[0];
      if (artifact === undefined) throw new Error("Missing actual native artifact");
      f.store.artifacts.setStatus(artifact.id, "integrated");
      f.store.builds.transition(f.buildId, "completed");
      await onPrefix("completed", f);
      const receipt = await makeDesignIntelligenceReceipt(f.context, f.buildId);
      const current = await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff);
      expect(receipt.receipt.tasks[0]?.validation[0]?.evidenceId).toBe(current[0]?.id);
      f.store.events.append({ buildId: f.buildId, type: "evidence.recorded", payload: { contradictory: ["fixture diagnostic"] } });
      await onPrefix("cumulative-contradiction-after-completion", f);
      if (retainedRoot !== undefined) await execFileAsync("git", ["-C", f.root, "bundle", "create", path.join(retainedRoot, "disposable-repository.bundle"), "--all"]);
      const sources = prefixes.map((prefix) => prefix.source);
      const finalSource = sources.at(-1);
      if (finalSource === undefined) throw new Error("Missing actual native source history");
      const negativeCases: Array<{ defect: string; refused: boolean }> = [];
      const refuses = (defect: string, corrupted: NativeParitySource[], expected?: RegExp) => {
        expect(() => nativeParityEvents(corrupted), defect).toThrow(expected);
        negativeCases.push({ defect, refused: true });
      };
      refuses("missing prior publication prefixes", [finalSource]);
      const rewritten = structuredClone(sources);
      const rewrittenSource = rewritten.at(-1);
      const rewrittenEvent = rewrittenSource?.events[0];
      if (rewrittenSource === undefined || rewrittenEvent === undefined) throw new Error("Missing fixture event for source refusal");
      rewrittenEvent.type = "rewritten.history";
      rewrittenSource.sourceCutoff.sha256 = canonicalJsonSha256(rewrittenSource.events);
      refuses("rewritten source prefix", rewritten, /omitted or rewritten/);
      const foreign = structuredClone(sources);
      const foreignAttempt = foreign[0]?.tasks[0]?.attempts[0]?.attempt;
      if (foreignAttempt === undefined) throw new Error("Missing fixture attempt for source refusal");
      foreignAttempt.taskId = "foreign-native-task";
      refuses("cross-task attempt source", foreign);
      const missingBytes = structuredClone(sources);
      const certified = missingBytes.find((source) => source.certificates.length > 0);
      if (certified === undefined) throw new Error("Missing actual certificate prefix");
      certified.sourceFiles = certified.sourceFiles.filter((file) => !certified.certificates.some((certificate) => certificate.sourcePath === file.sourcePath));
      refuses("missing verified certificate bytes", missingBytes);
      const batches = prefixes.map((_, index) => nativeParityEvents(prefixes.slice(0, index + 1).map((prefix) => prefix.source)));
      const inputPath = path.join(f.root, "native-reference-input.json");
      await writeFile(inputPath, JSON.stringify({ handoff: f.handoff, eventBatches: batches.map((batch) => batch.events) }));
      const outputPath = path.join(f.root, "native-reference-output.json");
      const runner = "import {readFile,writeFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';import path from 'node:path';const [root,input,output]=process.argv.slice(1);const {bindContract}=await import(pathToFileURL(path.join(root,'src/contracts.js')));const {reduceExecutionEvents}=await import(pathToFileURL(path.join(root,'src/observations.js')));const {evaluateGovernor,GOVERNOR_POLICY_V1}=await import(pathToFileURL(path.join(root,'src/governor.js')));const data=JSON.parse(await readFile(input,'utf8'));const contract=bindContract(data.handoff);await writeFile(output,JSON.stringify(data.eventBatches.map(events=>{const observation=reduceExecutionEvents(events,{contract});return {observation,decision:evaluateGovernor({contract,observation,policy:GOVERNOR_POLICY_V1})}})),{flag:'wx'});";
      await execFileAsync(process.execPath, ["--input-type=module", "-e", runner, referenceRoot, inputPath, outputPath], { maxBuffer: 16 * 1024 * 1024 });
      reference = JSON.parse(await readFile(outputPath, "utf8")) as unknown;
      if (retainedRoot !== undefined) await writeFile(path.join(retainedRoot, "native-prefix-corpus.actual.json"), JSON.stringify({ classification: "ACTUAL_DISPOSABLE_NATIVE_RECORD_PREFIXES_TEST_HARNESS_CREATED_NATIVE_ATTEMPT", limitations: ["Inert integration Git/validation ports; task validation, SQLite, Git task commits, logs, manifests and certificates are actual", "Low-level retry-created attempts do not establish authorized governed coordinator recovery", "Complete sampled native event/row history and fixture evidence bytes retained; SQLite page files are not retained", "No provider, deployment or acceptance evidence"], sourceBindings, prefixes, batches, reference, negativeCases, receipt: receipt.receipt }, null, 2), { flag: "wx", mode: 0o600 });
      if (!Array.isArray(reference)) throw new Error("Reference output is not a complete prefix array");
      expect(reference).toHaveLength(prefixes.length);
      for (const [index, prefix] of prefixes.entries()) expect(reference[index], "whole observation and decision at " + prefix.label).toEqual(prefix.native);
      expect(await Promise.all(sourceBindings.map(async ({ relativePath }) => ({ relativePath, sha256: createHash("sha256").update(await readFile(path.join(referenceRoot, relativePath))).digest("hex") })))).toEqual(sourceBindings);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (retainedRoot !== undefined) await writeFile(path.join(retainedRoot, "result.actual.json"), JSON.stringify({ classification: "NATIVE_SOURCE_CORRESPONDENCE_NOT_AUTHORIZED_GOVERNED_RETRY_ACCEPTANCE", passed: failure === null, failure, sourceBindings, prefixes, reference }, null, 2), { flag: "wx", mode: 0o600 });
      observed.mockRestore();
      f?.cleanup();
    }
  });
});

describe("historical native publication context", () => {
  it.each([
    { failures: 1, retryAfterFailure: false, label: "one actual integration failure" },
    { failures: 2, retryAfterFailure: false, label: "two actual integration failures" },
    { failures: 2, retryAfterFailure: true, label: "two failures after a later native retry clears the active failure" },
  ])("projects canonical own-attempt history for $label without reviving current evidence", async ({ failures, retryAfterFailure }) => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    const observed = vi.spyOn(GovernorControlService.prototype, "evaluate");
    try {
      const history = await nativeIntegrationHistoryFixture(f, failures);
      if (retryAfterFailure) {
        const retry = await retryCapabilityFixture(f);
        expect(retry.readyForCommit, JSON.stringify(retry)).toBe(true);
        // Actual validation and manifest publication have completed, but this
        // later attempt has no certificate publication to revive current proof.
        expect(f.store.tasks.getById(f.taskId).state).toBe("validated");
      }
      expect(await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff)).toEqual([]);
      const retainedTask = f.store.tasks.getById(f.taskId);
      const retainedAttempts = f.store.tasks.listAttempts(f.taskId);
      const retainedEvents = f.store.events.listForBuild(f.buildId);
      const result = await evaluateGovernedBuild(f.context, f.buildId);
      const observation = observed.mock.calls.at(-1)?.[0].observation;
      if (process.env.TCP002_HISTORICAL_OUTPUT_ROOT !== undefined) {
        await mkdir(process.env.TCP002_HISTORICAL_OUTPUT_ROOT, { recursive: true });
        await writeFile(path.join(process.env.TCP002_HISTORICAL_OUTPUT_ROOT, `canonical-history-${failures}-failures${retryAfterFailure ? "-after-retry" : ""}.actual.json`), JSON.stringify({
          schemaVersion: 1,
          classification: "CANONICAL_SHAPE_NATIVE_PROVENANCE_CONFORMANCE_NOT_TRAFFIC_CONTROL_CUMULATIVE_PARITY",
          buildId: f.buildId,
          taskId: f.taskId,
          task: { state: retainedTask.state, attempt: retainedTask.attempt, errorCode: retainedTask.errorCode },
          attempts: retainedAttempts.map((attempt) => ({ id: attempt.id, attempt: attempt.attempt, status: attempt.status, errorCode: attempt.errorCode, resultCommit: attempt.resultCommit })),
          certificates: history.certificates.map((certificate) => ({
            id: certificate.id,
            attempt: certificate.body.producer.attempt,
            manifestId: certificate.body.manifest.id,
            resultCommit: certificate.body.producer.resultCommit,
            publicationSequence: retainedEvents.find((event) => event.type === "evidence.native_validation_certified" && event.payload.certificateId === certificate.id)?.sequence,
          })),
          failures: history.frames.map((event) => ({ eventType: event.type, sequence: event.sequence, taskId: event.taskId, nativeFrame: event.payload.governorFailure })),
          action: result?.decision.action,
          observation,
          expectedCanonicalHistory: history.snapshots,
        }, null, 2));
      }
      expect(result?.decision.action).toBe(retryAfterFailure ? "BLOCK_INTEGRATION" : "REQUEST_REPAIR");
      expect(observation).toBeDefined();
      expect(observation?.evidence).toEqual({ items: [], satisfied: [], contradictory: [] });
      expect(observation?.failureHistory).toEqual(history.snapshots);
      if (retryAfterFailure) {
        expect(observation?.failure).toBeNull();
        expect(observation?.failureRepeatCount).toBe(0);
      } else {
        const activeAttempt = retainedAttempts.find((attempt) => attempt.attempt === failures);
        const frame = history.frames.at(-1);
        if (activeAttempt === undefined || frame === undefined) throw new Error("Missing actual active native failure");
        expect(observation?.failure).toEqual({
          code: activeAttempt.errorCode,
          classification: "deterministic",
          retryable: false,
          signature: activeAttempt.errorMessage ?? activeAttempt.errorCode,
          files: f.store.tasks.listChangedFiles(f.taskId, failures).map((file) => file.path),
          fingerprint: (frame.payload.governorFailure as Record<string, unknown>).fingerprint,
        });
        expect(observation?.failureRepeatCount).toBe(failures);
      }
      expect(f.store.tasks.getById(f.taskId)).toEqual(retainedTask);
      expect(f.store.tasks.listAttempts(f.taskId)).toEqual(retainedAttempts);
      expect(f.store.events.listForBuild(f.buildId).filter((event) => event.sequence <= (retainedEvents.at(-1)?.sequence ?? 0))).toEqual(retainedEvents);
      expect(f.store.events.listForBuild(f.buildId).some((event) => event.type === "integration.completed")).toBe(false);
    } finally { observed.mockRestore(); f.cleanup(); }
  });

  it("continues a genuinely certified native retry while preserving earlier own-attempt failure history", async () => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    const observed = vi.spyOn(GovernorControlService.prototype, "evaluate");
    try {
      const history = await nativeIntegrationHistoryFixture(f, 2);
      const retry = await retryCapabilityFixture(f);
      expect(retry.readyForCommit, JSON.stringify(retry)).toBe(true);
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      const current = await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff);
      expect(current).toHaveLength(1);
      const certificate = current[0];
      if (certificate === undefined) throw new Error("Missing actual third-attempt native certificate");
      expect(certificate.body.producer).toMatchObject({ buildId: f.buildId, taskId: f.taskId, attempt: 3 });
      expect(history.certificates.map((item) => item.id)).not.toContain(certificate.id);
      const retainedTask = f.store.tasks.getById(f.taskId);
      const retainedAttempts = f.store.tasks.listAttempts(f.taskId);
      const retainedEvents = f.store.events.listForBuild(f.buildId);
      const result = await evaluateGovernedBuild(f.context, f.buildId);
      const observation = observed.mock.calls.at(-1)?.[0].observation;
      if (process.env.TCP002_HISTORICAL_OUTPUT_ROOT !== undefined) {
        await mkdir(process.env.TCP002_HISTORICAL_OUTPUT_ROOT, { recursive: true });
        await writeFile(path.join(process.env.TCP002_HISTORICAL_OUTPUT_ROOT, "canonical-history-2-failures-current-retry-certificate.actual.json"), JSON.stringify({
          schemaVersion: 1,
          classification: "CANONICAL_SHAPE_NATIVE_PROVENANCE_CONFORMANCE_NOT_TRAFFIC_CONTROL_CUMULATIVE_PARITY",
          buildId: f.buildId,
          taskId: f.taskId,
          attempts: retainedAttempts.map((attempt) => ({ id: attempt.id, attempt: attempt.attempt, status: attempt.status, errorCode: attempt.errorCode, resultCommit: attempt.resultCommit })),
          certificates: [...history.certificates, certificate].map((item) => ({ id: item.id, attempt: item.body.producer.attempt, publicationSequence: retainedEvents.find((event) => event.type === "evidence.native_validation_certified" && event.payload.certificateId === item.id)?.sequence })),
          failures: history.frames.map((event) => ({ eventType: event.type, sequence: event.sequence, taskId: event.taskId, nativeFrame: event.payload.governorFailure })),
          action: result?.decision.action,
          observation,
          expectedCanonicalHistory: history.snapshots,
        }, null, 2));
      }
      expect(result?.decision.action).toBe("CONTINUE");
      expect(observation?.failure).toBeNull();
      expect(observation?.failureRepeatCount).toBe(0);
      expect(observation?.failureHistory).toEqual(history.snapshots);
      expect(observation?.evidence).toEqual({ items: [certificate.id], satisfied: [certificate.body.artifact.name], contradictory: [] });
      const decisionEvent = f.store.events.listForBuild(f.buildId).filter((event) => event.type === "governor.decision").at(-1);
      expect(decisionEvent?.payload.nativeSources).toMatchObject({
        tasks: [{
          id: f.taskId, backlogTaskId: retainedTask.backlogTaskId, baseCommit: retainedTask.baseCommit,
          resultCommit: retainedTask.resultCommit, sha256: canonicalJsonSha256(retainedTask),
          attempts: retainedAttempts.map((attempt) => ({ id: attempt.id, attempt: attempt.attempt, resultCommit: attempt.resultCommit, sha256: canonicalJsonSha256(attempt) })),
        }],
        certificates: [{ id: certificate.id, sha256: certificate.sha256, ...certificate.body.producer }],
        events: { throughSequence: retainedEvents.at(-1)?.sequence, count: retainedEvents.length, sha256: canonicalJsonSha256(retainedEvents) },
      });
      expect(f.store.tasks.getById(f.taskId)).toEqual(retainedTask);
      expect(f.store.tasks.listAttempts(f.taskId)).toEqual(retainedAttempts);
      expect(f.store.events.listForBuild(f.buildId).filter((event) => event.sequence <= (retainedEvents.at(-1)?.sequence ?? 0))).toEqual(retainedEvents);
    } finally { observed.mockRestore(); f.cleanup(); }
  });

  it("refuses malformed contradiction history before an actual native integration failure", async () => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      expect(await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff)).toHaveLength(1);
      // Deliberate negative corruption in this disposable journal, not a
      // positive native evidence producer or an invented failure frame.
      const malformed = f.store.events.append({ buildId: f.buildId, taskId: f.taskId, type: "evidence.recorded", payload: { contradictory: [{ unsupported: true }] } });
      await failNativeIntegrationFixture(f);
      const failure = f.store.events.listForBuild(f.buildId).find((event) => event.type === "integration.failed");
      expect(malformed.sequence).toBeLessThan(failure?.sequence ?? 0);
      expect(f.store.tasks.getAttempt(f.taskId, 1)).toMatchObject({ status: "failed", errorCode: "INTEGRATION_VALIDATION_FAILED" });
      await expect(evaluateGovernedBuild(f.context, f.buildId)).rejects.toThrow("GOVERNED_FAILURE_HISTORY_UNAVAILABLE");
      expect(f.store.events.listForBuild(f.buildId).some((event) => event.type === "governor.decision")).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each(["missing-old-certificate", "unsupported-old-frame"] as const)("refuses canonical history with %s even after a later retry clears the active failure", async (defect) => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    try {
      const history = await nativeIntegrationHistoryFixture(f, 2);
      const retry = await retryCapabilityFixture(f);
      expect(retry.readyForCommit, JSON.stringify(retry)).toBe(true);
      const firstCertificate = history.certificates[0]; const firstFrame = history.frames[0];
      if (firstCertificate === undefined || firstFrame === undefined) throw new Error("Missing actual earlier native sources");
      // Corrupt only a disposable negative source after actual native producers
      // have emitted all certificates and failure frames; no positive frame is seeded.
      if (defect === "missing-old-certificate") await rm(firstCertificate.sourcePath);
      else f.store.database.prepare("UPDATE build_events SET event_type = 'unit.unsupported_failure' WHERE sequence = ?").run(firstFrame.sequence);
      await expect(evaluateGovernedBuild(f.context, f.buildId)).rejects.toThrow("GOVERNED_FAILURE_HISTORY_UNAVAILABLE");
      expect(f.store.events.listForBuild(f.buildId).some((event) => event.type === "governor.decision")).toBe(false);
    } finally { f.cleanup(); }
  });

  it("uses retained native publication context after actual integration failure without reviving current evidence", async () => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    const observed = vi.spyOn(GovernorControlService.prototype, "evaluate");
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      expect(await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff)).toHaveLength(1);
      await failNativeIntegrationFixture(f);
      expect(f.store.tasks.getById(f.taskId)).toMatchObject({ state: "failed", errorCode: "INTEGRATION_VALIDATION_FAILED" });
      expect(f.store.tasks.getAttempt(f.taskId, 1)).toMatchObject({ status: "failed", errorCode: "INTEGRATION_VALIDATION_FAILED" });
      expect(await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff)).toEqual([]);
      const before = f.store.events.listForBuild(f.buildId);
      const publication = before.find((event) => event.type === "evidence.native_validation_certified");
      const failure = before.find((event) => event.type === "integration.failed");
      expect(publication?.sequence).toBeLessThan(failure?.sequence ?? 0);
      if (process.env.TCP002_HISTORICAL_OUTPUT_ROOT !== undefined) {
        await mkdir(process.env.TCP002_HISTORICAL_OUTPUT_ROOT, { recursive: true });
        await writeFile(path.join(process.env.TCP002_HISTORICAL_OUTPUT_ROOT, "actual-integration-failure.json"), JSON.stringify({ classification: "NATIVE_PRODUCERS_INERT_GIT_VALIDATION_PORTS", task: f.store.tasks.getById(f.taskId), attempt: f.store.tasks.getAttempt(f.taskId, 1), events: before }, null, 2));
      }
      const result = await evaluateGovernedBuild(f.context, f.buildId);
      expect(result?.decision.action).toBe("REQUEST_REPAIR");
      expect(observed.mock.calls.at(-1)?.[0].observation.evidence).toEqual({ items: [], satisfied: [], contradictory: [] });
      expect(observed.mock.calls.at(-1)?.[0].observation.evidenceDelta).toMatchObject({ score: 0, direction: "ZERO" });
      expect(failure?.payload.governorFailure).toMatchObject({ attempt: 1, attemptId: "evidence-attempt" });
      expect(f.store.events.listForBuild(f.buildId).some((event) => event.type === "integration.completed")).toBe(false);
    } finally { observed.mockRestore(); f.cleanup(); }
  });

  it("refuses the actual integration crash window before the coordinator persists attempt failure", async () => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      await failNativeIntegrationFixture(f, true);
      expect(f.store.tasks.getById(f.taskId).state).toBe("failed");
      expect(f.store.tasks.getAttempt(f.taskId, 1).status).toBe("succeeded");
      expect(f.store.events.listForBuild(f.buildId).some((event) => event.type === "integration.failed")).toBe(true);
      expect(await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff)).toEqual([]);
      await expect(evaluateGovernedBuild(f.context, f.buildId)).rejects.toThrow("GOVERNED_FAILURE_HISTORY_UNAVAILABLE");
      expect(f.store.events.listForBuild(f.buildId).some((event) => event.type === "governor.decision")).toBe(false);
    } finally { f.cleanup(); }
  });

  it.each([
    "missing-certificate", "tampered-certificate", "missing-manifest", "tampered-manifest", "missing-log", "tampered-log",
    "missing-certificate-event", "missing-manifest-event", "certificate-after-failure", "manifest-after-certificate", "duplicate-certificate-event",
    "duplicate-failure-frame", "unsupported-failure-type", "artifact-republished", "artifact-status-changed",
    "cross-build", "cross-task", "cross-attempt", "cross-manifest", "cross-handoff", "wrong-base", "wrong-result", "wrong-log-argv", "wrong-log-index", "frame-base", "frame-result", "frame-branch", "missing-frame-context",
  ])("refuses retained historical publication context with %s", async (defect) => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      const certificate = (await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff))[0];
      if (certificate === undefined) throw new Error("Missing actually published fixture certificate");
      const publication = f.store.events.listForBuild(f.buildId).find((event) => event.type === "evidence.native_validation_certified");
      const manifestPublication = f.store.events.listForBuild(f.buildId).find((event) => event.type === "manifest.published");
      const manifest = f.store.manifests.findForTask(f.taskId, "validated", 1);
      const artifact = f.store.artifacts.listForBuild(f.buildId)[0];
      const validation = certificate.body.validations[0];
      if (publication === undefined || manifestPublication === undefined || manifest === undefined || artifact === undefined || validation === undefined) throw new Error("Missing actual native publication sources");
      // Deliberate corruption is confined to this disposable negative fixture.
      // Positive context always comes from the unchanged native producers.
      if (defect === "manifest-after-certificate") {
        f.store.database.prepare("DELETE FROM build_events WHERE sequence = ?").run(manifestPublication.sequence);
        f.store.events.append({ buildId: f.buildId, taskId: f.taskId, type: manifestPublication.type, payload: manifestPublication.payload });
      }
      if (defect === "artifact-republished") f.store.artifacts.replaceValidated(artifact.id, { artifactType: "unit/changed-type", repositoryPath: null, storagePath: null, sha256: null, metadata: {} });
      if (defect === "artifact-status-changed") f.store.artifacts.setStatus(artifact.id, "integrated");
      await failNativeIntegrationFixture(f);
      const failure = f.store.events.listForBuild(f.buildId).find((event) => event.type === "integration.failed");
      if (failure === undefined) throw new Error("Missing actual manager failure event");
      const logPath = path.join(path.dirname(certificate.sourcePath), `${validation.id}.json`);
      if (defect === "missing-certificate") await rm(certificate.sourcePath);
      if (defect === "tampered-certificate") await writeFile(certificate.sourcePath, (await readFile(certificate.sourcePath, "utf8")) + " ");
      if (defect === "missing-manifest") await rm(manifest.manifestPath);
      if (defect === "tampered-manifest") await writeFile(manifest.manifestPath, (await readFile(manifest.manifestPath, "utf8")) + " ");
      if (defect === "missing-log") await rm(logPath);
      if (defect === "tampered-log") await writeFile(logPath, (await readFile(logPath, "utf8")) + " ");
      if (["missing-certificate-event", "certificate-after-failure"].includes(defect)) f.store.database.prepare("DELETE FROM build_events WHERE sequence = ?").run(publication.sequence);
      if (defect === "missing-manifest-event") f.store.database.prepare("DELETE FROM build_events WHERE sequence = ?").run(manifestPublication.sequence);
      if (["certificate-after-failure", "duplicate-certificate-event"].includes(defect)) f.store.events.append({ buildId: f.buildId, taskId: f.taskId, type: publication.type, payload: publication.payload });
      if (defect === "duplicate-failure-frame") f.store.events.append({ buildId: f.buildId, taskId: f.taskId, type: failure.type, payload: failure.payload });
      if (defect === "unsupported-failure-type") f.store.database.prepare("UPDATE build_events SET event_type = 'evidence.recorded' WHERE sequence = ?").run(failure.sequence);
      if (["frame-base", "frame-result", "frame-branch", "missing-frame-context"].includes(defect)) {
        const payload = structuredClone(failure.payload);
        const frame = payload.governorFailure as Record<string, unknown>;
        if (defect === "frame-base") frame.baseCommit = "f".repeat(40);
        if (defect === "frame-result") frame.resultCommit = "f".repeat(40);
        if (defect === "frame-branch") frame.branch = "other-branch";
        if (defect === "missing-frame-context") { delete frame.baseCommit; delete frame.resultCommit; delete frame.branch; }
        f.store.database.prepare("UPDATE build_events SET payload_json = ? WHERE sequence = ?").run(JSON.stringify(payload), failure.sequence);
      }
      if (["cross-build", "cross-task", "cross-attempt", "cross-manifest", "cross-handoff", "wrong-base", "wrong-result", "wrong-log-argv", "wrong-log-index"].includes(defect)) {
        const body = structuredClone(certificate.body);
        if (defect === "cross-build") body.producer.buildId = "other-build";
        if (defect === "cross-task") body.producer.taskId = "other-task";
        if (defect === "cross-attempt") body.producer.attempt = 2;
        if (defect === "cross-manifest") body.manifest.id = "other-manifest";
        if (defect === "cross-handoff") body.handoffSha256 = "f".repeat(64);
        if (defect === "wrong-base") body.producer.baseCommit = "f".repeat(40);
        if (defect === "wrong-result") body.producer.resultCommit = "f".repeat(40);
        if (defect === "wrong-log-argv" || defect === "wrong-log-index") {
          const log = JSON.parse(await readFile(logPath, "utf8")) as { argv: string[]; index: number };
          if (defect === "wrong-log-argv") log.argv = ["node", "wrong-command"];
          else log.index = 1;
          const bytes = `${JSON.stringify(log, null, 2)}\n`;
          await writeFile(logPath, bytes);
          const entry = body.validations[0]; if (entry === undefined) throw new Error("Missing native log binding");
          entry.logSha256 = createHash("sha256").update(bytes).digest("hex");
        }
        const id = canonicalJsonSha256(body);
        await writeFile(path.join(path.dirname(certificate.sourcePath), `native-validation-${id}.json`), `${JSON.stringify({ id, ...body }, null, 2)}\n`);
        f.store.database.prepare("UPDATE build_events SET payload_json = ? WHERE sequence = ?").run(JSON.stringify({ ...publication.payload, certificateId: id }), publication.sequence);
      }
      await expect(evaluateGovernedBuild(f.context, f.buildId)).rejects.toThrow("GOVERNED_FAILURE_HISTORY_UNAVAILABLE");
      expect(await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff)).toEqual([]);
      expect(f.store.events.listForBuild(f.buildId).some((event) => event.type === "governor.decision" || event.type === "integration.completed")).toBe(false);
    } finally { f.cleanup(); }
  });

  it("keeps later mutable validation and artifact state separate from verified past publication bytes", async () => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    const observed = vi.spyOn(GovernorControlService.prototype, "evaluate");
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      await failNativeIntegrationFixture(f);
      const row = f.store.validations.listForBuild(f.buildId)[0];
      const artifact = f.store.artifacts.listForBuild(f.buildId)[0];
      if (row === undefined || artifact === undefined) throw new Error("Missing native source identities");
      f.store.validations.setStatus(row.id, "failed", { exitCode: 1, logPath: null });
      f.store.artifacts.setStatus(artifact.id, "integrated");
      expect((await evaluateGovernedBuild(f.context, f.buildId))?.decision.action).toBe("REQUEST_REPAIR");
      expect(await readVerifiedNativeValidationEvidence(f, f.buildId, f.handoff)).toEqual([]);
      expect(observed.mock.calls.at(-1)?.[0].observation.evidence).toEqual({ items: [], satisfied: [], contradictory: [] });
      expect(observed.mock.calls.at(-1)?.[0].observation.evidenceDelta).toMatchObject({ score: 0, direction: "ZERO" });
    } finally { observed.mockRestore(); f.cleanup(); }
  });

  it.each(["validation-row", "changed-file"])("refuses %s changed during asynchronous historical verification", async (mutation) => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    let restore = () => {};
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      await failNativeIntegrationFixture(f);
      const row = f.store.validations.listForBuild(f.buildId)[0];
      if (row === undefined) throw new Error("Missing native validation row");
      const find = f.store.manifests.findForTask.bind(f.store.manifests);
      const lookup = vi.spyOn(f.store.manifests, "findForTask").mockImplementationOnce((...args) => {
        const result = find(...args);
        if (mutation === "validation-row") f.store.validations.setStatus(row.id, "failed", { exitCode: 1 });
        else f.store.tasks.recordChangedFiles(f.taskId, 1, [{ path: "outside-ownership/new.ts", changeType: "modified", withinOwnership: false }]);
        return result;
      });
      restore = () => lookup.mockRestore();
      await expect(evaluateGovernedBuild(f.context, f.buildId)).rejects.toThrow("GOVERNED_FAILURE_HISTORY_UNAVAILABLE");
      expect(lookup).toHaveBeenCalled();
      expect(f.store.events.listForBuild(f.buildId).some((event) => event.type === "governor.decision")).toBe(false);
    } finally { restore(); f.cleanup(); }
  });

  it("uses the failed attempt's own publication context after a later native worker retry", async () => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    const observed = vi.spyOn(GovernorControlService.prototype, "evaluate");
    let coordinator: BuildCoordinator | undefined;
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      await failNativeIntegrationFixture(f);
      f.store.tasks.retry(f.taskId);
      f.store.tasks.transition(f.taskId, "running");
      f.store.tasks.updateAttempt(f.taskId, 2, { status: "failed", errorCode: "WORKER_FAILED", errorMessage: "inert retry failed" });
      const getProvider = vi.fn(() => { throw new Error("Retry context must not dispatch a provider"); });
      coordinator = new BuildCoordinator({ ...f.context, handoffService: f.manifests, agentProviders: { get: getProvider } } as unknown as ConstructorParameters<typeof BuildCoordinator>[0]);
      const native = coordinator as unknown as { failTask(taskId: string, eventType: string, code: string, message: string): unknown };
      native.failTask(f.taskId, "task.worker_failed", "WORKER_FAILED", "inert retry failed");
      expect((await evaluateGovernedBuild(f.context, f.buildId))?.decision.action).toBe("REQUEST_REPAIR");
      expect(observed.mock.calls.at(-1)?.[0].observation.evidence).toEqual({ items: [], satisfied: [], contradictory: [] });
      expect(observed.mock.calls.at(-1)?.[0].observation.evidenceDelta).toMatchObject({ score: 0, direction: "ZERO" });
      expect(getProvider).not.toHaveBeenCalled();
    } finally { await coordinator?.shutdown(); observed.mockRestore(); f.cleanup(); }
  });

  it("preserves native sequence across a complete multi-page journal with unrelated global gaps", async () => {
    const f = await nativeEvidenceFixture(false, undefined, true);
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      f.store.repositories.create({ id: "other-repo", name: "inert other repository", localPath: path.join(f.root, "other-repository"), configPath: ".agentflow.yaml", baseBranch: "main" });
      f.store.builds.create({ id: "other-build", repositoryId: "other-repo", backlogPath: "BACKLOG.md", baseCommit: f.executionBase, integrationBranch: "other-integration", tasks: [] });
      f.store.transaction(() => {
        for (let index = 0; index < 10010; index += 1) {
          f.store.events.append({ buildId: f.buildId, type: "unit.inert-journal-padding", payload: { index } });
          if (index % 1000 === 0) f.store.events.append({ buildId: "other-build", type: "unit.unrelated", payload: {} });
        }
      });
      await failNativeIntegrationFixture(f);
      expect((await evaluateGovernedBuild(f.context, f.buildId))?.decision.action).toBe("REQUEST_REPAIR");
      expect(f.store.events.listForBuild(f.buildId, { limit: 10000 })).toHaveLength(10000);
    } finally { f.cleanup(); }
  });
});

describe("Record-derived native capability export", () => {
  it("accepts genuine retry reuse of unchanged declared artifacts with historical registration metadata", async () => {
    const f = await nativeEvidenceFixture(true);
    try {
      const before = f.store.artifacts.listForBuild(f.buildId).find((item) => item.artifactType === "design-intelligence/capability-activation-plan");
      expect((await retryCapabilityFixture(f)).readyForCommit).toBe(true);
      expect(f.store.tasks.getById(f.taskId).attempt).toBe(2);
      expect(f.store.artifacts.listForBuild(f.buildId).find((item) => item.id === before?.id)).toEqual(before);
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      const exported = await makeDesignIntelligenceReceipt(f.context, f.buildId);
      expect(exported.receipt.evidence.artifacts.some((item) => item.class === "capability-plan")).toBe(true);
      const currentRows = f.store.validations.listForBuild(f.buildId).filter((item) => item.logPath?.includes("attempt-2"));
      expect(exported.receipt.tasks[0]?.validation.map((item) => item.evidenceId).sort()).toEqual(currentRows.map((item) => item.id).sort());
    } finally { f.cleanup(); }
  });

  it("rejects stale registration payload when the genuine current manifest and result bytes changed", async () => {
    const f = await nativeEvidenceFixture(true);
    try {
      const old = f.store.artifacts.listForBuild(f.buildId).find((item) => item.artifactType === "design-intelligence/capability-activation-plan"); if (old === undefined) throw new Error("Missing old plan registration");
      expect((await retryCapabilityFixture(f, "format")).readyForCommit).toBe(true);
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      const current = f.store.artifacts.listForBuild(f.buildId); expect(current.find((item) => item.id === old.id)?.sha256).not.toBe(old.sha256);
      const spy = vi.spyOn(f.store.artifacts, "listForBuild").mockReturnValue(current.map((item) => item.id === old.id ? old : item));
      try { await expect(makeDesignIntelligenceReceipt(f.context, f.buildId)).rejects.toMatchObject({ code: "RECEIPT_EVIDENCE_CHANGED" }); } finally { spy.mockRestore(); }
    } finally { f.cleanup(); }
  });

  it.skipIf(process.env.AFI003_NATIVE_ROOT === undefined)("refuses malformed actual capability bytes through the predeclared unchanged Proofloom semantic command before certification", async () => {
    const f = await nativeEvidenceFixture(true);
    try {
      expect(f.handoff.tasks[0]?.validate).toContain("node src/capability-check.mjs");
      const summary = await retryCapabilityFixture(f, "malformed");
      expect(summary.readyForCommit).toBe(false);
      expect(summary.commands.find((item) => item.command === "node src/capability-check.mjs")).toMatchObject({ status: "failed", exitCode: 1 });
      await expect(publishNativeValidationEvidence(f, f.buildId, f.handoff)).rejects.toThrow("NATIVE_VALIDATION_EVIDENCE_INVALID");
      const decision = await evaluateGovernedBuild(f.context, f.buildId); expect(decision?.decision.action).toBe("REQUEST_REPAIR");
      expect(f.store.tasks.getById(f.taskId)).toMatchObject({ state: "failed", resultCommit: null, integrationCommit: null });
      expect(f.store.events.listForBuild(f.buildId).some((event) => event.type === "evidence.native_validation_certified" || event.type === "integration.completed")).toBe(false);
      if (process.env.AFI003_CAPABILITY_OUTPUT_ROOT !== undefined) {
        await mkdir(process.env.AFI003_CAPABILITY_OUTPUT_ROOT, { recursive: true });
        await writeFile(path.join(process.env.AFI003_CAPABILITY_OUTPUT_ROOT, "preintegration-semantic-refusal.json"), JSON.stringify({ classification: "ACTUAL_DECLARED_PF_SEMANTIC_CHECK_REFUSAL_UNIT_FIXTURE", summary, decision, task: f.store.tasks.getById(f.taskId), validations: f.store.validations.listForBuild(f.buildId), events: f.store.events.listForBuild(f.buildId) }, null, 2));
      }
    } finally { f.cleanup(); }
  });
  it("exports immutable plan/binding bytes and detached observations linked to dynamic actual native logs", async () => {
    const f = await nativeEvidenceFixture(true);
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      expect((await evaluateGovernedBuild(f.context, f.buildId))?.decision.action).toBe("CONTINUE");
      // Explicit disposable integration lifecycle; no coordinator/provider claim.
      await execFileAsync("git", ["-C", f.root, "commit", "--allow-empty", "-m", "fixture integration lifecycle"]);
      const integrationCommit = (await execFileAsync("git", ["-C", f.root, "rev-parse", "HEAD"])).stdout.trim();
      f.store.tasks.transition(f.taskId, "integrating"); f.store.recordIntegrationSuccess(f.taskId, { integrationCommit }); f.store.builds.transition(f.buildId, "completed");
      const exported = await makeDesignIntelligenceReceipt(f.context, f.buildId);
      const read = async (kind: string) => { const source = exported.sources.find((item) => exported.receipt.evidence.artifacts.some((artifact) => artifact.path === item.relativePath && artifact.class === kind)); if (source === undefined) throw new Error(`Missing ${kind}`); return { source, document: JSON.parse(await readFile(source.sourcePath, "utf8")) as Record<string, unknown> }; };
      const plan = await read("capability-plan"); const binding = await read("capability-binding"); const observation = await read("capability-observation");
      expect(plan.document).toEqual(f.capabilityDocuments?.plan); expect(binding.document).toEqual(f.capabilityDocuments?.binding);
      const rows = f.store.validations.listForBuild(f.buildId);
      expect(observation.document).toMatchObject({ kind: "design-intelligence/capability-observation", handoff: { id: f.handoff.handoffId, sha256: canonicalJsonSha256(f.handoff) } });
      expect(observation.document.observations).toEqual(expect.arrayContaining(rows.map((row) => ({ subject: "member:fixture-checker", checkId: row.command, evidenceId: row.id }))));
      for (const row of rows) {
        expect(exported.receipt.tasks[0]?.validation.find((item) => item.command === row.command)?.evidenceId).toBe(row.id);
        expect(exported.receipt.evidence.artifacts.find((item) => item.id === row.id)?.class).toBe("agentflow:native-task-validation-log");
      }
      const outputRoot = process.env.AFI003_CAPABILITY_OUTPUT_ROOT ?? path.join(f.root, "capability-export-test");
      await mkdir(outputRoot, { recursive: true });
      for (const source of exported.sources) { const target = path.join(outputRoot, source.relativePath); await mkdir(path.dirname(target), { recursive: true }); await copyFile(source.sourcePath, target); }
      await writeFile(path.join(outputRoot, "capability-native-export.json"), JSON.stringify({ classification: "ACTUAL_NATIVE_PRODUCER_UNIT_FIXTURE_NOT_HTTP_OR_PROVIDER", receipt: exported.receipt, handoff: f.handoff, binding: f.capabilityDocuments?.binding, evidenceRoot: outputRoot, validations: rows }, null, 2));
      const nativeRoot = process.env.AFI003_NATIVE_ROOT;
      if (nativeRoot !== undefined) {
        const audit = await execFileAsync("python3", ["-B", "-c", "import json,sys;from design_intelligence.agentflow_contracts import audit_capability_plan_receipt;d=json.load(open(sys.argv[1]));print(json.dumps(audit_capability_plan_receipt(d['binding'],d['receipt'],handoff=d['handoff'],evidence_root=d['evidenceRoot'])))", path.join(outputRoot, "capability-native-export.json")], { cwd: nativeRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
        await writeFile(path.join(outputRoot, "proofloom-capability-audit.json"), audit.stdout);
        expect(JSON.parse(audit.stdout)).toMatchObject({ status: "PASS", capabilityVerified: true, obligationsVerified: true });
      }
      const watermark = f.store.events.getLatestSequence(f.buildId);
      await writeFile(path.join(f.root, "src/capability-plan.json"), "mutable worktree bytes must not be exported");
      expect(await makeDesignIntelligenceReceipt(f.context, f.buildId)).toEqual(exported);
      expect(f.store.events.getLatestSequence(f.buildId)).toBe(watermark);
    } finally { f.cleanup(); }
  });

  it("refuses tampered retained document bytes rather than repairing or replacing them", async () => {
    const f = await nativeEvidenceFixture(true);
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      const exported = await makeDesignIntelligenceReceipt(f.context, f.buildId);
      const artifact = exported.receipt.evidence.artifacts.find((item) => item.class === "capability-plan");
      const source = exported.sources.find((item) => item.relativePath === artifact?.path); if (source === undefined) throw new Error("Missing retained plan");
      await writeFile(source.sourcePath, "tampered");
      await expect(makeDesignIntelligenceReceipt(f.context, f.buildId)).rejects.toMatchObject({ code: "RECEIPT_EVIDENCE_CHANGED" });
      expect(await readFile(source.sourcePath, "utf8")).toBe("tampered");
    } finally { f.cleanup(); }
  });

  it.each(["wrong-task", "unknown-check"] as const)("refuses a digest-valid declared %s document", async (defect) => {
    const f = await nativeEvidenceFixture(true, defect);
    try { await publishNativeValidationEvidence(f, f.buildId, f.handoff); await expect(makeDesignIntelligenceReceipt(f.context, f.buildId)).rejects.toMatchObject({ code: "RECEIPT_EVIDENCE_CHANGED" }); } finally { f.cleanup(); }
  });

  it.each(["missing", "duplicate", "wrong-attempt", "tampered-digest"] as const)("refuses %s registry linkage", async (defect) => {
    const f = await nativeEvidenceFixture(true);
    try {
      await publishNativeValidationEvidence(f, f.buildId, f.handoff);
      const rows = f.store.artifacts.listForBuild(f.buildId); const document = rows.find((item) => item.artifactType === "design-intelligence/capability-activation-plan"); if (document === undefined) throw new Error("Missing fixture plan record");
      const altered = defect === "missing" ? rows.filter((item) => item.id !== document.id) : defect === "duplicate" ? [...rows, { ...document, id: "duplicate" }] : rows.map((item) => item.id !== document.id ? item : { ...item, ...(defect === "wrong-attempt" ? { metadata: { ...item.metadata, attempt: 2 } } : { sha256: "0".repeat(64) }) });
      const spy = vi.spyOn(f.store.artifacts, "listForBuild").mockReturnValue(altered);
      try { await expect(makeDesignIntelligenceReceipt(f.context, f.buildId)).rejects.toMatchObject({ code: "RECEIPT_EVIDENCE_CHANGED" }); } finally { spy.mockRestore(); }
    } finally { f.cleanup(); }
  });
});

describe("Native validation certificate current-record verification", () => {
  it("publishes one genuine certificate idempotently, preserves current proof through integration, and exports actual bytes", async () => {
    const fixture = await nativeEvidenceFixture();
    try {
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
      // Missing native certificate still triggers the protected missing-evidence rule.
      fixture.store.events.append({ buildId: fixture.buildId, type: "evidence.recorded", payload: { satisfied: ["focused tests"], items: ["untrusted-label"] } });
      const missing = await evaluateGovernedBuild(fixture.context, fixture.buildId);
      expect(missing?.decision.action).not.toBe("CONTINUE");
      await publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      await publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      const certificates = await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      expect(certificates).toHaveLength(1);
      const certificate = certificates[0];
      if (certificate === undefined) throw new Error("Expected actual native certificate");
      expect(certificate.id).toBe(canonicalJsonSha256(certificate.body));
      expect(certificate.body.producer).toMatchObject({ buildId: fixture.buildId, taskId: fixture.taskId, attempt: 1, resultCommit: fixture.committed.resultCommit });
      expect(certificate.body.validations).toMatchObject([{ index: 0, argv: ["npm", "test"], required: true, status: "passed", exitCode: 0 }]);
      expect(fixture.store.events.listForBuild(fixture.buildId).filter((event) => event.type === "evidence.native_validation_certified")).toHaveLength(1);
      const allowed = await evaluateGovernedBuild(fixture.context, fixture.buildId);
      expect(allowed?.decision.action).toBe("CONTINUE");
      fixture.store.tasks.transition(fixture.taskId, "integrating");
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toHaveLength(1);
      fixture.store.tasks.transition(fixture.taskId, "integrated", { integrationCommit: fixture.committed.resultCommit });
      const artifact = fixture.store.artifacts.listForBuild(fixture.buildId)[0];
      if (artifact === undefined) throw new Error("Expected pathless declared artifact");
      fixture.store.artifacts.setStatus(artifact.id, "integrated");
      fixture.store.builds.transition(fixture.buildId, "completed");
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toHaveLength(1);
      const exported = await makeDesignIntelligenceReceipt(fixture.context, fixture.buildId);
      expect(exported.receipt.evidence.artifacts.find((artifact) => artifact.id === certificate.id)).toMatchObject({ id: certificate.id, class: "focused tests", sha256: certificate.sha256 });
      expect(exported.sources[0]?.sourcePath).toBe(certificate.sourcePath);
      const exportWatermark = fixture.store.events.getLatestSequence(fixture.buildId);
      const repeatedExport = await makeDesignIntelligenceReceipt(fixture.context, fixture.buildId);
      expect(repeatedExport).toEqual(exported);
      expect(fixture.store.events.getLatestSequence(fixture.buildId)).toBe(exportWatermark);
      const governorSource = exported.sources.find((source) => source.relativePath.includes("/governor-provenance/"));
      if (governorSource === undefined) throw new Error("Expected actual Governor source artifact");
      const governorBytes = await readFile(governorSource.sourcePath);
      expect((JSON.parse(governorBytes.toString("utf8")) as { sourceEventWatermark: number }).sourceEventWatermark).toBe(exportWatermark);
      expect(await readFile(governorSource.sourcePath)).toEqual(governorBytes);
      expect(createHash("sha256").update(await readFile(certificate.sourcePath)).digest("hex")).toBe(exported.sources[0]?.sha256);
      const certificateBytes = await readFile(certificate.sourcePath);
      await writeFile(certificate.sourcePath, Buffer.concat([certificateBytes, Buffer.from(" \n")]));
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
      await expect(makeDesignIntelligenceReceipt(fixture.context, fixture.buildId)).rejects.toMatchObject({ code: "RECEIPT_EVIDENCE_CHANGED" });
      await writeFile(certificate.sourcePath, certificateBytes);
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toHaveLength(1);
      await writeFile(certificate.sourcePath, "forged certificate");
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
      await expect(makeDesignIntelligenceReceipt(fixture.context, fixture.buildId)).rejects.toMatchObject({ code: "RECEIPT_EVIDENCE_CHANGED" });
    } finally { fixture.cleanup(); }
  });

  it("refuses partial, optional, wrong-command/order, cross-task and changed native log bytes", async () => {
    const fixture = await nativeEvidenceFixture();
    try {
      await publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      const logPath = fixture.logs[0];
      if (logPath === undefined) throw new Error("Expected actual native validation log");
      const original = await readFile(logPath, "utf8");
      const outcome = JSON.parse(original) as Record<string, unknown>;
      for (const mutation of [{ argv: ["node", "unapproved.js"] }, { index: 1 }, { required: false }, { status: "failed", exitCode: 1 }, { command: "substituted" }, { startedAt: "2000-01-01T00:00:00.000Z" }]) {
        await writeFile(logPath, JSON.stringify({ ...outcome, ...mutation }));
        expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
      }
      await rm(logPath);
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
      const elsewhere = path.join(fixture.root, "untrusted-log.json");
      await writeFile(elsewhere, original);
      await symlink(elsewhere, logPath);
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
      await rm(logPath); await writeFile(logPath, original);
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toHaveLength(1);
      // A changed current result cannot be rescued by any historical label/event.
      fixture.store.tasks.transition(fixture.taskId, "integrating", { resultCommit: "f".repeat(40) });
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
    } finally { fixture.cleanup(); }
  });

  it("rederives current retry evidence while the pathless artifact row retains old attempt metadata", async () => {
    const fixture = await nativeEvidenceFixture();
    try {
      await publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      const prior = await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      const declaredArtifact = fixture.store.artifacts.listForBuild(fixture.buildId)[0];
      if (declaredArtifact === undefined) throw new Error("Expected native pathless artifact");
      expect(declaredArtifact.metadata.attempt).toBe(1);
      fixture.store.tasks.transition(fixture.taskId, "failed");
      fixture.store.tasks.updateAttempt(fixture.taskId, 1, { status: "failed" });
      fixture.store.tasks.retry(fixture.taskId);
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
      fixture.store.tasks.updateAttempt(fixture.taskId, 2, { status: "running", startedAt: new Date().toISOString() });
      fixture.store.tasks.transition(fixture.taskId, "running");
      await writeFile(path.join(fixture.root, "src", "index.js"), "export const ready = 2;\n");
      fixture.store.tasks.transition(fixture.taskId, "validating");
      const validation = await validateTask({ buildId: fixture.buildId, taskId: fixture.taskId, attempt: 2, worktreePath: fixture.root, baseCommit: fixture.executionBase, ownedPaths: ["src/"], commands: ["npm test"], workerCompletedSuccessfully: true });
      expect(validation.readyForCommit, JSON.stringify(validation)).toBe(true);
      const directory = path.join(fixture.environment.runsPath, fixture.buildId, fixture.taskId, "attempt-2");
      await mkdir(directory, { recursive: true });
      for (const [index, outcome] of validation.commands.entries()) {
        const id = `retry-validation-${index}`; const logPath = path.join(directory, `${id}.json`);
        await writeFile(logPath, `${JSON.stringify(outcome, null, 2)}\n`);
        fixture.store.validations.create({ id, buildId: fixture.buildId, taskId: fixture.taskId, validationType: "task", command: outcome.command, status: "passed", exitCode: outcome.exitCode, startedAt: outcome.startedAt, completedAt: outcome.completedAt, logPath });
      }
      const committed = await new TaskCommitService().commit({ worktreePath: fixture.root, baseCommit: fixture.executionBase, branchName: "main", backlogTaskId: "AF-001", title: "Retry", changedFiles: validation.ownership.changedFiles, allowNoChanges: false });
      fixture.store.tasks.recordChangedFiles(fixture.taskId, 2, committed.changedFiles);
      const manifest = await fixture.manifests.publish({ buildId: fixture.buildId, taskId: fixture.taskId, backlogTaskId: "AF-001", attempt: 2, status: "validated", baseCommit: fixture.executionBase, resultCommit: committed.resultCommit, branch: "main", worktreePath: fixture.root, changedFiles: committed.changedFiles.map((item) => item.path), consumes: [], produces: fixture.handoff.tasks[0]?.produces.map(({ name, type, version }) => ({ name, type, version })) ?? [] });
      fixture.store.tasks.transition(fixture.taskId, "validated", { resultCommit: committed.resultCommit });
      fixture.store.tasks.updateAttempt(fixture.taskId, 2, { status: "succeeded", resultCommit: committed.resultCommit, completedAt: new Date().toISOString() });
      expect(fixture.store.artifacts.getById(declaredArtifact.id).metadata.attempt).toBe(1);
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
      await publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      const current = await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      expect(current).toHaveLength(1);
      expect(current[0]?.body.producer.attempt).toBe(2);
      expect(current[0]?.body.manifest.id).toBe(manifest.record.id);
      expect(current[0]?.id).not.toBe(prior[0]?.id);
      const exported = await makeDesignIntelligenceReceipt(fixture.context, fixture.buildId);
      expect(exported.receipt.tasks[0]?.validation).toHaveLength(1);
      expect(exported.receipt.tasks[0]?.validation[0]?.evidenceId).toBe(current[0]?.id);
      expect(current[0]?.body.validations.map((validation) => validation.id)).toEqual(["retry-validation-0"]);
      expect(fixture.store.validations.listForBuild(fixture.buildId)).toHaveLength(2);
      expect(fixture.store.events.listForBuild(fixture.buildId).filter((event) => event.type === "evidence.native_validation_certified")).toHaveLength(2);
    } finally { fixture.cleanup(); }
  });

  it("observes an actual native contradiction appended during awaited certificate verification", async () => {
    const fixture = await nativeEvidenceFixture();
    try {
      await publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      const actualRows = fixture.store.validations.listForBuild.bind(fixture.store.validations);
      let contradicted = false;
      const spy = vi.spyOn(fixture.store.validations, "listForBuild").mockImplementation((buildId) => {
        const rows = actualRows(buildId);
        if (!contradicted) {
          contradicted = true;
          fixture.store.events.append({ buildId, type: "evidence.recorded", payload: { contradictory: ["focused tests"] } });
        }
        return rows;
      });
      const evaluated = await evaluateGovernedBuild(fixture.context, fixture.buildId);
      spy.mockRestore();
      expect(contradicted).toBe(true);
      expect(evaluated?.decision).toMatchObject({ action: "BLOCK_INTEGRATION", ruleId: "required-evidence-contradicted" });
    } finally { vi.restoreAllMocks(); fixture.cleanup(); }
  });

  it("chains after a real native Governor decision produced during awaited certificate verification", async () => {
    const fixture = await nativeEvidenceFixture();
    try {
      await publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      const nativeControl = new GovernorControlService(fixture.store.events);
      const actualEvaluate = nativeControl.evaluate.bind(nativeControl);
      let nativeInput: Parameters<GovernorControlService["evaluate"]>[0] | undefined;
      const capture = vi.spyOn(GovernorControlService.prototype, "evaluate").mockImplementation((input) => {
        nativeInput = input;
        return actualEvaluate(input);
      });
      const initial = await evaluateGovernedBuild(fixture.context, fixture.buildId);
      capture.mockRestore();
      if (initial === undefined || nativeInput === undefined) throw new Error("Expected actual native evaluation input");
      const currentNativeInput = nativeInput;
      const actualRows = fixture.store.validations.listForBuild.bind(fixture.store.validations);
      let inFlightHash: string | undefined;
      const spy = vi.spyOn(fixture.store.validations, "listForBuild").mockImplementation((buildId) => {
        const rows = actualRows(buildId);
        if (inFlightHash === undefined) {
          const concurrent = new GovernorControlService(fixture.store.events).evaluate({ ...currentNativeInput, recordedAt: new Date().toISOString(), previousRecordHash: initial.record.recordHash });
          inFlightHash = concurrent.record.recordHash;
        }
        return rows;
      });
      const evaluated = await evaluateGovernedBuild(fixture.context, fixture.buildId);
      spy.mockRestore();
      expect(inFlightHash).toBeDefined();
      expect(evaluated?.record.previousRecordHash).toBe(inFlightHash);
    } finally { vi.restoreAllMocks(); fixture.cleanup(); }
  });

  it("refuses a state change while the final native byte verification is in flight", async () => {
    const fixture = await nativeEvidenceFixture();
    try {
      await publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      const original = fixture.store.validations.listForBuild.bind(fixture.store.validations);
      let reads = 0;
      const spy = vi.spyOn(fixture.store.validations, "listForBuild").mockImplementation((buildId) => {
        reads += 1;
        const rows = original(buildId);
        if (reads === 2) fixture.store.tasks.transition(fixture.taskId, "failed");
        return rows;
      });
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
      expect(reads).toBeGreaterThanOrEqual(2);
      spy.mockRestore();
    } finally { vi.restoreAllMocks(); fixture.cleanup(); }
  });

  it.skipIf(!process.env.AFI003_NATIVE_ROOT)("passes the actual frozen strict bundle validator and refuses native cursor drift", async () => {
    const fixture = await nativeEvidenceFixture();
    const app = Fastify();
    try {
      await publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      fixture.store.tasks.transition(fixture.taskId, "integrating");
      fixture.store.tasks.transition(fixture.taskId, "integrated", { integrationCommit: fixture.committed.resultCommit });
      fixture.store.builds.transition(fixture.buildId, "completed");
      const fingerprint = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
      const declared = fixture.handoff.tasks[0];
      if (declared === undefined) throw new Error("Expected exact declared task");
      const experiment = WaleRunLabExperimentSchema.parse({
        experimentId: `exp_${"7".repeat(64)}`, runId: "run_WireFixture",
        repositorySnapshot: { state: "VERIFIED", commit: fixture.handoff.repository.baseCommit, tree: fixture.handoff.repository.snapshotSha256, reason: null },
        frozenTask: { state: "VERIFIED", ids: [fingerprint(declared.id)], titleFingerprints: [fingerprint(declared.title)] },
        frozenRequirements: { state: "UNKNOWN", items: [], reason: "FROZEN_REQUIREMENTS_NOT_RETAINED_SEPARATELY" },
        acceptanceCriteria: { state: "VERIFIED", count: declared.acceptanceCriteria.length, items: declared.acceptanceCriteria.map((criterion, index) => ({ id: fingerprint(`${declared.id}:acceptance:${index + 1}`), fingerprint: fingerprint(criterion) })) },
        parameters: { deliverySize: 100, overflowBehavior: "SPLIT_OR_REPLAN", humanInterruptionBudget: 0, authorityEscalationRequired: true, strategy: "NORMAL_EXECUTION", verificationProfile: "unit", verificationProfileReference: "native-unit", requiredCheckBindings: [{ id: "unit", retainedReference: "npm-test" }], requiredChecksCannotBeBypassed: true, agentModel: null },
        authorityStateReference: `authority-${fixture.handoff.authority.stateSha256.slice(0, 24)}`, strategy: "NORMAL_EXECUTION",
        executionResult: { status: "UNKNOWN", completionState: "UNKNOWN", reason: "EXPERIMENT_NOT_EXECUTED" }, verificationEvidence: { state: "UNKNOWN", reason: "EXPERIMENT_NOT_EXECUTED" }, comparisonEligibility: { state: "UNKNOWN", reason: "EXACT_CASE_COMPARISON_NOT_BOUND" }, candidateApplication: { authorized: false, reason: "SEPARATE_AUTHORITY_BOUND_STEP_REQUIRED" }, claimBoundary: "Result applies to this exact run.",
      });
      // Exact identity is seeded for this serializer test; full native admission is AFI-003.
      fixture.store.events.appendExperimentBinding(fixture.buildId, experiment);
      const { bundle } = await makeWaleRunLabReceiptBundle(fixture.context, fixture.buildId, experiment);
      expect(Object.keys(bundle).sort()).toEqual(["schemaVersion", "kind", "experimentId", "runId", "bridgeBuildReference", "receipt", "receiptSha256", "evidence", "claimBoundary"].sort());
      const nativeRoot = process.env.AFI003_NATIVE_ROOT;
      if (nativeRoot === undefined) throw new Error("Explicit frozen native root required");
      const bundlePath = path.join(fixture.root, "native-bundle.json");
      await writeFile(bundlePath, JSON.stringify(bundle));
      const validator = "import json,sys;from design_intelligence.agentflow_run_lab import _validate_bundle,AgentFlowRunLabError;value=json.load(open(sys.argv[1]));args=sys.argv[2:];accepted=_validate_bundle(value,*args)\ntry:\n _validate_bundle(dict(value,eventWatermark=0),*args)\nexcept AgentFlowRunLabError as error:\n assert error.reason=='UPSTREAM_SHAPE_INVALID'\nelse:\n raise AssertionError('unsupported key accepted')\nprint(json.dumps({'accepted':True,'extraRefused':True}))";
      const checked = await execFileAsync("python3", ["-c", validator, bundlePath, experiment.experimentId, experiment.runId, fixture.buildId, fixture.handoff.handoffId, canonicalJsonSha256(fixture.handoff)], { cwd: nativeRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
      expect(JSON.parse(checked.stdout)).toEqual({ accepted: true, extraRefused: true });
      const token = "a".repeat(43);
      registerWaleRunLabRoutes(app, { ...fixture.context, environment: { ...fixture.environment, waleBridgeTokenSha256: createHash("sha256").update(token).digest("hex") } });
      const headers = { authorization: `Bearer ${token}` };
      const status = await app.inject({ method: "GET", url: `/api/wale/run-lab/experiments/${experiment.experimentId}`, headers });
      expect(status.statusCode, status.body).toBe(200);
      expect(status.json<{ lastEventSequence: number }>().lastEventSequence).toBe(fixture.store.events.getLatestSequence(fixture.buildId));
      await evaluateGovernedBuild(fixture.context, fixture.buildId);
      const actualNativeRead = nativeEvidenceControl.readManagedNativeEvidenceBytes;
      let decisionDuringRetention = false;
      const earlyRace = vi.spyOn(nativeEvidenceControl, "readManagedNativeEvidenceBytes").mockImplementation(async (...args) => {
        const bytes = await actualNativeRead(...args);
        if (args[1].includes("governor-provenance") && !decisionDuringRetention) {
          decisionDuringRetention = true;
          await evaluateGovernedBuild(fixture.context, fixture.buildId);
        }
        return bytes;
      });
      await expect(makeWaleRunLabReceiptBundle(fixture.context, fixture.buildId, experiment)).rejects.toThrow();
      expect(decisionDuringRetention).toBe(true);
      earlyRace.mockRestore();
      const actualLatest = fixture.store.events.getLatestSequence.bind(fixture.store.events);
      let watermarkReads = 0;
      const spy = vi.spyOn(fixture.store.events, "getLatestSequence").mockImplementation((buildId) => {
        watermarkReads += 1;
        if (watermarkReads === 2) fixture.store.events.append({ buildId, type: "fixture.cursor_drift", payload: { reason: "negative native watermark race" } });
        return actualLatest(buildId);
      });
      await expect(makeWaleRunLabReceiptBundle(fixture.context, fixture.buildId, experiment)).rejects.toThrow("Receipt evidence unavailable");
      expect(watermarkReads).toBe(2);
      spy.mockRestore();
      const events = await app.inject({ method: "GET", url: `/api/wale/run-lab/experiments/${experiment.experimentId}/events?after=0&limit=200`, headers });
      expect(events.statusCode, events.body).toBe(200);
      expect(events.json<{ cursor: number }>().cursor).toBe(actualLatest(fixture.buildId));
    } finally { vi.restoreAllMocks(); await app.close(); fixture.cleanup(); }
  });

  it.skipIf(!process.env.AFI003_NATIVE_ROOT)("initializes the actual frozen Run Theater with retained Governor artifacts", async () => {
    const fixture = await nativeEvidenceFixture();
    try {
      await publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff);
      await evaluateGovernedBuild(fixture.context, fixture.buildId);
      fixture.store.tasks.transition(fixture.taskId, "integrating");
      fixture.store.tasks.transition(fixture.taskId, "integrated", { integrationCommit: fixture.committed.resultCommit });
      fixture.store.builds.transition(fixture.buildId, "completed");
      const exported = await makeDesignIntelligenceReceipt(fixture.context, fixture.buildId);
      const receiptPath = path.join(fixture.root, "retained-export", "retained-receipt.json");
      await mkdir(path.dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, JSON.stringify(exported.receipt));
      const evidenceRoot = path.join(fixture.root, "retained-export");
      for (const source of exported.sources) {
        const target = path.join(evidenceRoot, source.relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, await readFile(source.sourcePath));
      }
      const nativeRoot = process.env.AFI003_NATIVE_ROOT;
      if (nativeRoot === undefined) throw new Error("Explicit frozen native root required");
      const result = await execFileAsync("python3", ["-c", "import json,sys;from design_intelligence.run_theater import build_run_theater;value=build_run_theater(sys.argv[1],sys.argv[2],evidence_root=sys.argv[3]);print(json.dumps({'kind':value['kind']}))", receiptPath, path.join(fixture.root, "handoff.json"), evidenceRoot], { cwd: nativeRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
      expect(JSON.parse(result.stdout)).toEqual({ kind: "wale/run-theater" });
    } finally { fixture.cleanup(); }
  });

  it("refuses forged self-certified references and changed current manifest bytes", async () => {
    const fixture = await nativeEvidenceFixture();
    try {
      fixture.store.events.append({ buildId: fixture.buildId, taskId: fixture.taskId, type: "evidence.native_validation_certified", payload: { certificateId: "f".repeat(64), handoffSha256: canonicalJsonSha256(fixture.handoff), artifactName: "focused tests", attempt: 1 } });
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
      await expect(publishNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).rejects.toThrow("NATIVE_VALIDATION_EVIDENCE_INVALID");
      await writeFile(fixture.publication.record.manifestPath, "tampered manifest");
      expect(await readVerifiedNativeValidationEvidence(fixture, fixture.buildId, fixture.handoff)).toEqual([]);
    } finally { fixture.cleanup(); }
  });
});
