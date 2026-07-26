export interface RetryPolicy {
  maximumAttempts: number;
  baseDelayMs: number;
  maximumDelayMs: number;
  retryableFailureCodes: ReadonlySet<string>;
}

export interface RetryDecision {
  retry: boolean;
  reason: "scheduled" | "attempt_limit" | "non_retryable";
  delayMs: number;
  nextAttempt: number | null;
}

export const DEFAULT_RETRYABLE_FAILURE_CODES = new Set([
  "idle_timeout",
  "timeout",
  "process_disappeared",
  "spawn_error",
  "WORKER_PROCESS_DISAPPEARED",
  "REMOTE_LEASE_EXPIRED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
]);

export function decideRetry(
  attempt: number,
  failureCode: string,
  policy: RetryPolicy,
): RetryDecision {
  if (!policy.retryableFailureCodes.has(failureCode)) {
    return {
      retry: false,
      reason: "non_retryable",
      delayMs: 0,
      nextAttempt: null,
    };
  }
  if (attempt >= policy.maximumAttempts) {
    return {
      retry: false,
      reason: "attempt_limit",
      delayMs: 0,
      nextAttempt: null,
    };
  }
  const exponent = Math.max(0, attempt - 1);
  return {
    retry: true,
    reason: "scheduled",
    delayMs: Math.min(
      policy.maximumDelayMs,
      policy.baseDelayMs * 2 ** exponent,
    ),
    nextAttempt: attempt + 1,
  };
}
