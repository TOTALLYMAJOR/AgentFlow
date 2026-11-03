import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_GIT_OUTPUT_BYTES } from "../src/repositories/git.js";
import {
  MemoryRepositoryPersistence,
  RepositoryService,
} from "../src/repositories/index.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(async (root) => {
    await rm(root, { recursive: true, force: true });
    temporaryRoots.delete(root);
  }));
});

describe("repository review input admission", () => {
  for (const target of ["configuration", "backlog"] as const) {
    it.each([
      {
        name: "oversized",
        // A comments-only document is not a valid configuration or backlog.
        // Size refusal must win over YAML/schema/backlog parsing errors.
        contents: () => Buffer.alloc(MAX_GIT_OUTPUT_BYTES + 1, "#"),
        code: "REVIEWED_FILE_TOO_LARGE",
        statusCode: 413,
      },
      {
        name: "invalid UTF-8",
        contents: () => Buffer.from([0xc3, 0x28, 0xff]),
        code: "REVIEWED_FILE_ENCODING_INVALID",
        statusCode: 400,
      },
    ])(`refuses $name ${target} before parsing without changing files or Git state`, async ({ contents, code, statusCode }) => {
      const repository = await mkdtemp(path.join(tmpdir(), "agentflow-review-input-"));
      temporaryRoots.add(repository);
      await git(repository, ["init", "--initial-branch=main"]);
      await git(repository, ["config", "user.name", "AgentFlow Test"]);
      await git(repository, ["config", "user.email", "agentflow@example.invalid"]);
      await writeFile(path.join(repository, "README.md"), "# Original source\n");
      await git(repository, ["add", "README.md"]);
      await git(repository, ["commit", "-m", "initial fixture"]);

      const service = new RepositoryService(new MemoryRepositoryPersistence());
      await service.initialize(repository);
      const registered = await service.register(repository);
      const filename = target === "configuration" ? ".agentflow.yaml" : "BACKLOG.md";
      await writeFile(path.join(repository, filename), contents());
      await writeFile(path.join(repository, "README.md"), "# Retained staged source\n");
      await git(repository, ["add", "README.md"]);
      const before = await snapshot(repository);

      const review = target === "configuration"
        ? service.reviewConfiguration(registered.id)
        : service.reviewBacklog(registered.id);
      await expect(review).rejects.toMatchObject({ code, statusCode });

      expect(await snapshot(repository)).toEqual(before);
    });
  }
});

async function snapshot(repository: string) {
  const filenames = (await readdir(repository)).filter((name) => name !== ".git").sort();
  const files = await Promise.all(filenames.map(async (name) => [
    name,
    createHash("sha256").update(await readFile(path.join(repository, name))).digest("hex"),
  ]));
  return {
    head: await git(repository, ["rev-parse", "HEAD"]),
    index: await readFile(path.join(repository, ".git/index")),
    files,
  };
}

async function git(repository: string, arguments_: string[]) {
  const result = await execFileAsync("git", ["-C", repository, ...arguments_], { encoding: "utf8" });
  return result.stdout.trim();
}
