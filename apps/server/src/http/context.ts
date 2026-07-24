import type { AgentFlowEnvironment } from "../config/environment.js";
import type { AgentFlowDatabase, DatabaseRepositories } from "../db/index.js";
import type { RepositoryService } from "../repositories/index.js";

export interface AgentFlowContext {
  environment: AgentFlowEnvironment;
  database: AgentFlowDatabase;
  store: DatabaseRepositories;
  repositoryService: RepositoryService;
}
