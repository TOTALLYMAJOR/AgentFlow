import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEnvironment } from "../apps/server/src/config/environment.js";
import { buildApp } from "../apps/server/src/http/app.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => { temporaryRoots.delete(root); await rm(root, { recursive: true, force: true }); }));
});

describe("multi-repository lifecycle acceptance", () => {
  it("runs three exact repository plans to completion and retires terminal state idempotently", async () => {
    const runtimeHome = await temporaryRoot("agentflow-multi-runtime");
    const repositoryPaths = await Promise.all([fixtureRepository("contracts"), fixtureRepository("service"), fixtureRepository("web")]);
    const { app, context } = await buildApp({ environment: resolveEnvironment({ AGENTFLOW_HOME: runtimeHome, AGENTFLOW_LOG_LEVEL: "silent" }), staticRoot: false, logger: false });
    vi.spyOn(context.coordinator, "start").mockImplementation(async (buildId) => context.store.builds.transition(buildId, "running", { eventType: "acceptance.build_started" }));
    try {
      const members: Array<{ planId: string; baseCommit: string }> = [];
      for (const repositoryPath of repositoryPaths) {
        const repository = (await app.inject({ method: "POST", url: "/api/repositories", payload: { path: repositoryPath } })).json<{ id: string }>();
        const plan = (await app.inject({ method: "POST", url: "/api/plans", payload: { repositoryId: repository.id } })).json<{ id: string }>();
        members.push({ planId: plan.id, baseCommit: (await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim() });
      }
      const dependencies = members.slice(1).map((member, index) => ({ producerPlanId: members[index]?.planId, consumerPlanId: member.planId, dependencyType: "hard" }));
      const proposed = await app.inject({ method: "POST", url: "/api/initiatives", payload: { title: "Three repository release", objective: "Deliver contracts, service, and web from one reviewed authority", members, dependencies } });
      expect(proposed.statusCode).toBe(201);
      const initiativeId = proposed.json<{ id: string }>().id;
      const approved = await app.inject({ method: "POST", url: `/api/initiatives/${initiativeId}/approve` });
      expect(approved.json<{ digest: string }>().digest).toMatch(/^[0-9a-f]{64}$/);

      let state = (await app.inject({ method: "POST", url: `/api/initiatives/${initiativeId}/start` })).json<{ status: string; builds: Array<{ id: string; planId: string }> }>();
      expect(state.builds).toHaveLength(1);
      for (const member of members) {
        const build = state.builds.find((candidate) => candidate.planId === member.planId);
        expect(build).toBeDefined();
        context.store.builds.transition(build?.id ?? "", "completed", { eventType: "acceptance.build_completed" });
        state = (await app.inject({ method: "POST", url: `/api/initiatives/${initiativeId}/reconcile` })).json<typeof state>();
      }
      expect(state).toMatchObject({ status: "completed" });
      expect(state.builds).toHaveLength(3);

      for (const build of state.builds) {
        const first = await app.inject({ method: "POST", url: `/api/builds/${build.id}/cleanup`, payload: { deleteMergedBranches: true, retentionHours: 0 } });
        const second = await app.inject({ method: "POST", url: `/api/builds/${build.id}/cleanup`, payload: { deleteMergedBranches: true, retentionHours: 0 } });
        expect(first.statusCode).toBe(200); expect(second.statusCode).toBe(200);
        expect(second.json<{ receipts: unknown[] }>().receipts.length).toBeGreaterThan(0);
      }
      const final = await app.inject({ method: "GET", url: `/api/initiatives/${initiativeId}` });
      expect(final.json()).toMatchObject({ status: "completed", blockers: [] });
      expect(JSON.stringify(final.json())).not.toContain("deployed");
    } finally { await app.close(); }
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `${prefix}-`)); temporaryRoots.add(root); return root;
}

async function fixtureRepository(name: string): Promise<string> {
  const root = await temporaryRoot(`agentflow-${name}`);
  await execFileAsync("git", ["init", "--initial-branch=main", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "AgentFlow Acceptance"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "acceptance@example.test"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: `fixture-${name}`, private: true, scripts: { lint: "node --check src/index.js", typecheck: "node --check src/index.js", test: "node --test", build: "node --check src/index.js" } }, null, 2));
  await writeFile(path.join(root, "src", "index.js"), `export const repository = ${JSON.stringify(name)};\n`);
  await writeFile(path.join(root, "BACKLOG.md"), `# ${name} backlog\n\n## ${name.toUpperCase()}-001 - Deliver ${name}\n\n\`\`\`yaml\nestimate_hours: 1\ndepends_on: []\nowns:\n  - src/\nvalidate:\n  - npm run typecheck\n\`\`\`\n\nDeliver ${name}.\n\n### Acceptance Criteria\n\n- The repository passes typecheck.\n`);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "fixture"]);
  return root;
}
