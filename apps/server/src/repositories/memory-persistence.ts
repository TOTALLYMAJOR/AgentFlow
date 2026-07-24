import type { RepositoryRecord } from "../domain/types.js";

import { RepositoryServiceError } from "./errors.js";
import type { RepositoryPersistence } from "./types.js";

export class MemoryRepositoryPersistence implements RepositoryPersistence {
  readonly #records = new Map<string, RepositoryRecord>();

  public create(record: RepositoryRecord): Promise<RepositoryRecord> {
    if (
      this.#records.has(record.id) ||
      [...this.#records.values()].some(
        (candidate) => candidate.localPath === record.localPath,
      )
    ) {
      throw new RepositoryServiceError(
        "REPOSITORY_ALREADY_REGISTERED",
        `Repository ${record.localPath} is already registered`,
        409,
      );
    }
    this.#records.set(record.id, cloneRecord(record));
    return Promise.resolve(cloneRecord(record));
  }

  public list(): Promise<RepositoryRecord[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(cloneRecord),
    );
  }

  public getById(id: string): Promise<RepositoryRecord | null> {
    const record = this.#records.get(id);
    return Promise.resolve(record === undefined ? null : cloneRecord(record));
  }

  public getByLocalPath(
    localPath: string,
  ): Promise<RepositoryRecord | null> {
    const record = [...this.#records.values()].find(
      (candidate) => candidate.localPath === localPath,
    );
    return Promise.resolve(record === undefined ? null : cloneRecord(record));
  }

  public update(record: RepositoryRecord): Promise<RepositoryRecord> {
    if (!this.#records.has(record.id)) {
      throw new RepositoryServiceError(
        "REPOSITORY_NOT_FOUND",
        `Repository ${record.id} is not registered`,
        404,
      );
    }
    this.#records.set(record.id, cloneRecord(record));
    return Promise.resolve(cloneRecord(record));
  }

  public deleteById(id: string): Promise<boolean> {
    return Promise.resolve(this.#records.delete(id));
  }
}

function cloneRecord(record: RepositoryRecord): RepositoryRecord {
  return structuredClone(record);
}
