import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

import type { BuildEntity } from "../db/index.js";
import type { RepositoryRecord } from "../domain/types.js";
import { loadRepositoryConfig } from "./config.js";
import { runGit } from "./git.js";

export interface RepositoryTargetBlocker {
  code: string;
  message: string;
  recovery: string;
}

export interface RepositoryTarget {
  repositoryId: string;
  name: string;
  path: string;
  baseBranch: string;
  currentBranch: string | null;
  head: string | null;
  clean: boolean;
  upstream: { ahead: number; behind: number } | null;
  backlog: { path: string | null; present: boolean; tracked: boolean };
  designIntelligence: { configured: boolean; status: "available" | "not_configured" };
  activeBuild: { id: string; status: string } | null;
  eligible: boolean;
  blockers: RepositoryTargetBlocker[];
  warnings: RepositoryTargetBlocker[];
  stateFingerprint: string;
  checkedAt: string;
}

export async function inspectRepositoryTarget(
  repository: RepositoryRecord,
  activeBuild: BuildEntity | undefined,
  checkedAt = new Date().toISOString(),
): Promise<RepositoryTarget> {
  const blockers: RepositoryTargetBlocker[] = [];
  const warnings: RepositoryTargetBlocker[] = [];
  let head: string | null = null;
  let currentBranch: string | null = null;
  let clean = false;
  let upstream: RepositoryTarget["upstream"] = null;
  let backlogPath: string | null = null;
  let backlogPresent = false;
  let backlogTracked = false;

  if (repository.status !== "ready") {
    blockers.push({ code: "REPOSITORY_NOT_READY", message: `Repository status is ${repository.status}.`, recovery: "Inspect the repository and resolve its reported configuration or access issues." });
  }

  try {
    head = (await runGit(repository.localPath, ["rev-parse", "HEAD"])).stdout.trim();
    currentBranch = await runGit(repository.localPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((result) => result.stdout.trim()).catch(() => null);
    const status = (await runGit(repository.localPath, ["status", "--porcelain", "--untracked-files=all"])).stdout.trim();
    clean = status.length === 0;
    if (!clean) blockers.push({ code: "WORKTREE_DIRTY", message: "The registered checkout has uncommitted or untracked work.", recovery: "Commit the intended baseline or use a separate clean checkout; do not discard unrelated work." });
    upstream = await readUpstreamDivergence(repository.localPath);
  } catch {
    blockers.push({ code: "GIT_STATE_UNAVAILABLE", message: "Current Git state could not be read.", recovery: "Restore repository access and inspect the registered path." });
  }

  try {
    const config = await loadRepositoryConfig(repository.localPath);
    backlogPath = config.backlog.path;
    backlogPresent = await exists(path.join(repository.localPath, backlogPath));
    backlogTracked = backlogPresent && await runGit(repository.localPath, ["ls-files", "--error-unmatch", "--", backlogPath]).then(() => true).catch(() => false);
    if (!backlogPresent) warnings.push({ code: "BACKLOG_MISSING", message: `${backlogPath} does not exist yet.`, recovery: "Generate or create a reviewed backlog before planning." });
    else if (!backlogTracked) warnings.push({ code: "BACKLOG_UNCOMMITTED", message: `${backlogPath} is not committed.`, recovery: "Review and commit the backlog before planning." });
  } catch {
    blockers.push({ code: "CONFIG_UNAVAILABLE", message: "The AgentFlow repository configuration could not be loaded.", recovery: "Repair .agentflow.yaml and inspect the repository again." });
  }

  if (activeBuild !== undefined) blockers.push({ code: "ACTIVE_BUILD_EXISTS", message: `Build ${activeBuild.id} is ${activeBuild.status}.`, recovery: "Complete, cancel, or otherwise resolve the active build before starting another for this repository." });
  const designIntelligenceConfigured = await exists(path.join(repository.localPath, "devctl.yaml")) || await exists(path.join(repository.localPath, ".design"));
  const fingerprintPayload = { repositoryId: repository.id, head, currentBranch, clean, upstream, backlogPath, backlogPresent, backlogTracked, status: repository.status, activeBuildId: activeBuild?.id ?? null, designIntelligenceConfigured };

  return {
    repositoryId: repository.id,
    name: repository.name,
    path: repository.localPath,
    baseBranch: repository.baseBranch,
    currentBranch,
    head,
    clean,
    upstream,
    backlog: { path: backlogPath, present: backlogPresent, tracked: backlogTracked },
    designIntelligence: { configured: designIntelligenceConfigured, status: designIntelligenceConfigured ? "available" : "not_configured" },
    activeBuild: activeBuild === undefined ? null : { id: activeBuild.id, status: activeBuild.status },
    eligible: blockers.length === 0,
    blockers,
    warnings,
    stateFingerprint: createHash("sha256").update(JSON.stringify(fingerprintPayload)).digest("hex"),
    checkedAt,
  };
}

async function readUpstreamDivergence(repositoryRoot: string): Promise<RepositoryTarget["upstream"]> {
  try {
    const output = (await runGit(repositoryRoot, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).stdout.trim();
    const [aheadText, behindText] = output.split(/\s+/);
    const ahead = Number(aheadText);
    const behind = Number(behindText);
    return Number.isSafeInteger(ahead) && Number.isSafeInteger(behind) ? { ahead, behind } : null;
  } catch {
    return null;
  }
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true).catch(() => false);
}
