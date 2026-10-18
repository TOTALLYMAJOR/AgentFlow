import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { RepositoryService } from "../repositories/service.js";
import { MemoryRepositoryPersistence } from "../repositories/memory-persistence.js";
import { resolveGitRepositoryRoot, runGit } from "../repositories/git.js";
import { planBacklogMarkdown } from "../planning/planner.js";

/** Local preflight never starts a coordinator or executes repository commands. */
export async function assessRepository(input: string, prepare = false) {
  const root = await resolveGitRepositoryRoot(path.resolve(input));
  const service = new RepositoryService(new MemoryRepositoryPersistence());
  let inspection = await service.inspectLocal(root);
  const created: string[] = [];
  if (prepare && !inspection.checks.configPresent) {
    const initialized = await service.initialize(root);
    if (initialized.created) created.push(".agentflow.yaml");
    inspection = await service.inspectLocal(root);
  }
  const issues: Array<{ code: string; message: string }> = inspection.issues.map(({ code, message }) => ({ code, message }));
  const config = inspection.config;
  let backlog = { path: config?.backlog.path ?? "BACKLOG.md", present: false, valid: false, tasks: 0 };
  if (config !== undefined) {
    const filename = path.resolve(root, config.backlog.path);
    try {
      const canonical = await realpath(filename);
      const relative = path.relative(root, canonical);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || !(await lstat(filename)).isFile()) {
        throw new Error("Backlog must be a regular file inside this repository");
      }
      const result = planBacklogMarkdown(await readFile(filename, "utf8"), {
        defaultValidation: config.validation.task_default,
        workerMaximum: config.workers.maximum,
      });
      backlog = { ...backlog, present: true, valid: result.valid, tasks: result.tasks.length };
      issues.push(...result.errors.map(({ code, message }) => ({ code, message })));
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      issues.push({ code: missing ? "BACKLOG_MISSING" : "BACKLOG_UNREADABLE", message: missing ? `Create ${config.backlog.path} manually or use agentflow backlog generate.` : String(error) });
    }
  }
  let hasCommit = true;
  try { await runGit(root, ["rev-parse", "--verify", "HEAD"]); }
  catch { hasCommit = false; issues.push({ code: "NO_COMMIT", message: "Create the repository's initial commit before planning." }); }
  if (hasCommit && config !== undefined) {
    for (const file of [".agentflow.yaml", ...(backlog.present ? [backlog.path] : [])]) {
      try { await runGit(root, ["ls-files", "--error-unmatch", "--", file]); }
      catch { issues.push({ code: "INPUT_NOT_TRACKED", message: `${file} must be reviewed and committed, including when ignored by Git.` }); }
    }
    try {
      const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
      const base = (await runGit(root, ["rev-parse", `refs/heads/${config.repository.base_branch}^{commit}`])).stdout.trim();
      if (head !== base) issues.push({ code: "BASE_NOT_CURRENT", message: `Checkout differs from configured base ${config.repository.base_branch}. Reconcile the intended base before planning.` });
    } catch {
      issues.push({ code: "LOCAL_BASE_MISSING", message: `Create or check out the configured local base branch ${config.repository.base_branch} before planning.` });
    }
  }
  const dirty = (await runGit(root, ["status", "--porcelain", "--untracked-files=all"])).stdout.length > 0;
  if (dirty) issues.push({ code: "REPOSITORY_NOT_CLEAN", message: "Review and commit intended changes, or explicitly create a separate worktree. Nothing was stashed or committed." });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const next = !inspection.checks.configPresent
    ? `agentflow setup ${quote(root)} --prepare`
    : inspection.issues.length > 0 ? "Repair the configuration issues, then rerun setup."
    : !hasCommit || dirty || issues.some(issue => issue.code === "INPUT_NOT_TRACKED") ? `Review changes in ${root}, commit the intended files, then rerun setup.`
    : !backlog.present ? `agentflow repo add ${quote(root)} --no-init; then agentflow backlog generate <repository-id> --objective 'Describe your intended outcome'`
    : !backlog.valid ? `Repair ${backlog.path} using the reported errors, then rerun setup.`
    : issues.length > 0 ? "Resolve the reported repository issues, then rerun setup."
    : `agentflow start ${quote(root)}`;
  return { localPath: root, ready: issues.length === 0, created, backlog, issues, nextAction: next };
}

/** An intentionally non-executable worksheet; never invent product work. */
export async function writeBacklogWorksheet(root: string) {
  const filename = path.join(root, "BACKLOG.draft.md");
  await writeFile(filename, [
    "# Backlog preparation worksheet", "",
    "This is not an executable AgentFlow backlog. Fill this in, then translate each bounded task into the grammar in examples/BACKLOG.md.", "",
    "- Intended outcome:", "- Repository evidence and relevant instructions:",
    "- In-scope files and excluded work:", "- Dependencies:",
    "- Measurable acceptance criteria:", "- Existing validation commands:",
    "- Recovery / rollback:", "",
  ].join("\n"), { flag: "wx" });
  return filename;
}
