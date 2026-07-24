import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { resolveEnvironment } from "../apps/server/src/config/environment.js";
import {
  buildApp,
  type AgentFlowApp,
} from "../apps/server/src/http/app.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();

const FAKE_CODEX_SOURCE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const taskId = process.env.AGENTFLOW_TASK_ID ?? "";
const attempt = Number(process.env.AGENTFLOW_ATTEMPT ?? "0");
const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const tracePath = path.join(fixtureRoot, "fake-codex-trace.jsonl");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString("utf8");
const record = (phase, extra = {}) => {
  appendFileSync(
    tracePath,
    JSON.stringify({
      phase,
      taskId,
      attempt,
      processId: process.pid,
      worktreePath: process.cwd(),
      occurredAtMs: Date.now(),
      ...extra
    }) + "\\n",
    "utf8"
  );
};
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const writeJson = async (relativePath, value) => {
  const destination = path.join(process.cwd(), relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(value, null, 2) + "\\n", "utf8");
};
const completed = {
  status: "completed",
  summary: "Implemented " + taskId + " in the deterministic acceptance fixture",
  validation_notes: ["AgentFlow owns declared validation"],
  handoff_notes: ["Artifacts are ready for AgentFlow publication"],
  risks: []
};
const emitResult = () => {
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(completed) }
  }) + "\\n");
};

record("started", {
  contractVisible:
    prompt.includes('"name": "checkout-contract"') &&
    prompt.includes('"amount_cents": "number"')
});
process.stdout.write(
  JSON.stringify({ type: "thread.started", thread_id: taskId + "-" + attempt }) +
    "\\n"
);

if (["BL-101", "BL-102", "BL-103"].includes(taskId) && attempt === 1) {
  // The acceptance test stops AgentFlow while this first wave is live.
  await delay(30_000);
}
if (attempt === 2 && taskId === "BL-102") {
  // Leave enough time for the other independent workers to start.
  await delay(3_000);
}
if (attempt === 2 && ["BL-101", "BL-103"].includes(taskId)) {
  // Keep the build non-terminal while BL-102 is observed and retried.
  await delay(6_000);
}

if (taskId === "BL-100") {
  await writeJson("contracts/checkout/contract.json", {
    name: "checkout-response",
    version: "1.0.0",
    response: {
      status: "string",
      amount_cents: "number"
    }
  });
} else if (taskId === "BL-101") {
  const contractVisible = prompt.includes('"name": "checkout-contract"');
  await mkdir(path.join(process.cwd(), "db/migrations"), { recursive: true });
  await writeFile(
    path.join(process.cwd(), "db/migrations/001_checkout.sql"),
    "CREATE TABLE checkout_attempts (id TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL);\\n",
    "utf8"
  );
  await writeJson("db/migrations/contract-consumption.json", {
    contractVisible,
    contractVersion: "1.0.0"
  });
} else if (taskId === "BL-102") {
  const contractVisible = prompt.includes('"name": "checkout-contract"');
  await writeJson("backend/contract-consumption.json", {
    contractVisible,
    contractVersion: "1.0.0"
  });
  await writeJson("backend/response.json", {
    status: "ok",
    // Attempt two is deliberately incompatible. The retry fixes the type.
    amount_cents: attempt === 2 ? "1999" : 1999
  });
} else if (taskId === "BL-103") {
  const contractVisible = prompt.includes('"name": "checkout-contract"');
  await writeJson("frontend/contract-consumption.json", {
    contractVisible,
    contractVersion: "1.0.0"
  });
  await writeJson("frontend/checkout-view.json", {
    states: ["loading", "success", "failure"],
    reads: ["status", "amount_cents"]
  });
} else if (taskId === "BL-104") {
  const consumedArtifacts = [
    "checkout-database",
    "checkout-provider",
    "checkout-consumer"
  ].every((name) => prompt.includes('"name": "' + name + '"'));
  await writeJson("tests/integration/checkout-result.json", {
    consumedArtifacts,
    providerConsumerCompatible: true
  });
} else {
  process.stderr.write("Unknown fake task " + taskId + "\\n");
  process.exitCode = 2;
}

record("finished");
emitResult();
`;

const TASK_VALIDATOR_SOURCE = `import { access, readFile } from "node:fs/promises";

