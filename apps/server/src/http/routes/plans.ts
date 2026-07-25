import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PlanResult } from "../../domain/types.js";
import { GitCommandRunner } from "../../git/index.js";
import { AgentFlowError } from "../errors.js";
import type { AgentFlowContext } from "../context.js";
import {
  loadRepositoryConfig,
} from "../../repositories/index.js";
import { planBacklogMarkdown } from "../../planning/index.js";
import { createId, nowIso } from "../../util/ids.js";

const CreatePlanBody = z.object({
  repositoryId: z.string().min(1),
  backlogPath: z.string().trim().min(1).optional(),
  workerEfficiency: z.number().positive().max(1).optional(),
  overheadPercent: z.number().min(0).max(500).optional(),
});

const PlanIdParameters = z.object({
  id: z.string().min(1),
});

const GenerateBacklogBody = z
  .object({
    mode: z.enum(["objective", "auto"]),
    objective: z.string().trim().min(10).max(4_000).optional(),
    backlogPath: z.string().trim().min(1).optional(),
  })
  .superRefine((input, context) => {
    if (input.mode === "objective" && input.objective === undefined) {
      context.addIssue({
        code: "custom",
        path: ["objective"],
        message: "An objective is required in guided mode",
      });
    }
  });

const execFileAsync = promisify(execFile);
const MAX_CODEX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function registerPlanRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.post("/api/repositories/:id/backlog/generate", async (request) => {
    const { id } = PlanIdParameters.parse(request.params);
    const input = GenerateBacklogBody.parse(request.body);
    const repository = await context.repositoryService.get(id);
    const config = await loadRepositoryConfig(repository.localPath);
    const relativeBacklogPath = input.backlogPath ?? config.backlog.path;
    const backlogPath = resolveRepositoryPath(
      repository.localPath,
      relativeBacklogPath,
    );
    const git = new GitCommandRunner();
    const before = await git.run(repository.localPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (before.stdout.trim().length > 0) {
      throw new AgentFlowError(
        "REPOSITORY_NOT_CLEAN",
        "Backlog generation requires a clean registered checkout",
        409,
        before.stdout.trim().split("\n"),
      );
    }

    const prompt = backlogGenerationPrompt(
      relativeBacklogPath,
      input.mode,
      input.objective,
    );
    let output: { stdout: string; stderr: string };
    try {
      output = await execFileAsync(
        context.environment.codexBinary,
        [
          "exec",
          "--cd",
          repository.localPath,
          "--sandbox",
          "workspace-write",
          "--ephemeral",
          prompt,
        ],
        {
          encoding: "utf8",
          maxBuffer: MAX_CODEX_OUTPUT_BYTES,
          timeout: context.environment.workerTimeoutMs,
          windowsHide: true,
        },
      );
    } catch (cause) {
      throw new AgentFlowError(
        "BACKLOG_GENERATION_FAILED",
        "Codex could not generate the backlog",
        502,
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    await access(backlogPath).catch(() => {
      throw new AgentFlowError(
        "BACKLOG_NOT_CREATED",
        `Codex completed without creating ${relativeBacklogPath}`,
        502,
      );
    });
    const after = await git.run(repository.localPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    const changedPaths = statusPaths(after.stdout);
    const unexpectedPaths = changedPaths.filter(
      (changedPath) => changedPath !== relativeBacklogPath,
    );
    if (unexpectedPaths.length > 0) {
      throw new AgentFlowError(
        "BACKLOG_SCOPE_VIOLATION",
        "Codex changed files outside the requested backlog",
        409,
        { backlogPath: relativeBacklogPath, unexpectedPaths },
      );
    }

    return {
      repositoryId: repository.id,
      backlogPath: relativeBacklogPath,
      mode: input.mode,
      changed: changedPaths.includes(relativeBacklogPath),
      summary: output.stdout.trim(),
      warnings: output.stderr.trim(),
      nextAction:
        "Review and commit the backlog, then validate it to create an immutable plan.",
    };
  });

  app.post("/api/plans", async (request, reply) => {
    const input = CreatePlanBody.parse(request.body);
    const repository = await context.repositoryService.get(input.repositoryId);
    const config = await loadRepositoryConfig(repository.localPath);
    const relativeBacklogPath = input.backlogPath ?? config.backlog.path;
    const backlogPath = await resolveRepositoryFile(
      repository.localPath,
      relativeBacklogPath,
    );
    const markdown = await readFile(backlogPath, "utf8");
    const planning = planBacklogMarkdown(markdown, {
      defaultValidation: config.validation.task_default,
      workerMaximum: config.workers.maximum,
      ...(input.workerEfficiency === undefined
        ? {}
        : { workerEfficiency: input.workerEfficiency }),
      ...(input.overheadPercent === undefined
        ? {}
        : { overheadPercent: input.overheadPercent }),
    });

    if (!planning.valid || planning.plan === undefined) {
      throw new AgentFlowError(
        "BACKLOG_INVALID",
        "The backlog did not pass AgentFlow preflight",
        422,
        planning.errors,
      );
    }

    const id = createId("plan");
    const createdAt = nowIso();
    const backlogSha256 = createHash("sha256").update(markdown).digest("hex");
    const normalizedPlan: PlanResult = {
      id,
      repositoryId: repository.id,
      backlogPath: relativeBacklogPath,
      backlogSha256,
      ...planning.plan,
      createdAt,
    };
    const stored = context.store.plans.create({
      id,
      repositoryId: repository.id,
      backlogPath: relativeBacklogPath,
      backlogSha256,
      backlogContents: markdown,
      repositoryConfig: config,
      normalizedPlan,
      createdAt,
    });
    await reply.status(201).send(stored.normalizedPlan);
  });

  app.get("/api/plans/:id", async (request) => {
    const { id } = PlanIdParameters.parse(request.params);
    return context.store.plans.getById(id).normalizedPlan;
  });
}

function resolveRepositoryPath(
  repositoryRoot: string,
  relativePath: string,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new AgentFlowError(
      "INVALID_REPOSITORY_PATH",
      "Backlog paths must be relative to the registered repository",
    );
  }
  const candidate = path.resolve(repositoryRoot, relativePath);
  const relative = path.relative(repositoryRoot, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new AgentFlowError(
      "INVALID_REPOSITORY_PATH",
      "Backlog path escapes the registered repository",
    );
  }
  return candidate;
}

async function resolveRepositoryFile(
  repositoryRoot: string,
  relativePath: string,
): Promise<string> {
  const candidate = resolveRepositoryPath(repositoryRoot, relativePath);
  const canonical = await realpath(candidate);
  const canonicalRelative = path.relative(repositoryRoot, canonical);
  if (
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new AgentFlowError(
      "INVALID_REPOSITORY_PATH",
      "Backlog symlink escapes the registered repository",
    );
  }
  return canonical;
}

function statusPaths(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 4)
    .map((line) => {
      const value = line.slice(3);
      const renameSeparator = " -> ";
      return value.includes(renameSeparator)
        ? (value.split(renameSeparator).at(-1) ?? value)
        : value;
    });
}

function backlogGenerationPrompt(
  backlogPath: string,
  mode: "objective" | "auto",
  objective?: string,
): string {
  const selection =
    mode === "auto"
      ? [
          "Choose the highest-value next program using repository evidence.",
          "Inspect product documentation, architecture, existing backlogs and queues, tests, TODOs, incomplete flows, and recent Git history.",
          "Consider at least three candidates internally, then choose based on user impact, explicit repository intent, dependency-unblocking value, readiness, and risk.",
          "Do not invent market demand, repeat completed work, or prioritize cosmetic cleanup over documented capability gaps.",
          "In the final summary, name the selected program, alternatives considered, and evidence supporting the choice.",
        ].join(" ")
      : `Objective: ${objective ?? ""}`;
  return [
    `Create or replace ${backlogPath} for AgentFlow.`,
    selection,
    `Inspect this repository before designing the work. Edit only ${backlogPath}.`,
    "Do not implement tasks, change source code, commit, push, or start AgentFlow.",
    "Every task heading must be exactly: ## TASK-ID - Imperative task title",
    "Immediately after each heading, add a yaml fence with estimate_hours, depends_on, owns, and validate.",
    "Use produces and consumes when tasks exchange versioned artifacts.",
    "After the fence, write a concrete description and a ### Acceptance Criteria section with measurable bullets.",
    "All dependencies must exist in this backlog and the graph must be acyclic.",
    "Parallel tasks must have non-overlapping ownership paths.",
    "Contract and schema work must precede providers and consumers.",
    "Use validation commands that actually exist in this repository.",
    "Prefer small independently verifiable tasks and preserve repository authority, security, privacy, and accessibility boundaries.",
    "Return a short evidence-based summary after writing the file.",
  ].join("\n\n");
}
