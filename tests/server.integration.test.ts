import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEnvironment } from "../apps/server/src/config/environment.js";
import { buildApp } from "../apps/server/src/http/app.js";

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map(async (root) => {
      temporaryRoots.delete(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("production server", () => {
  it("binds to loopback and serves API plus dashboard assets", async () => {
    const runtimeHome = await temporaryRoot("runtime");
    const staticRoot = await temporaryRoot("static");
    await writeFile(
      path.join(staticRoot, "index.html"),
      "<!doctype html><title>AgentFlow integration</title>",
    );
    const environment = resolveEnvironment({
      AGENTFLOW_HOME: runtimeHome,
      AGENTFLOW_LOG_LEVEL: "silent",
    });
    const { app } = await buildApp({
      environment,
      staticRoot,
      logger: false,
    });

    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:/u);

      const health = await fetch(`${address}/api/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        status: "ok",
        database: { journalMode: "wal" },
      });

      const dashboard = await fetch(address);
      expect(dashboard.status).toBe(200);
      await expect(dashboard.text()).resolves.toContain(
        "AgentFlow integration",
      );
    } finally {
      await app.close();
    }
  });
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `agentflow-${label}-`));
  temporaryRoots.add(root);
  return root;
}
