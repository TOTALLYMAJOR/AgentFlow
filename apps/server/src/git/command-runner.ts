import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";

import { GitRuntimeError } from "./errors.js";

import type {
  GitCommandRecord,
  GitCommandRecorder,
} from "./types.js";

const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;

interface NodeCommandError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals;
}
export class GitCommandRunner {
  readonly #history: GitCommandRecord[] = [];
  readonly #recorder: GitCommandRecorder | undefined;
  #sequence = 0;

  public constructor(recorder?: GitCommandRecorder) {
    this.#recorder = recorder;
  }

  public history(): readonly GitCommandRecord[] {
    return this.#history.map((record) => ({
      ...record,
      arguments: [...record.arguments],
    }));
  }

  public async run(
    cwd: string,
    arguments_: readonly string[],
  ): Promise<GitCommandRecord> {
    const started = performance.now();
    const startedAt = new Date().toISOString();

    const result = await new Promise<{
      error: NodeCommandError | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        "git",
        ["-C", cwd, ...arguments_],
        {
          encoding: "utf8",
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            error: error as NodeCommandError | null,
            stdout,
            stderr,
          });
        },
      );
    });

    const exitCode =
      result.error === null
        ? 0
        : typeof result.error.code === "number"
          ? result.error.code
          : 1;
    const record: GitCommandRecord = {
      sequence: ++this.#sequence,
      executable: "git",
      cwd,
      arguments: [...arguments_],
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, performance.now() - started),
      exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    this.#history.push(record);
    this.#recorder?.(record);

    if (result.error !== null) {
      throw new GitRuntimeError(
        "GIT_COMMAND_FAILED",
        formatGitFailure(arguments_, exitCode, result.stderr),
        record,
        { cause: result.error },
      );
    }
    return record;
  }
}

function formatGitFailure(
  arguments_: readonly string[],
  exitCode: number,
  stderr: string,
): string {
  const action = arguments_[0] ?? "command";
  const detail = stderr.trim();
  return detail.length === 0
    ? `Git ${action} failed with exit code ${exitCode}`
    : `Git ${action} failed with exit code ${exitCode}: ${detail}`;
}
