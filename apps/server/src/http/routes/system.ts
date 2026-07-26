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
    const activeBuilds = context.store.builds.listActive();
    const busyWorkers = context.store.workers.countBusy();
    const runners = context.store.runners.list();
    const remoteJobs = context.store.remoteJobs.countsByStatus();
    return {
      status: diagnostics.ok ? "ok" : "degraded",
      version: process.env.npm_package_version ?? "0.3.0",
      host: `${context.environment.host}:${context.environment.port}`,
      database: {
        status: diagnostics.ok ? "ok" : "degraded",
        journalMode: diagnostics.journalMode,
      },
      activeBuildId: activeBuilds[0]?.id ?? null,
      activeBuildIds: activeBuilds.map((build) => build.id),
      resources: {
        workerCapacity: context.environment.maxConcurrentWorkers,
        busyWorkers,
        availableWorkers: Math.max(
          0,
          context.environment.maxConcurrentWorkers - busyWorkers,
        ),
      },
      agentProviders: {
        default: context.environment.defaultAgentProvider,
        configured: context.agentProviders.list(),
      },
      runners: {
        total: runners.length,
        online: runners.filter((runner) => runner.status === "online").length,
        availableSlots: runners.reduce(
          (total, runner) =>
            total +
            (runner.status === "online"
              ? Math.max(0, runner.capacity - runner.busySlots)
              : 0),
          0,
        ),
      },
      remoteJobs: {
        queued: remoteJobs.queued ?? 0,
        leased: remoteJobs.leased ?? 0,
        completed: remoteJobs.completed ?? 0,
        failed: remoteJobs.failed ?? 0,
        expired: remoteJobs.expired ?? 0,
      },
      retries: {
        pending: context.store.retrySchedules.list().length,
        maximumAttempts: context.environment.retryMaximumAttempts,
        baseDelayMs: context.environment.retryBaseDelayMs,
        maximumDelayMs: context.environment.retryMaximumDelayMs,
      },
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
