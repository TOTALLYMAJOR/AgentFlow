import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createId } from "../../util/ids.js";
import type { AgentFlowContext } from "../context.js";

const CapabilityValue = z.union([z.string(), z.number(), z.boolean()]);
const RegisterRunnerBody = z.object({
  name: z.string().trim().min(1).max(120),
  providerId: z.string().trim().min(1).max(64),
  capacity: z.number().int().min(1).max(64),
  capabilities: z.record(z.string(), CapabilityValue).default({}),
});
const HeartbeatBody = z.object({
  busySlots: z.number().int().min(0),
  capacity: z.number().int().min(1).max(64).optional(),
  status: z.enum(["online", "draining"]).default("online"),
  capabilities: z.record(z.string(), CapabilityValue).optional(),
});

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function authenticateRunner(
  request: FastifyRequest,
  context: AgentFlowContext,
) {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (token.length === 0) {
    return undefined;
  }
  return context.store.runners.findByTokenSha256(sha256(token));
}

export function registerRunnerRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.get("/api/runners", async () => context.store.runners.list());

  app.post("/api/runners/register", async (request, reply) => {
    const input = RegisterRunnerBody.parse(request.body);
    context.agentProviders.get(input.providerId);
    const token = randomBytes(32).toString("base64url");
    const runner = context.store.runners.create({
      id: createId("runner"),
      name: input.name,
      providerId: input.providerId,
      transport: "remote",
      capacity: input.capacity,
      capabilities: input.capabilities,
      tokenSha256: sha256(token),
    });
    await reply.status(201).send({ runner, token });
  });

  app.post("/api/runners/heartbeat", async (request, reply) => {
    const runner = authenticateRunner(request, context);
    if (runner === undefined) {
      await reply.status(401).send({
        error: {
          code: "RUNNER_AUTHENTICATION_FAILED",
          message: "A valid runner bearer token is required",
        },
      });
      return;
    }
    const input = HeartbeatBody.parse(request.body);
    await reply.send(
      context.store.runners.heartbeat(runner.id, {
        busySlots: input.busySlots,
        status: input.status,
        ...(input.capacity === undefined
          ? {}
          : { capacity: input.capacity }),
        ...(input.capabilities === undefined
          ? {}
          : { capabilities: input.capabilities }),
      }),
    );
  });
}
