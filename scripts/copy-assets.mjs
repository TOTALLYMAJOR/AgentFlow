import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
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

const migrationsSource = await readFile(
  path.join(root, "apps", "server", "src", "db", "migrations.ts"),
  "utf8",
);
const migrationDirectory = path.join(output, "migrations");
await mkdir(migrationDirectory, { recursive: true });

const sqlByConstant = new Map(
  [...migrationsSource.matchAll(/const ([A-Z_]+) = `\n([\s\S]*?)`;/g)].map(
    (match) => [match[1], `\n${match[2]}`],
  ),
);
const migrationListMatch = migrationsSource.match(
  /export const MIGRATIONS[\s\S]*?Object\.freeze\(\[([\s\S]*?)\]\);/,
);
if (migrationListMatch === null) {
  throw new Error("Unable to find the AgentFlow migration catalog");
}

const migrations = [
  ...migrationListMatch[1].matchAll(
    /version:\s*(\d+),\s*name:\s*"([^"]+)",\s*sql:\s*([A-Z_]+),/g,
  ),
].map((match) => {
  const version = Number.parseInt(match[1], 10);
  const name = match[2];
  const sql = sqlByConstant.get(match[3]);
  if (sql === undefined) {
    throw new Error(`Migration ${version} references missing SQL ${match[3]}`);
  }
  return {
    version,
    name,
    sql,
    runtimeChecksum: createHash("sha256")
      .update(`${version}\n${name}\n${sql}`)
      .digest("hex"),
    fileSha256: createHash("sha256")
      .update(`${sql.trimEnd()}\n`)
      .digest("hex"),
  };
});

if (migrations.length === 0) {
  throw new Error("The AgentFlow migration catalog is empty");
}
let previousVersion = 0;
const migrationNames = new Set();
for (const migration of migrations) {
  if (migration.version <= previousVersion) {
    throw new Error(
      `Migration versions must increase (${previousVersion} then ${migration.version})`,
    );
  }
  if (migrationNames.has(migration.name)) {
    throw new Error(`Duplicate migration name: ${migration.name}`);
  }
  previousVersion = migration.version;
  migrationNames.add(migration.name);
  const filename = `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`;
  await writeFile(
    path.join(migrationDirectory, filename),
    `${migration.sql.trimEnd()}\n`,
    "utf8",
  );
}

await writeFile(
  path.join(migrationDirectory, "manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      migrations: migrations.map(
        ({ version, name, runtimeChecksum, fileSha256 }) => ({
          version,
          name,
          runtimeChecksum,
          fileSha256,
          file: `${String(version).padStart(4, "0")}_${name}.sql`,
        }),
      ),
    },
    null,
    2,
  )}\n`,
  "utf8",
);
