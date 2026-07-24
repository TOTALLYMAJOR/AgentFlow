import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import { HandoffManifestService } from "../artifacts/index.js";
import {
  ensureRuntimeLayout,
  resolveEnvironment,
  type AgentFlowEnvironment,
} from "../config/environment.js";
import {
  createDatabaseRepositories,
  openDatabase,
} from "../db/index.js";
import {
  adaptRepositoryPersistence,
  RepositoryService,
} from "../repositories/index.js";
import { RecoveryService } from "../recovery/index.js";
import { BuildCoordinator } from "../orchestration/coordinator.js";
import { registerErrorHandling } from "./errors.js";
import type { AgentFlowContext } from "./context.js";
import { registerBuildRoutes } from "./routes/builds.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerRepositoryRoutes } from "./routes/repositories.js";
import { registerSystemRoutes } from "./routes/system.js";

export interface BuildAppOptions {
  environment?: AgentFlowEnvironment;
  databasePath?: string;
  staticRoot?: string | false;
  logger?: FastifyServerOptions["logger"];
}

export interface AgentFlowApp {
  app: FastifyInstance;
  context: AgentFlowContext;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<AgentFlowApp> {
  const environment = options.environment ?? resolveEnvironment();
  await ensureRuntimeLayout(environment);
  const database = openDatabase(options.databasePath ?? environment.databasePath);
  const store = createDatabaseRepositories(database);
  const repositoryService = new RepositoryService(
    adaptRepositoryPersistence(store.repositories),
  );
  const handoffService = new HandoffManifestService(
    store,
    environment.artifactsPath,
  );
  const coordinator = new BuildCoordinator({
    environment,
    store,
    repositoryService,
    handoffService,
  });
  const recoveryService = new RecoveryService({
    store,
    resolveRepositoryPath: async (repositoryId) =>
      (await repositoryService.get(repositoryId)).localPath,
    monitorExistingProcess: (build, task, worker) =>
      coordinator.monitorExistingProcess(build, task, worker),
    resumeValidation: (build, task) =>
      coordinator.resumeValidation(build, task),
    queueIntegration: (build, task) =>
      coordinator.queueIntegration(build, task),
    recoveredIntegration: (build, task) =>
      coordinator.recoverIntegratedManifest(build, task),
  });
  const context: AgentFlowContext = {
    environment,
    database,
    store,
    repositoryService,
    handoffService,
    recoveryService,
    coordinator,
  };
  await recoveryService.reconcileActiveBuilds();
  const recoveredBuild = store.builds.findActive();
  if (recoveredBuild?.status === "running") {
    coordinator.requestTick(recoveredBuild.id);
  }
  const app = Fastify({
    logger:
      options.logger ??
      ({
        level: environment.logLevel,
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "request.headers.authorization",
            "*.token",
            "*.secret",
            "*.password",
          ],
          censor: "[REDACTED]",
        },
      } satisfies NonNullable<FastifyServerOptions["logger"]>),
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: (origin, callback) => {
      const allowed =
        origin === undefined ||
        origin === `http://${environment.host}:${environment.port}` ||
        origin === "http://127.0.0.1:5173";
      callback(
        allowed ? null : new Error("Cross-origin request rejected"),
        allowed,
      );
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });

  registerSystemRoutes(app, context);
  registerRepositoryRoutes(app, context);
  registerPlanRoutes(app, context);
  registerBuildRoutes(app, context);
  registerErrorHandling(app);

  const staticRoot =
    options.staticRoot === false
      ? null
      : options.staticRoot ?? findStaticRoot();
  if (staticRoot !== null && existsSync(path.join(staticRoot, "index.html"))) {
    await app.register(fastifyStatic, {
      root: staticRoot,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        await reply.sendFile("index.html");
        return;
      }
      await reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: `Route ${request.method} ${request.url} was not found`,
        },
      });
    });
  } else {
    app.setNotFoundHandler(async (request, reply) => {
      await reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: `Route ${request.method} ${request.url} was not found`,
        },
      });
    });
  }

  app.addHook("onClose", async () => {
    await coordinator.shutdown();
    if (database.open) {
      database.close();
    }
  });
  return { app, context };
}

function findStaticRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(moduleDirectory, "web");
  return existsSync(bundled)
    ? bundled
    : path.resolve(process.cwd(), "apps", "web", "dist");
}
