import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactEntity,
  DatabaseRepositories,
  TaskManifestEntity,
} from "../db/index.js";
import { createId } from "../util/ids.js";
import {
  ArtifactRegistryError,
  HANDOFF_MANIFEST_SCHEMA_VERSION,
  type HandoffManifest,
  type HandoffPublication,
  type ManifestArtifactReference,
  type PublishHandoffInput,
} from "./types.js";

export class HandoffManifestService {
  constructor(
    private readonly store: DatabaseRepositories,
    private readonly artifactsRoot: string,
  ) {}

  async publish(input: PublishHandoffInput): Promise<HandoffPublication> {
    const validated =
      input.status === "integrated"
        ? this.requireValidatedManifest(input)
        : undefined;
    const consumed =
      validated?.consumes ??
      input.consumes.map(({ name, version }) => {
        const artifact = this.requireIntegratedArtifact(
          input.buildId,
          name,
          version,
        );
        return {
          name: artifact.name,
          type: artifact.artifactType,
          version: artifact.version,
          ...(artifact.repositoryPath === null
            ? {}
            : { path: artifact.repositoryPath }),
          ...(artifact.sha256 === null ? {} : { sha256: artifact.sha256 }),
          producerTaskId: artifact.producerTaskId,
        } satisfies ManifestArtifactReference;
      });
    const produced =
      validated?.produces ??
      (await Promise.all(
        input.produces.map(async (artifact) =>
          this.describeProducedArtifact(input.worktreePath, artifact),
        ),
      ));
    const manifest: HandoffManifest = {
      schemaVersion: HANDOFF_MANIFEST_SCHEMA_VERSION,
      buildId: input.buildId,
      taskId: input.taskId,
      backlogTaskId: input.backlogTaskId,
      attempt: input.attempt,
      status: input.status,
      baseCommit: input.baseCommit,
      resultCommit: input.resultCommit,
      integrationCommit: input.integrationCommit ?? null,
      branch: input.branch,
      changedFiles:
        validated?.changedFiles ??
        [...new Set(input.changedFiles)].sort(),
      consumes: consumed.sort(compareArtifactReferences),
      produces: produced.sort(compareArtifactReferences),
      validation: {
        task: "passed",
        integration: input.status === "integrated" ? "passed" : "pending",
      },
    };
    const contents = `${JSON.stringify(manifest, null, 2)}\n`;
    const sha256 = sha256Text(contents);
    const manifestPath = this.manifestPath(input);
    const existing = this.store.manifests.findForTask(
      input.taskId,
      input.status,
      input.attempt,
    );
    if (existing !== undefined) {
      if (existing.sha256 !== sha256) {
        throw new ArtifactRegistryError(
          "MANIFEST_IMMUTABLE_CONFLICT",
          `The ${input.status} manifest for ${input.taskId} is immutable and differs from the requested publication`,
        );
      }
      return {
        manifest: existing.manifest as unknown as HandoffManifest,
        record: existing,
        artifacts: this.artifactsForTask(input.buildId, input.taskId),
      };
    }

    await writeImmutableFile(manifestPath, contents);
    const artifacts =
      input.status === "validated"
        ? this.registerValidatedArtifacts(input, produced, manifestPath)
        : this.promoteIntegratedArtifacts(input, produced);
    let record: TaskManifestEntity;
    try {
      record = this.store.manifests.create({
        id: createId("manifest"),
        buildId: input.buildId,
        taskId: input.taskId,
        attempt: input.attempt,
        status: input.status,
        schemaVersion: HANDOFF_MANIFEST_SCHEMA_VERSION,
        manifestPath,
        sha256,
        manifest: manifest as unknown as Record<string, unknown>,
      });
    } catch (error) {
      const raced = this.store.manifests.findForTask(
        input.taskId,
        input.status,
        input.attempt,
      );
      if (raced === undefined || raced.sha256 !== sha256) {
        throw error;
      }
      record = raced;
    }
    return { manifest, record, artifacts };
  }

