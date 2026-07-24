import type {
  DetectedStack,
  RepositoryRecord,
} from "../domain/types.js";

import type { RepositoryPersistence } from "./types.js";

type MaybePromise<T> = T | Promise<T>;

/**
 * Minimal shape implemented by the SQLite repository registry. Keeping this
 * structural avoids coupling repository inspection to a particular database
 * library or migration module.
 */
export interface RepositoryMetadataStore {
  create(record: RepositoryRecord): MaybePromise<RepositoryRecord>;
  list(): MaybePromise<RepositoryRecord[]>;
  findById(id: string): MaybePromise<RepositoryRecord | undefined>;
  findByLocalPath(
    localPath: string,
  ): MaybePromise<RepositoryRecord | undefined>;
  update(
    id: string,
    input: {
      name?: string;
      configPath?: string;
      baseBranch?: string;
      remoteName?: string | null;
      status?: RepositoryRecord["status"];
      detectedStack?: DetectedStack;
      updatedAt?: string;
    },
  ): MaybePromise<RepositoryRecord>;
  remove(id: string): MaybePromise<boolean>;
}

export function adaptRepositoryPersistence(
  store: RepositoryMetadataStore,
): RepositoryPersistence {
  return {
    async create(record) {
      return await store.create(record);
    },
    async list() {
      return await store.list();
    },
    async getById(id) {
      return (await store.findById(id)) ?? null;
    },
    async getByLocalPath(localPath) {
      return (await store.findByLocalPath(localPath)) ?? null;
    },
    async update(record) {
      return await store.update(record.id, {
        name: record.name,
        configPath: record.configPath,
        baseBranch: record.baseBranch,
        remoteName: record.remoteName,
        status: record.status,
        detectedStack: record.detectedStack,
        updatedAt: record.updatedAt,
      });
    },
    async deleteById(id) {
      return await store.remove(id);
    },
  };
}
