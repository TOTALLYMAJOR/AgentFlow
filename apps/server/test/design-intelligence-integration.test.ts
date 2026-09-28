import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveEnvironment } from "../src/config/environment.js";
import { buildApp } from "../src/http/app.js";
import { backlogHandoffErrors, canonicalJsonSha256, GovernedTaskHandoffSchema, parseHandoffBinding, renderBacklog, verifyGovernedHandoffForExecution, verifyHandoffAuthoritySources } from "../src/integration/design-intelligence.js";
import { planBacklogMarkdown } from "../src/planning/planner.js";

const governedTasks = [
  { id: "AF-001", title: "Implement", description: "Implement the approved task.", estimateHours: 1, dependsOn: [], owns: ["src/"], acceptanceCriteria: ["Tests pass"], validate: ["npm test"], produces: [], consumes: [] },
] as const;

function approvedHandoff(baseCommit: string, sourceSha256: string) {
  const sources = [{ path: "AGENTS.md", sha256: sourceSha256 }];
  const authorityStateSha256 = "c".repeat(64);
  const governanceReportSha256 = "d".repeat(64);
  const snapshotSha256 = canonicalJsonSha256({ baseCommit, worktreeState: "clean", authorityStateSha256, governanceReportSha256, sources });
  const proposed = {
    schemaVersion: "2.1.0", kind: "design-intelligence/governed-task-handoff", handoffId: "DI-AF-001", createdAt: "2026-09-12T12:00:00Z",
    programId: "program_01measurementsuccess",
    repository: { baseCommit, snapshotSha256, worktreeState: "clean" }, objective: "Deliver a verified contract-first integration.",
    authority: { status: "PROPOSED", stateSha256: authorityStateSha256, governanceReportSha256, sources },
    tasks: governedTasks,
    proof: { requiredEvidence: ["focused tests"], claimBoundary: "Local integration only." },
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
    scope: { repository: ".", paths: ["src/"], actions: ["execute-governed-handoff"] },
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
      const { app } = await buildApp({ environment: resolveEnvironment({ AGENTFLOW_HOME: runtime, AGENTFLOW_LOG_LEVEL: "silent" }), staticRoot: false, logger: false });
      try {
        const registered = await app.inject({ method: "POST", url: "/api/repositories", payload: { path: root } });
        expect(registered.statusCode, registered.body).toBe(201);
        const repositoryId = registered.json<{ id: string }>().id;
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
        const receipt = await app.inject({ method: "GET", url: `/api/builds/${created.json<{ id: string }>().id}/design-intelligence-receipt` });
        expect(receipt.statusCode).toBe(200);
        expect(receipt.json()).toMatchObject({ schemaVersion: "1.1.0", kind: "agentflow/build-receipt", programId: approved.programId, handoff: { id: approved.handoffId, sha256: canonicalJsonSha256(approved) }, build: { status: "ready", governedBaseCommit: baseCommit } });
      } finally {
        await app.close();
      }
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(runtime, { recursive: true, force: true })]);
    }
  }, 20_000);
});
