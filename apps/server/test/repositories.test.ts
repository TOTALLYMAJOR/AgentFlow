import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { RepositoryRepository } from "../src/db/repository-repository.js";
import {
  adaptRepositoryPersistence,
  AgentFlowRepositoryConfigSchema,
  createRepositoryConfigFile,
  MemoryRepositoryPersistence,
  repositoryConfigPath,
  RepositoryService,
  type AgentFlowRepositoryConfig,
} from "../src/repositories/index.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map(async (root) => {
      await rm(root, { recursive: true, force: true });
      temporaryRoots.delete(root);
    }),
  );
});

describe("RepositoryService", () => {
  it("keeps the synchronous SQLite registry behind the injected persistence port", () => {
    const adaptSqliteRegistry = (store: RepositoryRepository) =>
      adaptRepositoryPersistence(store);

    expect(adaptSqliteRegistry).toBeTypeOf("function");
  });

  it("registers and inspects three canonical repositories with detected stacks", async () => {
    const npmRepository = await createFixtureRepository("npm-vite", {
      packageJson: {
        name: "npm-vite",
        private: true,
        workspaces: ["apps/*"],
        scripts: {
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          test: "vitest run",
          build: "vite build",
        },
        dependencies: {
          react: "19.0.0",
        },
        devDependencies: {
          "@playwright/test": "1.0.0",
          vite: "7.0.0",
        },
      },
      lockfile: "package-lock.json",
      directories: ["apps/web", "apps/server", "contracts"],
      files: {
        "apps/web/package.json": JSON.stringify({
          name: "web",
          dependencies: { react: "19.0.0", vite: "7.0.0" },
        }),
        "apps/server/package.json": JSON.stringify({
          name: "server",
          dependencies: { fastify: "5.0.0" },
        }),
        "compose.yaml": "services: {}\n",
        "playwright.config.ts": "export default {};\n",
      },
    });
    const pnpmRepository = await createFixtureRepository("pnpm-next", {
      packageJson: {
        name: "pnpm-next",
        packageManager: "pnpm@10.0.0",
        scripts: {
          lint: "next lint",
          test: "vitest run",
          build: "next build",
        },
        dependencies: {
          next: "15.0.0",
          react: "19.0.0",
        },
      },
      lockfile: "pnpm-lock.yaml",
      directories: ["web"],
    });
    const yarnRepository = await createFixtureRepository("yarn-api", {
      packageJson: {
        name: "yarn-api",
        packageManager: "yarn@4.0.0",
        scripts: {
          typecheck: "tsc --noEmit",
          test: "vitest run",
        },
        dependencies: {
          fastify: "5.0.0",
        },
      },
      lockfile: "yarn.lock",
      directories: ["api", "packages/contracts"],
    });

    const persistence = new MemoryRepositoryPersistence();
    const service = new RepositoryService(persistence);
    const npmRecord = await service.register(
      path.join(npmRepository, "apps", "web"),
    );
    const pnpmRecord = await service.register(pnpmRepository);
    const yarnRecord = await service.register(yarnRepository);

    expect(await service.list()).toHaveLength(3);
    expect(npmRecord.localPath).toBe(npmRepository);
    expect(npmRecord.detectedStack).toMatchObject({
      packageManager: "npm",
      frameworks: ["Vite", "React", "Playwright"],
      composeFile: "compose.yaml",
      monorepo: true,
      frontendRoots: ["apps/web"],
      backendRoots: ["apps/server"],
      contractRoots: ["contracts"],
      suggestedValidation: [
        "npm run lint",
        "npm run typecheck",
        "npm test",
        "npm run build",
      ],
    });
    expect(pnpmRecord.detectedStack).toMatchObject({
      packageManager: "pnpm",
      frameworks: ["Next.js", "React"],
      frontendRoots: ["web"],
    });
    expect(yarnRecord.detectedStack).toMatchObject({
      packageManager: "yarn",
      backendRoots: ["api"],
      contractRoots: ["packages/contracts"],
    });

    const inspection = await service.inspect(npmRecord.id);
    expect(inspection.status).toBe("ready");
    expect(inspection.checks).toEqual({
      pathExists: true,
      directory: true,
      accessible: true,
      gitRepository: true,
      configPresent: true,
      configValid: true,
      baseBranchExists: true,
    });
  });

  it("rejects a missing path", async () => {
    const parent = await createTemporaryRoot("missing");
    const missing = path.join(parent, "does-not-exist");
    const service = new RepositoryService(
      new MemoryRepositoryPersistence(),
    );

    await expect(service.register(missing)).rejects.toMatchObject({
      code: "REPOSITORY_PATH_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("rejects an existing non-Git directory", async () => {
    const directory = await createTemporaryRoot("not-git");
    await writeFile(path.join(directory, "README.md"), "not a repository\n");
    const service = new RepositoryService(
      new MemoryRepositoryPersistence(),
    );

    await expect(service.register(directory)).rejects.toMatchObject({
      code: "REPOSITORY_NOT_GIT_REPOSITORY",
    });
  });

  it("rejects an invalid or unsafe .agentflow.yaml", async () => {
    const repository = await createFixtureRepository("invalid-config");
    await writeFile(
      repositoryConfigPath(repository),
      [
        "version: 1",
        "repository:",
        "  name: invalid-config",
        "  base_branch: main",
        "backlog:",
        "  path: ../outside.md",
        "workers:",
        "  maximum: 5",
        "contracts:",
        "  roots: []",
        "validation:",
        "  task_default: []",
        "  integration: []",
        "docker:",
        "  enabled: false",
        "  compose_file: compose.yaml",
        "git:",
        "  remote: origin",
        "  push_task_branches: false",
        "  push_integration_branch: false",
        "unexpected: true",
        "",
      ].join("\n"),
    );
    const service = new RepositoryService(
      new MemoryRepositoryPersistence(),
    );

    await expect(
      service.register(repository, { initializeIfMissing: false }),
    ).rejects.toMatchObject({
      code: "REPOSITORY_CONFIG_INVALID",
    });
  });

  it("rejects a configured base branch that does not exist", async () => {
    const repository = await createFixtureRepository("missing-base", {
      baseBranch: "develop",
    });
    const service = new RepositoryService(
      new MemoryRepositoryPersistence(),
    );

    await expect(service.register(repository)).rejects.toMatchObject({
      code: "REPOSITORY_BASE_BRANCH_MISSING",
    });
  });

  it("initializes .agentflow.yaml atomically and never overwrites it", async () => {
    const repository = await createFixtureRepository("initialize", {
      config: false,
      packageJson: {
        name: "initialize",
        scripts: {
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          test: "vitest run",
          build: "vite build",
        },
        devDependencies: {
          vite: "7.0.0",
        },
      },
      lockfile: "package-lock.json",
    });
    const service = new RepositoryService(
      new MemoryRepositoryPersistence(),
    );

    const first = await service.initialize(repository);
    const firstSource = await readFile(first.configPath, "utf8");
    const second = await service.initialize(repository);
    const secondSource = await readFile(second.configPath, "utf8");
    const metadata = await stat(first.configPath);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(secondSource).toBe(firstSource);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(first.config.validation).toEqual({
      task_default: ["npm run lint", "npm run typecheck"],
      integration: [
        "npm run lint",
        "npm run typecheck",
        "npm test",
        "npm run build",
      ],
    });
  });

  it("removes registry metadata without deleting or modifying source", async () => {
    const repository = await createFixtureRepository("removal-safety", {
      files: {
        "src/irreplaceable.ts": "export const sourceStillExists = true;\n",
      },
    });
    const sourcePath = path.join(repository, "src", "irreplaceable.ts");
    const before = await readFile(sourcePath, "utf8");
    const service = new RepositoryService(
      new MemoryRepositoryPersistence(),
    );
    const record = await service.register(repository);

    await service.remove(record.id);

    await expect(service.get(record.id)).rejects.toMatchObject({
      code: "REPOSITORY_NOT_FOUND",
    });
    expect(await readFile(sourcePath, "utf8")).toBe(before);
    expect((await stat(path.join(repository, ".git"))).isDirectory()).toBe(
      true,
    );
  });
});

describe("AgentFlowRepositoryConfigSchema", () => {
  it("accepts the prompt contract and rejects unknown keys", () => {
    const config = validConfig("schema");
    expect(AgentFlowRepositoryConfigSchema.parse(config)).toEqual(config);
    expect(() =>
      AgentFlowRepositoryConfigSchema.parse({
        ...config,
        misspelled_validation: {},
      }),
    ).toThrow();
  });
});

interface FixtureOptions {
  baseBranch?: string;
  config?: boolean;
  packageJson?: Record<string, unknown>;
  lockfile?: string;
  directories?: string[];
  files?: Record<string, string>;
}

async function createFixtureRepository(
  name: string,
  options: FixtureOptions = {},
): Promise<string> {
  const parent = await createTemporaryRoot(name);
  const repository = path.join(parent, "repository");
  await mkdir(repository);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "AgentFlow Test"]);
  await git(repository, ["config", "user.email", "agentflow@example.invalid"]);

  for (const directory of options.directories ?? []) {
    await mkdir(path.join(repository, directory), { recursive: true });
  }
  for (const [relativePath, source] of Object.entries(options.files ?? {})) {
    const target = path.join(repository, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  if (options.packageJson !== undefined) {
    await writeFile(
      path.join(repository, "package.json"),
      `${JSON.stringify(options.packageJson, null, 2)}\n`,
    );
  }
  if (options.lockfile !== undefined) {
    await writeFile(path.join(repository, options.lockfile), "{}\n");
  }
  if (options.config !== false) {
    await createRepositoryConfigFile(
      repository,
      validConfig(name, options.baseBranch ?? "main"),
    );
  }
  await writeFile(path.join(repository, "README.md"), `# ${name}\n`);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "test fixture"]);
  return repository;
}

function validConfig(
  name: string,
  baseBranch = "main",
): AgentFlowRepositoryConfig {
  return {
    version: 1,
    repository: {
      name,
      base_branch: baseBranch,
    },
    backlog: {
      path: "BACKLOG.md",
    },
    workers: {
      maximum: 4,
    },
    contracts: {
      roots: ["contracts/", "packages/contracts/"],
    },
    validation: {
      task_default: ["npm run lint", "npm run typecheck"],
      integration: [
        "npm run lint",
        "npm run typecheck",
        "npm test",
        "npm run build",
      ],
    },
    docker: {
      enabled: true,
      compose_file: "compose.yaml",
    },
    git: {
      remote: "origin",
      push_task_branches: false,
      push_integration_branch: false,
      open_integration_pull_request: false,
    },
  };
}

async function createTemporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `agentflow-${label}-`));
  temporaryRoots.add(root);
  return root;
}

async function git(
  repository: string,
  arguments_: string[],
): Promise<void> {
  await execFileAsync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
  });
}
