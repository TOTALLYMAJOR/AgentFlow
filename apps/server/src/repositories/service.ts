import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import type {
  DetectedStack,
  RepositoryRecord,
} from "../domain/types.js";
import { createId, nowIso } from "../util/ids.js";

import {
  createRepositoryConfigFile,
  loadRepositoryConfig,
  repositoryConfigPath,
  type AgentFlowRepositoryConfig,
} from "./config.js";
import {
  errorFromRepositoryIssue,
  RepositoryServiceError,
} from "./errors.js";
import {
  canonicalizeDirectory,
  detectDefaultBranch,
  gitBranchExists,
  resolveGitRepositoryRoot,
} from "./git.js";
import { detectRepositoryStack } from "./stack-detector.js";
import type {
  InitializeRepositoryResult,
  LocalRepositoryInspection,
  RegisterRepositoryOptions,
  RegisteredRepositoryInspection,
  RepositoryHealthChecks,
  RepositoryIssue,
  RepositoryIssueCode,
  RepositoryPersistence,
} from "./types.js";

const EMPTY_STACK: DetectedStack = {
  scripts: [],
  frameworks: [],
  monorepo: false,
  frontendRoots: [],
  backendRoots: [],
  contractRoots: [],
  suggestedValidation: [],
};

export class RepositoryService {
  public constructor(
    private readonly persistence: RepositoryPersistence,
  ) {}

  public async initialize(
    localPath: string,
  ): Promise<InitializeRepositoryResult> {
    const repositoryRoot = await resolveGitRepositoryRoot(localPath);
    await assertCurrentUserCanInspect(repositoryRoot, true);

    const configPath = repositoryConfigPath(repositoryRoot);
    const existing = await pathKind(configPath);
    if (existing !== "missing") {
      const config = await loadRepositoryConfig(repositoryRoot);
      return {
        localPath: repositoryRoot,
        configPath,
        created: false,
        config,
      };
    }

    const detectedStack = await detectRepositoryStack(repositoryRoot);
    const baseBranch = await detectDefaultBranch(repositoryRoot);
    const config = defaultRepositoryConfig(
      repositoryRoot,
      baseBranch,
      detectedStack,
    );
    const result = await createRepositoryConfigFile(repositoryRoot, config);
    return {
      localPath: repositoryRoot,
      configPath,
      created: result === "created",
      config:
        result === "created"
          ? config
          : await loadRepositoryConfig(repositoryRoot),
    };
  }

