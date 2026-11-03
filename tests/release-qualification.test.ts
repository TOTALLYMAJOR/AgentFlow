import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const verifier = path.join(repositoryRoot, "scripts", "verify-release.mjs");
const temporaryRoots = new Set<string>();

interface ReleaseEvidence {
  qualification: string;
  finalQualification: boolean;
  releaseReady: boolean;
  error: string | null;
  steps: Array<{ name: string; status: string }>;
}

const FAKE_GIT = `#!/bin/sh
if [ "$1" = "status" ]; then
  if [ "$FAKE_DIRTY" = "1" ]; then
    printf " M package.json\\n"
  fi
elif [ "$1" = "rev-parse" ]; then
  printf "%s\\n" "\${FAKE_COMMIT:-abc123}"
else
  printf "unexpected git arguments: %s\\n" "$*" >&2
  exit 2
fi
`;

const FAKE_NPM = `#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const args = process.argv.slice(2);
const action =
  args[0] === "run" && args[1] === "verify"
    ? "verify"
    : args[0] === "run" && args[1] === "pack:release"
      ? "pack"
      : args[0] === "run" && args[1] === "smoke:install"
        ? "smoke"
        : "unknown";
await appendFile(
  process.env.FAKE_COMMAND_LOG,
  JSON.stringify({ action, args }) + "\\n",
);
if (process.env.FAKE_FAIL_STEP === action) {
  process.stderr.write("simulated " + action + " failure\\n");
  process.exit(23);
}
if (action === "pack") {
  const outputIndex = args.indexOf("--output");
  const output = args[outputIndex + 1];
  await mkdir(output, { recursive: true });
  const tarball = "manifest-selected-artifact.tgz";
  const source = "manifest-selected-source.zip";
  await writeFile(path.join(output, tarball), "npm archive\\n");
  await writeFile(path.join(output, source), "source archive\\n");
  const metadata = async (file) => {
    const contents = await readFile(path.join(output, file));
    return {
      file,
      sha256: createHash("sha256").update(contents).digest("hex"),
      bytes: contents.length,
    };
  };
  const artifacts = [await metadata(tarball), await metadata(source)];
  const manifest = {
    schemaVersion: 1,
    package: "agentflow",
    version: "0.3.0",
    gitCommit: process.env.FAKE_COMMIT ?? "abc123",
    sourceDirty: args.includes("--allow-dirty"),
    artifacts,
  };
  const manifestContents = JSON.stringify(manifest, null, 2) + "\\n";
  await writeFile(path.join(output, "release-manifest.json"), manifestContents);
  const checksums = [
    ...artifacts.map(({ file, sha256 }) => ({ file, sha256 })),
    {
      file: "release-manifest.json",
      sha256: createHash("sha256").update(manifestContents).digest("hex"),
    },
  ];
  if (process.env.FAKE_FAIL_STEP === "checksum") {
    checksums[0].sha256 = "0".repeat(64);
  }
  await writeFile(
    path.join(output, "SHA256SUMS"),
    checksums.map(({ file, sha256 }) => sha256 + "  " + file).join("\\n") + "\\n",
  );
  process.exit(0);
}
if (action === "smoke") {
  process.exit(0);
}
if (action === "verify") {
  process.exit(0);
}
process.stderr.write("unexpected npm arguments: " + args.join(" ") + "\\n");
process.exit(2);
`;

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  temporaryRoots.clear();
});

