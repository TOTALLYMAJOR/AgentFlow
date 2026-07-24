import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import net from "node:net";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const smokeRoot = await mkdtemp(path.join(tmpdir(), "agentflow-install-smoke-"));
const prefix = path.join(smokeRoot, "prefix");
const runtime = path.join(smokeRoot, "runtime");
const configRoot = path.join(smokeRoot, "config");
const fakeBin = path.join(smokeRoot, "fake-bin");
const systemctlLog = path.join(smokeRoot, "systemctl.log");
const localPack = path.join(smokeRoot, "pack");
let serverProcess;

try {
  await Promise.all([
    mkdir(prefix),
    mkdir(runtime),
    mkdir(configRoot),
    mkdir(fakeBin),
    mkdir(localPack),
  ]);
  const tarball =
    options.tarball === undefined
      ? await buildTemporaryTarball(localPack)
      : path.resolve(options.tarball);
  await access(tarball);

  await run("npm", [
    "install",
    "--global",
    "--prefix",
    prefix,
    tarball,
  ]);
  const executable = path.join(prefix, "bin", "agentflow");
  await access(executable);
  const globalModulesRoot = (
    await run("npm", ["root", "--global", "--prefix", prefix])
  ).stdout.trim();
  const packageRoot = path.join(globalModulesRoot, "agentflow");
  await verifyInstalledPackage(packageRoot);

  const fakeSystemctl = path.join(fakeBin, "systemctl");
  await writeFile(
    fakeSystemctl,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$AGENTFLOW_SMOKE_SYSTEMCTL_LOG"',
      'if [ "${AGENTFLOW_SMOKE_FAIL_SYSTEMCTL_ACTION:-}" = "$3" ]; then',
      '  printf "%s\\n" "simulated systemctl $3 failure" >&2',
      "  exit 42",
      "fi",
      'if [ "$3" = "status" ]; then',
      '  printf "%s\\n" "AgentFlow smoke service status"',
      "fi",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  await chmod(fakeSystemctl, 0o755);

  const cliEnvironment = {
    ...process.env,
    AGENTFLOW_HOME: runtime,
    AGENTFLOW_HOST: "127.0.0.1",
    AGENTFLOW_LOG_LEVEL: "silent",
    AGENTFLOW_SMOKE_SYSTEMCTL_LOG: systemctlLog,
    NPM_CONFIG_PREFIX: prefix,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  const version = (await run(executable, ["--version"], undefined, cliEnvironment))
    .stdout
    .trim();
  const packageMetadata = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (version !== packageMetadata.version) {
    throw new Error(
      `Installed CLI version ${version} does not match package ${packageMetadata.version}`,
    );
  }

  const help = (
    await run(executable, ["--help"], undefined, cliEnvironment)
  ).stdout;
  for (const command of [
    "serve",
    "doctor",
    "repo",
    "plan",
    "run",
    "status",
    "inspect",
    "retry",
    "worktrees",
    "service",
    "backup",
    "upgrade",
    "uninstall",
  ]) {
    if (!new RegExp(`\\b${command}\\b`).test(help)) {
      throw new Error(`Installed CLI help is missing ${command}`);
    }
  }
  const nestedHelp = new Map([
    ["repo", ["add", "list", "inspect", "init"]],
    ["service", ["install", "start", "stop", "status"]],
    ["worktrees", ["list", "clean"]],
  ]);
  for (const [command, subcommands] of nestedHelp) {
    const output = (
      await run(executable, [command, "--help"], undefined, cliEnvironment)
    ).stdout;
    for (const subcommand of subcommands) {
      if (!new RegExp(`\\b${subcommand}\\b`).test(output)) {
        throw new Error(
          `Installed CLI help is missing ${command} ${subcommand}`,
        );
      }
    }
  }

  const doctor = JSON.parse(
    (await run(executable, ["doctor"], undefined, cliEnvironment)).stdout,
  );
  if (doctor.ok !== true || doctor.installedContent?.ok !== true) {
    throw new Error(`Installed doctor failed: ${JSON.stringify(doctor)}`);
  }
  if (doctor.binding !== "http://127.0.0.1:4782") {
    throw new Error(`Doctor reported an unsafe binding: ${doctor.binding}`);
  }

  const serviceInstall = JSON.parse(
    (
      await run(
        executable,
        ["service", "install"],
        undefined,
        cliEnvironment,
      )
    ).stdout,
  );
  await verifyUserService(serviceInstall, prefix);

  // Existing files must be replaced with exact safe modes, rather than
  // retaining permissive modes from a previous or damaged installation.
  await Promise.all([
    chmod(serviceInstall.unitPath, 0o666),
    chmod(serviceInstall.environmentPath, 0o666),
  ]);
  const modeCorrectedServiceInstall = JSON.parse(
    (
      await run(
        executable,
        ["service", "install"],
        undefined,
        cliEnvironment,
      )
    ).stdout,
  );
  await verifyUserService(modeCorrectedServiceInstall, prefix);

  // Service installation must never follow a pre-existing destination
  // symlink. Check both the environment and unit targets, then restore them.
  const symlinkSentinel = path.join(smokeRoot, "service-symlink-sentinel");
  await writeFile(symlinkSentinel, "preserve-me\n", "utf8");
  await unlink(serviceInstall.environmentPath);
  await symlink(symlinkSentinel, serviceInstall.environmentPath);
  await expectCommandFailure(
    executable,
    ["service", "install"],
    cliEnvironment,
    "Refusing to replace service symlink",
  );
  await assertSentinelPreserved(symlinkSentinel);
  await unlink(serviceInstall.environmentPath);

  await unlink(serviceInstall.unitPath);
  await symlink(symlinkSentinel, serviceInstall.unitPath);
  await expectCommandFailure(
    executable,
    ["service", "install"],
    cliEnvironment,
    "Refusing to replace service symlink",
  );
  await assertSentinelPreserved(symlinkSentinel);
  await unlink(serviceInstall.unitPath);

  const hardenedServiceInstall = JSON.parse(
    (
      await run(
        executable,
        ["service", "install"],
        undefined,
        cliEnvironment,
      )
    ).stdout,
  );
  await verifyUserService(hardenedServiceInstall, prefix);
  await run(executable, ["service", "start"], undefined, cliEnvironment);
  await run(executable, ["service", "status"], undefined, cliEnvironment);
  await run(executable, ["service", "stop"], undefined, cliEnvironment);

  const port = await findAvailablePort();
  serverProcess = spawn(executable, ["serve"], {
    env: {
      ...cliEnvironment,
      AGENTFLOW_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverOutput = collectOutput(serverProcess);
  const health = await pollJson(`http://127.0.0.1:${port}/api/health`);
  if (health.status !== "ok") {
    throw new Error(`Installed server health failed: ${JSON.stringify(health)}`);
  }
  const dashboardResponse = await globalThis.fetch(
    `http://127.0.0.1:${port}/`,
  );
  const dashboard = await dashboardResponse.text();
  if (!dashboardResponse.ok || !dashboard.toLowerCase().includes("<!doctype html>")) {
    throw new Error("Installed server did not serve the built dashboard");
  }
  serverProcess.kill("SIGTERM");
  const serverExit = await waitForExit(serverProcess, 10_000);
  if (
    (serverExit.code !== null && serverExit.code !== 0) ||
    (serverExit.signal !== null && serverExit.signal !== "SIGTERM") ||
    (serverExit.code === null && serverExit.signal === null)
  ) {
    throw new Error(
      `Installed server exited unexpectedly: ${JSON.stringify({
        ...serverExit,
        output: serverOutput(),
      })}`,
    );
  }
  serverProcess = undefined;

  await expectCommandFailure(
    executable,
    ["upgrade"],
    cliEnvironment,
    "Registry upgrades require a published AgentFlow release",
  );

  // Reinstall the reviewed local tarball. This validates explicit package
  // selection, not registry independence or a cross-version migration.
  await run(
    executable,
    ["upgrade", tarball],
    undefined,
    cliEnvironment,
  );
  await access(executable);

  // A stop/disable failure must preserve both the executable and service files.
  await expectCommandFailure(
    executable,
    ["uninstall"],
    {
      ...cliEnvironment,
      AGENTFLOW_SMOKE_FAIL_SYSTEMCTL_ACTION: "disable",
    },
    "user service could not be stopped and disabled",
  );
  await Promise.all([
    access(executable),
    access(serviceInstall.unitPath),
    access(serviceInstall.environmentPath),
  ]);

  await run(executable, ["uninstall"], undefined, cliEnvironment);
  if (await exists(executable)) {
    throw new Error("Isolated uninstall left the AgentFlow executable behind");
  }
  if (!(await exists(path.join(runtime, "agentflow.db")))) {
    throw new Error("Uninstall removed AgentFlow runtime data");
  }
  if (
    (await exists(
      path.join(configRoot, "systemd", "user", "agentflow.service"),
    )) ||
    (await exists(path.join(configRoot, "agentflow", "environment")))
  ) {
    throw new Error("Uninstall left stale systemd user-service files");
  }

  const systemctlCalls = await readFile(systemctlLog, "utf8");
  for (const expected of [
    "--user --no-pager daemon-reload",
    "--user --no-pager enable agentflow.service",
    "--user --no-pager start agentflow.service",
    "--user --no-pager status agentflow.service",
    "--user --no-pager stop agentflow.service",
    "--user --no-pager disable --now agentflow.service",
  ]) {
    if (!systemctlCalls.includes(expected)) {
      throw new Error(`Missing systemctl call: ${expected}`);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        version,
        node: process.version,
        isolatedPrefix: true,
        doctor: true,
        dashboard: true,
        userService: true,
        serviceFileHardening: true,
        registryUpgradeGuard: true,
        localTarballReinstall: true,
        uninstallFailsClosed: true,
        uninstallPreservedRuntime: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (serverProcess !== undefined && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await waitForExit(serverProcess, 5_000).catch(() => {
      serverProcess?.kill("SIGKILL");
    });
  }
  if (!options.keep) {
    await rm(smokeRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Smoke-test files preserved at ${smokeRoot}\n`);
  }
}

function parseArguments(arguments_) {
  const result = { tarball: undefined, keep: false };
  for (const argument of arguments_) {
    if (argument === "--keep") {
      result.keep = true;
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: npm run smoke:install -- [agentflow-<version>.tgz] [--keep]\n",
      );
      process.exit(0);
    }
    if (result.tarball !== undefined) {
      throw new Error(`Unexpected smoke-test argument: ${argument}`);
    }
    result.tarball = argument;
  }
  return result;
}

async function expectCommandFailure(
  command,
  arguments_,
  environment,
  expectedMessage,
) {
  try {
    await run(command, arguments_, undefined, environment);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expectedMessage)) {
      throw new Error(
        `Command failed without ${JSON.stringify(expectedMessage)}: ${message}`,
        { cause: error },
      );
    }
    return;
  }
  throw new Error(`${command} ${arguments_.join(" ")} unexpectedly succeeded`);
}

async function assertSentinelPreserved(filename) {
  if ((await readFile(filename, "utf8")) !== "preserve-me\n") {
    throw new Error("Service installation modified a symlink target");
  }
}

async function buildTemporaryTarball(destination) {
  await run("npm", ["pack", "--json", "--pack-destination", destination], root);
  const candidates = (await readdir(destination)).filter((entry) =>
    entry.endsWith(".tgz"),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one temporary npm tarball, found ${candidates.length}`,
    );
  }
  return path.join(destination, candidates[0]);
}

async function verifyInstalledPackage(packageRoot) {
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
  for (const [relativePath, expectedHash] of expectedHashes) {
    const actualHash = await sha256File(path.join(packageRoot, relativePath));
    if (actualHash !== expectedHash) {
      throw new Error(
        `Installed ${relativePath} hash ${actualHash} does not match the supplied artifact`,
      );
    }
  }
  for (const relativePath of [
    "dist/cli.js",
    "dist/index.js",
    "dist/web/index.html",
    "examples/.agentflow.yaml",
    "examples/BACKLOG.md",
    "docs/INSTALLATION.md",
    "docs/TROUBLESHOOTING.md",
  ]) {
    await access(path.join(packageRoot, relativePath));
  }

  const migrationRoot = path.join(packageRoot, "dist", "migrations");
  const manifest = JSON.parse(
    await readFile(path.join(migrationRoot, "manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.migrations) ||
    manifest.migrations.length === 0
  ) {
    throw new Error("Installed migration manifest is invalid");
  }
  for (const migration of manifest.migrations) {
    const migrationPath = path.join(migrationRoot, migration.file);
    const fileHash = await sha256File(migrationPath);
    if (fileHash !== migration.fileSha256) {
      throw new Error(`Installed migration checksum failed: ${migration.file}`);
    }
  }
}

async function verifyUserService(paths, prefix) {
  const expectedUnit = path.join(
    configRoot,
    "systemd",
    "user",
    "agentflow.service",
  );
  const expectedEnvironment = path.join(
    configRoot,
    "agentflow",
    "environment",
  );
  if (
    paths.unitPath !== expectedUnit ||
    paths.environmentPath !== expectedEnvironment
  ) {
    throw new Error(`Service paths escaped XDG_CONFIG_HOME: ${JSON.stringify(paths)}`);
  }
  const [unit, environment, unitStat, environmentStat] = await Promise.all([
    readFile(expectedUnit, "utf8"),
    readFile(expectedEnvironment, "utf8"),
    stat(expectedUnit),
    stat(expectedEnvironment),
  ]);
  for (const expected of [
    "Restart=on-failure",
    "WantedBy=default.target",
    "EnvironmentFile=",
    "ExecStart=",
    " serve",
  ]) {
    if (!unit.includes(expected)) {
      throw new Error(`Generated user service is missing ${expected}`);
    }
  }
  if (!unit.includes(prefix)) {
    throw new Error("Generated user service does not use the installed CLI");
  }
  for (const expected of [
    'AGENTFLOW_HOST="127.0.0.1"',
    `AGENTFLOW_HOME="${runtime}"`,
    'AGENTFLOW_PORT="4782"',
    'AGENTFLOW_LOG_LEVEL="silent"',
    "AGENTFLOW_CODEX_BIN=",
    "AGENTFLOW_WORKER_TIMEOUT_MS=",
  ]) {
    if (!environment.includes(expected)) {
      throw new Error(`Generated service environment is missing ${expected}`);
    }
  }
  if ((unitStat.mode & 0o777) !== 0o644) {
    throw new Error("Generated service unit permissions are not 0644");
  }
  if ((environmentStat.mode & 0o777) !== 0o600) {
    throw new Error("Generated service environment permissions are not 0600");
  }
  if (await commandAvailable("systemd-analyze")) {
    await run("systemd-analyze", ["verify", expectedUnit]);
  }
}

async function findAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to allocate a loopback smoke-test port");
  }
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  return port;
}

async function pollJson(url) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function collectOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return () => ({ stdout, stderr });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new Error(`Process ${child.pid ?? "unknown"} did not exit`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      globalThis.clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      globalThis.clearTimeout(timeout);
      reject(error);
    });
  });
}

async function run(command, arguments_, cwd = root, environment = process.env) {
  try {
    return await execFileAsync(command, arguments_, {
      cwd,
      env: environment,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const stdout =
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof error.stdout === "string"
        ? error.stdout.trim()
        : "";
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    throw new Error(
      `${command} ${arguments_.join(" ")} failed${
        stdout.length > 0 ? `\nstdout: ${stdout}` : ""
      }${stderr.length > 0 ? `\nstderr: ${stderr}` : ""}`,
      { cause: error },
    );
  }
}

async function sha256File(filename) {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function commandAvailable(command) {
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
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
