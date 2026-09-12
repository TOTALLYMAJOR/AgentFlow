import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { assessRepository, writeBacklogWorksheet } from "../src/onboarding/repository.js";
import { runGit } from "../src/repositories/git.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agentflow-onboarding-")); roots.push(root);
  await runGit(root, ["init", "-b", "main"]);
  await runGit(root, ["config", "user.name", "Test"]);
  await runGit(root, ["config", "user.email", "test@example.test"]);
  return root;
}
it("guides an unborn repo, creates config once, and preserves user changes", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "notes.txt"), "keep me");
  expect((await assessRepository(root)).issues.map(i => i.code)).toContain("CONFIG_MISSING");
  const first = await assessRepository(root, true);
  expect(first.created).toEqual([".agentflow.yaml"]);
  expect(first.issues.map(i => i.code)).toEqual(expect.arrayContaining(["NO_COMMIT", "BACKLOG_MISSING", "REPOSITORY_NOT_CLEAN"]));
  const config = await readFile(path.join(root, ".agentflow.yaml"), "utf8");
  expect((await assessRepository(root, true)).created).toEqual([]);
  expect(await readFile(path.join(root, ".agentflow.yaml"), "utf8")).toBe(config);
  expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("keep me");
});
it("distinguishes missing, invalid, uncommitted and ready backlogs", async () => {
  const root = await fixture();
  await assessRepository(root, true);
  await runGit(root, ["add", "."]); await runGit(root, ["commit", "-m", "setup"]);
  expect((await assessRepository(root)).nextAction).toContain("backlog generate");
  await writeFile(path.join(root, "BACKLOG.md"), "# Not tasks\n");
  expect((await assessRepository(root)).backlog.valid).toBe(false);
  await writeFile(path.join(root, "BACKLOG.md"), '## DOC-1 - Document setup\n\n```yaml\nestimate_hours: 1\ndepends_on: []\nowns: [README.md]\nvalidate: ["git diff --check"]\n```\n\nDocument the workflow.\n\n### Acceptance Criteria\n\n- README explains setup.\n');
  expect((await assessRepository(root)).ready).toBe(false);
  await runGit(root, ["add", "."]); await runGit(root, ["commit", "-m", "backlog"]);
  expect((await assessRepository(root)).ready).toBe(true);
});
it("does not follow backlog symlinks or overwrite worksheets", async () => {
  const root = await fixture(); await assessRepository(root, true);
  await symlink(".agentflow.yaml", path.join(root, "BACKLOG.md"));
  expect((await assessRepository(root)).issues.map(i => i.code)).toContain("BACKLOG_UNREADABLE");
  await writeBacklogWorksheet(root);
  await expect(writeBacklogWorksheet(root)).rejects.toThrow();
});
it("honors custom backlog paths and preserves invalid configuration", async () => {
  const root = await fixture(); await assessRepository(root, true);
  const configPath = path.join(root, ".agentflow.yaml");
  const config = (await readFile(configPath, "utf8")).replace("BACKLOG.md", "WORK.md");
  await writeFile(configPath, config);
  expect((await assessRepository(root)).backlog.path).toBe("WORK.md");
  await writeFile(configPath, "version: broken\n");
  expect((await assessRepository(root, true)).issues.map(i => i.code)).toContain("CONFIG_INVALID");
  expect(await readFile(configPath, "utf8")).toBe("version: broken\n");
});
