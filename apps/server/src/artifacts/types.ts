import type {
  ArtifactEntity,
  TaskManifestEntity,
  TaskManifestStatus,
} from "../db/index.js";

export const HANDOFF_MANIFEST_SCHEMA_VERSION = "1.0.0";

export interface ManifestArtifactReference {
  name: string;
  type: string;
  version: string;
  path?: string;
  sha256?: string;
  producerTaskId?: string;
}

export interface HandoffManifest {
  schemaVersion: typeof HANDOFF_MANIFEST_SCHEMA_VERSION;
  buildId: string;
  taskId: string;
  backlogTaskId: string;
  status: TaskManifestStatus;
  baseCommit: string;
  resultCommit: string;
  integrationCommit: string | null;
  branch: string;
  changedFiles: string[];
  consumes: ManifestArtifactReference[];
  produces: ManifestArtifactReference[];
  validation: {
    task: "passed";
    integration: "pending" | "passed";
  };
}

export interface PublishHandoffInput {
  buildId: string;
  taskId: string;
  backlogTaskId: string;
  status: TaskManifestStatus;
  baseCommit: string;
  resultCommit: string;
  integrationCommit?: string | null;
  branch: string;
  worktreePath: string;
  changedFiles: string[];
  consumes: Array<{
    name: string;
    version: string;
  }>;
  produces: Array<{
    name: string;
    type: string;
    version: string;
    path?: string;
  }>;
}

export interface HandoffPublication {
  manifest: HandoffManifest;
  record: TaskManifestEntity;
  artifacts: ArtifactEntity[];
}

export class ArtifactRegistryError extends Error {
  constructor(
    readonly code:
      | "ARTIFACT_NOT_INTEGRATED"
      | "ARTIFACT_DUPLICATE"
      | "ARTIFACT_PATH_INVALID"
      | "ARTIFACT_PRODUCER_MISMATCH"
      | "MANIFEST_IMMUTABLE_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactRegistryError";
  }
}
