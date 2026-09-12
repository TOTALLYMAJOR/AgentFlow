import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { InitiativeDependencyInput, InitiativeMemberInput, InitiativeStatus } from "../domain/multi-repo.js";
import { inImmediateTransaction, systemClock, type Clock } from "./shared.js";

export interface InitiativeEntity {
  id: string; title: string; objective: string; status: InitiativeStatus;
  digest: string | null; approvedAt: string | null; createdAt: string; updatedAt: string;
  members: InitiativeMemberInput[]; dependencies: InitiativeDependencyInput[];
}
interface InitiativeRow { id: string; title: string; objective: string; status: InitiativeStatus; digest: string | null; approved_at: string | null; created_at: string; updated_at: string }
interface MemberRow { repository_id: string; plan_id: string; base_commit: string; plan_sha256: string }
interface DependencyRow { producer_plan_id: string; consumer_plan_id: string; dependency_type: InitiativeDependencyInput["dependencyType"]; artifact_name: string | null; artifact_version: string | null; shared_resource: string | null }

export class InitiativeRepository {
  constructor(private readonly database: Database.Database, private readonly clock: Clock = systemClock) {}

  create(input: { id: string; title: string; objective: string; members: InitiativeMemberInput[]; dependencies?: InitiativeDependencyInput[] }): InitiativeEntity {
    return inImmediateTransaction(this.database, () => {
      if (input.members.length < 2) throw new Error("An initiative requires at least two repositories");
      const now = this.clock();
      this.database.prepare(`INSERT INTO initiatives (id,title,objective,status,created_at,updated_at) VALUES (?,?,?,'proposed',?,?)`).run(input.id, input.title, input.objective, now, now);
      const member = this.database.prepare(`INSERT INTO initiative_members (initiative_id,repository_id,plan_id,position,base_commit,plan_sha256) VALUES (?,?,?,?,?,?)`);
      input.members.forEach((value, position) => member.run(input.id, value.repositoryId, value.planId, position, value.baseCommit, value.planSha256));
      const dependency = this.database.prepare(`INSERT INTO initiative_dependencies (initiative_id,producer_plan_id,consumer_plan_id,dependency_type,artifact_name,artifact_version,shared_resource) VALUES (?,?,?,?,?,?,?)`);
      for (const value of input.dependencies ?? []) dependency.run(input.id, value.producerPlanId, value.consumerPlanId, value.dependencyType, value.artifactName ?? null, value.artifactVersion ?? null, value.sharedResource ?? null);
      return this.get(input.id);
    });
  }

  approve(id: string): InitiativeEntity {
    return inImmediateTransaction(this.database, () => {
      const current = this.get(id);
      if (current.status !== "proposed") return current;
      const digest = createHash("sha256").update(JSON.stringify({ objective: current.objective, members: current.members, dependencies: current.dependencies })).digest("hex");
      const now = this.clock();
      this.database.prepare(`UPDATE initiatives SET status='approved', digest=?, approved_at=?, updated_at=? WHERE id=? AND status='proposed'`).run(digest, now, now, id);
      return this.get(id);
    });
  }

  get(id: string): InitiativeEntity {
    const row = this.database.prepare<[string], InitiativeRow>(`SELECT id,title,objective,status,digest,approved_at,created_at,updated_at FROM initiatives WHERE id=?`).get(id);
    if (!row) throw new Error(`Initiative not found: ${id}`);
    const members = this.database.prepare<[string], MemberRow>(`SELECT repository_id,plan_id,base_commit,plan_sha256 FROM initiative_members WHERE initiative_id=? ORDER BY position`).all(id);
    const dependencies = this.database.prepare<[string], DependencyRow>(`SELECT producer_plan_id,consumer_plan_id,dependency_type,artifact_name,artifact_version,shared_resource FROM initiative_dependencies WHERE initiative_id=? ORDER BY id`).all(id);
    return { id: row.id, title: row.title, objective: row.objective, status: row.status, digest: row.digest, approvedAt: row.approved_at, createdAt: row.created_at, updatedAt: row.updated_at,
      members: members.map(v => ({ repositoryId: v.repository_id, planId: v.plan_id, baseCommit: v.base_commit, planSha256: v.plan_sha256 })),
      dependencies: dependencies.map(v => ({ producerPlanId: v.producer_plan_id, consumerPlanId: v.consumer_plan_id, dependencyType: v.dependency_type, ...(v.artifact_name ? { artifactName: v.artifact_name } : {}), ...(v.artifact_version ? { artifactVersion: v.artifact_version } : {}), ...(v.shared_resource ? { sharedResource: v.shared_resource } : {}) })) };
  }
}
