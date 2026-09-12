import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseRepositories } from "../src/db/index.js";
import { createDatabaseFixture, type DatabaseFixture } from "./helpers/database-fixture.js";

describe("multi-repository initiative persistence", () => {
  let fixture: DatabaseFixture | undefined;
  afterEach(() => { fixture?.cleanup(); fixture = undefined; });

  it("binds exact repository plans and makes membership immutable after approval", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database, () => "2026-09-12T18:00:00.000Z");
    for (const suffix of ["a", "b"]) {
      store.repositories.create({ id: `repo_${suffix}`, name: suffix.toUpperCase(), localPath: `/tmp/repo-${suffix}`, configPath: `/tmp/repo-${suffix}/.agentflow.yaml`, baseBranch: "main" });
      fixture.database.prepare(`INSERT INTO plans (id,repository_id,backlog_path,backlog_sha256,backlog_contents,normalized_plan_json,created_at) VALUES (?,?,?,?,?,'{}',?)`).run(`plan_${suffix}`, `repo_${suffix}`, "BACKLOG.md", `sha-${suffix}`, "# backlog", "2026-09-12T18:00:00.000Z");
    }
    const initiative = store.initiatives.create({
      id: "initiative_1", title: "Coordinated release", objective: "Ship provider and consumer together",
      members: [
        { repositoryId: "repo_a", planId: "plan_a", baseCommit: "aaa", planSha256: "sha-a" },
        { repositoryId: "repo_b", planId: "plan_b", baseCommit: "bbb", planSha256: "sha-b" },
      ],
      dependencies: [{ producerPlanId: "plan_a", consumerPlanId: "plan_b", dependencyType: "artifact", artifactName: "api", artifactVersion: "1.0.0" }],
    });
    expect(initiative.members).toHaveLength(2);
    const approved = store.initiatives.approve(initiative.id);
    expect(approved.status).toBe("approved");
    expect(approved.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => fixture?.database.prepare(`DELETE FROM initiative_members WHERE initiative_id=? AND plan_id=?`).run(initiative.id, "plan_a")).toThrow(/immutable/i);
    expect(store.initiatives.approve(initiative.id).digest).toBe(approved.digest);
    const running = store.initiatives.transition(initiative.id, "running", "initiative.started");
    expect(running.status).toBe("running");
  });

  it("rejects duplicate repository membership without partial writes", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    store.repositories.create({ id: "repo_a", name: "A", localPath: "/tmp/repo-a", configPath: "/tmp/repo-a/.agentflow.yaml", baseBranch: "main" });
    for (const plan of ["plan_a", "plan_b"]) fixture.database.prepare(`INSERT INTO plans (id,repository_id,backlog_path,backlog_sha256,backlog_contents,normalized_plan_json,created_at) VALUES (?,?,?,'sha','# backlog','{}','now')`).run(plan, "repo_a", "BACKLOG.md");
    expect(() => store.initiatives.create({ id: "initiative_bad", title: "Bad", objective: "Duplicate", members: [
      { repositoryId: "repo_a", planId: "plan_a", baseCommit: "a", planSha256: "sha" },
      { repositoryId: "repo_a", planId: "plan_b", baseCommit: "b", planSha256: "sha" },
    ] })).toThrow(/UNIQUE/i);
    expect(fixture.database.prepare(`SELECT count(*) AS count FROM initiatives`).get()).toEqual({ count: 0 });
  });

  it("replans by superseding rather than mutating approved initiative authority", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database, () => "2026-09-12T18:00:00.000Z");
    for (const suffix of ["a", "b"]) {
      store.repositories.create({ id: `repo_${suffix}`, name: suffix.toUpperCase(), localPath: `/tmp/repo-${suffix}`, configPath: `/tmp/repo-${suffix}/.agentflow.yaml`, baseBranch: "main" });
      fixture.database.prepare(`INSERT INTO plans (id,repository_id,backlog_path,backlog_sha256,backlog_contents,normalized_plan_json,created_at) VALUES (?,?,?,?,?,'{}',?)`).run(`plan_${suffix}`, `repo_${suffix}`, "BACKLOG.md", `sha-${suffix}`, "# backlog", "2026-09-12T18:00:00.000Z");
    }
    const members = [
      { repositoryId: "repo_a", planId: "plan_a", baseCommit: "aaa", planSha256: "sha-a" },
      { repositoryId: "repo_b", planId: "plan_b", baseCommit: "bbb", planSha256: "sha-b" },
    ];
    const approved = store.initiatives.approve(store.initiatives.create({ id: "initiative_original", title: "Original", objective: "Original authority", members }).id);
    const replacement = store.initiatives.create({ id: "initiative_replanned", title: "Replacement", objective: "Revised authority", members, supersedesInitiativeId: approved.id });

    expect(replacement).toMatchObject({ status: "proposed", supersedesInitiativeId: approved.id, digest: null });
    expect(store.initiatives.get(approved.id)).toMatchObject({ status: "approved", digest: approved.digest, objective: "Original authority", supersedesInitiativeId: null });
  });
});
