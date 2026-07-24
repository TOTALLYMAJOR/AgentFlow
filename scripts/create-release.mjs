import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value =
      (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return value >>> 0;
});
const options = parseArguments(process.argv.slice(2));
const packageMetadata = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const version = requireSafeVersion(packageMetadata.version);
const outputDirectory = path.resolve(
  options.output ?? path.join(root, "release"),
);

assertSafeOutputDirectory(outputDirectory);
const gitStatus = await run("git", [
  "status",
  "--porcelain",
  "--untracked-files=all",
]);
if (gitStatus.stdout.length > 0 && !options.allowDirty) {
  throw new Error(
    "Release creation requires a clean Git worktree. Commit or stash changes, or pass --allow-dirty for a non-final diagnostic build.",
  );
}
const gitCommit = (
  await run("git", ["rev-parse", "--verify", "HEAD"])
).stdout.trim();

const outputExists = await exists(outputDirectory);
if (outputExists) {
  if (!options.force) {
    throw new Error(
      `Release output already exists: ${outputDirectory}. Pass --force to replace this exact directory.`,
    );
  }
  await assertReplaceableReleaseDirectory(outputDirectory);
}

const parentDirectory = path.dirname(outputDirectory);
await mkdir(parentDirectory, { recursive: true });
const stageRoot = await mkdtemp(
  path.join(parentDirectory, ".agentflow-release-stage-"),
);

try {
  const packDirectory = path.join(stageRoot, "npm-pack");
  const repeatPackDirectory = path.join(stageRoot, "npm-pack-repeat");
  const finalDirectory = path.join(stageRoot, "final");
  await Promise.all([
    mkdir(packDirectory),
    mkdir(repeatPackDirectory),
    mkdir(finalDirectory),
  ]);

  await run(
    "npm",
    ["pack", "--json", "--pack-destination", packDirectory],
    root,
  );
  const packedPath = await requireSingleTarball(packDirectory);
  await verifyPackageContents(packedPath);

  // The second pack intentionally skips prepack. It proves that npm's archive
  // representation is stable for the exact built tree used by the first pack.
  await run(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      repeatPackDirectory,
    ],
    root,
  );
  const repeatedPath = await requireSingleTarball(repeatPackDirectory);
  const [packedHash, repeatedHash] = await Promise.all([
    sha256File(packedPath),
    sha256File(repeatedPath),
  ]);
  if (packedHash !== repeatedHash) {
    throw new Error(
      "npm produced different tarballs for the same built source tree",
    );
  }

  const trackedFiles = await listSourceFiles(options.allowDirty);
  await verifySourceInputs(trackedFiles);
  const sourcePrefix = `agentflow-${version}`;
  const firstZip = await createStoredZip(trackedFiles, sourcePrefix);
  const repeatedZip = await createStoredZip(trackedFiles, sourcePrefix);
  if (!firstZip.equals(repeatedZip)) {
    throw new Error("Source ZIP generation was not deterministic");
  }

  const tarballName = `agentflow-${version}.tgz`;
  const sourceZipName = `agentflow-${version}-source.zip`;
  const tarballPath = path.join(finalDirectory, tarballName);
  const sourceZipPath = path.join(finalDirectory, sourceZipName);
  await Promise.all([
    copyFile(packedPath, tarballPath),
    writeFile(sourceZipPath, firstZip),
  ]);

  const artifacts = await Promise.all(
    [tarballPath, sourceZipPath].map(async (artifactPath) => ({
      file: path.basename(artifactPath),
      sha256: await sha256File(artifactPath),
      bytes: (await stat(artifactPath)).size,
    })),
  );
  const releaseManifest = {
    schemaVersion: 1,
    package: packageMetadata.name,
    version,
    gitCommit,
    sourceDirty: gitStatus.stdout.length > 0,
    nodeEngine: packageMetadata.engines?.node ?? null,
    artifacts,
    installedContent: {
      dashboard: "dist/web/index.html",
      migrations: "dist/migrations/manifest.json",
      specification:
        "docs/architecture/SPEC-1-AgentFlow-Local-Agentic-Engineering-Platform.md",
      implementationPrompts:
        "docs/implementation/AgentFlow-Codex-Implementation-Prompts.md",
      repositoryConfigExample: "examples/.agentflow.yaml",
      backlogExample: "examples/BACKLOG.md",
    },
  };
  const manifestPath = path.join(finalDirectory, "release-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    "utf8",
  );

  const checksumArtifacts = [
    ...artifacts,
    {
      file: path.basename(manifestPath),
      sha256: await sha256File(manifestPath),
      bytes: (await stat(manifestPath)).size,
    },
  ].sort((left, right) => compareText(left.file, right.file));
  await writeFile(
    path.join(finalDirectory, "SHA256SUMS"),
    `${checksumArtifacts
      .map(({ sha256, file }) => `${sha256}  ${file}`)
      .join("\n")}\n`,
    "utf8",
  );

  if (outputExists) {
    await rm(outputDirectory, { recursive: true, force: true });
  }
  await rename(finalDirectory, outputDirectory);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        outputDirectory,
        version,
        gitCommit,
        sourceDirty: gitStatus.stdout.length > 0,
        files: [
          tarballName,
          sourceZipName,
          "release-manifest.json",
          "SHA256SUMS",
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(stageRoot, { recursive: true, force: true });
}

