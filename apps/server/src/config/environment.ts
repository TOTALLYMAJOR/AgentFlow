import { homedir } from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";

const EnvironmentSchema = z.object({
  AGENTFLOW_HOME: z.string().trim().min(1).optional(),
  AGENTFLOW_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  AGENTFLOW_PORT: z.coerce.number().int().min(1).max(65_535).default(4782),
  AGENTFLOW_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  AGENTFLOW_CODEX_BIN: z.string().trim().min(1).default("codex"),
  AGENTFLOW_WORKER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(1_800_000),
});

export interface AgentFlowEnvironment {
  home: string;
  host: "127.0.0.1";
  port: number;
  logLevel:
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace"
    | "silent";
  codexBinary: string;
  workerTimeoutMs: number;
  databasePath: string;
  logsPath: string;
  runsPath: string;
  worktreesPath: string;
  backupsPath: string;
  pidPath: string;
}

export function resolveEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): AgentFlowEnvironment {
  const parsed = EnvironmentSchema.parse(source);
  const home = path.resolve(
    parsed.AGENTFLOW_HOME ?? path.join(homedir(), ".agentflow"),
  );
  return {
    home,
    host: parsed.AGENTFLOW_HOST,
    port: parsed.AGENTFLOW_PORT,
    logLevel: parsed.AGENTFLOW_LOG_LEVEL,
    codexBinary: parsed.AGENTFLOW_CODEX_BIN,
    workerTimeoutMs: parsed.AGENTFLOW_WORKER_TIMEOUT_MS,
    databasePath: path.join(home, "agentflow.db"),
    logsPath: path.join(home, "logs"),
    runsPath: path.join(home, "runs"),
    worktreesPath: path.join(home, "worktrees"),
    backupsPath: path.join(home, "backups"),
    pidPath: path.join(home, "agentflow.pid"),
  };
}

export async function ensureRuntimeLayout(
  environment: AgentFlowEnvironment,
): Promise<void> {
  await Promise.all(
    [
      environment.home,
      environment.logsPath,
      environment.runsPath,
      environment.worktreesPath,
      environment.backupsPath,
    ].map(async (directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
  );
}
