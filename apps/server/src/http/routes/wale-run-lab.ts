import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BuildEntity, BuildEventEntity, BuildStatus } from "../../db/index.js";
import { canonicalJsonSha256 } from "../../integration/design-intelligence.js";
import { WaleRunLabExperimentSchema, type WaleRunLabExperiment } from "../../integration/wale-run-lab.js";
import { makeWaleRunLabReceiptBundle } from "../../integration/wale-run-lab-receipt-bundle.js";
import { createBuildForPlan } from "./builds.js";
import type { AgentFlowContext } from "../context.js";

const BRIDGE_PREFIX = "/api/wale/run-lab/experiments";
const terminalStatuses: readonly BuildStatus[] = ["completed", "failed", "cancelled"];
const ExperimentBody = z.object({
  sourceBuildId: z.string().min(1).max(160),
  experiment: WaleRunLabExperimentSchema,
}).strict();
const ExperimentParameters = z.object({ experimentId: z.string().regex(/^exp_[0-9a-f]{64}$/) }).strict();
const EvidenceParameters = ExperimentParameters.extend({ index: z.string() });
const EventQuery = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();
const eventProjection: Readonly<Record<string, { kind: string; label: string }>> = {
  "wale.experiment.bound": { kind: "PREPARED", label: "Experiment bound" },
  "build.started": { kind: "STARTED", label: "Run started" },
  "build.paused": { kind: "PAUSED", label: "Run paused" },
  "build.resumed": { kind: "RESUMED", label: "Run resumed" },
  "wale.delivery_size_evaluated": { kind: "MEASURED", label: "Delivery size evaluated" },
  "task.validated": { kind: "VERIFIED", label: "Task validation passed" },
  "integration.completed": { kind: "INTEGRATED", label: "Task integrated" },
  "integration.failed": { kind: "FAILED", label: "Task integration failed" },
  "build.completed": { kind: "COMPLETED", label: "Run completed" },
  "build.failed": { kind: "FAILED", label: "Run failed" },
  "build.cancelled": { kind: "CANCELLED", label: "Run cancelled" },
};

function bridgeError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  return reply.status(statusCode).send({ error: { code, message } });
}

function authenticate(request: FastifyRequest, reply: FastifyReply, context: AgentFlowContext): boolean {
  const expectedHex = context.environment.waleBridgeTokenSha256;
  if (expectedHex === null) {
    bridgeError(reply, 503, "WALE_BRIDGE_DISABLED", "The Wale bridge is not configured");
    return false;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(request.headers.authorization ?? "");
  if (match === null) {
    bridgeError(reply, 401, "WALE_BRIDGE_AUTHENTICATION_FAILED", "A valid Wale bridge bearer token is required");
    return false;
  }
  const supplied = createHash("sha256").update(match[1] ?? "").digest();
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    bridgeError(reply, 401, "WALE_BRIDGE_AUTHENTICATION_FAILED", "A valid Wale bridge bearer token is required");
    return false;
  }
  return true;
}

function resolveExperiment(context: AgentFlowContext, experimentId: string): { event: BuildEventEntity; build: BuildEntity; experiment: WaleRunLabExperiment } | undefined {
  const event = context.store.events.findByExperimentId(experimentId);
  if (event === undefined) return undefined;
  const parsed = WaleRunLabExperimentSchema.safeParse(event.payload);
  if (!parsed.success) return undefined;
  const build = context.store.builds.findById(event.buildId);
  return build === undefined ? undefined : { event, build, experiment: parsed.data };
}

function exactReplay(existing: ReturnType<typeof resolveExperiment>, source: BuildEntity, experiment: WaleRunLabExperiment): boolean {
  if (existing === undefined) return false;
  const BoundBases = z.object({ executionBaseCommit: z.string().regex(/^[a-f0-9]{40}$/), governedBaseCommit: z.string().regex(/^[a-f0-9]{40}$/) }).loose();
  const sourceBinding = BoundBases.safeParse(source.normalizedPlan.governedHandoff);
  const retainedBinding = BoundBases.safeParse(existing.build.normalizedPlan.governedHandoff);
  return sourceBinding.success && retainedBinding.success &&
    existing.build.planId === source.planId &&
    existing.build.repositoryId === source.repositoryId &&
    existing.build.baseCommit === source.baseCommit &&
    existing.build.baseCommit === sourceBinding.data.executionBaseCommit &&
    existing.build.baseCommit === retainedBinding.data.executionBaseCommit &&
    experiment.repositorySnapshot.commit === sourceBinding.data.governedBaseCommit &&
    canonicalJsonSha256(retainedBinding.data) === canonicalJsonSha256(sourceBinding.data) &&
    canonicalJsonSha256(existing.experiment) === canonicalJsonSha256(experiment);
}