const taskId = process.argv[2];
const readJson = async (filePath) =>
  JSON.parse(await readFile(filePath, "utf8"));
const requireContractConsumption = async (filePath) => {
  const marker = await readJson(filePath);
  if (marker.contractVisible !== true || marker.contractVersion !== "1.0.0") {
    throw new Error("worker did not receive the exact integrated contract");
  }
};

switch (taskId) {
  case "BL-100": {
    const contract = await readJson("contracts/checkout/contract.json");
    if (
      contract.version !== "1.0.0" ||
      contract.response?.amount_cents !== "number"
    ) {
      throw new Error("checkout contract is incomplete");
    }
    break;
  }
  case "BL-101":
    await access("db/migrations/001_checkout.sql");
    await requireContractConsumption("db/migrations/contract-consumption.json");
    break;
  case "BL-102": {
    await requireContractConsumption("backend/contract-consumption.json");
    const response = await readJson("backend/response.json");
    if (response.status !== "ok" || response.amount_cents === undefined) {
      throw new Error("backend response fixture is incomplete");
    }
    break;
  }
  case "BL-103": {
    await requireContractConsumption("frontend/contract-consumption.json");
    const view = await readJson("frontend/checkout-view.json");
    if (!view.reads?.includes("amount_cents")) {
      throw new Error("frontend does not consume the contract field");
    }
    break;
  }
  case "BL-104": {
    const result = await readJson("tests/integration/checkout-result.json");
    if (
      result.consumedArtifacts !== true ||
      result.providerConsumerCompatible !== true
    ) {
      throw new Error("integration worker did not receive its artifacts");
    }
    break;
  }
  default:
    throw new Error("unknown task validation target: " + taskId);
}
`;

const INTEGRATION_VALIDATOR_SOURCE = `import { access, readFile } from "node:fs/promises";

const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};
const readJson = async (filePath) =>
  JSON.parse(await readFile(filePath, "utf8"));

const contract = await readJson("contracts/checkout/contract.json");
if (await exists("backend/response.json")) {
  const response = await readJson("backend/response.json");
  for (const [field, type] of Object.entries(contract.response)) {
    if (typeof response[field] !== type) {
      throw new Error(
        "backend contract mismatch: " + field + " must be " + type +
          ", received " + typeof response[field]
      );
    }
  }
}
if (await exists("frontend/checkout-view.json")) {
  const view = await readJson("frontend/checkout-view.json");
  for (const field of Object.keys(contract.response)) {
    if (!view.reads.includes(field)) {
      throw new Error("frontend is missing contract field " + field);
    }
  }
}
if (await exists("tests/integration/checkout-result.json")) {
  for (const required of [
    "db/migrations/001_checkout.sql",
    "backend/response.json",
    "frontend/checkout-view.json"
  ]) {
    if (!(await exists(required))) {
      throw new Error("final integration is missing " + required);
    }
  }
  const result = await readJson("tests/integration/checkout-result.json");
  if (
    result.consumedArtifacts !== true ||
    result.providerConsumerCompatible !== true
  ) {
    throw new Error("final provider/consumer result is invalid");
  }
}
`;

const AGENTFLOW_CONFIG = `version: 1
repository:
  name: agentflow-acceptance-fixture
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
    - node scripts/validate-task.mjs default
  integration:
    - node scripts/validate-integration.mjs
docker:
  enabled: false
  compose_file: compose.yaml
git:
  remote: origin
  push_task_branches: false
  push_integration_branch: false
  open_integration_pull_request: false
`;

const ACCEPTANCE_BACKLOG = `# AgentFlow deterministic acceptance backlog

## BL-100 — Define checkout contract

