import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const outputDirectory = path.resolve(options.output ?? path.join(root, "release"));
const evidencePath = path.resolve(
  options.evidence ?? path.join(outputDirectory, "release-evidence.json"),
);
const mode = options.diagnostic ? "NON_FINAL_DIAGNOSTIC" : "FINAL";
const steps = [
  step("full-verification"),
  step("deterministic-packaging"),
  step("checksum-verification"),
  step("isolated-install-smoke"),
];
const evidence = {
  schemaVersion: 1,
  qualification: mode,
  finalQualification: !options.diagnostic,
  releaseReady: false,
  status: "running",
  repository: root,
  outputDirectory,
  gitCommit: null,
  version: null,
  sourceDirty: null,
  artifacts: null,
  steps,
  error: null,
};
let evidenceDestinationSafe = false;

try {
  await requireSafeDestinations();
  evidenceDestinationSafe = true;
  const status = await capture("git", [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  evidence.sourceDirty = status.trim().length > 0;
  evidence.gitCommit = (
    await capture("git", ["rev-parse", "--verify", "HEAD"])
  ).trim();

  if (evidence.sourceDirty && !options.diagnostic) {
    throw new Error(
      "Final release qualification requires a clean Git worktree. Use --diagnostic only for explicitly non-final troubleshooting.",
    );
  }
  if (options.diagnostic) {
    process.stderr.write(
      "NON-FINAL DIAGNOSTIC: this run cannot establish release readiness.\n",
    );
  }

  await executeStep(steps[0], "npm", ["run", "verify"]);

  await executeStep(steps[1], "npm", [
    "run",
    "pack:release",
    "--",
    "--output",
    outputDirectory,
    "--force",
    ...(options.diagnostic ? ["--allow-dirty"] : []),
  ]);

  const qualified = await executeStep(
    steps[2],
    process.execPath,
    [],
    () =>
      qualifyArtifacts({
        outputDirectory,
        expectedCommit: evidence.gitCommit,
        expectedTag: options.tag,
        diagnostic: options.diagnostic,
      }),
  );
  evidence.version = qualified.version;
  evidence.sourceDirty = qualified.sourceDirty;
  evidence.artifacts = qualified.files;

  await executeStep(steps[3], "npm", [
    "run",
    "smoke:install",
    "--",
    path.join(outputDirectory, qualified.files.tarball),
  ]);

  evidence.status = "passed";
  evidence.releaseReady = !options.diagnostic;
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? error.message : String(error);
  for (const candidate of steps) {
    if (candidate.status === "pending") {
      candidate.status = "skipped";
    }
  }
  process.exitCode = 1;
} finally {
  evidence.completedAt = new Date().toISOString();
  evidence.evidencePath = evidencePath;
  if (evidenceDestinationSafe) {
    try {
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      evidence.status = "failed";
      evidence.releaseReady = false;
      evidence.error =
        evidence.error === null
          ? `Unable to write release evidence: ${message}`
          : `${evidence.error}; unable to write release evidence: ${message}`;
      process.exitCode = 1;
    }
  }

  const summary = JSON.stringify(evidence);
  process.stdout.write(`AGENTFLOW_RELEASE_EVIDENCE=${summary}\n`);
  if (evidence.status === "failed") {
    process.stderr.write(`Release qualification failed: ${evidence.error}\n`);
  } else if (options.diagnostic) {
    process.stdout.write(
      "NON-FINAL DIAGNOSTIC complete; release readiness remains false.\n",
    );
  } else {
    process.stdout.write("Final release qualification passed.\n");
  }
}

function step(name) {
  return { name, status: "pending", startedAt: null, completedAt: null };
}

async function executeStep(record, command, arguments_, operation) {
  record.status = "running";
  record.startedAt = new Date().toISOString();
  try {
    const result =
      operation === undefined
        ? await run(command, arguments_)
        : await operation();
    record.status = "passed";
    return result;
  } catch (error) {
    record.status = "failed";
    throw error;
  } finally {
    record.completedAt = new Date().toISOString();
  }
}

async function qualifyArtifacts({
  outputDirectory: directory,
  expectedCommit,
  expectedTag,
  diagnostic,
}) {
  const packageMetadata = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const manifestPath = path.join(directory, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.package !== packageMetadata.name ||
    manifest.version !== packageMetadata.version
  ) {
    throw new Error("Release manifest does not match package metadata");
  }
  if (manifest.gitCommit !== expectedCommit) {
    throw new Error(
      `Release manifest commit ${String(manifest.gitCommit)} does not match ${expectedCommit}`,
    );
  }
  if (!diagnostic && manifest.sourceDirty !== false) {
    throw new Error("Final release manifest reports a dirty source tree");
  }
  if (expectedTag !== undefined && expectedTag !== `v${manifest.version}`) {
    throw new Error(
      `Release tag ${expectedTag} does not match package version v${manifest.version}`,
    );
  }
  if (!Array.isArray(manifest.artifacts)) {
    throw new Error("Release manifest artifacts are missing");
  }

  const manifestFiles = manifest.artifacts.map((artifact) =>
    requireSafeArtifact(artifact?.file),
  );
  const tarballs = manifestFiles.filter((file) => file.endsWith(".tgz"));
  const sources = manifestFiles.filter((file) => file.endsWith("-source.zip"));
  if (tarballs.length !== 1 || sources.length !== 1) {
    throw new Error(
      "Release manifest must identify exactly one tarball and one source archive",
    );
  }

  const checksums = parseChecksums(
    await readFile(path.join(directory, "SHA256SUMS"), "utf8"),
  );
  const expectedChecksumFiles = new Set([
    ...manifestFiles,
    "release-manifest.json",
  ]);
  if (
    checksums.size !== expectedChecksumFiles.size ||
    [...expectedChecksumFiles].some((file) => !checksums.has(file))
  ) {
    throw new Error(
      "SHA256SUMS must contain exactly the manifest artifacts and release manifest",
    );
  }

  for (const [file, expectedHash] of checksums) {
    const actualHash = await sha256File(path.join(directory, file));
    if (actualHash !== expectedHash) {
      throw new Error(`Checksum verification failed for ${file}`);
    }
  }
  for (const artifact of manifest.artifacts) {
    const file = requireSafeArtifact(artifact?.file);
    const fileStat = await stat(path.join(directory, file));
    if (
      artifact.sha256 !== checksums.get(file) ||
      artifact.bytes !== fileStat.size
    ) {
      throw new Error(`Manifest metadata verification failed for ${file}`);
    }
  }

  return {
    version: manifest.version,
    sourceDirty: manifest.sourceDirty === true,
    files: {
      tarball: tarballs[0],
      sourceArchive: sources[0],
      manifest: "release-manifest.json",
      checksums: "SHA256SUMS",
    },
  };
}

function parseChecksums(contents) {
  const result = new Map();
  const lines = contents.split("\n").filter(Boolean);
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/.exec(line);
    if (match === null) {
      throw new Error(`Invalid SHA256SUMS entry: ${line}`);
    }
    if (result.has(match[2])) {
      throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`);
    }
    result.set(match[2], match[1]);
  }
  return result;
}

function requireSafeArtifact(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.basename(value) !== value ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`Unsafe release artifact path: ${String(value)}`);
  }
  return value;
}

async function sha256File(filename) {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function requireSafeDestinations() {
  if ([root, path.parse(outputDirectory).root, path.resolve(homedir())].includes(outputDirectory)) {
    throw new Error(`Refusing unsafe release output directory: ${outputDirectory}`);
  }
  const insideOutput = evidencePath.startsWith(`${outputDirectory}${path.sep}`);
  if (evidencePath === outputDirectory ||
      (insideOutput && evidencePath !== path.join(outputDirectory, "release-evidence.json"))) {
    throw new Error("Evidence cannot replace a release asset. Use release-evidence.json or a fresh file outside the output directory.");
  }
  try {
    await lstat(path.join(outputDirectory, "release-evidence.json"));
    throw new Error("Output retains qualification evidence. Choose a fresh --output; the earlier report will not be replaced.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const destination of [outputDirectory, evidencePath]) {
    let current = destination;
    while (true) {
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink()) {
          throw new Error(`Refusing symlinked release destination: ${current}`);
        }
        if (current === evidencePath) {
          throw new Error("Evidence path already exists. Choose a new --evidence or --output; retained evidence will not be overwritten.");
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${arguments_.join(" ")} failed ${
            signal === null ? `with exit code ${String(code)}` : `from ${signal}`
          }`,
        ),
      );
    });
  });
}

async function capture(command, arguments_) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          `${command} ${arguments_.join(" ")} failed ${
            signal === null ? `with exit code ${String(code)}` : `from ${signal}`
          }: ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
  });
}

function parseArguments(arguments_) {
  const result = {
    diagnostic: false,
    output: undefined,
    evidence: undefined,
    tag: undefined,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--diagnostic") {
      result.diagnostic = true;
      continue;
    }
    if (["--output", "--evidence", "--tag"].includes(argument)) {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      const key =
        argument === "--output"
          ? "output"
          : argument === "--evidence"
            ? "evidence"
            : "tag";
      result[key] = value;
      index += 1;
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: npm run release:verify -- [--diagnostic] [--output <directory>] [--evidence <file>] [--tag v<version>]\n",
      );
      process.exit(0);
    }
    throw new Error(`Unknown release verification option: ${argument}`);
  }
  if (result.diagnostic && result.tag !== undefined) {
    throw new Error(
      "--diagnostic cannot be combined with --tag because tag qualification must be final",
    );
  }
  return result;
}
