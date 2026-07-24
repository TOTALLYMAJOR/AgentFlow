#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
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
import { buildApp } from "./http/app.js";

const execFileAsync = promisify(execFile);
const program = new Command();

program
  .name("agentflow")
  .description("Local-first control plane for parallel Codex engineering")
  .version("0.3.0");

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
      printJson({
        ok:
          diagnostics.ok &&
          commands.find(({ command }) => command === "git")?.available === true,
        binding: `http://${environment.host}:${environment.port}`,
        home: environment.home,
        database: diagnostics,
        commands,
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
  .description("Upgrade the globally installed AgentFlow npm package")
  .action(async () => {
    await runForeground("npm", ["install", "--global", "agentflow@latest"]);
  });

program
  .command("uninstall")
  .description("Uninstall the executable while preserving runtime data")
  .action(async () => {
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
      await access(path.join(entry, command));
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
  const userConfig = path.join(homedir(), ".config", "agentflow");
  const systemdDirectory = path.join(homedir(), ".config", "systemd", "user");
  const environmentPath = path.join(userConfig, "environment");
  const unitPath = path.join(systemdDirectory, "agentflow.service");
  await Promise.all([
    mkdir(userConfig, { recursive: true, mode: 0o700 }),
    mkdir(systemdDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(
    environmentPath,
    [
      `AGENTFLOW_HOME=${systemdEscapeEnvironment(environment.home)}`,
      `AGENTFLOW_HOST=${environment.host}`,
      `AGENTFLOW_PORT=${environment.port}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(environmentPath, 0o600);

  const cliPath = path.resolve(process.argv[1] ?? "agentflow");
  await writeFile(
    unitPath,
    [
      "[Unit]",
      "Description=AgentFlow local engineering control plane",
      "After=default.target",
      "",
      "[Service]",
      "Type=simple",
      `EnvironmentFile=${systemdEscapeUnit(environmentPath)}`,
      `ExecStart=${systemdEscapeUnit(process.execPath)} ${systemdEscapeUnit(cliPath)} serve`,
      "Restart=on-failure",
      "RestartSec=3",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o644 },
  );
  return { unitPath, environmentPath };
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

function systemdEscapeEnvironment(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "");
}

function systemdEscapeUnit(value: string): string {
  return value.replaceAll("%", "%%").replaceAll(" ", "\\x20");
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

// Keep a tiny read dependency here so packagers retain docs referenced by the
// CLI's installed help without executing or mutating them.
void readFile;
