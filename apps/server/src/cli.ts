#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Command } from "commander";
import {
  ensureRuntimeLayout,
  resolveEnvironment,
} from "./config/environment.js";
import {
  createDatabaseBackup,
  getDatabaseDiagnostics,
  openDatabase,
} from "./db/index.js";
import { GitWorktreeManager } from "./git/index.js";
import { buildApp } from "./http/app.js";

const execFileAsync = promisify(execFile);
const installation = await locateAgentFlowInstallation();
const program = new Command();

program
  .name("agentflow")
  .description("Local-first control plane for parallel Codex engineering")
  .version(installation.version);

program
  .command("serve")
  .description("Start the loopback API and dashboard")
  .action(async () => {
    await import("./index.js");
  });

program
  .command("doctor")
  .description("Check runtime, database, Git, Codex, Docker, and systemd health")
  .action(async () => {
    const environment = resolveEnvironment();
    await ensureRuntimeLayout(environment);
    const database = openDatabase(environment.databasePath);
    try {
      const diagnostics = getDatabaseDiagnostics(database);
      const commands = await Promise.all(
        ["git", "codex", "docker", "systemctl"].map(async (command) => ({
          command,
          available: await commandAvailable(command),
        })),
      );
      const installedContent = await inspectInstalledContent(installation.root);
      printJson({
        ok:
          diagnostics.ok &&
          commands.find(({ command }) => command === "git")?.available ===
            true &&
          installedContent.ok,
        version: installation.version,
        binding: `http://${environment.host}:${environment.port}`,
        home: environment.home,
        database: diagnostics,
        commands,
        installedContent,
        notes: [
          "Codex and Docker are optional until a build requires them.",
          "AgentFlow never binds to an external network interface.",
        ],
      });
    } finally {
      database.close();
    }
  });

const repo = program.command("repo").description("Manage source repositories");

repo
  .command("init")
  .argument("<path>", "absolute Git repository path")
  .description("Initialize .agentflow.yaml without overwriting an existing file")
  .action(async (repositoryPath: string) => {
    printJson(
      await callApi(
        "POST",
        "/api/repositories/initialize",
        { path: repositoryPath },
      ),
    );
  });

repo
  .command("add")
  .argument("<path>", "absolute Git repository path")
  .option("--no-init", "reject a repository missing .agentflow.yaml")
  .description("Register and inspect a repository")
  .action(async (repositoryPath: string, options: { init: boolean }) => {
    printJson(
      await callApi("POST", "/api/repositories", {
        path: repositoryPath,
        initializeIfMissing: options.init,
      }),
    );
  });

repo
  .command("list")
  .description("List registered repositories")
  .action(async () => {
    printJson(await callApi("GET", "/api/repositories"));
  });

repo
  .command("inspect")
  .argument("<repository-id>")
  .description("Re-run repository health and stack inspection")
  .action(async (repositoryId: string) => {
    printJson(
      await callApi(
        "POST",
        `/api/repositories/${encodeURIComponent(repositoryId)}/inspect`,
      ),
    );
  });

repo
  .command("remove")
  .argument("<repository-id>")
  .description("Remove registry metadata only; source is never deleted")
  .action(async (repositoryId: string) => {
    await callApi(
      "DELETE",
      `/api/repositories/${encodeURIComponent(repositoryId)}`,
    );
    process.stdout.write(`Removed repository metadata for ${repositoryId}\n`);
  });

program
  .command("plan")
  .argument("<repository-id>")
  .option("--backlog <path>", "repository-relative backlog path")
  .description("Validate and persist an immutable backlog plan")
  .action(
    async (
      repositoryId: string,
      options: { backlog?: string },
    ) => {
      printJson(
        await callApi("POST", "/api/plans", {
          repositoryId,
          ...(options.backlog === undefined
            ? {}
            : { backlogPath: options.backlog }),
        }),
      );
    },
  );

program
  .command("run")
  .argument("<plan-id>")
  .description("Create and start a build from an immutable plan")
  .action(async (planId: string) => {
    const created = await callApi<{ id: string }>("POST", "/api/builds", {
      planId,
    });
    printJson(
      await callApi(
        "POST",
        `/api/builds/${encodeURIComponent(created.id)}/start`,
      ),
    );
  });