  requireIntegratedArtifact(
    buildId: string,
    name: string,
    version: string,
  ): ArtifactEntity {
    const artifact = this.store.artifacts.findExact(buildId, name, version);
    if (artifact === undefined || artifact.status !== "integrated") {
      throw new ArtifactRegistryError(
        "ARTIFACT_NOT_INTEGRATED",
        `Artifact ${name}@${version} is not integrated in build ${buildId}`,
      );
    }
    return artifact;
  }

  downstreamContext(
    buildId: string,
    requirements: readonly { name: string; version: string }[],
  ): {
    artifacts: ArtifactEntity[];
    manifests: TaskManifestEntity[];
  } {
    const artifacts = requirements.map(({ name, version }) =>
      this.requireIntegratedArtifact(buildId, name, version),
    );
    const manifests = [
      ...new Map(
        artifacts.map((artifact) => {
          const manifest = this.store.manifests.findForTask(
            artifact.producerTaskId,
            "integrated",
          );
          if (manifest === undefined) {
            throw new ArtifactRegistryError(
              "ARTIFACT_NOT_INTEGRATED",
              `Integrated artifact ${artifact.name}@${artifact.version} has no integrated handoff manifest`,
            );
          }
          return [manifest.id, manifest] as const;
        }),
      ).values(),
    ];
    return { artifacts, manifests };
  }

  private manifestPath(input: PublishHandoffInput): string {
    return path.join(
      path.resolve(this.artifactsRoot),
      safeSegment(input.buildId),
      safeSegment(input.taskId),
      `attempt-${input.attempt}.${input.status}.manifest.json`,
    );
  }

  private async describeProducedArtifact(
    worktreePath: string,
    artifact: PublishHandoffInput["produces"][number],
  ): Promise<ManifestArtifactReference> {
    if (artifact.path === undefined) {
      return {
        name: artifact.name,
        type: artifact.type,
        version: artifact.version,
      };
    }
    const resolved = await resolveRepositoryArtifact(
      worktreePath,
      artifact.path,
    );
    const metadata = await lstat(resolved);
    return {
      name: artifact.name,
      type: artifact.type,
      version: artifact.version,
      path: normalizeRelativePath(artifact.path),
      ...(metadata.isFile() ? { sha256: await sha256File(resolved) } : {}),
    };
  }

  private requireValidatedManifest(
    input: PublishHandoffInput,
  ): HandoffManifest {
    const record = this.store.manifests.findForTask(
      input.taskId,
      "validated",
      input.attempt,
    );
    if (record === undefined) {
      throw new ArtifactRegistryError(
        "VALIDATED_MANIFEST_MISSING",
        `Task ${input.taskId} attempt ${input.attempt} has no validated handoff manifest`,
      );
    }
    const manifest = record.manifest as unknown as HandoffManifest;
    if (
      manifest.buildId !== input.buildId ||
      manifest.taskId !== input.taskId ||
      manifest.backlogTaskId !== input.backlogTaskId ||
      manifest.attempt !== input.attempt ||
      manifest.baseCommit !== input.baseCommit ||
      manifest.resultCommit !== input.resultCommit ||
      manifest.branch !== input.branch
    ) {
      throw new ArtifactRegistryError(
        "MANIFEST_CONTEXT_MISMATCH",
        `Integrated handoff context differs from the validated manifest for ${input.taskId} attempt ${input.attempt}`,
      );
    }
    return manifest;
  }

