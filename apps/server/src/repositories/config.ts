import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";
import { z } from "zod";

import { RepositoryServiceError } from "./errors.js";

export const REPOSITORY_CONFIG_FILENAME = ".agentflow.yaml";

const nonEmptyLine = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) => !value.includes("\0") && !/[\r\n]/u.test(value),
    "must be a single line without NUL characters",
  );

const repositoryRelativePath = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !path.posix.isAbsolute(value.replaceAll("\\", "/")) &&
      !/^[A-Za-z]:[\\/]/u.test(value),
    "must be a repository-relative path",
  )
  .refine(
    (value) =>
      !value
        .replaceAll("\\", "/")
        .split("/")
        .some((segment) => segment === ".."),
    "must not escape the repository",
  );

const repositoryName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u,
    "must start with a letter or number and contain only safe name characters",
  );

const gitName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !value.includes("\0") &&
      !/[\s~^:?*[\]\\]/u.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith(".lock"),
    "must be a safe Git branch or remote name",
  );

const command = nonEmptyLine;

const RepositorySectionSchema = z
  .object({
    name: repositoryName,
    base_branch: gitName,
  })
  .strict();

const BacklogSectionSchema = z
  .object({
    path: repositoryRelativePath,
  })
  .strict();

const WorkersSectionSchema = z
  .object({
    maximum: z.number().int().min(1).max(4),
  })
  .strict();

const ContractsSectionSchema = z
  .object({
    roots: z.array(repositoryRelativePath).max(64),
  })
  .strict();

const ValidationSectionSchema = z
  .object({
    task_default: z.array(command).min(1).max(64),
    integration: z.array(command).min(1).max(64),
  })
  .strict();

const DockerSectionSchema = z
  .object({
    enabled: z.boolean(),
    compose_file: repositoryRelativePath,
  })
  .strict();

const GitSectionSchema = z
  .object({
    remote: gitName,
    push_task_branches: z.boolean(),
    push_integration_branch: z.boolean(),
    open_integration_pull_request: z.boolean().default(false),
  })
  .strict();

export const AgentFlowRepositoryConfigSchema = z
  .object({
    version: z.literal(1),
    repository: RepositorySectionSchema,
    backlog: BacklogSectionSchema,
    workers: WorkersSectionSchema,
    contracts: ContractsSectionSchema,
    validation: ValidationSectionSchema,
    docker: DockerSectionSchema,
    git: GitSectionSchema,
  })
  .strict();

export type AgentFlowRepositoryConfig = z.infer<
  typeof AgentFlowRepositoryConfigSchema
>;

export function repositoryConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, REPOSITORY_CONFIG_FILENAME);
}

export async function loadRepositoryConfig(
  repositoryRoot: string,
): Promise<AgentFlowRepositoryConfig> {
  const configPath = repositoryConfigPath(repositoryRoot);
  let source: string;

  try {
    const metadata = await lstat(configPath);
    if (!metadata.isFile()) {
      throw new RepositoryServiceError(
        "REPOSITORY_CONFIG_INVALID",
        `${configPath} is not a regular file`,
        400,
      );
    }
    await access(configPath, fsConstants.R_OK);
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof RepositoryServiceError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new RepositoryServiceError(
        "REPOSITORY_CONFIG_MISSING",
        `${configPath} does not exist`,
        400,
      );
    }
    throw new RepositoryServiceError(
      "REPOSITORY_CONFIG_UNREADABLE",
      `The current user cannot read ${configPath}`,
      403,
      errorMessage(error),
    );
  }

  let untyped: unknown;
  try {
    untyped = parse(source, {
      merge: false,
      prettyErrors: true,
      strict: true,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new RepositoryServiceError(
      "REPOSITORY_CONFIG_INVALID",
      `${configPath} is not valid YAML`,
      400,
      errorMessage(error),
    );
  }

  const parsed = AgentFlowRepositoryConfigSchema.safeParse(untyped);
  if (!parsed.success) {
    throw new RepositoryServiceError(
      "REPOSITORY_CONFIG_INVALID",
      `${configPath} does not match AgentFlow configuration version 1`,
      400,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export async function createRepositoryConfigFile(
  repositoryRoot: string,
  config: AgentFlowRepositoryConfig,
): Promise<"created" | "exists"> {
  const validated = AgentFlowRepositoryConfigSchema.parse(config);
  const configPath = repositoryConfigPath(repositoryRoot);

  await assertPathInsideRepository(repositoryRoot, configPath);

  let handle;
  try {
    handle = await open(configPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return "exists";
    }
    throw new RepositoryServiceError(
      "REPOSITORY_CONFIG_INITIALIZATION_FAILED",
      `Could not create ${configPath}`,
      isNodeError(error) &&
        typeof error.code === "string" &&
        ["EACCES", "EPERM"].includes(error.code)
        ? 403
        : 400,
      errorMessage(error),
    );
  }

  try {
    await handle.writeFile(
      stringify(validated, {
        indent: 2,
        lineWidth: 0,
      }),
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return "created";
}

async function assertPathInsideRepository(
  repositoryRoot: string,
  candidatePath: string,
): Promise<void> {
  const canonicalRoot = await realpath(repositoryRoot);
  const relative = path.relative(canonicalRoot, path.resolve(candidatePath));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new RepositoryServiceError(
      "REPOSITORY_PATH_ESCAPE",
      `${candidatePath} is outside the repository`,
      400,
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
