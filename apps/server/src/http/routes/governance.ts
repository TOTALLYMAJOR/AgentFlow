import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  REPOSITORY_TEMPLATES,
  repositoryTemplate,
} from "../../governance/templates.js";
import { validateRepositoryAgainstPolicy } from "../../governance/organization-policy.js";
import { replaceRepositoryConfigFile } from "../../repositories/index.js";
import { AgentFlowError } from "../errors.js";
import type { AgentFlowContext } from "../context.js";

const ApplyTemplateBody = z.object({
  repositoryId: z.string().min(1),
  templateId: z.string().min(1),
  confirmOverwrite: z.literal(true),
});

export function registerGovernanceRoutes(
  app: FastifyInstance,
  context: AgentFlowContext,
): void {
  app.get("/api/governance", async () => ({
    policy: context.organizationPolicy,
    policyPath: context.environment.organizationPolicyPath,
    templates: REPOSITORY_TEMPLATES,
  }));

  app.post("/api/governance/templates/apply", async (request) => {
    const input = ApplyTemplateBody.parse(request.body);
    const repository = await context.repositoryService.get(input.repositoryId);
    let template;
    try {
      template = repositoryTemplate(input.templateId);
    } catch {
      throw new AgentFlowError("TEMPLATE_NOT_FOUND", "Repository template was not found", 404);
    }
    const config = {
      ...template.config,
      repository: {
        name: repository.name,
        base_branch: repository.baseBranch,
      },
    };
    const policyErrors = validateRepositoryAgainstPolicy(
      config,
      context.organizationPolicy,
    );
    if (policyErrors.length > 0) {
      throw new AgentFlowError(
        "TEMPLATE_POLICY_VIOLATION",
        "The template does not satisfy organization policy",
        422,
        policyErrors,
      );
    }
    await replaceRepositoryConfigFile(repository.localPath, config);
    return {
      repositoryId: repository.id,
      templateId: template.id,
      configPath: repository.configPath,
      nextAction: "Review and commit .agentflow.yaml before creating a plan.",
    };
  });
}