  private registerValidatedArtifacts(
    input: PublishHandoffInput,
    produced: readonly ManifestArtifactReference[],
    manifestPath: string,
  ): ArtifactEntity[] {
    return produced.map((artifact) => {
      const existing = this.store.artifacts.findExact(
        input.buildId,
        artifact.name,
        artifact.version,
      );
      if (existing !== undefined) {
        if (existing.producerTaskId !== input.taskId) {
          throw new ArtifactRegistryError(
            "ARTIFACT_DUPLICATE",
            `Artifact ${artifact.name}@${artifact.version} already has a different producer`,
          );
        }
        const payloadMatches =
          existing.artifactType === artifact.type &&
          existing.repositoryPath === (artifact.path ?? null) &&
          existing.sha256 === (artifact.sha256 ?? null);
        if (payloadMatches && existing.status === "validated") {
          return existing;
        }
        if (existing.status === "integrated") {
          throw new ArtifactRegistryError(
            "ARTIFACT_DUPLICATE",
            `Integrated artifact ${artifact.name}@${artifact.version} is immutable; publish a new version`,
          );
        }
        return this.store.artifacts.replaceValidated(existing.id, {
          artifactType: artifact.type,
          repositoryPath: artifact.path ?? null,
          storagePath: manifestPath,
          sha256: artifact.sha256 ?? null,
          metadata: {
            manifestPath,
            manifestStatus: "validated",
            attempt: input.attempt,
          },
        });
      }
      return this.store.artifacts.publish({
        id: createId("artifact"),
        buildId: input.buildId,
        producerTaskId: input.taskId,
        name: artifact.name,
        artifactType: artifact.type,
        version: artifact.version,
        repositoryPath: artifact.path ?? null,
        storagePath: manifestPath,
        sha256: artifact.sha256 ?? null,
        status: "validated",
        metadata: {
          manifestPath,
          manifestStatus: "validated",
          attempt: input.attempt,
        },
      });
    });
  }

  private promoteIntegratedArtifacts(
    input: PublishHandoffInput,
    produced: readonly ManifestArtifactReference[],
  ): ArtifactEntity[] {
    return produced.map((artifact) => {
      const existing = this.store.artifacts.findExact(
        input.buildId,
        artifact.name,
        artifact.version,
      );
      if (existing === undefined) {
        throw new ArtifactRegistryError(
          "ARTIFACT_PRODUCER_MISMATCH",
          `Artifact ${artifact.name}@${artifact.version} was not published by validation`,
        );
      }
      if (existing.producerTaskId !== input.taskId) {
        throw new ArtifactRegistryError(
          "ARTIFACT_PRODUCER_MISMATCH",
          `Artifact ${artifact.name}@${artifact.version} belongs to another producer`,
        );
      }
      if (
        existing.artifactType !== artifact.type ||
        existing.repositoryPath !== (artifact.path ?? null) ||
        existing.sha256 !== (artifact.sha256 ?? null)
      ) {
        throw new ArtifactRegistryError(
          "ARTIFACT_PAYLOAD_MISMATCH",
          `Artifact ${artifact.name}@${artifact.version} differs from its validated handoff`,
        );
      }
      return existing.status === "integrated"
        ? existing
        : this.store.artifacts.setStatus(existing.id, "integrated");
    });
  }

  private artifactsForTask(buildId: string, taskId: string): ArtifactEntity[] {
    return this.store.artifacts
      .listForBuild(buildId)
      .filter((artifact) => artifact.producerTaskId === taskId);
  }
}

async function resolveRepositoryArtifact(
  worktreePath: string,
  repositoryPath: string,
): Promise<string> {
  const normalized = normalizeRelativePath(repositoryPath);
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new ArtifactRegistryError(
      "ARTIFACT_PATH_INVALID",
      `Artifact path must stay within the task worktree: ${repositoryPath}`,
    );
  }
  const root = await realpath(worktreePath);
  const target = await realpath(path.resolve(root, normalized));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new ArtifactRegistryError(
      "ARTIFACT_PATH_INVALID",
      `Artifact path escapes the task worktree: ${repositoryPath}`,
    );
  }
  return target;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function safeSegment(value: string): string {
  if (/^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..") {
    return value;
  }
  return `id-${sha256Text(value).slice(0, 20)}`;
}

function compareArtifactReferences(
  first: ManifestArtifactReference,
  second: ManifestArtifactReference,
): number {
  return (
    first.name.localeCompare(second.name) ||
    first.version.localeCompare(second.version)
  );
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function writeImmutableFile(
  destination: string,
  contents: string,
): Promise<void> {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, contents, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporary, destination);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
    const existing = await readFile(destination, "utf8");
    if (existing !== contents) {
      throw new ArtifactRegistryError(
        "MANIFEST_IMMUTABLE_CONFLICT",
        `Manifest file already exists with different content: ${destination}`,
      );
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
