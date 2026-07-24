import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexArguments,
  buildWorkerPrompt,
  runCodexWorker,
  startCodexWorker,
  WORKER_RESULT_JSON_SCHEMA,
  type CodexWorkerOptions,
  type WorkerPromptContext,
} from "../src/workers/index.js";

const FAKE_CODEX_SOURCE = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "success";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
await writeFile(".fake-args.json", JSON.stringify(process.argv.slice(2)), "utf8");
await writeFile(".fake-prompt.md", prompt, "utf8");

const completed = {
  status: "completed",
  summary: "Implemented the scoped task",
  validation_notes: ["AgentFlow will run declared validation"],
  handoff_notes: ["Ready for ownership enforcement"],
  risks: []
};
const emitResult = (result = completed) => {
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(result) }
  }) + "\\n");
};

if (scenario === "success") {
  await mkdir("src", { recursive: true });
  await writeFile("src/owned.txt", "done\\n", "utf8");
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake" }) + "\\n");
  emitResult();
} else if (scenario === "no_changes") {
  emitResult();
} else if (scenario === "ownership_violation") {
  await mkdir("docs", { recursive: true });
  await writeFile("docs/outside.txt", "outside ownership\\n", "utf8");
  emitResult();
} else if (scenario === "malformed") {
  process.stdout.write("{ definitely-not-json\\n");
  emitResult();
} else if (scenario === "nonzero") {
  process.stderr.write("api_key=" + process.env.FAKE_SECRET + "\\n");
  process.stderr.write("x".repeat(2048) + "\\n");
  process.exitCode = 7;
} else if (scenario === "blocked") {
  emitResult({
    status: "blocked",
    summary: "Missing an external dependency",
    validation_notes: [],
    handoff_notes: []
  });
} else if (scenario === "zero_without_result") {
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
} else if (scenario === "invalid_result") {
  emitResult({ status: "completed", summary: "" });
} else if (scenario === "hang") {
  const sentinel = process.env.FAKE_SENTINEL;
  if (sentinel) {
    spawn(process.execPath, [
      "-e",
      "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'orphan'), 400)",
      sentinel
    ], { stdio: "ignore" });
  }
  setInterval(() => {}, 1000);
} else if (scenario === "disappear") {
  process.kill(process.pid, "SIGKILL");
}
`;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

function promptContext(): WorkerPromptContext {
  return {
    buildId: "build-01",
    attempt: 1,
    task: {
      id: "BL-101",
      title: "Implement checkout contract",
      description: "Add the checkout contract without touching other areas.",
      acceptanceCriteria: ["The contract is typed.", "Examples are included."],
      ownedPaths: ["src/checkout"],
      validationCommands: ["npm run typecheck"],
    },
    repositoryInstructions: "Follow AGENTS.md and preserve strict TypeScript.",
    dependencyManifests: [
      {
        name: "identity-handoff",
        version: "1.0.0",
        sha256: "abc123",
        content: { status: "integrated" },
      },
    ],
    consumedContracts: [
      {
        name: "identity-schema",
        version: "2.1.0",
        sourcePath: "contracts/identity.json",
        content: { type: "object" },
      },
    ],
    consumedArtifacts: [
      {
        name: "generated-types",
        version: "2.1.0",
        content: ["UserId"],
      },
    ],
    examplePayloads: [
      {
        name: "checkout-request",
        content: { customerId: "customer-1" },
      },
    ],
  };
}

interface Fixture {
  root: string;
  worktreePath: string;
  attemptDirectory: string;
  executable: string;
  sentinel: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "agentflow-worker-"));
  temporaryRoots.push(root);
  const worktreePath = path.join(root, "worktree");
  const attemptDirectory = path.join(
    root,
    "runs",
    "build-01",
    "tasks",
    "BL-101",
    "attempt-1",
  );
  const executable = path.join(root, "fake-codex.mjs");
  const sentinel = path.join(root, "orphan-sentinel");
  await mkdir(worktreePath, { recursive: true });
  await writeFile(executable, FAKE_CODEX_SOURCE, "utf8");
  await chmod(executable, 0o700);
  return { root, worktreePath, attemptDirectory, executable, sentinel };
}

function options(
  fixture: Fixture,
  scenario: string,
  overrides: Partial<CodexWorkerOptions> = {},
): CodexWorkerOptions {
  return {
    executable: fixture.executable,
    worktreePath: fixture.worktreePath,
    attemptDirectory: fixture.attemptDirectory,
    prompt: promptContext(),
    environment: {
      FAKE_CODEX_SCENARIO: scenario,
      FAKE_SECRET: "super-secret-value",
      FAKE_SENTINEL: fixture.sentinel,
    },
    secrets: ["super-secret-value"],
    timeoutMs: 2_000,
    idleTimeoutMs: 1_000,
    heartbeatIntervalMs: 20,
    terminationGraceMs: 50,
    ...overrides,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

describe("worker prompt and command contract", () => {
  it("includes scoped context and every prohibited authority boundary", () => {
    const prompt = buildWorkerPrompt(promptContext());
    expect(prompt).toContain("ID: BL-101");
    expect(prompt).toContain("The contract is typed.");
    expect(prompt).toContain("src/checkout");
    expect(prompt).toContain("identity-handoff");
    expect(prompt).toContain("identity-schema");
    expect(prompt).toContain("generated-types");
    expect(prompt).toContain("checkout-request");
    expect(prompt).toContain("Commit, push, merge");
    expect(prompt).toContain("Control Docker");
    expect(prompt).toContain("Modify the backlog");
  });

  it("includes the previous attempt failure in retry prompts", () => {
    const context = promptContext();
    context.attempt = 2;
    context.previousAttempt = {
      name: "attempt-1-failure",
      content: {
        status: "failed",
        errorCode: "INTEGRATION_VALIDATION_FAILED",
        errorMessage: "amount_cents must be a number",
        resultCommit: "deadbeef",
      },
    };

    const prompt = buildWorkerPrompt(context);

    expect(prompt).toContain("PREVIOUS ATTEMPT FAILURE");
    expect(prompt).toContain("attempt-1-failure");
    expect(prompt).toContain("INTEGRATION_VALIDATION_FAILED");
    expect(prompt).toContain("amount_cents must be a number");
    expect(prompt).toContain("deadbeef");
  });

  it("locks JSONL, sandbox, schema, cwd, and stdin command arguments", () => {
    expect(buildCodexArguments("/run/result.schema.json", ["--model", "fake"])).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--output-schema",
      "/run/result.schema.json",
      "--model",
      "fake",
      "-",
    ]);
    expect(() =>
      buildCodexArguments("/run/result.schema.json", [
        "--sandbox=danger-full-access",
      ]),
    ).toThrow("controlled by AgentFlow");
    expect(() =>
      buildCodexArguments("/run/result.schema.json", [
        "--config",
        "sandbox_mode=danger-full-access",
      ]),
    ).toThrow("not permitted by AgentFlow");
  });
});

describe("Codex worker runtime", () => {
  it("streams a successful structured result and records an isolated attempt", async () => {
    const fixture = await createFixture();
    const started: number[] = [];
    const heartbeats: string[] = [];
    const events: string[] = [];

    const outcome = await runCodexWorker(
      options(fixture, "success", {
        additionalArguments: ["--model", "fake"],
        onStarted: (pid) => started.push(pid),
        onHeartbeat: (heartbeat) => heartbeats.push(heartbeat.reason),
        onEvent: (event) => events.push(event.type),
      }),
    );

    expect(outcome.success).toBe(true);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.finalResult?.status).toBe("completed");
    expect(outcome.eventCount).toBe(2);
    expect(started).toEqual([outcome.pid]);
    expect(heartbeats).toContain("activity");
    expect(events).toContain("worker.started");
    expect(events.at(-1)).toBe("worker.completed");
    expect(
      JSON.parse(
        await readFile(
          path.join(fixture.worktreePath, ".fake-args.json"),
          "utf8",
        ),
      ),
    ).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--output-schema",
      outcome.paths.resultSchema,
      "--model",
      "fake",
      "-",
    ]);
    expect(
      await readFile(path.join(fixture.worktreePath, ".fake-prompt.md"), "utf8"),
    ).toContain("AgentFlow, not you, owns Git history");
    expect(
      JSON.parse(await readFile(outcome.paths.resultSchema, "utf8")),
    ).toEqual(WORKER_RESULT_JSON_SCHEMA);
    expect(JSON.parse(await readFile(outcome.paths.outcome, "utf8"))).toMatchObject({
      success: true,
      status: "succeeded",
      pid: outcome.pid,
    });
    expect(JSON.parse(await readFile(outcome.paths.result, "utf8"))).toMatchObject({
      status: "completed",
      summary: "Implemented the scoped task",
    });
    expect((await stat(outcome.paths.prompt)).mode & 0o777).toBe(0o600);

    await expect(
      runCodexWorker(options(fixture, "success")),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it.each([
    ["no_changes", ".fake-prompt.md"],
    ["ownership_violation", "docs/outside.txt"],
  ])(
    "supports the deterministic %s fixture for downstream enforcement",
    async (scenario, expectedPath) => {
      const fixture = await createFixture();
      const outcome = await runCodexWorker(options(fixture, scenario));
      expect(outcome.success).toBe(true);
      expect(await exists(path.join(fixture.worktreePath, expectedPath))).toBe(
        true,
      );
    },
  );

  it("preserves malformed JSONL while continuing to the valid final result", async () => {
    const fixture = await createFixture();
    const malformed: string[] = [];
    const outcome = await runCodexWorker(
      options(fixture, "malformed", {
        onEvent: (event) => {
          if (event.type === "worker.jsonl_malformed") {
            malformed.push(event.raw);
          }
        },
      }),
    );

    expect(outcome.success).toBe(true);
    expect(outcome.malformedEventCount).toBe(1);
    expect(malformed).toEqual(["{ definitely-not-json"]);
    expect(await readFile(outcome.paths.jsonl, "utf8")).toContain(
      "{ definitely-not-json\n",
    );
  });

  it("redacts secrets, bounds logs, and reports a nonzero exit", async () => {
    const fixture = await createFixture();
    const outcome = await runCodexWorker(
      options(fixture, "nonzero", { maximumLogBytes: 128 }),
    );
    const stderr = await readFile(outcome.paths.stderr, "utf8");

    expect(outcome.success).toBe(false);
    expect(outcome.failureCode).toBe("process_exit_nonzero");
    expect(outcome.exitCode).toBe(7);
    expect(outcome.logsTruncated.stderr).toBe(true);
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).toContain("log truncated");
    expect(stderr).not.toContain("super-secret-value");
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(128);
  });

  it.each([
    ["zero_without_result", "structured_result_missing"],
    ["invalid_result", "structured_result_invalid"],
    ["blocked", "worker_reported_blocked"],
  ] as const)(
    "does not treat exit zero as success for %s",
    async (scenario, failureCode) => {
      const fixture = await createFixture();
      const outcome = await runCodexWorker(options(fixture, scenario));
      expect(outcome.exitCode).toBe(0);
      expect(outcome.success).toBe(false);
      expect(outcome.failureCode).toBe(failureCode);
    },
  );

  it("times out the complete process group and prevents an orphan child", async () => {
    const fixture = await createFixture();
    const outcome = await runCodexWorker(
      options(fixture, "hang", {
        timeoutMs: 80,
        idleTimeoutMs: 1_000,
      }),
    );

    expect(outcome.status).toBe("timed_out");
    expect(outcome.failureCode).toBe("timeout");
    await delay(500);
    expect(await exists(fixture.sentinel)).toBe(false);
  });

  it("enforces an independent output-idle timeout", async () => {
    const fixture = await createFixture();
    const outcome = await runCodexWorker(
      options(fixture, "hang", {
        timeoutMs: 2_000,
        idleTimeoutMs: 80,
      }),
    );

    expect(outcome.status).toBe("idle_timed_out");
    expect(outcome.failureCode).toBe("idle_timeout");
  });

  it("cancels the complete process group through the explicit handle", async () => {
    const fixture = await createFixture();
    const handle = await startCodexWorker(options(fixture, "hang"));
    expect(handle.pid).not.toBeNull();
    handle.cancel();
    const outcome = await handle.completion;

    expect(outcome.status).toBe("cancelled");
    expect(outcome.failureCode).toBe("cancelled");
    await delay(500);
    expect(await exists(fixture.sentinel)).toBe(false);
  });

  it("classifies unexpected process disappearance separately", async () => {
    const fixture = await createFixture();
    const outcome = await runCodexWorker(options(fixture, "disappear"));

    expect(outcome.status).toBe("process_disappeared");
    expect(outcome.failureCode).toBe("process_disappeared");
    expect(outcome.signal).toBe("SIGKILL");
  });

  it("records an executable spawn failure without hanging", async () => {
    const fixture = await createFixture();
    const outcome = await runCodexWorker(
      options(fixture, "success", {
        executable: path.join(fixture.root, "missing-codex"),
      }),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.failureCode).toBe("spawn_error");
    expect(outcome.pid).toBeNull();
  });
});
