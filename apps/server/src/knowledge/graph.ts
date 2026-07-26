import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  KnowledgeEdgeEntity,
  KnowledgeNodeEntity,
} from "../db/index.js";
import { GitCommandRunner } from "../git/index.js";

const INDEXED_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface CodebaseGraph {
  baseCommit: string;
  nodes: KnowledgeNodeEntity[];
  edges: KnowledgeEdgeEntity[];
  skippedFiles: number;
}

export interface ImpactedFile {
  path: string;
  distance: number;
  importedChangedPaths: string[];
}

export async function scanCodebaseGraph(
  repositoryRoot: string,
): Promise<CodebaseGraph> {
  const git = new GitCommandRunner();
  const [commit, tracked] = await Promise.all([
    git.run(repositoryRoot, ["rev-parse", "HEAD"]),
    git.run(repositoryRoot, ["ls-files", "-z"]),
  ]);
  const indexedPaths = tracked.stdout
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .filter((filePath) => INDEXED_EXTENSIONS.has(path.posix.extname(filePath)))
    .sort();
  if (indexedPaths.length > MAX_FILES) {
    throw new Error(
      `Knowledge scan found ${indexedPaths.length} files; maximum is ${MAX_FILES}`,
    );
  }
  const sources = new Map<string, string>();
  const nodes: KnowledgeNodeEntity[] = [];
  let skippedFiles = 0;
  for (const filePath of indexedPaths) {
    const content = await readFile(path.join(repositoryRoot, filePath));
    if (content.byteLength > MAX_FILE_BYTES) {
      skippedFiles += 1;
      continue;
    }
    const source = content.toString("utf8");
    sources.set(filePath, source);
    nodes.push({
      path: filePath,
      kind: classifyPath(filePath),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  const available = new Set(nodes.map((node) => node.path));
  const edges: KnowledgeEdgeEntity[] = [];
  const edgeKeys = new Set<string>();
  for (const [sourcePath, source] of sources) {
    if (!isImportSource(sourcePath)) {
      continue;
    }
    for (const specifier of extractRelativeImports(source)) {
      const targetPath = resolveImport(sourcePath, specifier, available);
      if (targetPath === undefined) {
        continue;
      }
      const key = `${sourcePath}\0${targetPath}`;
      if (edgeKeys.has(key)) {
        continue;
      }
      edgeKeys.add(key);
      edges.push({ sourcePath, targetPath, edgeType: "imports" });
    }
  }
  edges.sort(
    (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) ||
      left.targetPath.localeCompare(right.targetPath),
  );
  return {
    baseCommit: commit.stdout.trim(),
    nodes,
    edges,
    skippedFiles,
  };
}

export function analyzeImpact(
  changedPaths: readonly string[],
  nodes: readonly KnowledgeNodeEntity[],
  edges: readonly KnowledgeEdgeEntity[],
): ImpactedFile[] {
  const normalizedChanges = [...new Set(changedPaths.map(normalizePath))];
  const knownPaths = new Set(nodes.map((node) => node.path));
  const roots = [...knownPaths].filter((candidate) =>
    normalizedChanges.some(
      (changed) =>
        candidate === changed ||
        candidate.startsWith(`${changed.replace(/\/+$/u, "")}/`),
    ),
  );
  const reverse = new Map<string, string[]>();
  for (const edge of edges) {
    const importers = reverse.get(edge.targetPath) ?? [];
    importers.push(edge.sourcePath);
    reverse.set(edge.targetPath, importers);
  }
  const distance = new Map(roots.map((root) => [root, 0]));
  const reasons = new Map<string, Set<string>>(
    roots.map((root) => [root, new Set([root])]),
  );
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    const nextDistance = (distance.get(current) ?? 0) + 1;
    for (const importer of reverse.get(current) ?? []) {
      const existingDistance = distance.get(importer);
      if (existingDistance === undefined || nextDistance < existingDistance) {
        distance.set(importer, nextDistance);
        queue.push(importer);
      }
      const importerReasons = reasons.get(importer) ?? new Set<string>();
      for (const reason of reasons.get(current) ?? [current]) {
        importerReasons.add(reason);
      }
      reasons.set(importer, importerReasons);
    }
  }
  return [...distance.entries()]
    .map(([filePath, fileDistance]) => ({
      path: filePath,
      distance: fileDistance,
      importedChangedPaths: [...(reasons.get(filePath) ?? [])].sort(),
    }))
    .sort(
      (left, right) =>
        left.distance - right.distance || left.path.localeCompare(right.path),
    );
}

function extractRelativeImports(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].flatMap((match) => {
      const specifier = match[1];
      return specifier?.startsWith(".") === true ? [specifier] : [];
    }),
  );
}

function resolveImport(
  sourcePath: string,
  specifier: string,
  available: ReadonlySet<string>,
): string | undefined {
  const base = normalizePath(
    path.posix.join(path.posix.dirname(sourcePath), specifier),
  );
  const runtimeExtension = path.posix.extname(base);
  const sourceBase = [".js", ".mjs", ".cjs"].includes(runtimeExtension)
    ? base.slice(0, -runtimeExtension.length)
    : base;
  const candidates = [
    base,
    ...IMPORT_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...IMPORT_EXTENSIONS.map((extension) => `${sourceBase}${extension}`),
    ...IMPORT_EXTENSIONS.map((extension) =>
      path.posix.join(base, `index${extension}`),
    ),
  ];
  return candidates.find((candidate) => available.has(candidate));
}

function classifyPath(filePath: string): KnowledgeNodeEntity["kind"] {
  if (/\.(?:test|spec)\.[^.]+$/u.test(filePath) || filePath.includes("/test/")) {
    return "test";
  }
  if (path.posix.extname(filePath) === ".md") {
    return "document";
  }
  if (
    /(?:^|\/)(?:package|tsconfig|vite\.config|vitest\.config|eslint)/u.test(
      filePath,
    ) ||
    [".json", ".yaml", ".yml"].includes(path.posix.extname(filePath))
  ) {
    return "config";
  }
  return "source";
}

function isImportSource(filePath: string): boolean {
  return IMPORT_EXTENSIONS.includes(path.posix.extname(filePath));
}

function normalizePath(filePath: string): string {
  return path.posix
    .normalize(filePath.replaceAll("\\", "/"))
    .replace(/^\.\//u, "");
}
