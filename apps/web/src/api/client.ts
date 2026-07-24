import type { ApiErrorPayload } from "./types.js";

const jsonHeaders = {
  "content-type": "application/json",
} as const;

export class ApiClientError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function apiFetch<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", jsonHeaders["content-type"]);
  const response = await fetch(input, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | ApiErrorPayload
      | null;
    throw new ApiClientError(
      payload?.error.code ?? "REQUEST_FAILED",
      payload?.error.message ?? `Request failed with status ${response.status}`,
      response.status,
      payload?.error.details,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function postJson<T>(
  input: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method: "POST" }
      : { method: "POST", body: JSON.stringify(body) };
  return apiFetch<T>(input, init);
}