program
  .command("status")
  .description("Show current and historical builds")
  .action(async () => {
    printJson(await callApi("GET", "/api/builds"));
  });

program
  .command("inspect")
  .argument("<build-id>")
  .description("Inspect a build and its task and worker state")
  .action(async (buildId: string) => {
    printJson(
      await callApi("GET", `/api/builds/${encodeURIComponent(buildId)}`),
    );
  });

program
  .command("retry")
  .argument("<build-id>")
  .argument("<task-id>")
  .description("Retry a failed or interrupted task as a new attempt")
  .action(async (buildId: string, taskId: string) => {
    printJson(
      await callApi(
        "POST",
        `/api/builds/${encodeURIComponent(buildId)}/tasks/${encodeURIComponent(taskId)}/retry`,
      ),
    );
  });

const worktrees = program
  .command("worktrees")
  .description("Inspect or safely clean AgentFlow-managed Git worktrees");

worktrees
  .command("list")
  .argument("<build-id>")
  .description("Reconcile the expected integration and task worktrees")
  .action(async (buildId: string) => {
    const { build, manager } = await managerForBuild(buildId);
    printJson(
      await manager.reconcileBuild(
        build.tasks.map((task) => ({
          taskId: task.id,
          ...(task.baseCommit === null ? {} : { baseCommit: task.baseCommit }),
        })),
        build.baseCommit,
      ),
    );
  });

worktrees
  .command("clean")
  .argument("<build-id>")
  .option(
    "--force",
    "allow active-build cleanup and removal of dirty managed worktrees",
  )
  .description("Remove managed worktrees while preserving their branches")
  .action(async (buildId: string, options: { force?: boolean }) => {
    const { build, manager } = await managerForBuild(buildId);
    const force = options.force === true;
    if (
      ["planning", "ready", "running", "paused", "interrupted"].includes(
        build.status,
      ) &&
      !force
    ) {
      throw new Error(
        `Build ${buildId} is ${build.status}; pass --force only after confirming no worker is running`,
      );
    }
    printJson({
      buildId,
      removals: await manager.cleanBuildWorktrees(
        build.tasks.map((task) => task.id),
        force,
      ),
    });
  });

program
  .command("backup")
  .description("Create and integrity-check an online SQLite backup")
  .action(async () => {
    const environment = resolveEnvironment();
    await ensureRuntimeLayout(environment);
    const database = openDatabase(environment.databasePath);
    try {
      printJson(
        await createDatabaseBackup(database, environment.backupsPath),
      );
    } finally {
      database.close();
    }
  });

const service = program
  .command("service")
  .description("Manage the current user's systemd service");

service
  .command("install")
  .description("Install a loopback-only user service")
  .action(async () => {
    const paths = await installUserService();
    await runSystemctl(["daemon-reload"]);
    await runSystemctl(["enable", "agentflow.service"]);
    printJson(paths);
  });

for (const action of ["start", "stop", "status"] as const) {
  service
    .command(action)
    .description(`${capitalize(action)} the AgentFlow user service`)
    .action(async () => {
      const result = await runSystemctl([action, "agentflow.service"]);
      if (result.stdout.length > 0) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr.length > 0) {
        process.stderr.write(result.stderr);
      }
    });
}

program
  .command("upgrade")
  .argument("[package-specifier]", "reviewed npm package, file, or URL to install")
  .description("Upgrade the globally installed AgentFlow npm package")
  .action(async (packageSpecifier?: string) => {
    if (packageSpecifier === undefined) {
      throw new Error(
        "Registry upgrades require a published AgentFlow release. Pass a reviewed local tarball or explicit package specifier; for example: agentflow upgrade /absolute/path/agentflow-0.3.0.tgz",
      );
    }
    await runForeground("npm", ["install", "--global", packageSpecifier]);
  });

