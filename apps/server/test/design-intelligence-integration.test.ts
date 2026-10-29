import * as nativeEvidenceControl from "../src/governor/build-control.js";
import { GovernorControlService } from "../src/governor/control-service.js";
import Fastify from "fastify";
import { registerWaleRunLabRoutes } from "../src/http/routes/wale-run-lab.js";
import { WaleRunLabExperimentSchema } from "../src/integration/wale-run-lab.js";
import { makeWaleRunLabReceiptBundle } from "../src/integration/wale-run-lab-receipt-bundle.js";
import { createDatabaseRepositories } from "../src/db/index.js";
import { createDatabaseFixture } from "./helpers/database-fixture.js";
import { HandoffManifestService } from "../src/artifacts/index.js";
import { TaskCommitService } from "../src/orchestration/task-commit.js";
import { validateTask } from "../src/validation/index.js";
import { publishNativeValidationEvidence, readVerifiedNativeValidationEvidence, evaluateGovernedBuild } from "../src/governor/build-control.js";
import { makeDesignIntelligenceReceipt } from "../src/integration/design-intelligence-receipt.js";
import { DEFAULT_ORGANIZATION_POLICY } from "../src/governance/organization-policy.js";
import type { AgentFlowContext } from "../src/http/context.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { resolveEnvironment } from "../src/config/environment.js";
import { buildApp } from "../src/http/app.js";
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

// This fixture executes native validation/commit/manifest producers, then exercises
// the evidence seam. It does not claim HTTP admission or a provider journey.
async function nativeEvidenceFixture() {
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
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "fixture base"]);
    const baseCommit = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const handoff = GovernedTaskHandoffSchema.parse(approvedHandoff(baseCommit, createHash("sha256").update(authorityBytes).digest("hex"), undefined, undefined, { produces: [{ name: "focused tests", type: "agentflow/native-task-validation-evidence", version: "1.0.0" }] }));
    await writeFile(path.join(root, "handoff.json"), JSON.stringify(handoff));
    await execFileAsync("git", ["-C", root, "add", "handoff.json"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "fixture approved carrier"]);
    const executionBase = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const plan = planBacklogMarkdown(renderBacklog(handoff, "handoff.json", "BACKLOG.md")).plan;
    if (plan === undefined) throw new Error("Expected native fixture plan");
    store.repositories.create({ id: "evidence-repo", name: "evidence fixture", localPath: root, configPath: ".agentflow.yaml", baseBranch: "main" });
    store.builds.create({ id: "evidence-build", repositoryId: "evidence-repo", backlogPath: "BACKLOG.md", baseCommit: executionBase, integrationBranch: "fixture-integration", status: "running", normalizedPlan: { ...plan, createdAt: new Date().toISOString(), governedHandoff: { id: handoff.handoffId, sha256: canonicalJsonSha256(handoff), path: "handoff.json", governedBaseCommit: baseCommit, executionBaseCommit: executionBase, carrierPaths: ["handoff.json", "BACKLOG.md"], proofBoundary: handoff.proof.claimBoundary } }, tasks: [{ id: "evidence-task", backlogTaskId: "AF-001", title: "Implement", description: "Synthetic native validation fixture", acceptanceCriteria: ["Tests pass"], state: "ready", attempt: 1, branchName: "main", worktreePath: root, baseCommit: executionBase, ownedPaths: ["src/"], validationCommands: ["npm test"] }] });
    const taskId = "evidence-task"; const buildId = "evidence-build";
    const attemptStartedAt = new Date().toISOString();
    store.tasks.createAttempt({ id: "evidence-attempt", taskId, buildId, attempt: 1, status: "running", startedAt: attemptStartedAt });
    store.tasks.transition(taskId, "running");
    await writeFile(path.join(root, "src", "index.js"), "export const ready = true;\n");
    store.tasks.transition(taskId, "validating");
    const validation = await validateTask({ buildId, taskId, attempt: 1, worktreePath: root, baseCommit: executionBase, ownedPaths: ["src/"], commands: ["npm test"], workerCompletedSuccessfully: true });
    expect(validation.readyForCommit).toBe(true);
    const directory = path.join(environment.runsPath, buildId, taskId, "attempt-1");
    await mkdir(directory, { recursive: true });
    const logs = [];
    for (const [index, outcome] of validation.commands.entries()) {
      const id = `validation-${index}`; const logPath = path.join(directory, `${id}.json`);
      await writeFile(logPath, `${JSON.stringify(outcome, null, 2)}\n`);
      store.validations.create({ id, buildId, taskId, validationType: "task", command: outcome.command, status: "passed", exitCode: outcome.exitCode, startedAt: outcome.startedAt, completedAt: outcome.completedAt, logPath });
      logs.push(logPath);
    }
    const committed = await new TaskCommitService().commit({ worktreePath: root, baseCommit: executionBase, branchName: "main", backlogTaskId: "AF-001", title: "Implement", changedFiles: validation.ownership.changedFiles, allowNoChanges: false });
    store.tasks.recordChangedFiles(taskId, 1, committed.changedFiles);
    const manifests = new HandoffManifestService(store, environment.artifactsPath);
    const publication = await manifests.publish({ buildId, taskId, backlogTaskId: "AF-001", attempt: 1, status: "validated", baseCommit: executionBase, resultCommit: committed.resultCommit, branch: "main", worktreePath: root, changedFiles: committed.changedFiles.map((item) => item.path), consumes: [], produces: handoff.tasks[0]?.produces.map(({ name, type, version }) => ({ name, type, version })) ?? [] });
    store.tasks.transition(taskId, "validated", { resultCommit: committed.resultCommit });
    store.tasks.updateAttempt(taskId, 1, { status: "succeeded", resultCommit: committed.resultCommit, completedAt: new Date().toISOString() });
    const dependencies = { store, environment };
    const context = { ...dependencies, repositoryService: { get: async () => store.repositories.getById("evidence-repo") }, organizationPolicy: DEFAULT_ORGANIZATION_POLICY } as unknown as AgentFlowContext;
    return { ...dependencies, context, root, handoff, taskId, buildId, logs, publication, manifests, committed, executionBase, cleanup: database.cleanup };
  } catch (error) { database.cleanup(); throw error; }
}

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
      expect(validation.readyForCommit).toBe(true);
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
