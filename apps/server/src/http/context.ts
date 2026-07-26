import type { AgentFlowEnvironment } from "../config/environment.js";
import type { HandoffManifestService } from "../artifacts/index.js";
import type { AgentFlowDatabase, DatabaseRepositories } from "../db/index.js";
import type { RecoveryService } from "../recovery/index.js";
import type { RepositoryService } from "../repositories/index.js";
import type { BuildCoordinator } from "../orchestration/coordinator.js";
import type { CodingAgentProviderRegistry } from "../workers/index.js";
import type { OrganizationPolicy } from "../governance/organization-policy.js";

export interface AgentFlowContext {
  environment: AgentFlowEnvironment;
  database: AgentFlowDatabase;
  store: DatabaseRepositories;
  repositoryService: RepositoryService;
  handoffService: HandoffManifestService;
  recoveryService: RecoveryService;
  coordinator: BuildCoordinator;
  agentProviders: CodingAgentProviderRegistry;
  organizationPolicy: OrganizationPolicy;
}
