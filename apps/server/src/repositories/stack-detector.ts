import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { DetectedStack } from "../domain/types.js";

const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

const FRONTEND_CANDIDATES = [
  "apps/web",
  "apps/frontend",
  "web",
  "frontend",
  "client",
] as const;

const BACKEND_CANDIDATES = [
  "apps/server",
  "apps/api",
  "apps/backend",
  "server",
  "api",
  "backend",
] as const;

const CONTRACT_CANDIDATES = [
  "contracts",
  "packages/contracts",
  "apps/contracts",
] as const;

interface PackageJson {
  packageManager?: unknown;
  scripts?: unknown;
  workspaces?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

interface PackageManifest {
  root: string;
  json: PackageJson;
}

export async function detectRepositoryStack(
  repositoryRoot: string,
  configuredContractRoots: string[] = [],
  configuredComposeFile?: string,
): Promise<DetectedStack> {
  const rootManifest = await readPackageManifest(repositoryRoot);
  const packageRoots = await discoverPackageRoots(repositoryRoot);
  const manifests = (
    await Promise.all(
      packageRoots.map(async (packageRoot) => readPackageManifest(packageRoot)),
    )
  ).filter((manifest): manifest is PackageManifest => manifest !== null);

  if (rootManifest !== null) {
    manifests.unshift(rootManifest);
  }

  const packageManager = await detectPackageManager(
    repositoryRoot,
    rootManifest?.json,
  );
  const scripts = scriptNames(rootManifest?.json);
  const frameworks = await detectFrameworks(repositoryRoot, manifests);
  const composeFile = await detectComposeFile(
    repositoryRoot,
    configuredComposeFile,
  );
  const monorepo = await detectMonorepo(
    repositoryRoot,
    rootManifest?.json,
    packageRoots,
  );
  const frontendRoots = await detectApplicationRoots(
    repositoryRoot,
    FRONTEND_CANDIDATES,
    manifests,
    "frontend",
  );
  const backendRoots = await detectApplicationRoots(
    repositoryRoot,
    BACKEND_CANDIDATES,
    manifests,
    "backend",
  );
  const contractRoots = await detectContractRoots(
    repositoryRoot,
    configuredContractRoots,
  );
  const suggestedValidation = suggestValidationCommands(
    packageManager,
    scripts,
  );

  return {
    ...(packageManager === undefined ? {} : { packageManager }),
    scripts,
    frameworks,
    ...(composeFile === undefined ? {} : { composeFile }),
    monorepo,
    frontendRoots,
    backendRoots,
    contractRoots,
    suggestedValidation,
  };
}

async function detectPackageManager(
  repositoryRoot: string,
  manifest: PackageJson | undefined,
): Promise<DetectedStack["packageManager"]> {
  if (typeof manifest?.packageManager === "string") {
    const declared = manifest.packageManager.split("@", 1)[0];
    if (declared === "npm" || declared === "pnpm" || declared === "yarn") {
      return declared;
    }
  }

  if (
    (await exists(path.join(repositoryRoot, "pnpm-lock.yaml"))) ||
    (await exists(path.join(repositoryRoot, "pnpm-workspace.yaml")))
  ) {
    return "pnpm";
  }
  if (await exists(path.join(repositoryRoot, "yarn.lock"))) {
    return "yarn";
  }
  if (
    (await exists(path.join(repositoryRoot, "package-lock.json"))) ||
    (await exists(path.join(repositoryRoot, "npm-shrinkwrap.json")))
  ) {
    return "npm";
  }
  return rootManifestIsNode(manifest) ? "npm" : undefined;
}

async function detectFrameworks(
  repositoryRoot: string,
  manifests: PackageManifest[],
): Promise<string[]> {
  const dependencies = new Set<string>();
  for (const manifest of manifests) {
    for (const name of dependencyNames(manifest.json)) {
      dependencies.add(name);
    }
  }

  const roots = [
    repositoryRoot,
    ...manifests.map((manifest) => manifest.root),
  ];
  const frameworkChecks: Array<[string, boolean]> = [
    [
      "Vite",
      dependencies.has("vite") ||
        (await anyRootHasFile(roots, [
          "vite.config.ts",
          "vite.config.js",
          "vite.config.mts",
          "vite.config.mjs",
        ])),
    ],
    [
      "Next.js",
      dependencies.has("next") ||
        (await anyRootHasFile(roots, [
          "next.config.ts",
          "next.config.js",
          "next.config.mjs",
        ])),
    ],
    ["React", dependencies.has("react")],
    [
      "Playwright",
      dependencies.has("@playwright/test") ||
        dependencies.has("playwright") ||
        (await anyRootHasFile(roots, [
          "playwright.config.ts",
          "playwright.config.js",
          "playwright.config.mts",
        ])),
    ],
  ];
  return frameworkChecks
    .filter(([, detected]) => detected)
    .map(([framework]) => framework);
}

async function detectComposeFile(
  repositoryRoot: string,
  configuredComposeFile?: string,
): Promise<string | undefined> {
  const candidates =
    configuredComposeFile === undefined
      ? COMPOSE_FILES
      : [configuredComposeFile, ...COMPOSE_FILES];
  for (const candidate of candidates) {
    if (await exists(path.join(repositoryRoot, candidate))) {
      return candidate;
    }
  }
  return undefined;
}

async function detectMonorepo(
  repositoryRoot: string,
  manifest: PackageJson | undefined,
  packageRoots: string[],
): Promise<boolean> {
  return (
    hasWorkspaces(manifest) ||
    packageRoots.length > 0 ||
    (await anyRootHasFile([repositoryRoot], [
      "pnpm-workspace.yaml",
      "lerna.json",
      "nx.json",
      "turbo.json",
      "rush.json",
    ]))
  );
}

async function detectApplicationRoots(
  repositoryRoot: string,
  knownCandidates: readonly string[],
  manifests: PackageManifest[],
  kind: "frontend" | "backend",
): Promise<string[]> {
  const detected = new Set<string>();
  for (const candidate of knownCandidates) {
    if (await isDirectory(path.join(repositoryRoot, candidate))) {
      detected.add(toPosix(candidate));
    }
  }

  for (const manifest of manifests) {
    if (manifest.root === repositoryRoot) {
      continue;
    }
    const relative = toPosix(path.relative(repositoryRoot, manifest.root));
    const dependencies = dependencyNames(manifest.json);
    const leaf = path.basename(manifest.root).toLowerCase();
    if (
      kind === "frontend" &&
      (dependencies.includes("react") ||
        dependencies.includes("next") ||
        dependencies.includes("vite") ||
        /^(web|frontend|client|ui)$/u.test(leaf))
    ) {
      detected.add(relative);
    }
    if (
      kind === "backend" &&
      (dependencies.some((name) =>
        [
          "fastify",
          "express",
          "hono",
          "koa",
          "@nestjs/core",
        ].includes(name),
      ) ||
        /^(server|api|backend)$/u.test(leaf))
    ) {
      detected.add(relative);
    }
  }
  return [...detected].sort();
}

async function detectContractRoots(
  repositoryRoot: string,
  configuredRoots: string[],
): Promise<string[]> {
  const candidates = new Set([
    ...configuredRoots.map(stripTrailingSlash),
    ...CONTRACT_CANDIDATES,
  ]);
  const detected: string[] = [];
  for (const candidate of candidates) {
    if (await isDirectory(path.join(repositoryRoot, candidate))) {
      detected.push(toPosix(candidate));
    }
  }
  return [...new Set(detected)].sort();
}

function suggestValidationCommands(
  packageManager: DetectedStack["packageManager"],
  scripts: string[],
): string[] {
  if (packageManager === undefined) {
    return [];
  }
  const available = new Set(scripts);
  return ["lint", "typecheck", "test", "build"]
    .filter((script) => available.has(script))
    .map((script) => packageScriptCommand(packageManager, script));
}

function packageScriptCommand(
  packageManager: NonNullable<DetectedStack["packageManager"]>,
  script: string,
): string {
  if (packageManager === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }
  if (packageManager === "pnpm") {
    return script === "test" ? "pnpm test" : `pnpm run ${script}`;
  }
  return `yarn ${script}`;
}

async function discoverPackageRoots(
  repositoryRoot: string,
): Promise<string[]> {
  const roots = new Set<string>();
  for (const parentName of ["apps", "packages"]) {
    const parent = path.join(repositoryRoot, parentName);
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        (await exists(path.join(parent, entry.name, "package.json")))
      ) {
        roots.add(path.join(parent, entry.name));
      }
    }
  }
  return [...roots].sort();
}

