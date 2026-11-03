import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerErrorHandling } from "../../server/src/http/errors.js";
import { ApiClientError, apiFetch, postJson } from "../src/api/client.js";

interface Echo {
  method: string;
  hasBody: boolean;
  body: unknown;
  contentType: string | null;
  callerHeader: string | string[] | null;
}

describe("web client through the native Fastify parser", () => {
  let app: FastifyInstance;
  let handlerCalls: number;
  let parserErrors: string[];
  let lastStatus: number;
  let lastRequest: Request;
  let lastInit: RequestInit | undefined;

  beforeEach(async () => {
    handlerCalls = 0;
    parserErrors = [];
    lastStatus = 0;
    app = Fastify({ logger: false });
    registerErrorHandling(app);
    app.addHook("onError", (_request, _reply, error, done) => {
      parserErrors.push(error.code);
      done();
    });
    app.route({
      method: ["GET", "POST", "DELETE"],
      url: "/client-probe",
      handler(request, reply) {
        handlerCalls += 1;
        return reply.send({
          method: request.method,
          hasBody: request.body !== undefined,
          body: request.body ?? null,
          contentType: request.headers["content-type"] ?? null,
          callerHeader: request.headers["x-client-fixture"] ?? null,
        } satisfies Echo);
      },
    });
    app.get("/no-content", (_request, reply) => reply.status(204).send());
    await app.ready();

    // Keep the real client, Web Request serialization, Fastify parser and native error handler.
    // Only transport is adapted to in-process injection; no listener/provider/runtime is started.
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      lastInit = init;
      const request = new Request(new URL(input, "http://127.0.0.1"), init);
      lastRequest = request;
      const payload = request.body === null
        ? undefined
        : Buffer.from(await request.arrayBuffer());
      const response = await app.inject({
        method: request.method as "GET" | "POST" | "DELETE",
        url: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers.entries()),
        ...(payload === undefined ? {} : { payload }),
      });
      lastStatus = response.statusCode;
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) headers.append(name, entry);
        } else if (value !== undefined) {
          headers.set(name, String(value));
        }
      }
      return new Response(response.statusCode === 204 ? null : response.body, {
        status: response.statusCode,
        headers,
      });
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it("sends a genuinely bodyless POST and reaches the native handler", async () => {
    const outcome = await postJson<Echo>("/client-probe").then(
      (value) => ({ ok: true, value }),
      (cause: unknown) => {
        if (!(cause instanceof ApiClientError)) throw cause;
        return { ok: false, status: cause.status, code: cause.code, parserCode: parserErrors.at(-1) };
      },
    );
    expect(outcome).toEqual({
      ok: true,
      value: { method: "POST", hasBody: false, body: null, contentType: null, callerHeader: null },
    });
    expect(lastStatus).toBe(200);
    expect(handlerCalls).toBe(1);
    expect(parserErrors).toEqual([]);
  });

  it("serializes supplied JSON bytes with the matching content type", async () => {
    const body = { planId: "fixture-plan", approved: true };
    await expect(postJson<Echo>("/client-probe", body)).resolves.toEqual({
      method: "POST", hasBody: true, body, contentType: "application/json", callerHeader: null,
    });
    expect(lastInit?.body).toBe(JSON.stringify(body));
    expect(lastStatus).toBe(200);
  });

  it("preserves caller headers, text body and request options", async () => {
    const headers = new Headers({ "Content-Type": "text/plain", "X-Client-Fixture": "preserved" });
    const controller = new AbortController();
    await expect(apiFetch<Echo>("/client-probe", {
      method: "POST", headers, body: "plain fixture text", cache: "no-store",
      credentials: "same-origin", signal: controller.signal,
    })).resolves.toEqual({
      method: "POST", hasBody: true, body: "plain fixture text", contentType: "text/plain", callerHeader: "preserved",
    });
    expect(headers.get("content-type")).toBe("text/plain");
    expect(lastInit?.cache).toBe("no-store");
    expect(lastInit?.credentials).toBe("same-origin");
    expect(lastInit?.signal).toBe(controller.signal);
  });

  it.each(["GET", "DELETE"] as const)("does not attach JSON content type to bodyless %s", async (method) => {
    await expect(apiFetch<Echo>("/client-probe", { method })).resolves.toEqual({
      method, hasBody: false, body: null, contentType: null, callerHeader: null,
    });
    expect(handlerCalls).toBe(1);
  });

  it("leaves FormData serialization and content type to Fetch", async () => {
    const body = new FormData();
    body.set("fixture", "retained");
    await expect(apiFetch("/client-probe", { method: "POST", body })).rejects.toBeInstanceOf(ApiClientError);
    expect(lastInit?.body).toBe(body);
    expect(lastRequest.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/u);
    expect(body.get("fixture")).toBe("retained");
    expect(parserErrors).toContain("FST_ERR_CTP_INVALID_MEDIA_TYPE");
    expect(handlerCalls).toBe(0);
  });

  it("preserves an explicit JSON header and the native empty-JSON refusal", async () => {
    await expect(apiFetch("/client-probe", {
      method: "POST", headers: { "Content-Type": "application/json" },
    })).rejects.toBeInstanceOf(ApiClientError);
    expect(lastStatus).toBeGreaterThanOrEqual(400);
    expect(parserErrors).toContain("FST_ERR_CTP_EMPTY_JSON_BODY");
    expect(handlerCalls).toBe(0);
  });

  it("preserves no-content response handling", async () => {
    await expect(apiFetch("/no-content")).resolves.toBeUndefined();
    expect(lastStatus).toBe(204);
  });
});
