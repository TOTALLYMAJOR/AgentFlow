import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

export class AgentFlowError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentFlowError";
  }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(async (error: FastifyError | Error, request, reply) => {
    if (error instanceof AgentFlowError) {
      request.log.warn(
        { code: error.code, details: error.details },
        error.message,
      );
      await reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return;
    }

    if (error.name === "EntityNotFoundError") {
      await reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: error.message,
        },
      });
      return;
    }

    if (
      error.name === "InvalidStateTransitionError" ||
      error.name === "ConcurrentStateChangeError"
    ) {
      await reply.status(409).send({
        error: {
          code: "STATE_CONFLICT",
          message: error.message,
        },
      });
      return;
    }

    if (
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("SQLITE_CONSTRAINT")
    ) {
      await reply.status(409).send({
        error: {
          code: "CONSTRAINT_CONFLICT",
          message: "The requested operation violates an AgentFlow invariant",
        },
      });
      return;
    }

    if (error instanceof ZodError) {
      await reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues,
        },
      });
      return;
    }

    request.log.error({ err: error }, "Unhandled request error");
    await reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "AgentFlow could not complete the request",
      },
    });
  });
}
