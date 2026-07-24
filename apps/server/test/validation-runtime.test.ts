import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildValidationEnvironment,
  collectGitChanges,
  createComposeProjectName,
  evaluateChangedFileOwnership,
  normalizeValidationCommand,
  parseCommandLine,
  parseNameStatusOutput,
  runValidationProcess,
  SecretRedactor,
  validateTask,
  ValidationCommandError,
  ValidationEnvironmentError,
} from "../src/validation/index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("validation command normalization", () => {
  it("parses quoted argv without invoking a shell", () => {
    expect(
      parseCommandLine(
        `node -e "process.stdout.write('hello world')" --flag='two words' ""`,
      ),
    ).toEqual([
      "node",
      "-e",
      "process.stdout.write('hello world')",
      "--flag=two words",
      "",
    ]);

    expect(
      normalizeValidationCommand({
        argv: ["npm", "test"],
        required: false,
        timeoutMs: 123,
        label: " unit tests ",
      }),
    ).toEqual({
      argv: ["npm", "test"],
      required: false,
      timeoutMs: 123,
      label: "unit tests",
    });
  });

  it("rejects shell control operators and environment-prefix execution", () => {
    expect(() => parseCommandLine("npm test && npm run build")).toThrow(
      ValidationCommandError,
    );
    expect(() => parseCommandLine("TOKEN=value npm test")).toThrow(
      ValidationCommandError,
    );
  });
});

describe("validation environment and redaction", () => {
  it("copies only allowlisted environment variables", () => {
    const environment = buildValidationEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        PRIVATE_TOKEN: "do-not-copy",
      },
      { CI: "1" },
    );
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      CI: "1",
    });
    expect(environment.PRIVATE_TOKEN).toBeUndefined();

    expect(() =>
      buildValidationEnvironment(process.env, {
        PRIVATE_TOKEN: "not-allowlisted",
      }),
    ).toThrow(ValidationEnvironmentError);
  });

  it("redacts configured secrets that cross stream chunk boundaries", () => {
    const redactor = new SecretRedactor(["secret-value"]);
    const output = [
      redactor.write("before secret"),
      redactor.write("-value after"),
      redactor.end(),
    ].join("");
    expect(output).toBe("before [REDACTED] after");
    expect(output).not.toContain("secret-value");
  });
});