program
  .command("uninstall")
  .description("Uninstall the executable while preserving runtime data")
  .action(async () => {
    await removeUserService();
    process.stdout.write(
      "Runtime data and worktrees will be preserved under AGENTFLOW_HOME.\n",
    );
    await runForeground("npm", ["uninstall", "--global", "agentflow"]);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(
    `AgentFlow error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

async function callApi<T = unknown>(
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const { app } = await buildApp({ staticRoot: false, logger: false });
  try {
    const response = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const body: {
        error?: { code?: string; message?: string };
      } = response.json();
      throw new Error(
        `${body.error?.code ?? response.statusCode}: ${body.error?.message ?? response.body}`,
      );
    }
    if (response.statusCode === 204 || response.body.length === 0) {
      return undefined as T;
    }
    return response.json<T>();
  } finally {
    await app.close();
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  for (const entry of pathEntries) {
    if (entry.length === 0) {
      continue;
    }
    try {
      await access(path.join(entry, command), fsConstants.X_OK);
      return true;
    } catch {
      // Continue searching PATH entries.
    }
  }
  return false;
}

async function installUserService(): Promise<{
  unitPath: string;
  environmentPath: string;
}> {
  const environment = resolveEnvironment();
  const configRoot = resolveUserConfigRoot();
  const userConfig = path.join(configRoot, "agentflow");
  const systemdConfig = path.join(configRoot, "systemd");
  const systemdDirectory = path.join(systemdConfig, "user");
  const environmentPath = path.join(userConfig, "environment");
  const unitPath = path.join(systemdDirectory, "agentflow.service");
  await ensureServiceDirectory(userConfig);
  await ensureServiceDirectory(systemdConfig);
  await ensureServiceDirectory(systemdDirectory);
  await writeServiceFileAtomic(
    environmentPath,
    [
      environmentFileAssignment("AGENTFLOW_HOME", environment.home),
      environmentFileAssignment("AGENTFLOW_HOST", environment.host),
      environmentFileAssignment("AGENTFLOW_PORT", String(environment.port)),
      environmentFileAssignment("AGENTFLOW_LOG_LEVEL", environment.logLevel),
      environmentFileAssignment("AGENTFLOW_CODEX_BIN", environment.codexBinary),
      environmentFileAssignment(
        "AGENTFLOW_WORKER_TIMEOUT_MS",
        String(environment.workerTimeoutMs),
      ),
      "",
    ].join("\n"),
    0o600,
  );

  const cliPath = path.resolve(process.argv[1] ?? "agentflow");
  await writeServiceFileAtomic(
    unitPath,
    [
      "[Unit]",
      "Description=AgentFlow local engineering control plane",
      "After=default.target",
      "",
      "[Service]",
      "Type=simple",
      `EnvironmentFile=${systemdQuote(environmentPath)}`,
      `ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(cliPath)} serve`,
      "Restart=on-failure",
      "RestartSec=3",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
    0o644,
  );
  return { unitPath, environmentPath };
}

async function removeUserService(): Promise<void> {
  const configRoot = resolveUserConfigRoot();
  const environmentPath = path.join(configRoot, "agentflow", "environment");
  const unitPath = path.join(configRoot, "systemd", "user", "agentflow.service");
  const unitExists = await fileExists(unitPath);
  if (unitExists) {
    if (!(await commandAvailable("systemctl"))) {
      throw new Error(
        `Refusing to uninstall while ${unitPath} exists because systemctl is unavailable. Stop and disable agentflow.service, then retry.`,
      );
    }
    try {
      await runSystemctl(["disable", "--now", "agentflow.service"]);
    } catch (error) {
      throw new Error(
        "Refusing to remove AgentFlow because the user service could not be stopped and disabled",
        { cause: error },
      );
    }
  }
  await Promise.all([
    unlink(unitPath).catch(ignoreMissingFile),
    unlink(environmentPath).catch(ignoreMissingFile),
  ]);
  if (unitExists && (await commandAvailable("systemctl"))) {
    try {
      await runSystemctl(["daemon-reload"]);
    } catch (error) {
      process.stderr.write(
        `Warning: unable to reload user services: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

async function runSystemctl(
  arguments_: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("systemctl", ["--user", "--no-pager", ...arguments_], {
    encoding: "utf8",
  });
}

async function runForeground(
  command: string,
  arguments_: string[],
): Promise<void> {
  const result = await execFileAsync(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

function resolveUserConfigRoot(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfig !== undefined && xdgConfig.length > 0) {
    if (!path.isAbsolute(xdgConfig)) {
      throw new Error("XDG_CONFIG_HOME must be an absolute path");
    }
    return path.resolve(xdgConfig);
  }
  return path.join(homedir(), ".config");
}

async function ensureServiceDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(
      `Refusing unsafe service configuration directory: ${directory}`,
    );
  }
}

async function writeServiceFileAtomic(
  filename: string,
  contents: string,
  mode: 0o600 | 0o644,
): Promise<void> {
  await assertSafeServiceFileTarget(filename);
  const temporaryPath = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.chmod(mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Re-check immediately before rename. rename replaces a directory entry
    // atomically rather than following a destination symlink.
    await assertSafeServiceFileTarget(filename);
    await rename(temporaryPath, filename);
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(ignoreMissingFile);
  }
}

async function assertSafeServiceFileTarget(filename: string): Promise<void> {
  try {
    const details = await lstat(filename);
    if (details.isSymbolicLink()) {
      throw new Error(`Refusing to replace service symlink: ${filename}`);
    }
    if (!details.isFile()) {
      throw new Error(`Refusing to replace non-file service path: ${filename}`);
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

function environmentFileAssignment(name: string, value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${name} contains a character unsafe for systemd`);
  }
  return `${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemdQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("A systemd unit path contains an unsafe character");
  }
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")}"`;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

interface CliBuild {
  id: string;
  repositoryId: string;
  baseCommit: string;
  status: string;
  tasks: Array<{
    id: string;
    baseCommit: string | null;
  }>;
}

interface CliRepository {
  id: string;
  localPath: string;
}

async function managerForBuild(buildId: string): Promise<{
  build: CliBuild;
  manager: GitWorktreeManager;
}> {
  const build = await callApi<CliBuild>(
    "GET",
    `/api/builds/${encodeURIComponent(buildId)}`,
  );
  const repository = await callApi<CliRepository>(
    "GET",
    `/api/repositories/${encodeURIComponent(build.repositoryId)}`,
  );
  const environment = resolveEnvironment();
  await ensureRuntimeLayout(environment);
  return {
    build,
    manager: await GitWorktreeManager.create({
      repositoryRoot: repository.localPath,
      worktreesRoot: environment.worktreesPath,
      repositoryId: repository.id,
      buildId,
    }),
  };
}

async function locateAgentFlowInstallation(): Promise<{
  root: string;
  version: string;
}> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const metadataPath = path.join(directory, "package.json");
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        metadata.name === "agentflow" &&
        typeof metadata.version === "string"
      ) {
        return { root: directory, version: metadata.version };
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error("Unable to locate the installed AgentFlow package metadata");
}

async function inspectInstalledContent(packageRoot: string): Promise<{
  ok: boolean;
  checks: Array<{
    path: string;
    present: boolean;
    sha256?: string;
    expectedSha256?: string;
    checksumMatches?: boolean;
  }>;
}> {
  const required = [
    "dist/web/index.html",
    "dist/migrations/manifest.json",
    "docs/architecture/SPEC-1-AgentFlow-Local-Agentic-Engineering-Platform.md",
    "docs/implementation/AgentFlow-Codex-Implementation-Prompts.md",
    "examples/.agentflow.yaml",
    "examples/BACKLOG.md",
  ];
  const expectedHashes = new Map([
    [
      "docs/architecture/SPEC-1-AgentFlow-Local-Agentic-Engineering-Platform.md",
      "341dac47141bfcd67a4d373e1bcfd22be4357f9676d7f4cabec86e3d14c19fad",
    ],
    [
      "docs/implementation/AgentFlow-Codex-Implementation-Prompts.md",
      "93114c0040f8bebc0278fe253744193db60fe854908e7447760f42b4bad7c3bd",
    ],
  ]);
  const checks = await Promise.all(
    required.map(async (relativePath) => {
      const absolutePath = path.join(packageRoot, relativePath);
      const present = await fileExists(absolutePath);
      const expectedSha256 = expectedHashes.get(relativePath);
      if (!present || expectedSha256 === undefined) {
        return { path: relativePath, present };
      }
      const sha256 = createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex");
      return {
        path: relativePath,
        present,
        sha256,
        expectedSha256,
        checksumMatches: sha256 === expectedSha256,
      };
    }),
  );
  return {
    ok: checks.every(
      ({ present, checksumMatches }) =>
        present && checksumMatches !== false,
    ),
    checks,
  };
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function ignoreMissingFile(error: unknown): void {
  if (!isMissingFile(error)) {
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