function parseArguments(arguments_) {
  const result = {
    output: undefined,
    force: false,
    allowDirty: false,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--output") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error("--output requires a directory");
      }
      result.output = value;
      index += 1;
      continue;
    }
    if (argument === "--force") {
      result.force = true;
      continue;
    }
    if (argument === "--allow-dirty") {
      result.allowDirty = true;
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: npm run pack:release -- [--output <directory>] [--force] [--allow-dirty]\n",
      );
      process.exit(0);
    }
    throw new Error(`Unknown release option: ${argument}`);
  }
  return result;
}

function requireSafeVersion(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value)
  ) {
    throw new Error(`Unsafe package version: ${String(value)}`);
  }
  return value;
}

function assertSafeOutputDirectory(candidate) {
  const forbidden = new Set([
    path.parse(candidate).root,
    path.resolve(root),
    path.resolve(homedir()),
  ]);
  if (forbidden.has(candidate)) {
    throw new Error(`Refusing unsafe release output directory: ${candidate}`);
  }
}

async function assertReplaceableReleaseDirectory(candidate) {
  const entries = await readdir(candidate);
  if (entries.length === 0) {
    return;
  }
  const manifestPath = path.join(candidate, "release-manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.package === "agentflow" && manifest.schemaVersion === 1) {
      return;
    }
  } catch {
    // Fall through to the refusal below.
  }
  throw new Error(
    `Refusing to replace ${candidate} because it is not a recognized AgentFlow release directory`,
  );
}

async function run(command, arguments_, cwd = root) {
  try {
    return await execFileAsync(command, arguments_, {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
    });
  } catch (error) {
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    throw new Error(
      `${command} ${arguments_.join(" ")} failed${stderr.length > 0 ? `: ${stderr}` : ""}`,
      { cause: error },
    );
  }
}