describe("spawn-based validation process", () => {
  it("streams redacted output, redacts recorded argv, and bounds capture", async () => {
    const streamed: string[] = [];
    const secret = "credential-123";
    const code = [
      `process.stdout.write(${JSON.stringify(secret.slice(0, 6))});`,
      `setTimeout(() => { process.stdout.write(${JSON.stringify(
        `${secret.slice(6)}:${"x".repeat(80)}`,
      )}); }, 5);`,
    ].join("");
    const result = await runValidationProcess({
      argv: [process.execPath, "-e", code, secret],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      secrets: [secret],
      maxOutputBytes: 24,
      onOutput: ({ chunk }) => {
        streamed.push(chunk);
      },
    });

    expect(result.status).toBe("passed");
    expect(result.argv.at(-1)).toBe("[REDACTED]");
    expect(streamed.join("")).toContain("[REDACTED]");
    expect(streamed.join("")).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toContain("output truncated after 24 bytes");
  });

  it("times out and cancels commands with explicit outcomes", async () => {
    const timedOut = await runValidationProcess({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 30,
      terminationGraceMs: 10,
    });
    expect(timedOut.status).toBe("timed_out");
    expect(timedOut.durationMs).toBeLessThan(2_000);

    const controller = new AbortController();
    const cancelled = await runValidationProcess({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      signal: controller.signal,
      terminationGraceMs: 10,
      onSpawn: () => {
        setTimeout(() => {
          controller.abort();
        }, 20);
      },
    });
    expect(cancelled.status).toBe("cancelled");
  });

  it("kills descendants in the validation process group on timeout", async () => {
    if (process.platform === "win32") {
      return;
    }
    const directory = await createTemporaryDirectory();
    const marker = path.join(directory, "descendant-survived");
    const descendantCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(
      marker,
    )}, "alive"), 250)`;
    const parentCode = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(
        descendantCode,
      )}], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000);",
    ].join("");

    const result = await runValidationProcess({
      argv: [process.execPath, "-e", parentCode],
      cwd: directory,
      timeoutMs: 30,
      terminationGraceMs: 10,
    });
    expect(result.status).toBe("timed_out");
    await new Promise((resolve) => {
      setTimeout(resolve, 350);
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("base-commit Git ownership inspection", () => {
  it("parses NUL-delimited renames without treating the score as a path", () => {
    expect(
      parseNameStatusOutput(
        "R100\0src/old name.ts\0src/new name.ts\0M\0src/index.ts\0",
      ),
    ).toEqual([
      {
        path: "src/new name.ts",
        changeType: "renamed",
        previousPath: "src/old name.ts",
      },
      {
        path: "src/index.ts",
        changeType: "modified",
        previousPath: null,
      },
    ]);
  });

  it("collects committed, staged, unstaged, deleted, renamed, and untracked paths", async () => {
    const repository = await createGitRepository({
      "src/old.ts": "same contents\n",
      "src/deleted.ts": "delete me\n",
      "docs/readme.md": "before\n",
      ".agentflow.yaml": "version: 1\n",
    });
    await git(repository.path, ["mv", "src/old.ts", "src/new.ts"]);
    await unlink(path.join(repository.path, "src/deleted.ts"));
    await writeFile(path.join(repository.path, "docs/readme.md"), "after\n");
    await writeFile(path.join(repository.path, "src/untracked.ts"), "new\n");
    await writeFile(
      path.join(repository.path, ".agentflow.yaml"),
      "version: 2\n",
    );

    const changes = await collectGitChanges(
      repository.path,
      repository.baseCommit,
    );
    expect(changes).toEqual(
      expect.arrayContaining([
        {
          path: "src/new.ts",
          changeType: "renamed",
          previousPath: "src/old.ts",
        },
        {
          path: "src/deleted.ts",
          changeType: "deleted",
          previousPath: null,
        },
        {
          path: "src/untracked.ts",
          changeType: "untracked",
          previousPath: null,
        },
      ]),
    );

    const ownership = evaluateChangedFileOwnership(changes, [
      "src",
      ".agentflow.yaml",
    ]);
    expect(ownership.passed).toBe(false);
    expect(ownership.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "docs/readme.md",
          reason: "outside_ownership",
        }),
        expect.objectContaining({
          path: ".agentflow.yaml",
          reason: "forbidden_path",
        }),
      ]),
    );
  });

  it("checks both sides of a rename against ownership", () => {
    const ownership = evaluateChangedFileOwnership(
      [
        {
          path: "src/moved.ts",
          previousPath: "docs/original.ts",
          changeType: "renamed",
        },
      ],
      ["src"],
    );
    expect(ownership.passed).toBe(false);
    expect(ownership.changedFiles[0]?.withinOwnership).toBe(false);
    expect(ownership.violations).toContainEqual(
      expect.objectContaining({
        path: "docs/original.ts",
        reason: "outside_ownership",
      }),
    );
  });
});

describe("task validation summary", () => {
  it("continues after optional failures, sets isolated Compose state, and cleans up", async () => {
    const repository = await createGitRepository({
      "src/index.ts": "before\n",
      "compose.yaml": "services: {}\n",
    });
    await writeFile(path.join(repository.path, "src/index.ts"), "after\n");
    const binDirectory = path.join(repository.path, "test-bin");
    await mkdir(binDirectory);
    const dockerLog = path.join(binDirectory, "docker-log.json");
    const dockerExecutable = path.join(binDirectory, "docker");
    await writeFile(
      dockerExecutable,
      `#!${process.execPath}\n` +
        `require("node:fs").writeFileSync(${JSON.stringify(
          dockerLog,
        )}, JSON.stringify({ argv: process.argv.slice(2), project: process.env.COMPOSE_PROJECT_NAME }));\n`,
    );
    await chmod(dockerExecutable, 0o755);
    const secret = "task-secret";

    const summary = await validateTask({
      buildId: "build/One",
      taskId: "BL-009",
      attempt: 2,
      worktreePath: repository.path,
      baseCommit: repository.baseCommit,
      ownedPaths: ["src", "test-bin"],
      commands: [
        {
          argv: [process.execPath, "-e", "process.exit(2)"],
          required: false,
          label: "advisory",
        },
        {
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write(process.env.TASK_SECRET ?? 'missing')",
          ],
          required: true,
        },
      ],
      workerCompletedSuccessfully: true,
      environment: {
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        TASK_SECRET: secret,
      },
      additionalEnvironmentKeys: ["TASK_SECRET"],
      secrets: [secret],
      compose: {
        enabled: true,
        composeFile: "compose.yaml",
        cleanup: true,
      },
    });

    expect(summary.status).toBe("passed");
    expect(summary.optionalFailures).toBe(1);
    expect(summary.requiredCommandsPassed).toBe(true);
    expect(summary.readyForCommit).toBe(true);
    expect(summary.commands[1]?.stdout).toBe("[REDACTED]");
    expect(summary.composeCleanup?.status).toBe("passed");
    const cleanup = JSON.parse(await readFile(dockerLog, "utf8")) as {
      argv: string[];
      project: string;
    };
    expect(cleanup.project).toBe(summary.composeProjectName);
    expect(cleanup.argv).toEqual([
      "compose",
      "-f",
      "compose.yaml",
      "-p",
      summary.composeProjectName,
      "down",
      "--remove-orphans",
    ]);
  });

  it("stops at a required failure and does not run later commands", async () => {
    const repository = await createGitRepository({
      "src/index.ts": "before\n",
    });
    await writeFile(path.join(repository.path, "src/index.ts"), "after\n");
    const marker = path.join(repository.path, "should-not-exist");

    const summary = await validateTask({
      buildId: "build-1",
      taskId: "task-1",
      attempt: 1,
      worktreePath: repository.path,
      baseCommit: repository.baseCommit,
      ownedPaths: ["src"],
      commands: [
        [process.execPath, "-e", "process.exit(3)"],
        [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
        ],
      ],
      workerCompletedSuccessfully: true,
    });

    expect(summary.status).toBe("failed");
    expect(summary.errorCode).toBe("VALIDATION_COMMAND_FAILED");
    expect(summary.commands).toHaveLength(1);
    expect(summary.readyForCommit).toBe(false);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails ownership before executing validation", async () => {
    const repository = await createGitRepository({
      "src/index.ts": "before\n",
      "docs/readme.md": "before\n",
    });
    await writeFile(path.join(repository.path, "docs/readme.md"), "after\n");
    const marker = path.join(repository.path, "validation-ran");

    const summary = await validateTask({
      buildId: "build-1",
      taskId: "task-1",
      attempt: 1,
      worktreePath: repository.path,
      baseCommit: repository.baseCommit,
      ownedPaths: ["src"],
      commands: [
        [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
        ],
      ],
      workerCompletedSuccessfully: true,
    });

    expect(summary.errorCode).toBe("OWNERSHIP_VIOLATION");
    expect(summary.commands).toHaveLength(0);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks ownership after validation-generated changes", async () => {
    const repository = await createGitRepository({
      "src/index.ts": "before\n",
      "docs/readme.md": "before\n",
    });
    await writeFile(path.join(repository.path, "src/index.ts"), "after\n");
    const generatedPath = path.join(repository.path, "docs/generated.txt");

    const summary = await validateTask({
      buildId: "build-1",
      taskId: "task-1",
      attempt: 1,
      worktreePath: repository.path,
      baseCommit: repository.baseCommit,
      ownedPaths: ["src"],
      commands: [
        [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(
            generatedPath,
          )}, "generated")`,
        ],
      ],
      workerCompletedSuccessfully: true,
    });

    expect(summary.errorCode).toBe("OWNERSHIP_VIOLATION");
    expect(summary.commands).toHaveLength(1);
    expect(summary.ownership.violations).toContainEqual(
      expect.objectContaining({
        path: "docs/generated.txt",
        reason: "outside_ownership",
      }),
    );
    expect(summary.readyForCommit).toBe(false);
  });

  it("enforces allow_no_changes and produces deterministic Compose names", async () => {
    const repository = await createGitRepository({
      "src/index.ts": "unchanged\n",
    });
    const baseInput = {
      buildId: "build-1",
      taskId: "task-1",
      attempt: 1,
      worktreePath: repository.path,
      baseCommit: repository.baseCommit,
      ownedPaths: ["src"],
      commands: [[process.execPath, "-e", "process.exit(0)"]],
      workerCompletedSuccessfully: true,
    } as const;

    const rejected = await validateTask(baseInput);
    expect(rejected.errorCode).toBe("NO_CHANGES");

    const accepted = await validateTask({
      ...baseInput,
      allowNoChanges: true,
    });
    expect(accepted.status).toBe("passed");
    expect(accepted.readyForCommit).toBe(true);

    const name = createComposeProjectName("Build / One", "BL:009", 1);
    expect(name).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/u);
    expect(name).toBe(
      createComposeProjectName("Build / One", "BL:009", 1),
    );
    expect(name).not.toBe(
      createComposeProjectName("Build / One", "BL:009", 2),
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agentflow-validation-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createGitRepository(
  files: Readonly<Record<string, string>>,
): Promise<{ path: string; baseCommit: string }> {
  const repositoryPath = await createTemporaryDirectory();
  await git(repositoryPath, ["init", "--quiet"]);
  await git(repositoryPath, ["config", "user.email", "tests@agentflow.local"]);
  await git(repositoryPath, ["config", "user.name", "AgentFlow Tests"]);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(repositoryPath, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await git(repositoryPath, ["add", "--all"]);
  await git(repositoryPath, ["commit", "--quiet", "-m", "base"]);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  return { path: repositoryPath, baseCommit: stdout.trim() };
}

async function git(
  repositoryPath: string,
  arguments_: readonly string[],
): Promise<void> {
  await execFileAsync("git", [...arguments_], {
    cwd: repositoryPath,
    encoding: "utf8",
  });
}
