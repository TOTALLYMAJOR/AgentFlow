import type { AgentFlowRepositoryConfig } from "../repositories/config.js";

export interface RepositoryTemplate {
  id: string;
  name: string;
  description: string;
  config: Omit<AgentFlowRepositoryConfig, "repository">;
}

const nodeValidation = {
  task_default: ["npm run lint", "npm run typecheck"],
  integration: ["npm run lint", "npm run typecheck", "npm test", "npm run build"],
};
const safeGit = {
  remote: "origin",
  push_task_branches: false,
  push_integration_branch: false,
  open_integration_pull_request: false,
};

export const REPOSITORY_TEMPLATES: RepositoryTemplate[] = [
  {
    id: "safe-generic",
    name: "Safe generic",
    description: "Conservative defaults for an unfamiliar Git repository.",
    config: {
      version: 1,
      backlog: { path: "BACKLOG.md" },
      workers: { maximum: 2 },
      contracts: { roots: ["contracts/"] },
      validation: {
        task_default: ["git diff --check"],
        integration: ["git diff --check"],
      },
      docker: { enabled: false, compose_file: "compose.yaml" },
      git: safeGit,
    },
  },
  {
    id: "node-service",
    name: "Node service",
    description: "Lint, typecheck, test, and build gates for a Node service.",
    config: {
      version: 1,
      backlog: { path: "BACKLOG.md" },
      workers: { maximum: 4 },
      contracts: { roots: ["contracts/", "src/contracts/"] },
      validation: nodeValidation,
      docker: { enabled: false, compose_file: "compose.yaml" },
      git: safeGit,
    },
  },
  {
    id: "node-monorepo",
    name: "Node monorepo",
    description: "Workspace defaults with shared contract ownership.",
    config: {
      version: 1,
      backlog: { path: "BACKLOG.md" },
      workers: { maximum: 4 },
      contracts: { roots: ["contracts/", "packages/contracts/"] },
      validation: nodeValidation,
      docker: { enabled: false, compose_file: "compose.yaml" },
      git: safeGit,
    },
  },
];

export function repositoryTemplate(templateId: string): RepositoryTemplate {
  const template = REPOSITORY_TEMPLATES.find(({ id }) => id === templateId);
  if (template === undefined) throw new Error(`Unknown repository template ${templateId}`);
  return template;
}
