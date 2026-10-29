import { GitCommandRunner } from "../git/index.js";

export const CONSERVATIVE_TEXT_CHURN_VERSION = "CONSERVATIVE_TEXT_CHURN_V1" as const;

export interface ConservativeTextChurnMeasurement {
  measurementVersion: typeof CONSERVATIVE_TEXT_CHURN_VERSION;
  additions: number;
  deletions: number;
  totalChurn: number;
  textFileCount: number;
  binaryFileCount: number;
}

export interface DeliverySizeEvaluationInput {
  worktreePath: string;
  baseCommit: string;
  candidateCommit: string;
}

export interface DeliverySizeEvaluator {
  evaluate(input: DeliverySizeEvaluationInput): Promise<ConservativeTextChurnMeasurement>;
}

interface NumstatRunner {
  run(cwd: string, arguments_: readonly string[]): Promise<{ stdout: string }>;
}

export class DeliverySizeMeasurementError extends Error {
  readonly code = "WALE_DELIVERY_SIZE_UNMEASURABLE";

  constructor() {
    super("The candidate delivery size could not be measured safely");
    this.name = "DeliverySizeMeasurementError";
  }
}

function fail(): never {
  throw new DeliverySizeMeasurementError();
}

function parseCount(value: string): number {
  if (!/^\d+$/u.test(value)) fail();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail();
  return parsed;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) fail();
  return total;
}

export function parseConservativeTextChurn(output: unknown): ConservativeTextChurnMeasurement {
  if (typeof output !== "string") fail();
  let additions = 0;
  let deletions = 0;
  let textFileCount = 0;
  let binaryFileCount = 0;
  if (output.length > 0) {
    const body = output.endsWith("\n") ? output.slice(0, -1) : output;
    if (body.length === 0) fail();
    for (const row of body.split("\n")) {
      const fields = row.split("\t");
      if (fields.length !== 3 || fields[2]?.length === 0) fail();
      if (fields[0] === "-" && fields[1] === "-") {
        binaryFileCount = safeAdd(binaryFileCount, 1);
        continue;
      }
      const rowAdditions = parseCount(fields[0] ?? "");
      const rowDeletions = parseCount(fields[1] ?? "");
      additions = safeAdd(additions, rowAdditions);
      deletions = safeAdd(deletions, rowDeletions);
      textFileCount = safeAdd(textFileCount, 1);
    }
  }
  return {
    measurementVersion: CONSERVATIVE_TEXT_CHURN_VERSION,
    additions,
    deletions,
    totalChurn: safeAdd(additions, deletions),
    textFileCount,
    binaryFileCount,
  };
}

export class ConservativeTextChurnEvaluator implements DeliverySizeEvaluator {
  readonly #git: NumstatRunner;

  constructor(git: NumstatRunner = new GitCommandRunner()) {
    this.#git = git;
  }

  async evaluate(input: DeliverySizeEvaluationInput): Promise<ConservativeTextChurnMeasurement> {
    if (!/^[0-9a-f]{40,64}$/u.test(input.baseCommit) || !/^[0-9a-f]{40,64}$/u.test(input.candidateCommit)) fail();
    try {
      const result = await this.#git.run(input.worktreePath, [
        "diff",
        "--numstat",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        input.baseCommit,
        input.candidateCommit,
        "--",
      ]);
      return parseConservativeTextChurn(result.stdout);
    } catch (error) {
      if (error instanceof DeliverySizeMeasurementError) throw error;
      fail();
    }
  }
}
