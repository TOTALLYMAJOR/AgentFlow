import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { readVersionedArtifact } from "../src/orchestration/coordinator.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("versioned artifact consumption", () => {
  it("reads immutable commit bytes, verifies file hashes, rejects symlinks, and describes directories", async () => {
    const repository = await createRepository();
    const integrationCommit = await gitOutput(repository, ["rev-parse", "HEAD"]);
    const committedJson = '{"revision":1}\n';

    await writeFile(
      path.join(repository, "artifacts", "data.json"),
      '{"revision":2,"tampered":true}\n',
      "utf8",
    );

    await expect(
      readVersionedArtifact(
        repository,
        "artifacts/data.json",
        integrationCommit,
        sha256(committedJson),
      ),
    ).resolves.toEqual({ revision: 1 });
    await expect(
      readVersionedArtifact(
        repository,
        "artifacts/data.json",
        integrationCommit,
        sha256("wrong bytes"),
      ),
    ).rejects.toThrow(/SHA-256 mismatch/i);
    await expect(
      readVersionedArtifact(
        repository,
        "artifacts/link.json",
        integrationCommit,
        sha256("data.json"),
      ),
    ).rejects.toThrow(/symbolic link|symlink/i);
    await expect(
      readVersionedArtifact(
        repository,
        "artifacts/directory",
        integrationCommit,
        null,
      ),
    ).resolves.toMatchObject({
      path: "artifacts/directory",
      kind: "directory",
      integrationCommit,
      fileCount: 2,
      files: [
        "artifacts/directory/a.txt",
        "artifacts/directory/nested/b.txt",
      ],
      truncated: false,
    });
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agentflow-artifact-"));
  temporaryRoots.push(root);
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, "artifacts", "directory", "nested"), {
    recursive: true,
  });
  await git(root, ["init", "--initial-branch=main", repository]);
  await git(repository, ["config", "user.name", "AgentFlow Test"]);
  await git(repository, ["config", "user.email", "agentflow@example.test"]);
  await writeFile(
    path.join(repository, "artifacts", "data.json"),
    '{"revision":1}\n',
    "utf8",
  );
  await writeFile(
    path.join(repository, "artifacts", "directory", "a.txt"),
    "a\n",
    "utf8",
  );
  await writeFile(
    path.join(repository, "artifacts", "directory", "nested", "b.txt"),
    "b\n",
    "utf8",
  );
  await symlink(
    "data.json",
    path.join(repository, "artifacts", "link.json"),
  );
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "add immutable artifacts"]);
  return repository;
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function git(cwd: string, arguments_: readonly string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
  });
}

async function gitOutput(
  cwd: string,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}
