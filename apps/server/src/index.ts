import { writeFile, unlink } from "node:fs/promises";
import { buildApp } from "./http/app.js";
import {
  ensureRuntimeLayout,
  resolveEnvironment,
} from "./config/environment.js";

const environment = resolveEnvironment();
await ensureRuntimeLayout(environment);
const { app } = await buildApp({ environment });

let closing = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  app.log.info({ signal }, "AgentFlow is shutting down");
  await app.close();
  await unlink(environment.pidPath).catch(() => undefined);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await writeFile(environment.pidPath, `${process.pid}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
await app.listen({
  host: environment.host,
  port: environment.port,
});