describe("release qualification", () => {
  it("runs verification, packaging, checksums, and smoke proof in order", async () => {
    const fixture = await createFixture();
    const result = await runVerifier(fixture);
    const commandLog = await readLog(fixture.log);

    expect(result.code).toBe(0);
    expect(commandLog.map((entry) => entry.action)).toEqual([
      "verify",
      "pack",
      "smoke",
    ]);
    const evidence = await readEvidence(fixture.output);
    expect(evidence.steps.map((step) => [step.name, step.status])).toEqual([
      ["full-verification", "passed"],
      ["deterministic-packaging", "passed"],
      ["checksum-verification", "passed"],
      ["isolated-install-smoke", "passed"],
    ]);
    expect(evidence.releaseReady).toBe(true);
  });

  it("discovers the smoke-install tarball from the release manifest", async () => {
    const fixture = await createFixture();
    const result = await runVerifier(fixture);
    const log = await readLog(fixture.log);
    const smoke = log.find((entry) => entry.action === "smoke");

    expect(result).toMatchObject({ code: 0 });
    expect(smoke?.args.at(-1)).toBe(
      path.join(fixture.output, "manifest-selected-artifact.tgz"),
    );
    expect(smoke?.args.at(-1)).not.toContain("agentflow-0.3.0.tgz");
  });

  it("refuses a dirty final run but labels an explicit diagnostic non-final", async () => {
    const finalFixture = await createFixture();
    const refused = await runVerifier(finalFixture, [], { FAKE_DIRTY: "1" });
    const refusedEvidence = await readEvidence(finalFixture.output);

    expect(refused.code).toBe(1);
    expect(await readLog(finalFixture.log)).toEqual([]);
    expect(refusedEvidence.releaseReady).toBe(false);
    expect(refusedEvidence.error).toContain("requires a clean Git worktree");

    const diagnosticFixture = await createFixture();
    const diagnostic = await runVerifier(
      diagnosticFixture,
      ["--diagnostic"],
      { FAKE_DIRTY: "1" },
    );
    const log = await readLog(diagnosticFixture.log);
    const packaging = log.find((entry) => entry.action === "pack");
    const evidence = await readEvidence(diagnosticFixture.output);

    expect(diagnostic.code).toBe(0);
    expect(packaging?.args).toContain("--allow-dirty");
    expect(evidence.qualification).toBe("NON_FINAL_DIAGNOSTIC");
    expect(evidence.finalQualification).toBe(false);
    expect(evidence.releaseReady).toBe(false);
  });

  it("propagates checksum failure and never starts smoke installation", async () => {
    const fixture = await createFixture();
    const result = await runVerifier(fixture, [], {
      FAKE_FAIL_STEP: "checksum",
    });
    const log = await readLog(fixture.log);
    const evidence = await readEvidence(fixture.output);

    expect(result.code).toBe(1);
    expect(log.map((entry) => entry.action)).toEqual(["verify", "pack"]);
    expect(evidence.steps.at(2)?.status).toBe("failed");
    expect(evidence.steps.at(3)?.status).toBe("skipped");
    expect(evidence.releaseReady).toBe(false);
    expect(evidence.error).toContain("Checksum verification failed");
  });

  it.each([
    "release-manifest.json",
    "SHA256SUMS",
    "manifest-selected-artifact.tgz",
    "source.zip",
  ])("refuses evidence colliding with %s before changing retained bytes", async (name) => {
    const fixture = await createFixture();
    await mkdir(fixture.output);
    const target = path.join(fixture.output, name);
    await writeFile(target, "retained asset\n");

    const result = await runVerifier(fixture, ["--evidence", target]);

    expect(result.code).toBe(1);
    expect(await readFile(target, "utf8")).toBe("retained asset\n");
    expect(await readLog(fixture.log)).toEqual([]);
  });

  it("preserves an unrelated file at the default evidence path", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.output);
    const target = path.join(fixture.output, "release-evidence.json");
    await writeFile(target, "retained diagnostic or unrelated file\n");

    const result = await runVerifier(fixture);

    expect(result.code).toBe(1);
    expect(await readFile(target, "utf8")).toBe("retained diagnostic or unrelated file\n");
    expect(await readLog(fixture.log)).toEqual([]);
  });

  it("refuses symlinked evidence ancestry without overwriting its target", async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.root, "sentinel.txt");
    const alias = path.join(fixture.root, "alias");
    await writeFile(target, "preserve me\n");
    await symlink(fixture.root, alias, "dir");

    const result = await runVerifier(fixture, ["--evidence", path.join(alias, "sentinel.txt")]);

    expect(result.code).toBe(1);
    expect(await readFile(target, "utf8")).toBe("preserve me\n");
    expect(await readLog(fixture.log)).toEqual([]);
  });

  it("supports a fresh evidence file outside the packaging directory", async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.root, "qualification.json");
    const result = await runVerifier(fixture, ["--evidence", target]);

    expect(result.code).toBe(0);
    expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({releaseReady: true});
  });

  it("refuses replacing a qualified directory retaining an earlier report", async () => {
    const fixture = await createFixture();
    expect((await runVerifier(fixture)).code).toBe(0);
    const retained = await readFile(path.join(fixture.output, "release-evidence.json"));
    const commands = await readLog(fixture.log);

    const result = await runVerifier(fixture, ["--evidence", path.join(fixture.root, "next.json")]);

    expect(result.code).toBe(1);
    expect(await readFile(path.join(fixture.output, "release-evidence.json"))).toEqual(retained);
    expect(await readLog(fixture.log)).toEqual(commands);
  });

  it.each(["verify", "pack", "smoke"])("propagates %s failure without a ready release", async (step) => {
    const fixture = await createFixture();
    const result = await runVerifier(fixture, [], { FAKE_FAIL_STEP: step });
    const log = await readLog(fixture.log);
    const expected = ["verify", "pack", "smoke"];

    expect(result.code).toBe(1);
    expect(log.map((entry) => entry.action)).toEqual(expected.slice(0, expected.indexOf(step) + 1));
    expect(await readEvidence(fixture.output)).toMatchObject({ releaseReady: false });
  });

  it("refuses diagnostic tag qualification before running commands", async () => {
    const fixture = await createFixture();
    const result = await runVerifier(fixture, ["--diagnostic", "--tag", "v0.3.0"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tag qualification must be final");
    expect(await readLog(fixture.log)).toEqual([]);
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agentflow-release-test-"));
  temporaryRoots.add(root);
  const bin = path.join(root, "bin");
  const output = path.join(root, "release-output");
  const log = path.join(root, "commands.jsonl");
  await mkdir(bin);
  await Promise.all([
    writeExecutable(path.join(bin, "git"), FAKE_GIT),
    writeExecutable(path.join(bin, "npm"), FAKE_NPM),
    writeFile(log, ""),
  ]);
  return { root, bin, output, log };
}

async function writeExecutable(filename: string, contents: string) {
  await writeFile(filename, contents);
  await chmod(filename, 0o755);
}

async function runVerifier(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  arguments_: string[] = [],
  environment: Record<string, string> = {},
) {
  const options = {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ...environment,
      FAKE_COMMAND_LOG: fixture.log,
      FAKE_COMMIT: "abc123",
      PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    encoding: "utf8" as const,
    maxBuffer: 10 * 1024 * 1024,
  };
  try {
    const result = await execFileAsync(
      process.execPath,
      [verifier, "--output", fixture.output, ...arguments_],
      options,
    );
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      typeof error.code !== "number"
    ) {
      throw error;
    }
    return {
      code: error.code,
      stdout:
        "stdout" in error && typeof error.stdout === "string"
          ? error.stdout
          : "",
      stderr:
        "stderr" in error && typeof error.stderr === "string"
          ? error.stderr
          : "",
    };
  }
}

async function readLog(filename: string) {
  const contents = await readFile(filename, "utf8");
  return contents
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          action: string;
          args: string[];
        },
    );
}

async function readEvidence(output: string): Promise<ReleaseEvidence> {
  return JSON.parse(
    await readFile(path.join(output, "release-evidence.json"), "utf8"),
  ) as ReleaseEvidence;
}
