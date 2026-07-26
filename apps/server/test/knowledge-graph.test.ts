import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeImpact,
  scanCodebaseGraph,
} from "../src/knowledge/graph.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("codebase knowledge graph", () => {
  it("indexes tracked imports and calculates reverse dependency impact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agentflow-knowledge-"));
    roots.push(root);
    await execFileAsync("git", ["init", "--initial-branch=main", root]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "test@example.test",
    ]);
    await mkdir(path.join(root, "src", "domain"), { recursive: true });
    await writeFile(
      path.join(root, "src", "domain", "contract.ts"),
      "export const contract = 'v1';\n",
    );
    await writeFile(
      path.join(root, "src", "service.ts"),
      "import { contract } from './domain/contract.js';\nexport { contract };\n",
    );
    await writeFile(
      path.join(root, "src", "index.ts"),
      "export { contract } from './service.js';\n",
    );
    await writeFile(
      path.join(root, "src", "index.test.ts"),
      "import { contract } from './index.js';\nvoid contract;\n",
    );
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", [
      "-C",
      root,
      "commit",
      "-m",
      "fixture",
    ]);

    const graph = await scanCodebaseGraph(root);
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toEqual([
      {
        sourcePath: "src/index.test.ts",
        targetPath: "src/index.ts",
        edgeType: "imports",
      },
      {
        sourcePath: "src/index.ts",
        targetPath: "src/service.ts",
        edgeType: "imports",
      },
      {
        sourcePath: "src/service.ts",
        targetPath: "src/domain/contract.ts",
        edgeType: "imports",
      },
    ]);
    expect(
      analyzeImpact(
        ["src/domain/contract.ts"],
        graph.nodes,
        graph.edges,
      ).map(({ path: filePath, distance }) => ({ filePath, distance })),
    ).toEqual([
      { filePath: "src/domain/contract.ts", distance: 0 },
      { filePath: "src/service.ts", distance: 1 },
      { filePath: "src/index.ts", distance: 2 },
      { filePath: "src/index.test.ts", distance: 3 },
    ]);
  });
});
