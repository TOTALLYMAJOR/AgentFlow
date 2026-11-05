import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentFlowContext } from "../src/http/context.js";
import { registerErrorHandling } from "../src/http/errors.js";
import { registerRepositoryRoutes } from "../src/http/routes/repositories.js";

const applications = new Set<FastifyInstance>();
const repositoryId = "repo-reviewed-http";
const configurationSha256 = "a".repeat(64);
const backlogSha256 = "b".repeat(64);
const commitSha = "c".repeat(40);

afterEach(async () => {
  await Promise.all([...applications].map(async (app) => {
    applications.delete(app);
    await app.close();
  }));
});

describe("repository review HTTP boundary", () => {
  it.each(["configuration", "backlog"] as const)(
    "delegates GET %s review by repository ID and cannot override its configured path", async (target) => {
      const { app, service, findActive } = fixture();
      const review = target === "configuration" ? service.reviewConfiguration : service.reviewBacklog;

      const response = await app.inject({
        method: "GET",
        url: `/api/repositories/${repositoryId}/${target}/review?path=/unreviewed/override`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(await review.mock.results[0]?.value);
      expect(review).toHaveBeenCalledTimes(1);
      expect(review).toHaveBeenCalledWith(repositoryId);
      expect(findActive).not.toHaveBeenCalled();
      expect(service.commitReviewedConfiguration).not.toHaveBeenCalled();
      expect(service.commitReviewedBacklog).not.toHaveBeenCalled();
      const otherReview = target === "configuration" ? service.reviewBacklog : service.reviewConfiguration;
      expect(otherReview).not.toHaveBeenCalled();
    },
  );

  it("delegates only the required exact-source hash for a configuration commit", async () => {
    const { app, service, findActive } = fixture();
    const expectations = { expectedConfigurationSha256: configurationSha256 };

    const response = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/configuration/commit`,
      payload: expectations,
    });

    expect(response.statusCode).toBe(200);
    expect(service.commitReviewedConfiguration).toHaveBeenCalledTimes(1);
    expect(service.commitReviewedConfiguration).toHaveBeenCalledWith(repositoryId, expectations);
    expect(findActive).toHaveBeenCalledExactlyOnceWith(repositoryId);
    expect(response.json()).toEqual(await service.commitReviewedConfiguration.mock.results[0]?.value);
    expect(service.commitReviewedBacklog).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing", payload: {} },
    { name: "malformed", payload: { expectedConfigurationSha256: "not-a-digest" } },
    { name: "uppercase", payload: { expectedConfigurationSha256: "A".repeat(64) } },
  ])("rejects a $name required configuration hash before build lookup or service mutation", async ({ payload }) => {
    const { app, service, findActive } = fixture();

    const response = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/configuration/commit`,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(findActive).not.toHaveBeenCalled();
    expect(service.commitReviewedConfiguration).not.toHaveBeenCalled();
    expect(service.commitReviewedBacklog).not.toHaveBeenCalled();
  });

  it("rejects an absent configuration commit body instead of silently accepting an unbound review", async () => {
    const { app, service, findActive } = fixture();

    const response = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/configuration/commit`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(findActive).not.toHaveBeenCalled();
    expect(service.commitReviewedConfiguration).not.toHaveBeenCalled();
  });

  it("passes the allowed reviewed backlog path and digest tuple unchanged to its service", async () => {
    const { app, service, findActive } = fixture();
    const expectations = {
      expectedBacklogPath: "plans/REVIEWED.md",
      expectedBacklogSha256: backlogSha256,
      expectedConfigurationSha256: configurationSha256,
    };

    const response = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/backlog/commit`,
      payload: expectations,
    });

    expect(response.statusCode).toBe(200);
    expect(service.commitReviewedBacklog).toHaveBeenCalledExactlyOnceWith(repositoryId, expectations);
    expect(findActive).toHaveBeenCalledExactlyOnceWith(repositoryId);
    expect(response.json()).toEqual(await service.commitReviewedBacklog.mock.results[0]?.value);
    expect(service.commitReviewedConfiguration).not.toHaveBeenCalled();
  });

  it("keeps omitted optional backlog expectations explicit as an empty service argument", async () => {
    const { app, service } = fixture();

    const response = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/backlog/commit`,
    });

    expect(response.statusCode).toBe(200);
    expect(service.commitReviewedBacklog).toHaveBeenCalledExactlyOnceWith(repositoryId, {});
  });

  it.each([
    { expectedBacklogPath: "" },
    { expectedBacklogSha256: "not-a-digest" },
    { expectedConfigurationSha256: "A".repeat(64) },
  ])("rejects invalid optional backlog expectations before delegation (%j)", async (payload) => {
    const { app, service, findActive } = fixture();

    const response = await app.inject({
      method: "POST",
      url: `/api/repositories/${repositoryId}/backlog/commit`,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(findActive).not.toHaveBeenCalled();
    expect(service.commitReviewedBacklog).not.toHaveBeenCalled();
  });

  it.each(["configuration", "backlog"] as const)(
    "rejects unknown path overrides in POST %s commit before any service mutation", async (target) => {
      const { app, service, findActive } = fixture();

      const response = await app.inject({
        method: "POST",
        url: `/api/repositories/${repositoryId}/${target}/commit`,
        payload: {
          expectedConfigurationSha256: configurationSha256,
          path: "/unreviewed/override",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(findActive).not.toHaveBeenCalled();
      expect(service.commitReviewedConfiguration).not.toHaveBeenCalled();
      expect(service.commitReviewedBacklog).not.toHaveBeenCalled();
    },
  );

  it.each(["configuration", "backlog"] as const)(
    "refuses POST %s commit while a build is active before calling either commit service", async (target) => {
      const { app, service, findActive } = fixture();
      findActive.mockReturnValue({ id: "build-active-http", status: "running" });

      const response = await app.inject({
        method: "POST",
        url: `/api/repositories/${repositoryId}/${target}/commit`,
        payload: { expectedConfigurationSha256: configurationSha256 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "REPOSITORY_GIT_BUSY" } });
      expect(findActive).toHaveBeenCalledExactlyOnceWith(repositoryId);
      expect(service.commitReviewedConfiguration).not.toHaveBeenCalled();
      expect(service.commitReviewedBacklog).not.toHaveBeenCalled();
    },
  );
});

function fixture() {
  const app = Fastify({ logger: false });
  applications.add(app);
  const service = {
    reviewConfiguration: vi.fn(async (id: string) => ({
      repositoryId: id,
      configurationPath: ".agentflow.yaml",
      configurationContents: "version: 1\n",
      configurationSha256,
      valid: true,
      nextAction: "Review the configuration before committing it.",
    })),
    reviewBacklog: vi.fn(async (id: string) => ({
      repositoryId: id,
      backlogPath: "plans/REVIEWED.md",
      absoluteBacklogPath: "/fixture/native/plans/REVIEWED.md",
      backlogContents: "# Review-only response fixture\n",
      configurationContents: "version: 1\n",
      backlogSha256,
      configurationSha256,
      valid: false,
      validationErrors: ["No native tasks found in this response fixture."],
      nextAction: "Correct the backlog before committing it.",
    })),
    commitReviewedConfiguration: vi.fn(async (id: string) => ({
      repositoryId: id,
      commitSha,
      committedPaths: [".agentflow.yaml"],
      requiresWorktreeReview: false,
      nextAction: "Continue only from the reviewed configuration.",
    })),
    commitReviewedBacklog: vi.fn(async (id: string) => ({
      repositoryId: id,
      commitSha,
      committedPaths: [".agentflow.yaml", "plans/REVIEWED.md"],
      requiresWorktreeReview: false,
      nextAction: "Review the saved backlog before planning.",
    })),
  };
  const findActive = vi.fn((): { id: string; status: string } | undefined => undefined);
  registerRepositoryRoutes(app, {
    repositoryService: service,
    store: { builds: { findActive } },
  } as unknown as AgentFlowContext);
  registerErrorHandling(app);
  return { app, service, findActive };
}
