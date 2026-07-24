import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const output = path.join(root, "dist");

await mkdir(output, { recursive: true });
await cp(path.join(root, "apps", "web", "dist"), path.join(output, "web"), {
  recursive: true,
  force: true,
});

for (const directory of ["docs", "examples"]) {
  await cp(path.join(root, directory), path.join(output, directory), {
    recursive: true,
    force: true,
  });
}
