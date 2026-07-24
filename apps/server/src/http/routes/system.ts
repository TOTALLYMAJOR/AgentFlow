import type { FastifyInstance } from "fastify";
import {
  createDatabaseBackup,
  getDatabaseDiagnostics,
} from "../../db/index.js";
import type { AgentFlowContext } from "../context.js";

export function registerSystemRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.get("/api/health", async () => {
    const diagnostics = getDatabaseDiagnostics(context.database);
    return {
      status: diagnostics.ok ? "ok" : "degraded",
      version: process.env.npm_package_version ?? "0.3.0",
      host: `${context.environment.host}:${context.environment.port}`,
      database: {
        status: diagnostics.ok ? "ok" : "degraded",
        journalMode: diagnostics.journalMode,
      },
      activeBuildId: context.store.builds.findActive()?.id ?? null,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  });

  app.get("/api/system/database", async () =>
    getDatabaseDiagnostics(context.database),
  );

  app.post("/api/system/database/backup", async (_request, reply) => {
    const result = await createDatabaseBackup(
      context.database,
      context.environment.backupsPath,
    );
    await reply.status(201).send(result);
  });
}