function fixedTaskCounts(context: AgentFlowContext, buildId: string): Record<string, number> {
  const counts: Record<string, number> = {
    pending: 0, blocked: 0, ready: 0, running: 0, validating: 0, validated: 0,
    integrating: 0, integrated: 0, failed: 0, cancelled: 0, interrupted: 0, blocked_failed: 0,
  };
  for (const task of context.store.tasks.listForBuild(buildId)) counts[task.state] = (counts[task.state] ?? 0) + 1;
  return counts;
}

function statusProjection(context: AgentFlowContext, resolved: NonNullable<ReturnType<typeof resolveExperiment>>) {
  const tasks = context.store.tasks.listForBuild(resolved.build.id);
  return {
    experimentId: resolved.experiment.experimentId,
    runId: resolved.experiment.runId,
    bridgeBuildReference: resolved.build.id,
    status: resolved.build.status,
    timestamps: { createdAt: resolved.build.createdAt, startedAt: resolved.build.startedAt, completedAt: resolved.build.completedAt },
    taskStateCounts: fixedTaskCounts(context, resolved.build.id),
    totalAttempts: tasks.reduce((total, task) => total + task.attempt, 0),
    lastEventSequence: context.store.events.getLatestSequence(resolved.build.id),
    receiptState: terminalStatuses.includes(resolved.build.status) ? "AVAILABLE" : "PENDING",
  };
}

function safeFailure(reply: FastifyReply, error: unknown): FastifyReply {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code.startsWith("SQLITE_CONSTRAINT") || code === "ACTIVE_BUILD_EXISTS") {
    return bridgeError(reply, 409, "WALE_BRIDGE_BUILD_CONFLICT", "The experiment build conflicts with current AgentFlow state");
  }
  return bridgeError(reply, 409, "WALE_BRIDGE_ADMISSION_REJECTED", "The experiment could not be admitted under current execution authority");
}

