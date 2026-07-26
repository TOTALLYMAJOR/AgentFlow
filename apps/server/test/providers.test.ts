import { describe, expect, it, vi } from "vitest";
import {
  CodingAgentProviderRegistry,
  type CodingAgentProvider,
} from "../src/workers/index.js";

describe("coding-agent provider registry", () => {
  it("returns configured providers deterministically", () => {
    const provider = {
      id: "fixture",
      execution: "local",
      start: vi.fn(),
    } satisfies CodingAgentProvider;
    const registry = new CodingAgentProviderRegistry([provider]);

    expect(registry.get("fixture")).toBe(provider);
    expect(registry.list()).toEqual([
      { id: "fixture", execution: "local" },
    ]);
  });

  it("rejects missing and duplicate providers", () => {
    expect(() => new CodingAgentProviderRegistry([])).toThrow(
      "At least one coding-agent provider is required",
    );
    const provider = {
      id: "fixture",
      execution: "local",
      start: vi.fn(),
    } satisfies CodingAgentProvider;
    expect(
      () => new CodingAgentProviderRegistry([provider, provider]),
    ).toThrow("Duplicate coding-agent provider: fixture");
    expect(
      () => new CodingAgentProviderRegistry([provider]).get("missing"),
    ).toThrow("Coding-agent provider is not configured: missing");
  });
});