async function readPackageManifest(
  packageRoot: string,
): Promise<PackageManifest | null> {
  const manifestPath = path.join(packageRoot, "package.json");
  try {
    const source = await readFile(manifestPath, "utf8");
    return {
      root: packageRoot,
      json: JSON.parse(source) as PackageJson,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function scriptNames(manifest: PackageJson | undefined): string[] {
  if (!isRecord(manifest?.scripts)) {
    return [];
  }
  return Object.entries(manifest.scripts)
    .filter(([, value]) => typeof value === "string")
    .map(([name]) => name)
    .sort();
}

function dependencyNames(manifest: PackageJson): string[] {
  return [
    ...recordKeys(manifest.dependencies),
    ...recordKeys(manifest.devDependencies),
  ];
}

function recordKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : [];
}

function rootManifestIsNode(
  manifest: PackageJson | undefined,
): manifest is PackageJson {
  return manifest !== undefined;
}

function hasWorkspaces(manifest: PackageJson | undefined): boolean {
  if (Array.isArray(manifest?.workspaces)) {
    return manifest.workspaces.length > 0;
  }
  return (
    isRecord(manifest?.workspaces) &&
    Array.isArray(manifest.workspaces.packages) &&
    manifest.workspaces.packages.length > 0
  );
}

async function anyRootHasFile(
  roots: string[],
  candidates: string[],
): Promise<boolean> {
  for (const root of new Set(roots)) {
    for (const candidate of candidates) {
      if (await exists(path.join(root, candidate))) {
        return true;
      }
    }
  }
  return false;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    await readdir(candidate);
    return true;
  } catch {
    return false;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "");
}

function toPosix(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