\`\`\`yaml
estimate_hours: 1
depends_on: []
owns:
  - contracts/checkout/
validate:
  - node scripts/validate-task.mjs BL-100
produces:
  - name: checkout-contract
    type: json-schema-contract
    version: 1.0.0
    path: contracts/checkout/contract.json
\`\`\`

Define the exact checkout response contract before implementation.

### Acceptance Criteria

- The versioned contract defines the status and amount fields.

## BL-101 — Create database migration

\`\`\`yaml
estimate_hours: 2
depends_on:
  - BL-100
owns:
  - db/migrations/
validate:
  - node scripts/validate-task.mjs BL-101
consumes:
  - task: BL-100
    artifact: checkout-contract
    version: 1.0.0
produces:
  - name: checkout-database
    type: database-migration
    version: 1.0.0
    path: db/migrations/001_checkout.sql
\`\`\`

Create storage that follows the integrated checkout contract.

### Acceptance Criteria

- The migration stores amount_cents as an integer.

## BL-102 — Implement backend provider

\`\`\`yaml
estimate_hours: 2
depends_on:
  - BL-100
owns:
  - backend/
validate:
  - node scripts/validate-task.mjs BL-102
consumes:
  - task: BL-100
    artifact: checkout-contract
    version: 1.0.0
produces:
  - name: checkout-provider
    type: service-fixture
    version: 1.0.0
    path: backend/response.json
\`\`\`

Implement a provider response from the integrated contract.

### Acceptance Criteria

- Integration validation rejects an incompatible amount type.
- A corrected retry returns amount_cents as a number.

## BL-103 — Implement frontend consumer

\`\`\`yaml
estimate_hours: 2
depends_on:
  - BL-100
owns:
  - frontend/
validate:
  - node scripts/validate-task.mjs BL-103
consumes:
  - task: BL-100
    artifact: checkout-contract
    version: 1.0.0
produces:
  - name: checkout-consumer
    type: frontend-fixture
    version: 1.0.0
    path: frontend/checkout-view.json
\`\`\`

Implement a consumer from the integrated contract.

### Acceptance Criteria

- The consumer reads every response field and exposes stable UI states.

## BL-104 — Verify provider and consumer integration

\`\`\`yaml
estimate_hours: 1
depends_on:
  - BL-101
  - BL-102
  - BL-103
owns:
  - tests/integration/
validate:
  - node scripts/validate-task.mjs BL-104
consumes:
  - task: BL-101
    artifact: checkout-database
    version: 1.0.0
  - task: BL-102
    artifact: checkout-provider
    version: 1.0.0
  - task: BL-103
    artifact: checkout-consumer
    version: 1.0.0
produces:
  - name: checkout-integration-evidence
    type: test-evidence
    version: 1.0.0
    path: tests/integration/checkout-result.json
\`\`\`

Verify all independently implemented components together.

### Acceptance Criteria

- The final integration consumes all exact-version upstream artifacts.
- The provider and consumer pass the repository integration validator.
`;

interface AcceptanceFixture {
  root: string;
  repositoryPath: string;
  runtimePath: string;
  fakeCodexPath: string;
  tracePath: string;
  baseCommit: string;
}

interface RepositoryResponse {
  id: string;
  localPath: string;
  baseBranch: string;
}

interface PlanResponse {
  id: string;
  waves: string[][];
  estimates: {
    maximumTheoreticalConcurrency: number;
  };
}

