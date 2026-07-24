import { AgentFlowError } from "../http/errors.js";

import type { RepositoryIssue } from "./types.js";

export class RepositoryServiceError extends AgentFlowError {
  public constructor(
    code: string,
    message: string,
    statusCode = 400,
    details?: unknown,
  ) {
    super(code, message, statusCode, details);
    this.name = "RepositoryServiceError";
  }
}

export function errorFromRepositoryIssue(
  issue: RepositoryIssue,
): RepositoryServiceError {
  const statusCode =
    issue.code === "PATH_NOT_FOUND"
      ? 404
      : issue.code === "PATH_NOT_ACCESSIBLE"
        ? 403
        : 400;

  return new RepositoryServiceError(
    `REPOSITORY_${issue.code}`,
    issue.message,
    statusCode,
    issue.details,
  );
}
