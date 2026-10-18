import path from "node:path";

export async function requestApi<T = unknown>(base: string, home: string, method: string, url: string, payload?: Record<string, unknown>): Promise<T> {
  let health: Response;
  try {
    health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new Error(`AgentFlow server is unavailable at ${base}. Run agentflow serve in another terminal, or agentflow service start, then retry.`);
  }
  const identity = await health.json() as { runtime?: { home?: string } };
  if (!health.ok || identity.runtime?.home === undefined || path.resolve(identity.runtime.home) !== path.resolve(home)) {
    throw new Error("The server at this port uses a different AGENTFLOW_HOME or is not AgentFlow. Use the matching home and port.");
  }
  // Never automatically retry mutations: a lost response may follow a successful write.
  let response: Response;
  try {
    response = await fetch(`${base}${url}`, {
      method,
      ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
    });
  } catch (cause) {
    throw new Error("Connection lost. The operation may have succeeded; inspect agentflow status and repository state before repeating it.", { cause });
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) {
    const error = body as { error?: { code?: string; message?: string; details?: unknown } };
    throw new Error(`${error.error?.code ?? response.status}: ${error.error?.message ?? response.statusText}${error.error?.details === undefined ? "" : `\n${JSON.stringify(error.error.details, null, 2)}`}`);
  }
  return body as T;
}