interface BuildTask {
  id: string;
  backlogTaskId: string;
  state: string;
  attempt: number;
  branchName: string | null;
  worktreePath: string | null;
  baseCommit: string | null;
  resultCommit: string | null;
  integrationCommit: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface BuildResponse {
  id: string;
  status: string;
  baseCommit: string;
  integrationBranch: string;
  integrationWorktree: string | null;
  actualElapsedSeconds: number | null;
  tasks: BuildTask[];
}

interface BuildEvent {
  sequence: number;
  type: string;
  taskId: string | null;
  payload: Record<string, unknown>;
}

interface ArtifactResponse {
  id: string;
  producerTaskId: string;
  name: string;
  version: string;
  status: string;
  repositoryPath: string | null;
}

interface ManifestResponse {
  id: string;
  taskId: string;
  status: string;
  attempt?: number;
  manifestPath: string;
  sha256: string;
  manifest: {
    consumes?: ManifestArtifactReference[];
    produces?: ManifestArtifactReference[];
  };
}

interface ManifestArtifactReference {
  name: string;
  type: string;
  version: string;
  path?: string;
  sha256?: string;
  producerTaskId?: string;
}

interface ValidationResponse {
  validationType: string;
  command: string;
  status: string;
  exitCode: number | null;
  logPath: string | null;
}

interface AttemptResponse {
  attempt: number;
  status: string;
  promptPath: string | null;
  jsonlPath: string | null;
  logPath: string | null;
  resultCommit: string | null;
}

interface TaskDetailResponse extends BuildTask {
  dependencies: Array<{
    dependencyTaskId: string;
    dependencyType: string;
    requiredArtifactName: string | null;
    requiredArtifactVersion: string | null;
  }>;
  ownership: string[];
  validationCommands: Array<{ command: string }>;
  attempts: AttemptResponse[];
  artifacts: ArtifactResponse[];
  manifests: ManifestResponse[];
  validations: ValidationResponse[];
  changedFiles: Array<{
    attempt: number;
    path: string;
    withinOwnership: boolean;
  }>;
  events: BuildEvent[];
}

interface MetricsResponse {
  estimatedSequentialHours: number;
  criticalPathHours: number;
  expectedElapsedHours: number;
  expectedSavingsPercent: number;
  actualElapsedSeconds: number;
  totalTasks: number;
  integratedTasks: number;
  failedTasks: number;
  ownershipViolations: number;
}

interface RuntimeDocument {
  path: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}

interface FakeCodexTrace {
  phase: "started" | "finished";
  taskId: string;
  attempt: number;
  processId: number;
  worktreePath: string;
  occurredAtMs: number;
  contractVisible?: boolean;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map(async (root) => {
      temporaryRoots.delete(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("AgentFlow end-to-end acceptance", () => {
  it(
    "recovers a real build, rejects an incompatible provider, retries it, and integrates every artifact",
    async () => {
      const fixture = await createAcceptanceFixture();
      const environment = resolveEnvironment({
        AGENTFLOW_HOME: fixture.runtimePath,
        AGENTFLOW_CODEX_BIN: fixture.fakeCodexPath,
        AGENTFLOW_LOG_LEVEL: "silent",
        AGENTFLOW_WORKER_TIMEOUT_MS: "20000",
      });
      let runningApp: AgentFlowApp | undefined;

      try {
        runningApp = await buildApp({
          environment,
          staticRoot: false,
          logger: false,
        });
        let address = await runningApp.app.listen({
          host: "127.0.0.1",
          port: 0,
        });

        const repository = await requestJson<RepositoryResponse>(
          address,
          "/api/repositories",
          {
            method: "POST",
            body: JSON.stringify({
              path: fixture.repositoryPath,
              initializeIfMissing: false,
            }),
          },
        );
        expect(repository).toMatchObject({
          localPath: fixture.repositoryPath,
          baseBranch: "main",
        });

        const plan = await requestJson<PlanResponse>(
          address,
          "/api/plans",
          {
            method: "POST",
            body: JSON.stringify({ repositoryId: repository.id }),
          },
        );
        expect(plan.waves).toEqual([
          ["BL-100"],
          ["BL-101", "BL-102", "BL-103"],
          ["BL-104"],
        ]);
        expect(plan.estimates.maximumTheoreticalConcurrency).toBe(3);

        const createdBuild = await requestJson<BuildResponse>(
          address,
          "/api/builds",
          {
            method: "POST",
            body: JSON.stringify({ planId: plan.id }),
          },
        );
        expect(createdBuild).toMatchObject({
          status: "ready",
          baseCommit: fixture.baseCommit,
        });
        expect(createdBuild.tasks).toHaveLength(5);

        await requestJson<BuildResponse>(
          address,
          `/api/builds/${createdBuild.id}/start`,
          { method: "POST" },
        );

        const runningWave = await waitForBuild(
          address,
          createdBuild.id,
          (build) =>
            ["BL-101", "BL-102", "BL-103"].every(
              (taskId) => taskByBacklogId(build, taskId).state === "running",
            ),
          "the independent implementation wave to run",
        );
        expect(taskByBacklogId(runningWave, "BL-100").state).toBe(
          "integrated",
        );
        const firstWaveWorktrees = ["BL-101", "BL-102", "BL-103"].map(
          (taskId) => taskByBacklogId(runningWave, taskId).worktreePath,
        );
        expect(new Set(firstWaveWorktrees).size).toBe(3);
        expect(
          firstWaveWorktrees.every(
            (worktree) =>
              worktree !== null &&
              worktree.startsWith(`${environment.worktreesPath}${path.sep}`) &&
              !worktree.startsWith(`${fixture.repositoryPath}${path.sep}`),
          ),
        ).toBe(true);

        // Simulate AgentFlow itself stopping, not a worker failure endpoint.
        await runningApp.app.close();
        runningApp = undefined;

        runningApp = await buildApp({
          environment,
          staticRoot: false,
          logger: false,
        });
        address = await runningApp.app.listen({
          host: "127.0.0.1",
          port: 0,
        });

        const recovered = await waitForBuild(
          address,
          createdBuild.id,
          (build) => build.status === "paused",
          "startup recovery to reconcile interrupted workers",
        );
        for (const taskId of ["BL-101", "BL-102", "BL-103"]) {
          expect(taskByBacklogId(recovered, taskId)).toMatchObject({
            state: "interrupted",
            attempt: 1,
            errorCode: "AGENTFLOW_SHUTDOWN",
          });
        }
        const recoveryEvents = await requestJson<BuildEvent[]>(
          address,
          `/api/builds/${createdBuild.id}/events?limit=10000`,
        );
        const interruptedTaskIds = new Set(
          ["BL-101", "BL-102", "BL-103"].map(
            (taskId) => taskByBacklogId(recovered, taskId).id,
          ),
        );
        expect(
          recoveryEvents.filter(
            (event) =>
              event.type === "recovery.decision" &&
              event.payload["action"] === "no_action" &&
              event.taskId !== null &&
              interruptedTaskIds.has(event.taskId),
          ),
        ).toHaveLength(3);
        expect(
          recoveryEvents.some(
            (event) => event.type === "scheduler.deadlock_paused",
          ),
        ).toBe(true);

        for (const taskId of ["BL-101", "BL-102", "BL-103"]) {
          const task = taskByBacklogId(recovered, taskId);
          await requestJson<BuildTask>(
            address,
            `/api/builds/${createdBuild.id}/tasks/${task.id}/retry`,
            { method: "POST" },
          );
        }
        await requestJson<BuildResponse>(
          address,
          `/api/builds/${createdBuild.id}/resume`,
          { method: "POST" },
        );

        const incompatible = await waitForBuild(
          address,
          createdBuild.id,
          (build) => taskByBacklogId(build, "BL-102").state === "failed",
          "the incompatible backend integration to fail",
        );
        const failedBackend = taskByBacklogId(incompatible, "BL-102");
        expect(failedBackend).toMatchObject({
          attempt: 2,
          errorCode: "INTEGRATION_VALIDATION_FAILED",
        });
        expect(incompatible.status).toBe("running");
        expect(
          await gitObjectExists(
            incompatible.integrationWorktree,
            "HEAD:backend/response.json",
          ),
        ).toBe(false);

        const failedBackendDetail = await requestJson<TaskDetailResponse>(
          address,
          `/api/builds/${createdBuild.id}/tasks/${failedBackend.id}`,
        );
        expect(
          failedBackendDetail.validations.some(
            (validation) =>
              validation.validationType === "integration" &&
              validation.status === "failed" &&
              validation.exitCode !== 0,
          ),
        ).toBe(true);
        expect(
          failedBackendDetail.events.some(
            (event) => event.type === "integration.failed",
          ),
        ).toBe(true);

        await requestJson<BuildTask>(
          address,
          `/api/builds/${createdBuild.id}/tasks/${failedBackend.id}/retry`,
          { method: "POST" },
        );
        const maybeBlockedIntegration = taskByBacklogId(
          await requestJson<BuildResponse>(
            address,
            `/api/builds/${createdBuild.id}`,
          ),
          "BL-104",
        );
        if (maybeBlockedIntegration.state === "blocked_failed") {
          await requestJson<BuildTask>(
            address,
            `/api/builds/${createdBuild.id}/tasks/${maybeBlockedIntegration.id}/retry`,
            { method: "POST" },
          );
        }

        const completed = await waitForBuild(
          address,
          createdBuild.id,
          (build) => build.status === "completed",
          "the corrected build to complete",
          30_000,
        );
        expect(completed.tasks.every((task) => task.state === "integrated")).toBe(
          true,
        );
        expect(taskByBacklogId(completed, "BL-102").attempt).toBe(3);
        expect(completed.actualElapsedSeconds).toBeGreaterThan(0);
        expect(completed.integrationWorktree).not.toBeNull();

        const trace = await readTrace(fixture.tracePath);
        const secondWaveStarts = trace.filter(
          (entry) =>
            entry.phase === "started" &&
            entry.attempt === 2 &&
            ["BL-101", "BL-102", "BL-103"].includes(entry.taskId),
        );
        const secondWaveFinishes = trace.filter(
          (entry) =>
            entry.phase === "finished" &&
            entry.attempt === 2 &&
            ["BL-101", "BL-102", "BL-103"].includes(entry.taskId),
        );
        expect(secondWaveStarts.map((entry) => entry.taskId).sort()).toEqual([
          "BL-101",
          "BL-102",
          "BL-103",
        ]);
        expect(secondWaveFinishes).toHaveLength(3);
        expect(
          Math.max(...secondWaveStarts.map((entry) => entry.occurredAtMs)),
        ).toBeLessThan(
          Math.min(...secondWaveFinishes.map((entry) => entry.occurredAtMs)),
        );
        expect(
          secondWaveStarts.every((entry) => entry.contractVisible === true),
        ).toBe(true);

        const events = await requestJson<BuildEvent[]>(
          address,
          `/api/builds/${createdBuild.id}/events?limit=10000`,
        );
        const implementationTaskIds = new Set(
          completed.tasks
            .filter((task) =>
              ["BL-101", "BL-102", "BL-103"].includes(task.backlogTaskId),
            )
            .map((task) => task.id),
        );
        expect(
          events.some((event) => {
            if (event.type !== "scheduler.cycle") {
              return false;
            }
            const selected = event.payload["selectedTaskIds"];
            return (
              Array.isArray(selected) &&
              [...implementationTaskIds].every((id) => selected.includes(id))
            );
          }),
        ).toBe(true);
        assertSerializedIntegrations(events);
        expect(events.some((event) => event.type === "build.completed")).toBe(
          true,
        );

        const artifacts = await requestJson<ArtifactResponse[]>(
          address,
          `/api/builds/${createdBuild.id}/artifacts`,
        );
        expect(
          artifacts.map((artifact) => [
            artifact.name,
            artifact.version,
            artifact.status,
          ]),
        ).toEqual(
          expect.arrayContaining([
            ["checkout-contract", "1.0.0", "integrated"],
            ["checkout-database", "1.0.0", "integrated"],
            ["checkout-provider", "1.0.0", "integrated"],
            ["checkout-consumer", "1.0.0", "integrated"],
            ["checkout-integration-evidence", "1.0.0", "integrated"],
          ]),
        );

        const manifests = await requestJson<ManifestResponse[]>(
          address,
          `/api/builds/${createdBuild.id}/manifests`,
        );
        for (const task of completed.tasks) {
          expect(
            manifests.some(
              (manifest) =>
                manifest.taskId === task.id &&
                manifest.status === "integrated" &&
                manifest.sha256.length === 64,
            ),
          ).toBe(true);
        }
        const backendIntegratedManifest = manifests.find(
          (manifest) =>
            manifest.taskId === taskByBacklogId(completed, "BL-102").id &&
            manifest.status === "integrated",
        );
        const contractConsumption =
          backendIntegratedManifest?.manifest.consumes?.find(
            (artifact) => artifact.name === "checkout-contract",
          );
        expect(contractConsumption).toMatchObject({
          name: "checkout-contract",
          type: "json-schema-contract",
          version: "1.0.0",
          path: "contracts/checkout/contract.json",
          producerTaskId: taskByBacklogId(completed, "BL-100").id,
        });
        expect(contractConsumption?.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(
          manifests.filter(
            (manifest) =>
              manifest.taskId === taskByBacklogId(completed, "BL-102").id &&
              manifest.status === "validated",
          ).length,
        ).toBeGreaterThanOrEqual(2);

        for (const task of completed.tasks) {
          const detail = await requestJson<TaskDetailResponse>(
            address,
            `/api/builds/${createdBuild.id}/tasks/${task.id}`,
          );
          expect(detail.branchName).toMatch(
            new RegExp(`^agent/${createdBuild.id}/`),
          );
          expect(detail.resultCommit).toMatch(/^[0-9a-f]{40,64}$/u);
          expect(detail.integrationCommit).toMatch(/^[0-9a-f]{40,64}$/u);
          expect(detail.ownership.length).toBeGreaterThan(0);
          expect(detail.validationCommands.length).toBeGreaterThan(0);
          expect(detail.changedFiles.length).toBeGreaterThan(0);
          expect(
            detail.changedFiles.every((change) => change.withinOwnership),
          ).toBe(true);
          expect(
            detail.validations.some(
              (validation) =>
                validation.validationType === "task" &&
                validation.status === "passed",
            ),
          ).toBe(true);
          expect(
            detail.validations.some(
              (validation) =>
                validation.validationType === "integration" &&
                validation.status === "passed",
            ),
          ).toBe(true);
        }

        const backend = taskByBacklogId(completed, "BL-102");
        const backendPrompt = await requestJson<RuntimeDocument>(
          address,
          `/api/builds/${createdBuild.id}/tasks/${backend.id}/attempts/3/prompt`,
        );
        expect(backendPrompt).toMatchObject({ truncated: false });
        expect(backendPrompt.content).toContain("checkout-contract");
        expect(backendPrompt.content).toContain('"amount_cents": "number"');
        for (const document of [
          "jsonl",
          "stderr",
          "result",
          "outcome",
        ]) {
          const visible = await requestJson<RuntimeDocument>(
            address,
            `/api/builds/${createdBuild.id}/tasks/${backend.id}/attempts/3/${document}`,
          );
          expect(visible.path).toContain("attempt-3");
          expect(visible.truncated).toBe(false);
        }

        const integrationTask = taskByBacklogId(completed, "BL-104");
        const integrationPrompt = await requestJson<RuntimeDocument>(
          address,
          `/api/builds/${createdBuild.id}/tasks/${integrationTask.id}/attempts/1/prompt`,
        );
        expect(integrationPrompt.content).toContain("checkout-database");
        expect(integrationPrompt.content).toContain("checkout-provider");
        expect(integrationPrompt.content).toContain("checkout-consumer");

        const metrics = await requestJson<MetricsResponse>(
          address,
          `/api/builds/${createdBuild.id}/metrics`,
        );
        expect(metrics).toMatchObject({
          estimatedSequentialHours: 8,
          totalTasks: 5,
          integratedTasks: 5,
          failedTasks: 0,
          ownershipViolations: 0,
          actualElapsedSeconds: completed.actualElapsedSeconds,
        });
        expect(metrics.criticalPathHours).toBe(4);
        expect(metrics.expectedElapsedHours).toBeLessThan(
          metrics.estimatedSequentialHours,
        );
        expect(metrics.expectedSavingsPercent).toBeGreaterThan(0);

        const integrationBranch = await git(
          completed.integrationWorktree,
          ["branch", "--show-current"],
        );
        expect(integrationBranch.trim()).toBe(completed.integrationBranch);
        const integrationHead = (
          await git(completed.integrationWorktree, [
            "rev-parse",
            "--verify",
            "HEAD^{commit}",
          ])
        ).trim();
        expect(integrationHead).toBe(integrationTask.integrationCommit);
        expect(
          (
            await readFile(
              path.join(
                requirePath(completed.integrationWorktree),
                "backend/response.json",
              ),
              "utf8",
            )
          ).trim(),
        ).toContain('"amount_cents": 1999');
        expect(
          (
            await git(fixture.repositoryPath, [
              "rev-parse",
              "--verify",
              "main^{commit}",
            ])
          ).trim(),
        ).toBe(fixture.baseCommit);
        expect(
          await git(fixture.repositoryPath, [
            "log",
            "--first-parent",
            "--format=%s",
            completed.integrationBranch,
          ]),
        ).toContain("Merge branch");
      } finally {
        await runningApp?.app.close();
      }
    },
    90_000,
  );
});

async function createAcceptanceFixture(): Promise<AcceptanceFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "agentflow-acceptance-"));
  temporaryRoots.add(root);
  const repositoryPath = path.join(root, "repository");
  const runtimePath = path.join(root, "runtime");
  const fakeCodexPath = path.join(root, "fake-codex.mjs");
  const tracePath = path.join(root, "fake-codex-trace.jsonl");

  await Promise.all([
    mkdir(repositoryPath, { recursive: true }),
    mkdir(runtimePath, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(repositoryPath, ".agentflow.yaml"),
      AGENTFLOW_CONFIG,
      "utf8",
    ),
    writeFile(
      path.join(repositoryPath, "BACKLOG.md"),
      ACCEPTANCE_BACKLOG,
      "utf8",
    ),
    writeFile(fakeCodexPath, FAKE_CODEX_SOURCE, "utf8"),
    writeFile(tracePath, "", "utf8"),
  ]);
  await mkdir(path.join(repositoryPath, "scripts"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(repositoryPath, "scripts/validate-task.mjs"),
      TASK_VALIDATOR_SOURCE,
      "utf8",
    ),
    writeFile(
      path.join(repositoryPath, "scripts/validate-integration.mjs"),
      INTEGRATION_VALIDATOR_SOURCE,
      "utf8",
    ),
  ]);
  await chmod(fakeCodexPath, 0o700);

  await git(repositoryPath, ["init", "--initial-branch=main"]);
  await git(repositoryPath, ["config", "user.name", "AgentFlow Acceptance"]);
  await git(repositoryPath, [
    "config",
    "user.email",
    "agentflow-acceptance@localhost",
  ]);
  await git(repositoryPath, ["add", "--all"]);
  await git(repositoryPath, ["commit", "-m", "test: seed acceptance fixture"]);
  const baseCommit = (
    await git(repositoryPath, ["rev-parse", "--verify", "HEAD^{commit}"])
  ).trim();

  return {
    root,
    repositoryPath,
    runtimePath,
    fakeCodexPath,
    tracePath,
    baseCommit,
  };
}

async function requestJson<T>(
  address: string,
  route: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${address}${route}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${route} returned ${response.status}: ${text}`,
    );
  }
  return JSON.parse(text) as T;
}

async function waitForBuild(
  address: string,
  buildId: string,
  predicate: (build: BuildResponse) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<BuildResponse> {
  const deadline = Date.now() + timeoutMs;
  let latest: BuildResponse | undefined;
  while (Date.now() < deadline) {
    latest = await requestJson<BuildResponse>(
      address,
      `/api/builds/${buildId}`,
    );
    if (predicate(latest)) {
      return latest;
    }
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${description}. Latest build: ${JSON.stringify(
      latest,
    )}`,
  );
}

function taskByBacklogId(
  build: BuildResponse,
  backlogTaskId: string,
): BuildTask {
  const task = build.tasks.find(
    (candidate) => candidate.backlogTaskId === backlogTaskId,
  );
  if (task === undefined) {
    throw new Error(`Build ${build.id} has no task ${backlogTaskId}`);
  }
  return task;
}

function assertSerializedIntegrations(events: readonly BuildEvent[]): void {
  let activeTaskId: string | null = null;
  let starts = 0;
  for (const event of events) {
    if (event.type === "task.integration_started") {
      expect(
        activeTaskId,
        `integration for ${event.taskId ?? "unknown"} overlapped ${activeTaskId ?? "none"}`,
      ).toBeNull();
      activeTaskId = event.taskId;
      starts += 1;
    }
    if (
      activeTaskId === event.taskId &&
      ["integration.completed", "integration.failed"].includes(event.type)
    ) {
      activeTaskId = null;
    }
  }
  expect(activeTaskId).toBeNull();
  // Five successful task integrations plus BL-102's rejected attempt.
  expect(starts).toBe(6);
}

async function readTrace(tracePath: string): Promise<FakeCodexTrace[]> {
  return (await readFile(tracePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as unknown;
      return parsed as FakeCodexTrace;
    });
}

async function git(
  workingDirectory: string | null,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execFileAsync(
    "git",
    ["-C", requirePath(workingDirectory), ...arguments_],
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return result.stdout;
}

async function gitObjectExists(
  workingDirectory: string | null,
  object: string,
): Promise<boolean> {
  try {
    await git(workingDirectory, ["cat-file", "-e", object]);
    return true;
  } catch {
    return false;
  }
}

function requirePath(value: string | null): string {
  if (value === null) {
    throw new Error("Expected a filesystem path, received null");
  }
  return value;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