export function registerWaleRunLabRoutes(app: FastifyInstance, context: AgentFlowContext): void {
  app.register(async (bridge) => {
    bridge.addHook("onRequest", async (request, reply) => {
      if (!authenticate(request, reply, context)) return reply;
    });

    bridge.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
      return payload;
    });

    bridge.setErrorHandler(async (error, request, reply) => {
      const errorCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 0;
      if (errorCode === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413) {
        await bridgeError(reply, 413, "WALE_BRIDGE_REQUEST_TOO_LARGE", "The Wale bridge request exceeds the allowed size");
        return;
      }
      if (errorCode === "FST_ERR_CTP_INVALID_JSON_BODY" || error instanceof SyntaxError) {
        await bridgeError(reply, 400, "WALE_BRIDGE_REQUEST_INVALID", "The Wale bridge request is invalid");
        return;
      }
      request.log.error({ code: errorCode }, "Unhandled Wale bridge request error");
      await bridgeError(reply, 500, "WALE_BRIDGE_INTERNAL_ERROR", "The Wale bridge could not complete the request");
    });

    bridge.post(BRIDGE_PREFIX, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const parsed = ExperimentBody.safeParse(request.body);
    if (!parsed.success) return bridgeError(reply, 400, "WALE_BRIDGE_REQUEST_INVALID", "The Wale bridge request is invalid");
    const { sourceBuildId, experiment } = parsed.data;
    const source = context.store.builds.findById(sourceBuildId);
    if (source === undefined || source.planId === null || !terminalStatuses.includes(source.status)) {
      return bridgeError(reply, 409, "WALE_BRIDGE_ADMISSION_REJECTED", "The source build is not a terminal planned build");
    }
    const existing = resolveExperiment(context, experiment.experimentId);
    if (existing !== undefined) {
      if (!exactReplay(existing, source, experiment)) return bridgeError(reply, 409, "WALE_EXPERIMENT_ID_CONFLICT", "The experiment ID is already bound to different immutable input");
      return reply.status(200).send(statusProjection(context, existing));
    }
    try {
      const build = await createBuildForPlan(context, source.planId, experiment);
      const created = resolveExperiment(context, experiment.experimentId);
      if (created === undefined || created.build.id !== build.id) throw new Error("binding unavailable");
      return await reply.status(201).send(statusProjection(context, created));
    } catch (error) {
      const concurrent = resolveExperiment(context, experiment.experimentId);
      if (concurrent !== undefined && exactReplay(concurrent, source, experiment)) return reply.status(200).send(statusProjection(context, concurrent));
      if (concurrent !== undefined) return bridgeError(reply, 409, "WALE_EXPERIMENT_ID_CONFLICT", "The experiment ID is already bound to different immutable input");
      return safeFailure(reply, error);
    }
  });

    bridge.post(`${BRIDGE_PREFIX}/:experimentId/start`, async (request, reply) => {
    const parameters = ExperimentParameters.safeParse(request.params);
    if (!parameters.success) return bridgeError(reply, 400, "WALE_BRIDGE_REQUEST_INVALID", "The Wale bridge request is invalid");
    const resolved = resolveExperiment(context, parameters.data.experimentId);
    if (resolved === undefined) return bridgeError(reply, 404, "WALE_EXPERIMENT_NOT_FOUND", "The experiment was not found");
    if (["paused", "interrupted"].includes(resolved.build.status)) return bridgeError(reply, 409, "WALE_EXPERIMENT_REQUIRES_EXPLICIT_RESUME", "The experiment requires an explicit AgentFlow resume decision");
    if (resolved.build.status === "ready") {
      try { await context.coordinator.start(resolved.build.id); }
      catch (error) { return safeFailure(reply, error); }
    }
    const current = resolveExperiment(context, parameters.data.experimentId);
    return reply.status(200).send(statusProjection(context, current ?? resolved));
  });

    bridge.get(`${BRIDGE_PREFIX}/:experimentId`, async (request, reply) => {
    const parameters = ExperimentParameters.safeParse(request.params);
    if (!parameters.success) return bridgeError(reply, 400, "WALE_BRIDGE_REQUEST_INVALID", "The Wale bridge request is invalid");
    const resolved = resolveExperiment(context, parameters.data.experimentId);
    return resolved === undefined
      ? bridgeError(reply, 404, "WALE_EXPERIMENT_NOT_FOUND", "The experiment was not found")
      : reply.send(statusProjection(context, resolved));
  });

    for (const suffix of ["receipt", "evidence/:index"] as const) {
      bridge.get(`${BRIDGE_PREFIX}/:experimentId/${suffix}`, async (request, reply) => {
        const parameters = (suffix === "receipt" ? ExperimentParameters : EvidenceParameters).safeParse(request.params);
        if (!parameters.success) return bridgeError(reply, 400, "WALE_BRIDGE_REQUEST_INVALID", "The Wale bridge request is invalid");
        const rawIndex = "index" in parameters.data ? String(parameters.data.index) : undefined;
        const index = rawIndex === undefined ? undefined : Number(rawIndex);
        if (rawIndex !== undefined && (!/^(0|[1-9][0-9]*)$/u.test(rawIndex) || !Number.isSafeInteger(index))) {
          return bridgeError(reply, 404, "WALE_RECEIPT_EVIDENCE_NOT_FOUND", "The experiment evidence was not found");
        }
        const resolved = resolveExperiment(context, parameters.data.experimentId);
        if (resolved === undefined) return bridgeError(reply, 404, "WALE_EXPERIMENT_NOT_FOUND", "The experiment was not found");
        if (!terminalStatuses.includes(resolved.build.status)) return bridgeError(reply, 409, "WALE_EXPERIMENT_NOT_TERMINAL", "The experiment is not terminal");
        try {
          const { bundle, selectedBytes } = await makeWaleRunLabReceiptBundle(context, resolved.build.id, resolved.experiment, index);
          if (index === undefined) return await reply.send(bundle);
          const entry = bundle.evidence[index];
          if (entry === undefined || selectedBytes === undefined) return await bridgeError(reply, 404, "WALE_RECEIPT_EVIDENCE_NOT_FOUND", "The experiment evidence was not found");
          return await reply.type("application/octet-stream").header("content-length", selectedBytes.length)
            .header("x-content-sha256", entry.sha256).send(selectedBytes);
        } catch {
          return bridgeError(reply, 409, "WALE_RECEIPT_EVIDENCE_UNAVAILABLE", "The experiment receipt evidence is unavailable");
        }
      });
    }

    bridge.get(`${BRIDGE_PREFIX}/:experimentId/events`, async (request, reply) => {
    const parameters = ExperimentParameters.safeParse(request.params);
    const query = EventQuery.safeParse(request.query);
    if (!parameters.success || !query.success) return bridgeError(reply, 400, "WALE_BRIDGE_REQUEST_INVALID", "The Wale bridge request is invalid");
    const resolved = resolveExperiment(context, parameters.data.experimentId);
    if (resolved === undefined) return bridgeError(reply, 404, "WALE_EXPERIMENT_NOT_FOUND", "The experiment was not found");
    const rows: Array<{ sequence: number; occurredAt: string; kind: string; label: string }> = [];
    let cursor = query.data.after;
    for (let pageIndex = 0; pageIndex < 10 && rows.length < query.data.limit; pageIndex += 1) {
      const events = context.store.events.listForBuild(resolved.build.id, { afterSequence: cursor, limit: 200 });
      if (events.length === 0) break;
      for (const event of events) {
        cursor = event.sequence;
        const projection = eventProjection[event.type];
        if (projection !== undefined) rows.push({ sequence: event.sequence, occurredAt: event.occurredAt, ...projection });
        if (rows.length === query.data.limit) break;
      }
      if (events.length < 200) break;
    }
    return reply.send({ events: rows, cursor, hasMore: context.store.events.getLatestSequence(resolved.build.id) > cursor });
    });
  });
}
