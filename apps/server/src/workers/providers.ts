import { startCodexWorker } from "./runtime.js";
import type { CodexWorkerHandle, CodexWorkerOptions } from "./types.js";

export type CodingAgentStartOptions = Omit<CodexWorkerOptions, "executable">;

export interface CodingAgentProvider {
  readonly id: string;
  readonly execution: "local";
  start(options: CodingAgentStartOptions): Promise<CodexWorkerHandle>;
}

export class CodexCodingAgentProvider implements CodingAgentProvider {
  readonly id = "codex";
  readonly execution = "local" as const;

  constructor(private readonly executable: string) {}

  start(options: CodingAgentStartOptions): Promise<CodexWorkerHandle> {
    return startCodexWorker({ ...options, executable: this.executable });
  }
}

export class CodingAgentProviderRegistry {
  private readonly providers = new Map<string, CodingAgentProvider>();

  constructor(providers: readonly CodingAgentProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new Error(`Duplicate coding-agent provider: ${provider.id}`);
      }
      this.providers.set(provider.id, provider);
    }
    if (this.providers.size === 0) {
      throw new Error("At least one coding-agent provider is required");
    }
  }

  get(id: string): CodingAgentProvider {
    const provider = this.providers.get(id);
    if (provider === undefined) {
      throw new Error(`Coding-agent provider is not configured: ${id}`);
    }
    return provider;
  }

  list(): Array<{ id: string; execution: CodingAgentProvider["execution"] }> {
    return [...this.providers.values()]
      .map(({ id, execution }) => ({ id, execution }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
