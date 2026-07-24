import type {
  DetectedStack,
  RepositoryRecord,
} from "../domain/types.js";

import type { AgentFlowRepositoryConfig } from "./config.js";

/**
 * The repository service owns repository inspection and safety. Persistence
 * implementations only store and retrieve registry metadata.
 */
export interface RepositoryPersistence {
  create(record: RepositoryRecord): Promise<RepositoryRecord>;
  list(): Promise<RepositoryRecord[]>;
  getById(id: string): Promise<RepositoryRecord | null>;
  getByLocalPath(localPath: string): Promise<RepositoryRecord | null>;
  update(record: RepositoryRecord): Promise<RepositoryRecord>;
  deleteById(id: string): Promise<boolean>;
}

export type RepositoryIssueCode =
  | "PATH_NOT_FOUND"
  | "PATH_NOT_DIRECTORY"
  | "PATH_NOT_ACCESSIBLE"
  | "NOT_GIT_REPOSITORY"
  | "NOT_GIT_WORKTREE"
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "BASE_BRANCH_MISSING"
  | "STACK_INSPECTION_FAILED";

export interface RepositoryIssue {
  code: RepositoryIssueCode;
  message: string;
  details?: unknown;
}

export interface RepositoryHealthChecks {
  pathExists: boolean;
  directory: boolean;
  accessible: boolean;
  gitRepository: boolean;
  configPresent: boolean;
  configValid: boolean;
  baseBranchExists: boolean;
}

export interface LocalRepositoryInspection {
  localPath: string;
  configPath: string;
  status: RepositoryRecord["status"];
  checks: RepositoryHealthChecks;
  issues: RepositoryIssue[];
  detectedStack: DetectedStack;
  config?: AgentFlowRepositoryConfig;
}

export interface RegisteredRepositoryInspection
  extends LocalRepositoryInspection {
  repository: RepositoryRecord;
}

export interface RegisterRepositoryOptions {
  /**
   * `repo add` can initialize the contract in a repository that does not have
   * one yet. Set this to false for a read-only registration attempt.
   */
  initializeIfMissing?: boolean;
}

export interface InitializeRepositoryResult {
  localPath: string;
  configPath: string;
  created: boolean;
  config: AgentFlowRepositoryConfig;
}
