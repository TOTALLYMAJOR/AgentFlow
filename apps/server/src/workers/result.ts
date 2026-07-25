import { z } from "zod";
import type { WorkerStructuredResult } from "./types.js";

const workerStructuredResultSchema = z
  .object({
    status: z.enum(["completed", "blocked", "failed"]),
    summary: z.string().trim().min(1),
    validation_notes: z.array(z.string()),
    handoff_notes: z.array(z.string()),
    risks: z.array(z.string()).optional(),
  })
  .strict();

export const WORKER_RESULT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "validation_notes",
    "handoff_notes",
    "risks",
  ],
  properties: {
    status: {
      type: "string",
      enum: ["completed", "blocked", "failed"],
    },
    summary: {
      type: "string",
      minLength: 1,
    },
    validation_notes: {
      type: "array",
      items: { type: "string" },
    },
    handoff_notes: {
      type: "array",
      items: { type: "string" },
    },
    risks: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export interface WorkerResultParse {
  result: WorkerStructuredResult | null;
  candidateFound: boolean;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTextCandidate(value: unknown): unknown {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function findCandidate(event: unknown): {
  candidate: unknown;
  found: boolean;
} {
  if (!isRecord(event)) {
    return { candidate: undefined, found: false };
  }

  if (
    "status" in event &&
    "summary" in event &&
    "validation_notes" in event &&
    "handoff_notes" in event
  ) {
    return { candidate: event, found: true };
  }

  for (const key of ["result", "structured_output", "output"] as const) {
    if (key in event) {
      return { candidate: event[key], found: true };
    }
  }

  const item = event.item;
  if (!isRecord(item)) {
    return { candidate: undefined, found: false };
  }

  for (const key of ["result", "structured_output", "output"] as const) {
    if (key in item) {
      return { candidate: item[key], found: true };
    }
  }

  if (event.type === "item.completed" && item.type === "agent_message") {
    return {
      candidate: parseTextCandidate(item.text),
      found: true,
    };
  }

  return { candidate: undefined, found: false };
}

export function parseWorkerResultEvent(event: unknown): WorkerResultParse {
  const { candidate: rawCandidate, found } = findCandidate(event);
  if (!found) {
    return { result: null, candidateFound: false, error: null };
  }

  const candidate =
    typeof rawCandidate === "string"
      ? parseTextCandidate(rawCandidate)
      : rawCandidate;
  const parsed = workerStructuredResultSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      result: null,
      candidateFound: true,
      error: z.prettifyError(parsed.error),
    };
  }

  const result: WorkerStructuredResult = {
    status: parsed.data.status,
    summary: parsed.data.summary,
    validation_notes: parsed.data.validation_notes,
    handoff_notes: parsed.data.handoff_notes,
    ...(parsed.data.risks === undefined ? {} : { risks: parsed.data.risks }),
  };
  return {
    result,
    candidateFound: true,
    error: null,
  };
}
