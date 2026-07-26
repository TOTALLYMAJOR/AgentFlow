import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentFlowContext } from "../context.js";
import { AgentFlowError } from "../errors.js";
import { authenticateRunner, sha256 } from "./runners.js";

const JobParameters = z.object({ id: z.string().min(1) });
const CompleteBody = z.object({
  status: z.enum(["completed", "failed"]),
  result: z.record(z.string(), z.unknown()),
});
const LEASE_DURATION_MS = 5 * 60 * 1000;

function leaseToken(request: FastifyRequest): string {
  const token = request.headers["x-agentflow-lease-token"];
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new AgentFlowError(
      "REMOTE_JOB_LEASE_REQUIRED",
      "A remote job lease token is required",
      401,
    );
  }
  return token.trim();
}

function nextLeaseExpiry(): string {
  return new Date(Date.now() + LEASE_DURATION_MS).toISOString();
}

export function registerRemoteJobRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.post("/api/remote-jobs/claim", async (request, reply) => {
    const runner = authenticateRunner(request, context);
    if (runner === undefined) {
      throw new AgentFlowError(
        "RUNNER_AUTHENTICATION_FAILED",
        "A valid runner bearer token is required",
        401,
      );
    }
    if (runner.status !== "online" || runner.busySlots >= runner.capacity) {
      throw new AgentFlowError(
        "RUNNER_NOT_AVAILABLE",
        "Runner must be online with available capacity to claim work",
        409,
      );
    }
    context.store.remoteJobs.expireLeases();
    const token = randomBytes(32).toString("base64url");
    const job = context.store.remoteJobs.claim({
      runnerId: runner.id,
      providerId: runner.providerId,
      leaseTokenSha256: sha256(token),
      leaseExpiresAt: nextLeaseExpiry(),
    });
    if (job === undefined) {
      await reply.status(204).send();
      return;
    }
    await reply.send({ job, leaseToken: token });
  });

  app.post("/api/remote-jobs/:id/heartbeat", async (request) => {
    const runner = authenticateRunner(request, context);
    if (runner === undefined) {
      throw new AgentFlowError(
        "RUNNER_AUTHENTICATION_FAILED",
        "A valid runner bearer token is required",
        401,
      );
    }
    const { id } = JobParameters.parse(request.params);
    try {
      return context.store.remoteJobs.heartbeat(
        id,
        runner.id,
        sha256(leaseToken(request)),
        nextLeaseExpiry(),
      );
    } catch (cause) {
      throw new AgentFlowError(
        "REMOTE_JOB_LEASE_INVALID",
        cause instanceof Error ? cause.message : "Remote job lease is invalid",
        409,
      );
    }
  });

  app.post("/api/remote-jobs/:id/complete", async (request) => {
    const runner = authenticateRunner(request, context);
    if (runner === undefined) {
      throw new AgentFlowError(
        "RUNNER_AUTHENTICATION_FAILED",
        "A valid runner bearer token is required",
        401,
      );
    }
    const { id } = JobParameters.parse(request.params);
    const body = CompleteBody.parse(request.body);
    const idempotencyKey = request.headers["idempotency-key"];
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.trim().length < 8
    ) {
      throw new AgentFlowError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "An Idempotency-Key header of at least 8 characters is required",
        400,
      );
    }
    const resultJson = JSON.stringify(body.result);
    try {
      const completed = context.store.remoteJobs.complete({
        id,
        runnerId: runner.id,
        leaseTokenSha256: sha256(leaseToken(request)),
        idempotencyKey: idempotencyKey.trim(),
        resultSha256: sha256(resultJson),
        status: body.status,
        result: body.result,
      });
      context.coordinator.completeRemoteJob(completed);
      return completed;
    } catch (cause) {
      throw new AgentFlowError(
        "REMOTE_JOB_RESULT_REJECTED",
        cause instanceof Error
          ? cause.message
          : "Remote job result was rejected",
        409,
      );
    }
  });
}
