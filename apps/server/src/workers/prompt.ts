import type {
  WorkerContextDocument,
  WorkerPromptContext,
} from "./types.js";

const DEFAULT_MAXIMUM_PROMPT_BYTES = 1024 * 1024;

export const PROHIBITED_WORKER_ACTIONS = [
  "Commit, push, merge, rebase, tag, or otherwise alter Git history.",
  "Create, remove, move, or repair Git worktrees.",
  "Modify AgentFlow state, runtime files, databases, logs, or orchestration metadata.",
  "Modify the backlog or task plan.",
  "Change files outside the explicitly owned paths.",
  "Control Docker, Docker Compose, or the Docker daemon directly.",
] as const;

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function renderList(items: readonly string[]): string {
  return items.length === 0
    ? "- None supplied."
    : items.map((item) => `- ${item}`).join("\n");
}

function renderDocuments(documents: readonly WorkerContextDocument[]): string {
  if (documents.length === 0) {
    return "[]";
  }

  return JSON.stringify(
    documents.map((document) => ({
      name: document.name,
      ...(document.version === undefined
        ? {}
        : { version: document.version }),
      ...(document.sourcePath === undefined
        ? {}
        : { sourcePath: document.sourcePath }),
      ...(document.sha256 === undefined ? {} : { sha256: document.sha256 }),
      content: document.content,
    })),
    null,
    2,
  );
}

export function buildWorkerPrompt(
  context: WorkerPromptContext,
  maximumBytes = DEFAULT_MAXIMUM_PROMPT_BYTES,
): string {
  if (!Number.isSafeInteger(context.attempt) || context.attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1024) {
    throw new Error("maximum prompt size must be at least 1024 bytes");
  }

  const taskId = requireNonEmpty(context.task.id, "task ID");
  const title = requireNonEmpty(context.task.title, "task title");
  const buildId = requireNonEmpty(context.buildId, "build ID");
  const ownedPaths = context.task.ownedPaths.map((ownedPath, index) =>
    requireNonEmpty(ownedPath, `owned path ${index + 1}`),
  );
  if (ownedPaths.length === 0) {
    throw new Error("at least one owned path is required");
  }

  const prompt = `You are an isolated implementation worker in an AgentFlow build.

SCOPE AND AUTHORITY
You may edit only the current task worktree and only the declared owned paths.
AgentFlow, not you, owns Git history, worktrees, validation, Docker execution, integration, publication, and durable run state.
Treat the supplied plan, contracts, artifacts, examples, and dependency manifests as immutable task context.

BUILD
Build ID: ${buildId}
Attempt: ${context.attempt}

TASK
ID: ${taskId}
Title: ${title}

DESCRIPTION
${context.task.description.trim() || "No description supplied."}

ACCEPTANCE CRITERIA
${renderList(context.task.acceptanceCriteria)}

OWNED PATHS
${renderList(ownedPaths)}

DECLARED VALIDATION COMMANDS
These are immutable plan data and will be run independently by AgentFlow. You may run useful non-Docker checks while implementing.
${renderList(context.task.validationCommands)}

REPOSITORY INSTRUCTIONS
${context.repositoryInstructions.trim() || "No additional repository instructions supplied."}

PREVIOUS ATTEMPT FAILURE
${context.previousAttempt === undefined ? "None." : renderDocuments([context.previousAttempt])}

INTEGRATED DEPENDENCY MANIFESTS
${renderDocuments(context.dependencyManifests)}

CONSUMED CONTRACTS
${renderDocuments(context.consumedContracts)}

CONSUMED ARTIFACTS
${renderDocuments(context.consumedArtifacts)}

EXAMPLE PAYLOADS
${renderDocuments(context.examplePayloads)}

PROHIBITED ACTIONS
${PROHIBITED_WORKER_ACTIONS.map((action) => `- ${action}`).join("\n")}

DELIVERY CONTRACT
- Implement the task completely and keep the change focused.
- Do not claim validation or acceptance evidence you did not actually observe.
- Do not include secrets, credentials, or private keys in output.
- Your final response must be one JSON object matching the supplied result schema.
- Use status "completed" only when your implementation work is complete.
- Use status "blocked" when an external dependency or missing authority prevents completion.
- Use status "failed" when the implementation attempt cannot be completed safely.
`;

  const size = Buffer.byteLength(prompt, "utf8");
  if (size > maximumBytes) {
    throw new Error(
      `worker prompt is ${size} bytes, exceeding the ${maximumBytes}-byte limit`,
    );
  }
  return prompt;
}
