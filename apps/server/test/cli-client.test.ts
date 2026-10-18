import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { requestApi } from "../src/client/api.js";
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(home: string) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/api/health" ? { runtime: { home } } : { id: "build-1" }));
  }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  return { base: `http://127.0.0.1:${address.port}`, requests };
}
it("uses the persistent server exactly once for a mutation", async () => {
  const { base, requests } = await fixture("/tmp/test-home");
  expect(await requestApi(base, "/tmp/test-home", "POST", "/api/builds", { planId: "p" })).toEqual({ id: "build-1" });
  expect(requests).toEqual(["GET /api/health", "POST /api/builds"]);
});
it("rejects a different installation before sending a mutation", async () => {
  const { base, requests } = await fixture("/tmp/other-home");
  await expect(requestApi(base, "/tmp/test-home", "POST", "/api/builds", {})).rejects.toThrow("different AGENTFLOW_HOME");
  expect(requests).toEqual(["GET /api/health"]);
});
it("gives a recovery instruction when the server is unavailable", async () => {
  const { base } = await fixture("/tmp/test-home");
  const server = servers[0]; if (server === undefined) throw new Error("missing server");
  await new Promise<void>(resolve => server.close(() => resolve()));
  await expect(requestApi(base, "/tmp/test-home", "GET", "/api/builds")).rejects.toThrow("agentflow serve");
});
