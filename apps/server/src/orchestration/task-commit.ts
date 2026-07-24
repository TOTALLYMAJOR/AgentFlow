import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { GitCommandRunner } from "../git/index.js";
import type {
  EvaluatedChangedFile,
} from "../validation/index.js";

export interface TaskCommitInput {
  worktreePath: string;
  baseCommit: string;
  branchName: string;
  backlogTaskId: string;
  title: string;
  changedFiles: readonly EvaluatedChangedFile[];
  allowNoChanges: boolean;
}

export interface CommittedChangedFile extends EvaluatedChangedFile {
  sha256: string | null;
}

export interface TaskCommitResult {
  resultCommit: string;
  createdCommit: boolean;
  changedFiles: CommittedChangedFile[];
}

export class TaskCommitService {
  constructor(private readonly runner = new GitCommandRunner()) {}

  async commit(input: TaskCommitInput): Promise<TaskCommitResult> {
    const worktreePath = await realpath(input.worktreePath);
    const status = await this.runner.run(worktreePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    let createdCommit = false;
    if (status.stdout.length > 0) {
      await this.runner.run(worktreePath, ["add", "--all", "--", "."]);
      await this.assertStagedPathsExpected(worktreePath, input.changedFiles);
      await this.runner.run(worktreePath, [
        "-c",
        "user.name=AgentFlow",
        "-c",
        "user.email=agentflow@localhost",
        "commit",
        "--no-gpg-sign",
        "-m",
        `agentflow(${input.backlogTaskId}): ${sanitizeTitle(input.title)}`,
      ]);
      createdCommit = true;
    }
    const resultCommit = (
      await this.runner.run(worktreePath, ["rev-parse", "--verify", "HEAD"])
    ).stdout.trim();
    await this.runner.run(worktreePath, [
      "merge-base",
      "--is-ancestor",
      input.baseCommit,
      resultCommit,
    ]);
    if (
      resultCommit === input.baseCommit &&
      !input.allowNoChanges
    ) {
      throw new Error(
        `Task ${input.backlogTaskId} produced no commit and does not allow no-change completion`,
      );
    }
    const after = await this.runner.run(worktreePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (after.stdout.length > 0) {
      throw new Error(
        `Task worktree ${worktreePath} is not clean after AgentFlow commit`,
      );
    }
    return {
      resultCommit,
      createdCommit,
      changedFiles: await Promise.all(
        input.changedFiles.map(async (change) => ({
          ...change,
          sha256:
            change.changeType === "deleted"
              ? null
              : await hashPathIfFile(worktreePath, change.path),
        })),
      ),
    };
  }

  async pushTaskBranch(
    worktreePath: string,
    remote: string,
    branchName: string,
  ): Promise<void> {
    await this.runner.run(await realpath(worktreePath), [
      "push",
      "--set-upstream",
      remote,
      branchName,
    ]);
  }

  private async assertStagedPathsExpected(
    worktreePath: string,
    changedFiles: readonly EvaluatedChangedFile[],
  ): Promise<void> {
    const staged = await this.runner.run(worktreePath, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
    ]);
    const expected = new Set(
      changedFiles.flatMap((change) => [
        change.path,
        ...(change.previousPath === null ? [] : [change.previousPath]),
      ]),
    );
    const unexpected = staged.stdout
      .split("\0")
      .filter(Boolean)
      .filter((candidate) => !expected.has(candidate));
    if (unexpected.length > 0) {
      await this.runner.run(worktreePath, ["reset"]);
      throw new Error(
        `Refusing to commit paths not present in the validated change set: ${unexpected.join(", ")}`,
      );
    }
  }
}

async function hashPathIfFile(
  worktreePath: string,
  repositoryPath: string,
): Promise<string | null> {
  const target = await realpath(path.resolve(worktreePath, repositoryPath));
  if (
    target !== worktreePath &&
    !target.startsWith(`${worktreePath}${path.sep}`)
  ) {
    throw new Error(`Changed path escapes task worktree: ${repositoryPath}`);
  }
  const metadata = await lstat(target);
  if (!metadata.isFile()) {
    return null;
  }
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function sanitizeTitle(title: string): string {
  const singleLine = title.replaceAll(/[\r\n]+/gu, " ").trim();
  return (singleLine || "complete task").slice(0, 120);
}
