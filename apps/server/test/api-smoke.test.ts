import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEnvironment } from "../src/config/environment.js";
import { buildApp } from "../src/http/app.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map(async (root) => {
      temporaryRoots.delete(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("AgentFlow API smoke", () => {
  it("serves health, repository registration, planning, and build creation", async () => {
    const runtimeHome = await temporaryRoot("runtime");
    const repositoryPath = await createFixtureRepository();
    const environment = resolveEnvironment({
      AGENTFLOW_HOME: runtimeHome,
      AGENTFLOW_LOG_LEVEL: "silent",
      AGENTFLOW_CODEX_BIN: "/definitely/missing/agentflow-test-codex",
    });
    const { app } = await buildApp({
      environment,
      staticRoot: false,
      logger: false,
    });

    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({
        status: "ok",
        host: "127.0.0.1:4782",
        database: { status: "ok", journalMode: "wal" },
      });

      const registered = await app.inject({
        method: "POST",
        url: "/api/repositories",
        payload: { path: repositoryPath },
      });
      expect(registered.statusCode).toBe(201);
      const repository = registered.json<{
        id: string;
        localPath: string;
        status: string;
      }>();
      expect(repository).toMatchObject({
        localPath: repositoryPath,
        status: "ready",
      });

      const planned = await app.inject({
        method: "POST",
        url: "/api/plans",
        payload: { repositoryId: repository.id },
      });
      expect(planned.statusCode).toBe(201);
      const plan = planned.json<{
        id: string;
        waves: string[][];
        estimates: { criticalPathHours: number };
      }>();
      expect(plan.waves).toEqual([["BL-100"], ["BL-101"]]);
      expect(plan.estimates.criticalPathHours).toBe(5);

      const buildResponse = await app.inject({
        method: "POST",
        url: "/api/builds",
        payload: { planId: plan.id },
      });
      expect(buildResponse.statusCode).toBe(201);
      const build = buildResponse.json<{
        id: string;
        status: string;
        tasks: Array<{ state: string }>;
      }>();
      expect(build.status).toBe("ready");
      expect(build.tasks.map((task) => task.state)).toEqual([
        "ready",
        "blocked",
      ]);

      const secondBuild = await app.inject({
        method: "POST",
        url: "/api/builds",
        payload: { planId: plan.id },
      });
      expect(secondBuild.statusCode).toBe(409);

      const started = await app.inject({
        method: "POST",
        url: `/api/builds/${build.id}/start`,
      });
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({ status: "running" });
    } finally {
      await app.close();
    }
  });

  it("serves the built application from the production server", async () => {
    const runtimeHome = await temporaryRoot("runtime-static");
    const staticRoot = await temporaryRoot("static");
    await writeFile(
      path.join(staticRoot, "index.html"),
      "<!doctype html><title>AgentFlow control plane</title>",
    );
    const environment = resolveEnvironment({
      AGENTFLOW_HOME: runtimeHome,
      AGENTFLOW_LOG_LEVEL: "silent",
    });
    const { app } = await buildApp({
      environment,
      staticRoot,
      logger: false,
    });

    try {
      const response = await app.inject({ method: "GET", url: "/" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("AgentFlow control plane");
    } finally {
      await app.close();
    }
  });

  it("reports database diagnostics and creates a consistent backup", async () => {
    const runtimeHome = await temporaryRoot("runtime-backup");
    const environment = resolveEnvironment({
      AGENTFLOW_HOME: runtimeHome,
      AGENTFLOW_LOG_LEVEL: "silent",
    });
    const { app } = await buildApp({
      environment,
      staticRoot: false,
      logger: false,
    });

    try {
      const diagnostics = await app.inject({
        method: "GET",
        url: "/api/system/database",
      });
      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json()).toMatchObject({
        ok: true,
        foreignKeysEnabled: true,
        journalMode: "wal",
      });

      const backup = await app.inject({
        method: "POST",
        url: "/api/system/database/backup",
      });
      expect(backup.statusCode).toBe(201);
      const backupResult = backup.json<{ path: string }>();
      expect(backupResult.path).toContain(environment.backupsPath);
    } finally {
      await app.close();
    }
  });
});

async function createFixtureRepository(): Promise<string> {
  const root = await temporaryRoot("repository");
  await execFileAsync("git", ["init", "--initial-branch=main", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "AgentFlow Test"]);
  await execFileAsync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "agentflow@example.test",
  ]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "agentflow-api-fixture",
        private: true,
        scripts: {
          lint: "node --check src/index.js",
          typecheck: "node --check src/index.js",
          test: "node --test",
          build: "node --check src/index.js",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(root, "src", "index.js"), "export const ok = true;\n");
  await writeFile(
    path.join(root, "BACKLOG.md"),
    `# Fixture backlog

## BL-100 - Define local contract

\`\`\`yaml
estimate_hours: 2
depends_on: []
owns:
  - contracts/example/
validate:
  - npm run typecheck
produces:
  - name: example-contract
    type: json-schema
    version: 1.0.0
    path: contracts/example/schema.json
\`\`\`

Create the contract.

### Acceptance Criteria

- The schema is versioned.

## BL-101 - Implement consumer

\`\`\`yaml
estimate_hours: 3
depends_on:
  - BL-100
owns:
  - src/
consumes:
  - task: BL-100
    artifact: example-contract
    version: 1.0.0
\`\`\`

Implement the consumer.

### Acceptance Criteria

- The consumer validates the example.
`,
  );
  await writeFile(
    path.join(root, ".agentflow.yaml"),
    `version: 1
repository:
  name: agentflow-api-fixture
  base_branch: main
backlog:
  path: BACKLOG.md
workers:
  maximum: 4
contracts:
  roots:
    - contracts/
validation:
  task_default:
    - npm run typecheck
  integration:
    - npm run typecheck
docker:
  enabled: false
  compose_file: compose.yaml
git:
  remote: origin
  push_task_branches: false
  push_integration_branch: false
  open_integration_pull_request: false
`,
  );
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "fixture"]);
  return root;
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `agentflow-${label}-`));
  temporaryRoots.add(root);
  return root;
}