  public async register(
    localPath: string,
    options: RegisterRepositoryOptions = {},
  ): Promise<RepositoryRecord> {
    const initializeIfMissing = options.initializeIfMissing ?? true;
    let canonicalPath: string;
    try {
      canonicalPath = await resolveGitRepositoryRoot(localPath);
    } catch (error) {
      throw normalizeRepositoryError(error);
    }

    if ((await this.persistence.getByLocalPath(canonicalPath)) !== null) {
      throw new RepositoryServiceError(
        "REPOSITORY_ALREADY_REGISTERED",
        `Repository ${canonicalPath} is already registered`,
        409,
      );
    }

    if (
      initializeIfMissing &&
      (await pathKind(repositoryConfigPath(canonicalPath))) === "missing"
    ) {
      await this.initialize(canonicalPath);
    }

    const inspection = await this.inspectLocal(canonicalPath);
    if (inspection.status !== "ready" || inspection.config === undefined) {
      const issue = inspection.issues[0];
      if (issue === undefined) {
        throw new RepositoryServiceError(
          "REPOSITORY_INVALID",
          `Repository ${canonicalPath} is not ready`,
        );
      }
      throw errorFromRepositoryIssue(issue);
    }

    const timestamp = nowIso();
    const record: RepositoryRecord = {
      id: createId("repo"),
      name: inspection.config.repository.name,
      localPath: inspection.localPath,
      configPath: inspection.configPath,
      baseBranch: inspection.config.repository.base_branch,
      remoteName: inspection.config.git.remote,
      status: "ready",
      detectedStack: inspection.detectedStack,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.persistence.create(record);
  }

  public list(): Promise<RepositoryRecord[]> {
    return this.persistence.list();
  }

  public async get(id: string): Promise<RepositoryRecord> {
    const repository = await this.persistence.getById(id);
    if (repository === null) {
      throw new RepositoryServiceError(
        "REPOSITORY_NOT_FOUND",
        `Repository ${id} is not registered`,
        404,
      );
    }
    return repository;
  }

  public async inspect(
    id: string,
  ): Promise<RegisteredRepositoryInspection> {
    const existing = await this.get(id);
    const inspection = await this.inspectLocal(existing.localPath);
    const config = inspection.config;
    const updated: RepositoryRecord = {
      ...existing,
      ...(config === undefined
        ? {}
        : {
            name: config.repository.name,
            baseBranch: config.repository.base_branch,
            remoteName: config.git.remote,
          }),
      localPath: inspection.localPath,
      configPath: inspection.configPath,
      status: inspection.status,
      detectedStack: inspection.detectedStack,
      updatedAt: nowIso(),
    };
    const repository = await this.persistence.update(updated);
    return {
      ...inspection,
      repository,
    };
  }

  /**
   * Removal is deliberately metadata-only. There is no source-directory path
   * passed to a filesystem deletion API anywhere in this operation.
   */
  public async remove(id: string): Promise<void> {
    await this.get(id);
    const removed = await this.persistence.deleteById(id);
    if (!removed) {
      throw new RepositoryServiceError(
        "REPOSITORY_NOT_FOUND",
        `Repository ${id} is not registered`,
        404,
      );
    }
  }

  public async inspectLocal(
    localPath: string,
  ): Promise<LocalRepositoryInspection> {
    const checks = emptyChecks();
    const issues: RepositoryIssue[] = [];
    let canonicalPath = path.resolve(localPath);

    try {
      canonicalPath = await canonicalizeDirectory(localPath);
      checks.pathExists = true;
      checks.directory = true;
      await assertCurrentUserCanInspect(canonicalPath, false);
      checks.accessible = true;
    } catch (error) {
      const issue = issueFromError(error);
      if (issue.code === "PATH_NOT_DIRECTORY") {
        checks.pathExists = true;
      }
      issues.push(issue);
      return inspectionResult(
        canonicalPath,
        checks,
        issues,
        EMPTY_STACK,
      );
    }

    try {
      canonicalPath = await resolveGitRepositoryRoot(canonicalPath);
      checks.gitRepository = true;
    } catch (error) {
      issues.push(issueFromError(error));
      return inspectionResult(
        canonicalPath,
        checks,
        issues,
        EMPTY_STACK,
      );
    }

    const configPath = repositoryConfigPath(canonicalPath);
    let config: AgentFlowRepositoryConfig | undefined;
    const configKind = await pathKind(configPath);
    checks.configPresent = configKind !== "missing";
    if (!checks.configPresent) {
      issues.push({
        code: "CONFIG_MISSING",
        message: `${configPath} does not exist`,
      });
    } else {
      try {
        config = await loadRepositoryConfig(canonicalPath);
        checks.configValid = true;
      } catch (error) {
        issues.push(issueFromError(error));
      }
    }

    let detectedStack = EMPTY_STACK;
    try {
      detectedStack = await detectRepositoryStack(
        canonicalPath,
        config?.contracts.roots ?? [],
        config?.docker.compose_file,
      );
    } catch (error) {
      issues.push({
        code: "STACK_INSPECTION_FAILED",
        message: `Could not inspect the stack in ${canonicalPath}`,
        details: errorMessage(error),
      });
    }

    if (config !== undefined) {
      try {
        checks.baseBranchExists = await gitBranchExists(
          canonicalPath,
          config.repository.base_branch,
          config.git.remote,
        );
        if (!checks.baseBranchExists) {
          issues.push({
            code: "BASE_BRANCH_MISSING",
            message: `Configured base branch ${config.repository.base_branch} does not exist in ${canonicalPath}`,
            details: {
              baseBranch: config.repository.base_branch,
              remote: config.git.remote,
            },
          });
        }
      } catch (error) {
        issues.push(issueFromError(error));
      }
    }

    return inspectionResult(
      canonicalPath,
      checks,
      issues,
      detectedStack,
      config,
    );
  }
}

export function defaultRepositoryConfig(
  repositoryRoot: string,
  baseBranch: string,
  detectedStack: DetectedStack,
): AgentFlowRepositoryConfig {
  const suggested = detectedStack.suggestedValidation;
  const taskValidation =
    suggested.filter(
      (command) =>
        command.includes("lint") || command.includes("typecheck"),
    ).length > 0
      ? suggested.filter(
          (command) =>
            command.includes("lint") || command.includes("typecheck"),
        )
      : suggested.slice(0, 2);
  const safeTaskValidation =
    taskValidation.length > 0 ? taskValidation : ["git diff --check"];
  const integrationValidation =
    suggested.length > 0
      ? suggested
      : ["git diff --check"];
  const contractRoots =
    detectedStack.contractRoots.length > 0
      ? detectedStack.contractRoots.map(withTrailingSlash)
      : ["contracts/", "packages/contracts/"];

  return {
    version: 1,
    repository: {
      name: safeRepositoryName(path.basename(repositoryRoot)),
      base_branch: baseBranch,
    },
    backlog: {
      path: "BACKLOG.md",
    },
    workers: {
      maximum: 4,
    },
    contracts: {
      roots: contractRoots,
    },
    validation: {
      task_default: safeTaskValidation,
      integration: integrationValidation,
    },
    docker: {
      enabled: detectedStack.composeFile !== undefined,
      compose_file: detectedStack.composeFile ?? "compose.yaml",
    },
    git: {
      remote: "origin",
      push_task_branches: false,
      push_integration_branch: false,
      open_integration_pull_request: false,
    },
  };
}

async function assertCurrentUserCanInspect(
  repositoryRoot: string,
  requireWrite: boolean,
): Promise<void> {
  const mode =
    fsConstants.R_OK |
    fsConstants.X_OK |
    (requireWrite ? fsConstants.W_OK : 0);
  try {
    await access(repositoryRoot, mode);
  } catch (error) {
    throw new RepositoryServiceError(
      "REPOSITORY_PATH_NOT_ACCESSIBLE",
      `The current user cannot ${requireWrite ? "initialize" : "inspect"} ${repositoryRoot}`,
      403,
      errorMessage(error),
    );
  }
}

function inspectionResult(
  localPath: string,
  checks: RepositoryHealthChecks,
  issues: RepositoryIssue[],
  detectedStack: DetectedStack,
  config?: AgentFlowRepositoryConfig,
): LocalRepositoryInspection {
  const status =
    issues.length === 0
      ? "ready"
      : issues.some((issue) =>
          ["PATH_NOT_FOUND", "PATH_NOT_ACCESSIBLE"].includes(issue.code),
        )
        ? "unavailable"
        : "invalid";
  return {
    localPath,
    configPath: repositoryConfigPath(localPath),
    status,
    checks,
    issues,
    detectedStack,
    ...(config === undefined ? {} : { config }),
  };
}

function issueFromError(error: unknown): RepositoryIssue {
  if (error instanceof RepositoryServiceError) {
    const code = repositoryIssueCode(error.code);
    return {
      code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: "PATH_NOT_ACCESSIBLE",
    message: "The current user cannot inspect the repository",
    details: errorMessage(error),
  };
}

function repositoryIssueCode(code: string): RepositoryIssueCode {
  const mappings: Record<string, RepositoryIssueCode> = {
    REPOSITORY_PATH_NOT_FOUND: "PATH_NOT_FOUND",
    REPOSITORY_PATH_NOT_DIRECTORY: "PATH_NOT_DIRECTORY",
    REPOSITORY_PATH_NOT_ACCESSIBLE: "PATH_NOT_ACCESSIBLE",
    REPOSITORY_NOT_GIT_REPOSITORY: "NOT_GIT_REPOSITORY",
    REPOSITORY_NOT_GIT_WORKTREE: "NOT_GIT_WORKTREE",
    REPOSITORY_CONFIG_MISSING: "CONFIG_MISSING",
    REPOSITORY_CONFIG_UNREADABLE: "CONFIG_INVALID",
    REPOSITORY_CONFIG_INVALID: "CONFIG_INVALID",
  };
  return mappings[code] ?? "CONFIG_INVALID";
}

function normalizeRepositoryError(error: unknown): RepositoryServiceError {
  if (error instanceof RepositoryServiceError) {
    return error;
  }
  return new RepositoryServiceError(
    "REPOSITORY_INSPECTION_FAILED",
    "AgentFlow could not inspect the repository",
    400,
    errorMessage(error),
  );
}

function emptyChecks(): RepositoryHealthChecks {
  return {
    pathExists: false,
    directory: false,
    accessible: false,
    gitRepository: false,
    configPresent: false,
    configValid: false,
    baseBranchExists: false,
  };
}

async function pathKind(
  candidate: string,
): Promise<"file" | "other" | "missing"> {
  try {
    return (await stat(candidate)).isFile() ? "file" : "other";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "missing";
    }
    throw new RepositoryServiceError(
      "REPOSITORY_PATH_NOT_ACCESSIBLE",
      `The current user cannot inspect ${candidate}`,
      403,
      errorMessage(error),
    );
  }
}

function safeRepositoryName(name: string): string {
  const safe = name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .slice(0, 128);
  return safe.length > 0 ? safe : "repository";
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
