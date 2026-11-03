import Fastify, { errorCodes, type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentFlowError, registerErrorHandling } from "../src/http/errors.js";

const applications = new Set<FastifyInstance>();
const privateFixture = "PRIVATE_CREDENTIAL_FIXTURE_DO_NOT_ECHO";

afterEach(async () => {
  await Promise.all([...applications].map(async (app) => {
    applications.delete(app);
    await app.close();
  }));
});

describe("native HTTP error classification", () => {
  it.each([
    { name: "empty JSON", payload: "", headers: { "content-type": "application/json" }, status: 400, code: "FST_ERR_CTP_EMPTY_JSON_BODY", message: "JSON request body cannot be empty." },
    { name: "malformed JSON", payload: `{"credential":"${privateFixture}", invalid}`, headers: { "content-type": "application/json" }, status: 400, code: "FST_ERR_CTP_INVALID_JSON_BODY", message: "Request body is not valid JSON." },
    { name: "incorrect content length", payload: '{"count":1}', headers: { "content-type": "application/json", "content-length": "1" }, status: 400, code: "FST_ERR_CTP_INVALID_CONTENT_LENGTH", message: "Request body does not match Content-Length." },
    { name: "oversized body", payload: JSON.stringify({ credential: privateFixture.repeat(20) }), headers: { "content-type": "application/json" }, status: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE", message: "Request body exceeds the size limit." },
    { name: "unsupported content type", payload: privateFixture, headers: { "content-type": "application/unknown" }, status: 415, code: "FST_ERR_CTP_INVALID_MEDIA_TYPE", message: "Request content type is not supported." },
  ])("preserves native $name rejection before the route handler", async ({ payload, headers, status, code, message }) => {
    const { app, handler } = fixture();
    const observedCodes: string[] = [];
    app.addHook("onError", async (_request, _reply, error) => { observedCodes.push(error.code); });

    const response = await app.inject({ method: "POST", url: "/parse", headers, payload });

    expect(observedCodes).toEqual([code]);
    expect(handler).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: { code, message } });
    expect(response.body).not.toContain(privateFixture);
    expect(response.body).not.toContain('"stack"');
    expect(response.body).not.toContain('"details"');
  });

  it("still parses valid JSON and invokes the existing route exactly once", async () => {
    const { app, handler } = fixture();

    const response = await app.inject({ method: "POST", url: "/parse", payload: { count: 1 } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: 1 });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ count: 1 });
  });

  it("does not publish a native parser error's supplied diagnostic message", async () => {
    const { app } = fixture();
    app.get("/native-parser-error", () => { throw new errorCodes.FST_ERR_CTP_INVALID_JSON_BODY(privateFixture); });

    const response = await app.inject({ method: "GET", url: "/native-parser-error" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: "FST_ERR_CTP_INVALID_JSON_BODY", message: "Request body is not valid JSON." } });
    expect(response.body).not.toContain(privateFixture);
  });

  it.each([
    { name: "ordinary exception", properties: {} },
    { name: "untrusted client status", properties: { statusCode: 400 } },
    { name: "untrusted server status", properties: { statusCode: 503 } },
    { name: "spoofed native parser code", properties: { statusCode: 400, code: "FST_ERR_CTP_INVALID_JSON_BODY" } },
  ])("keeps $name opaque instead of trusting its properties", async ({ properties }) => {
    const { app } = fixture();
    app.get("/unexpected", () => { throw Object.assign(new Error(privateFixture), properties); });

    const response = await app.inject({ method: "GET", url: "/unexpected" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "AgentFlow could not complete the request" } });
    expect(response.body).not.toContain(privateFixture);
  });

  it("keeps unexpected native framework server errors opaque", async () => {
    const { app } = fixture();
    app.get("/framework-server-error", () => { throw new errorCodes.FST_ERR_BAD_STATUS_CODE(privateFixture); });

    const response = await app.inject({ method: "GET", url: "/framework-server-error" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "AgentFlow could not complete the request" } });
    expect(response.body).not.toContain(privateFixture);
  });

  it("preserves an existing onRequest authentication refusal before JSON parsing", async () => {
    const { app, handler } = fixture(true);

    const response = await app.inject({ method: "POST", url: "/parse", headers: { "content-type": "application/json" }, payload: `invalid ${privateFixture}` });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." } });
    expect(handler).not.toHaveBeenCalled();
    expect(response.body).not.toContain(privateFixture);
  });

  it.each([400, 409])("preserves explicit typed domain refusal %s", async (status) => {
    const { app } = fixture();
    app.get("/domain-error", () => { throw new AgentFlowError("DOMAIN_REFUSAL", "Review the existing requirement.", status, { nextAction: "Review" }); });

    const response = await app.inject({ method: "GET", url: "/domain-error" });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: { code: "DOMAIN_REFUSAL", message: "Review the existing requirement.", details: { nextAction: "Review" } } });
  });

  it("preserves Zod validation refusal without invoking the mutation", async () => {
    const { app } = fixture();
    const mutate = vi.fn();
    app.post("/validated", (request) => { const input = z.object({ count: z.number().min(1) }).parse(request.body); mutate(input); return input; });

    const response = await app.inject({ method: "POST", url: "/validated", payload: { count: 0, credential: privateFixture } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: "Request validation failed" } });
    expect(response.json<{ error: { details: unknown[] } }>().error.details.length).toBeGreaterThan(0);
    expect(mutate).not.toHaveBeenCalled();
    expect(response.body).not.toContain(privateFixture);
  });
});

function fixture(authenticate = false) {
  const app = Fastify({ logger: false, bodyLimit: 256 });
  applications.add(app);
  if (authenticate) app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer local-fixture") throw new AgentFlowError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
  });
  const handler = vi.fn((body: unknown) => body);
  app.post("/parse", (request) => handler(request.body));
  registerErrorHandling(app);
  return { app, handler };
}
