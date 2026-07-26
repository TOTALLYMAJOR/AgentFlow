import { describe, expect, it } from "vitest";
import {
  decideRetry,
  DEFAULT_RETRYABLE_FAILURE_CODES,
} from "../src/orchestration/retry-policy.js";

const policy = {
  maximumAttempts: 4,
  baseDelayMs: 1_000,
  maximumDelayMs: 2_500,
  retryableFailureCodes: DEFAULT_RETRYABLE_FAILURE_CODES,
};

describe("automatic retry policy", () => {
  it("uses deterministic capped exponential backoff", () => {
    expect(decideRetry(1, "timeout", policy)).toEqual({
      retry: true,
      reason: "scheduled",
      delayMs: 1_000,
      nextAttempt: 2,
    });
    expect(decideRetry(2, "timeout", policy)).toMatchObject({
      retry: true,
      delayMs: 2_000,
      nextAttempt: 3,
    });
    expect(decideRetry(3, "timeout", policy)).toMatchObject({
      retry: true,
      delayMs: 2_500,
      nextAttempt: 4,
    });
  });

  it("stops at the attempt limit and rejects deterministic failures", () => {
    expect(decideRetry(4, "timeout", policy)).toMatchObject({
      retry: false,
      reason: "attempt_limit",
    });
    expect(decideRetry(1, "structured_result_invalid", policy)).toMatchObject({
      retry: false,
      reason: "non_retryable",
    });
  });
});