async function requireSingleTarball(directory) {
  const candidates = (await readdir(directory))
    .filter((entry) => entry.endsWith(".tgz"))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one npm tarball in ${directory}, found ${candidates.length}`,
    );
  }
  return path.join(directory, candidates[0]);
}

async function verifyPackageContents(tarballPath) {
  const listing = (
    await run("tar", ["-tzf", tarballPath], root)
  ).stdout
    .split("\n")
    .filter(Boolean);
  const required = [
    "package/package.json",
    "package/dist/cli.js",
    "package/dist/index.js",
    "package/dist/web/index.html",
    "package/dist/migrations/manifest.json",
    "package/docs/architecture/SPEC-1-AgentFlow-Local-Agentic-Engineering-Platform.md",
    "package/docs/implementation/AgentFlow-Codex-Implementation-Prompts.md",
    "package/docs/INSTALLATION.md",
    "package/docs/TROUBLESHOOTING.md",
    "package/examples/.agentflow.yaml",
    "package/examples/BACKLOG.md",
  ];
  const missing = required.filter((entry) => !listing.includes(entry));
  if (missing.length > 0) {
    throw new Error(`npm tarball is missing: ${missing.join(", ")}`);
  }
  if (
    !listing.some(
      (entry) =>
        entry.startsWith("package/dist/migrations/") &&
        entry.endsWith(".sql"),
    )
  ) {
    throw new Error("npm tarball does not contain exported SQL migrations");
  }
  if (
    !listing.some(
      (entry) =>
        entry.startsWith("package/dist/web/assets/") &&
        entry.endsWith(".js"),
    )
  ) {
    throw new Error("npm tarball does not contain built dashboard assets");
  }
}

async function listSourceFiles(includeUntracked) {
  const output = await run(
    "git",
    [
      "ls-files",
      "--cached",
      ...(includeUntracked ? ["--others", "--exclude-standard"] : []),
      "-z",
    ],
    root,
  );
  return output.stdout
    .split("\0")
    .filter(Boolean)
    .sort(compareText);
}

async function verifySourceInputs(files) {
  const required = [
    "package.json",
    "package-lock.json",
    "apps/server/src/db/migrations.ts",
    "scripts/create-release.mjs",
    "scripts/smoke-install.mjs",
    "docs/architecture/SPEC-1-AgentFlow-Local-Agentic-Engineering-Platform.md",
    "docs/implementation/AgentFlow-Codex-Implementation-Prompts.md",
    "examples/.agentflow.yaml",
    "examples/BACKLOG.md",
  ];
  const missing = required.filter((entry) => !files.includes(entry));
  if (missing.length > 0) {
    throw new Error(`Source ZIP inputs are missing: ${missing.join(", ")}`);
  }
  const expectedHashes = new Map([
    [
      "docs/architecture/SPEC-1-AgentFlow-Local-Agentic-Engineering-Platform.md",
      "341dac47141bfcd67a4d373e1bcfd22be4357f9676d7f4cabec86e3d14c19fad",
    ],
    [
      "docs/implementation/AgentFlow-Codex-Implementation-Prompts.md",
      "93114c0040f8bebc0278fe253744193db60fe854908e7447760f42b4bad7c3bd",
    ],
  ]);
  for (const [relativePath, expectedHash] of expectedHashes) {
    const actualHash = await sha256File(path.join(root, relativePath));
    if (actualHash !== expectedHash) {
      throw new Error(
        `${relativePath} does not match the supplied artifact (${actualHash})`,
      );
    }
  }
}

async function createStoredZip(files, prefix) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const relativePath of files) {
    const absolutePath = path.resolve(root, relativePath);
    if (
      absolutePath !== root &&
      !absolutePath.startsWith(`${root}${path.sep}`)
    ) {
      throw new Error(`Source path escapes the repository: ${relativePath}`);
    }
    const fileStat = await lstat(absolutePath);
    if (!fileStat.isFile()) {
      throw new Error(`Source ZIP only supports regular files: ${relativePath}`);
    }
    const data = await readFile(absolutePath);
    const archivePath = `${prefix}/${relativePath.replaceAll(path.sep, "/")}`;
    const name = Buffer.from(archivePath, "utf8");
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(33, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(33, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(
      (((fileStat.mode & 0xffff) << 16) | 0) >>> 0,
      38,
    );
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  if (files.length > 65_535 || offset > 0xffffffff) {
    throw new Error("Source tree exceeds classic ZIP limits");
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function sha256File(filename) {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
