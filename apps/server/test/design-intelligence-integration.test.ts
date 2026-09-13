import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveEnvironment } from "../src/config/environment.js";
import { buildApp } from "../src/http/app.js";
import { backlogHandoffErrors, canonicalJsonSha256, GovernedTaskHandoffSchema, parseHandoffBinding, renderBacklog, verifyHandoffAuthoritySources } from "../src/integration/design-intelligence.js";
import { planBacklogMarkdown } from "../src/planning/planner.js";

const handoff = {
  schemaVersion: "1.0.0", kind: "design-intelligence/governed-task-handoff", handoffId: "DI-AF-001", createdAt: "2026-09-12T12:00:00Z",
  repository: { baseCommit: "a".repeat(40) }, objective: "Deliver a verified contract-first integration.",
  authority: { status: "APPROVED", approvedBy: "owner", approvedAt: "2026-09-12T12:01:00Z", sources: [{ path: "AGENTS.md", sha256: "b".repeat(64) }] },
  tasks: [{ id: "AF-001", title: "Implement", description: "Implement the approved task.", estimateHours: 1, dependsOn: [], owns: ["src/"], acceptanceCriteria: ["Tests pass"], validate: ["npm test"], produces: [], consumes: [] }],
  proof: { requiredEvidence: ["focused tests"], claimBoundary: "Local integration only." },
} as const;
const execFileAsync = promisify(execFile);

describe("Design Intelligence integration", () => {
  it("rejects proposed authority", () => expect(() => GovernedTaskHandoffSchema.parse({ ...handoff, authority: { ...handoff.authority, status: "PROPOSED" } })).toThrow());
  it("renders a digest-bound AgentFlow backlog", () => {
    const parsed = GovernedTaskHandoffSchema.parse(handoff);
    const backlog = renderBacklog(parsed, "artifacts/handoff.json");
    expect(parseHandoffBinding(backlog)).toEqual(expect.objectContaining({ id: handoff.handoffId, sha256: canonicalJsonSha256(handoff) }));
    expect(backlog).toContain("## AF-001: Implement");
    const plan = planBacklogMarkdown(backlog);
    expect(plan.errors).toEqual([]);
    expect(plan.valid).toBe(true);
    expect(backlogHandoffErrors(plan.plan?.tasks ?? [], parsed)).toEqual([]);
  });
  it("detects backlog scope drift after import", () => {
    const parsed = GovernedTaskHandoffSchema.parse(handoff);
    const plan = planBacklogMarkdown(renderBacklog(parsed, "artifacts/handoff.json").replace("src/", "other/"));
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
      const approved = GovernedTaskHandoffSchema.parse({ ...handoff, repository: { baseCommit }, authority: { ...handoff.authority, sources: [{ path: "AGENTS.md", sha256: createHash("sha256").update(authority).digest("hex") }] } });
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
        expect(planned.json()).toMatchObject({ governedHandoff: { id: approved.handoffId, sha256: canonicalJsonSha256(approved) } });
        const created = await app.inject({ method: "POST", url: "/api/builds", payload: { planId: planned.json<{ id: string }>().id } });
        expect(created.statusCode).toBe(201);
        const receipt = await app.inject({ method: "GET", url: `/api/builds/${created.json<{ id: string }>().id}/design-intelligence-receipt` });
        expect(receipt.statusCode).toBe(200);
        expect(receipt.json()).toMatchObject({ kind: "agentflow/build-receipt", handoff: { id: approved.handoffId, sha256: canonicalJsonSha256(approved) }, build: { status: "ready" } });
      } finally {
        await app.close();
      }
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(runtime, { recursive: true, force: true })]);
    }
  }, 20_000);
});
