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
  AGENTFLOW_DEFAULT_AGENT_PROVIDER: z
    .string()
    .trim()
    .min(1)
    .default("codex"),
  AGENTFLOW_WORKER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(1_800_000),
  AGENTFLOW_MAX_CONCURRENT_WORKERS: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(4),
  AGENTFLOW_RETRY_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3),
  AGENTFLOW_RETRY_BASE_DELAY_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(3_600_000)
    .default(5_000),
  AGENTFLOW_RETRY_MAX_DELAY_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(86_400_000)
    .default(300_000),
}).refine(
  (environment) =>
    environment.AGENTFLOW_RETRY_MAX_DELAY_MS >=
    environment.AGENTFLOW_RETRY_BASE_DELAY_MS,
  {
    path: ["AGENTFLOW_RETRY_MAX_DELAY_MS"],
    message: "must be greater than or equal to the retry base delay",
  },
);

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
  defaultAgentProvider: string;
  workerTimeoutMs: number;
  maxConcurrentWorkers: number;
  retryMaximumAttempts: number;
  retryBaseDelayMs: number;
  retryMaximumDelayMs: number;
  databasePath: string;
  logsPath: string;
  runsPath: string;
  artifactsPath: string;
  worktreesPath: string;
  backupsPath: string;
  governancePath: string;
  organizationPolicyPath: string;
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
    defaultAgentProvider: parsed.AGENTFLOW_DEFAULT_AGENT_PROVIDER,
    workerTimeoutMs: parsed.AGENTFLOW_WORKER_TIMEOUT_MS,
    maxConcurrentWorkers: parsed.AGENTFLOW_MAX_CONCURRENT_WORKERS,
    retryMaximumAttempts: parsed.AGENTFLOW_RETRY_MAX_ATTEMPTS,
    retryBaseDelayMs: parsed.AGENTFLOW_RETRY_BASE_DELAY_MS,
    retryMaximumDelayMs: parsed.AGENTFLOW_RETRY_MAX_DELAY_MS,
    databasePath: path.join(home, "agentflow.db"),
    logsPath: path.join(home, "logs"),
    runsPath: path.join(home, "runs"),
    artifactsPath: path.join(home, "artifacts"),
    worktreesPath: path.join(home, "worktrees"),
    backupsPath: path.join(home, "backups"),
    governancePath: path.join(home, "governance"),
    organizationPolicyPath: path.join(home, "governance", "organization-policy.yaml"),
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
      environment.artifactsPath,
      environment.worktreesPath,
      environment.backupsPath,
      environment.governancePath,
    ].map(async (directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
  );
}
