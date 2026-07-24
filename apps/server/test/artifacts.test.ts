import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactRegistryError,
  ContractGovernanceService,
  HandoffManifestService,
  classifyContractChange,
} from "../src/artifacts/index.js";
import { createDatabaseRepositories } from "../src/db/index.js";
import {
  createDatabaseFixture,
  type DatabaseFixture,
} from "./helpers/database-fixture.js";

describe("handoff manifests and artifact registry", () => {
  let fixture: DatabaseFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("publishes immutable validated and integrated handoffs with exact-version consumption", async () => {
    fixture = createDatabaseFixture();
    const store = createStore(fixture);
    const worktree = path.join(fixture.directory, "worktree");
    mkdirSync(path.join(worktree, "contracts"), { recursive: true });
    writeFileSync(
      path.join(worktree, "contracts", "checkout.json"),
      '{"type":"object"}\n',
    );
    const service = new HandoffManifestService(
      store,
      path.join(fixture.directory, "artifacts"),
    );
    const common = {
      buildId: "build_1",
      taskId: "task_contract",
      backlogTaskId: "BL-100",
      attempt: 1,
      baseCommit: "base",
      resultCommit: "result",
      branch: "agent/build_1/BL-100",
      worktreePath: worktree,
      changedFiles: ["contracts/checkout.json"],
      consumes: [],
      produces: [
        {
          name: "checkout-api",
          type: "openapi",
          version: "1.0.0",
          path: "contracts/checkout.json",
        },
      ],
    };

    const validated = await service.publish({
      ...common,
      status: "validated",
    });
    expect(validated.artifacts[0]).toMatchObject({
      name: "checkout-api",
      version: "1.0.0",
      status: "validated",
    });
    expect(validated.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      service.requireIntegratedArtifact(
        "build_1",
        "checkout-api",
        "1.0.0",
      ),
    ).toThrow(ArtifactRegistryError);

    const integrated = await service.publish({
      ...common,
      status: "integrated",
      integrationCommit: "integration",
    });
    expect(integrated.artifacts[0]?.status).toBe("integrated");
    expect(
      service.downstreamContext("build_1", [
        { name: "checkout-api", version: "1.0.0" },
      ]).manifests,
    ).toHaveLength(1);

    const replay = await service.publish({
      ...common,
      status: "integrated",
      integrationCommit: "integration",
    });
    expect(replay.record.id).toBe(integrated.record.id);
    expect(store.manifests.listForBuild("build_1")).toHaveLength(2);
  });

  it("detects a duplicate name and exact version from another producer", async () => {
    fixture = createDatabaseFixture();
    const store = createStore(fixture);
    const worktree = path.join(fixture.directory, "worktree");
    mkdirSync(worktree, { recursive: true });
    const service = new HandoffManifestService(
      store,
      path.join(fixture.directory, "artifacts"),
    );
    await service.publish({
      buildId: "build_1",
      taskId: "task_contract",
      backlogTaskId: "BL-100",
      attempt: 1,
      status: "validated",
      baseCommit: "base",
      resultCommit: "result-a",
      branch: "agent/build_1/BL-100",
      worktreePath: worktree,
      changedFiles: [],
      consumes: [],
      produces: [
        { name: "checkout-api", type: "schema", version: "1.0.0" },
      ],
    });

    await expect(
      service.publish({
        buildId: "build_1",
        taskId: "task_backend",
        backlogTaskId: "BL-101",
        attempt: 1,
        status: "validated",
        baseCommit: "base",
        resultCommit: "result-b",
        branch: "agent/build_1/BL-101",
        worktreePath: worktree,
        changedFiles: [],
        consumes: [],
        produces: [
          { name: "checkout-api", type: "schema", version: "1.0.0" },
        ],
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_DUPLICATE" });
  });

  it("preserves attempt manifests while replacing only a non-integrated artifact revision", async () => {
    fixture = createDatabaseFixture();
    const store = createStore(fixture);
    const worktree = path.join(fixture.directory, "worktree");
    mkdirSync(path.join(worktree, "contracts"), { recursive: true });
    const contractPath = path.join(worktree, "contracts", "checkout.json");
    writeFileSync(contractPath, '{"revision":1}\n');
    const service = new HandoffManifestService(
      store,
      path.join(fixture.directory, "artifacts"),
    );
    const publication = {
      buildId: "build_1",
      taskId: "task_contract",
      backlogTaskId: "BL-100",
      status: "validated" as const,
      baseCommit: "base",
      branch: "agent/build_1/BL-100",
      worktreePath: worktree,
      changedFiles: ["contracts/checkout.json"],
      consumes: [],
      produces: [
        {
          name: "checkout-api",
          type: "json-schema",
          version: "1.0.0",
          path: "contracts/checkout.json",
        },
      ],
    };

    const first = await service.publish({
      ...publication,
      attempt: 1,
      resultCommit: "result-1",
    });
    writeFileSync(contractPath, '{"revision":2}\n');
    const second = await service.publish({
      ...publication,
      attempt: 2,
      resultCommit: "result-2",
    });

    expect(second.artifacts[0]?.id).toBe(first.artifacts[0]?.id);
    expect(second.artifacts[0]?.sha256).not.toBe(first.artifacts[0]?.sha256);
    expect(store.manifests.listForBuild("build_1")).toHaveLength(2);
    expect(
      store.manifests
        .listForBuild("build_1")
        .map((manifest) => manifest.attempt),
    ).toEqual([1, 2]);

    await service.publish({
      ...publication,
      attempt: 2,
      status: "integrated",
      resultCommit: "result-2",
      integrationCommit: "integration-2",
    });
    writeFileSync(contractPath, '{"revision":3}\n');
    await expect(
      service.publish({
        ...publication,
        attempt: 3,
        resultCommit: "result-3",
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_DUPLICATE" });
  });

  it("classifies contract compatibility and governs breaking changes", () => {
    expect(
      classifyContractChange(
        { type: "object", description: "old" },
        { type: "object", description: "new" },
      ).level,
    ).toBe("patch");
    expect(
      classifyContractChange(
        { type: "object", properties: { id: { type: "string" } } },
        {
          type: "object",
          properties: {
            id: { type: "string" },
            note: { type: "string" },
          },
        },
      ).level,
    ).toBe("minor");
    expect(
      classifyContractChange(
        {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        {
          type: "object",
          required: ["id", "email"],
          properties: {
            id: { type: "string" },
            email: { type: "string" },
          },
        },
      ).level,
    ).toBe("major");

    fixture = createDatabaseFixture();
    const store = createStore(fixture);
    const generated = store.artifacts.publish({
      id: "artifact_client",
      buildId: "build_1",
      producerTaskId: "task_backend",
      name: "checkout-client",
      artifactType: "generated-client",
      version: "1.0.0",
      status: "integrated",
    });
    const result = new ContractGovernanceService(store).governMajorChange({
      buildId: "build_1",
      producerTaskId: "task_contract",
      artifactName: "checkout-api",
      previousContract: {
        type: "object",
        properties: { id: { type: "string" } },
      },
      currentContract: { type: "object", properties: {} },
    });

    expect(result.classification.level).toBe("major");
    expect(result.affectedTaskIds).toEqual(["task_backend"]);
    expect(result.invalidatedArtifactIds).toEqual([generated.id]);
    expect(store.artifacts.getById(generated.id).status).toBe("invalidated");
    expect(store.approvals.listPending("build_1")).toHaveLength(1);
  });
});

function createStore(fixture: DatabaseFixture) {
  const store = createDatabaseRepositories(fixture.database);
  store.repositories.create({
    id: "repository_1",
    name: "Repository",
    localPath: path.join(fixture.directory, "repository"),
    configPath: path.join(fixture.directory, "repository", ".agentflow.yaml"),
    baseBranch: "main",
  });
  store.builds.create({
    id: "build_1",
    repositoryId: "repository_1",
    backlogPath: "BACKLOG.md",
    baseCommit: "base",
    integrationBranch: "agent-integration/build_1",
    status: "running",
    tasks: [
      {
        id: "task_contract",
        backlogTaskId: "BL-100",
        title: "Contract",
        description: "Define contract",
        acceptanceCriteria: ["Contract exists"],
      },
      {
        id: "task_backend",
        backlogTaskId: "BL-101",
        title: "Backend",
        description: "Implement provider",
        acceptanceCriteria: ["Provider passes"],
        dependencies: [
          {
            dependencyTaskId: "task_contract",
            dependencyType: "artifact",
            requiredArtifactName: "checkout-api",
            requiredArtifactVersion: "1.0.0",
          },
        ],
      },
    ],
  });
  return store;
}
