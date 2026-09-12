import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { InitiativeDependencyInput, InitiativeMemberInput, InitiativeStatus } from "../domain/multi-repo.js";
import { inImmediateTransaction, systemClock, type Clock } from "./shared.js";

export interface InitiativeEntity {
  id: string; title: string; objective: string; status: InitiativeStatus;
  digest: string | null; approvedAt: string | null; createdAt: string; updatedAt: string;
  members: Array<InitiativeMemberInput & { buildId: string | null }>;
  dependencies: InitiativeDependencyInput[];
  supersedesInitiativeId: string | null;
}
interface InitiativeRow { id: string; title: string; objective: string; status: InitiativeStatus; digest: string | null; approved_at: string | null; created_at: string; updated_at: string; supersedes_initiative_id: string | null }
interface MemberRow { repository_id: string; plan_id: string; base_commit: string; plan_sha256: string; build_id: string | null }
interface DependencyRow { producer_plan_id: string; consumer_plan_id: string; dependency_type: InitiativeDependencyInput["dependencyType"]; artifact_name: string | null; artifact_version: string | null; shared_resource: string | null }

export class InitiativeRepository {
  constructor(private readonly database: Database.Database, private readonly clock: Clock = systemClock) {}

  create(input: { id: string; title: string; objective: string; members: InitiativeMemberInput[]; dependencies?: InitiativeDependencyInput[]; supersedesInitiativeId?: string }): InitiativeEntity {
    return inImmediateTransaction(this.database, () => {
      if (input.members.length < 2) throw new Error("An initiative requires at least two repositories");
      const now = this.clock();
      this.database.prepare(`INSERT INTO initiatives (id,title,objective,status,created_at,updated_at,supersedes_initiative_id) VALUES (?,?,?,'proposed',?,?,?)`).run(input.id, input.title, input.objective, now, now, input.supersedesInitiativeId ?? null);
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

  transition(id: string, status: InitiativeStatus, eventType: string, payload: Record<string, unknown> = {}): InitiativeEntity {
    return inImmediateTransaction(this.database, () => {
      const current = this.get(id);
      const allowed: Record<InitiativeStatus, readonly InitiativeStatus[]> = {
        proposed: ["approved", "cancelled"], approved: ["running", "cancelled"],
        running: ["paused", "partial", "completed", "failed", "cancelled"],
        paused: ["running", "failed", "cancelled"], partial: ["running", "failed", "cancelled"],
        completed: [], failed: [], cancelled: [],
      };
      if (!allowed[current.status].includes(status)) throw new Error(`Initiative ${id} cannot transition from ${current.status} to ${status}`);
      const now = this.clock();
      this.database.prepare(`UPDATE initiatives SET status=?,updated_at=? WHERE id=?`).run(status, now, id);
      this.database.prepare(`INSERT INTO initiative_events (initiative_id,event_type,payload_json,occurred_at) VALUES (?,?,?,?)`).run(id, eventType, JSON.stringify(payload), now);
      return this.get(id);
    });
  }

  attachBuild(initiativeId: string, planId: string, buildId: string): InitiativeEntity {
    return inImmediateTransaction(this.database, () => {
      this.database.prepare(`INSERT INTO initiative_builds (initiative_id,plan_id,build_id,attached_at) VALUES (?,?,?,?)`).run(initiativeId, planId, buildId, this.clock());
      return this.get(initiativeId);
    });
  }

  findIdByBuild(buildId: string): string | undefined {
    return this.database.prepare<[string], { initiative_id: string }>(`SELECT initiative_id FROM initiative_builds WHERE build_id=?`).get(buildId)?.initiative_id;
  }

  listActive(): InitiativeEntity[] {
    return this.database.prepare<[], { id: string }>(`SELECT id FROM initiatives WHERE status IN ('approved','running','paused','partial') ORDER BY created_at,id`).all().map((row) => this.get(row.id));
  }

  list(): InitiativeEntity[] {
    return this.database.prepare<[], { id: string }>(`SELECT id FROM initiatives ORDER BY created_at DESC,id DESC`).all().map((row) => this.get(row.id));
  }

  get(id: string): InitiativeEntity {
    const row = this.database.prepare<[string], InitiativeRow>(`SELECT id,title,objective,status,digest,approved_at,created_at,updated_at,supersedes_initiative_id FROM initiatives WHERE id=?`).get(id);
    if (!row) throw new Error(`Initiative not found: ${id}`);
    const members = this.database.prepare<[string], MemberRow>(`SELECT m.repository_id,m.plan_id,m.base_commit,m.plan_sha256,b.build_id FROM initiative_members m LEFT JOIN initiative_builds b ON b.initiative_id=m.initiative_id AND b.plan_id=m.plan_id WHERE m.initiative_id=? ORDER BY m.position`).all(id);
    const dependencies = this.database.prepare<[string], DependencyRow>(`SELECT producer_plan_id,consumer_plan_id,dependency_type,artifact_name,artifact_version,shared_resource FROM initiative_dependencies WHERE initiative_id=? ORDER BY id`).all(id);
    return { id: row.id, title: row.title, objective: row.objective, status: row.status, digest: row.digest, approvedAt: row.approved_at, createdAt: row.created_at, updatedAt: row.updated_at, supersedesInitiativeId: row.supersedes_initiative_id,
      members: members.map(v => ({ repositoryId: v.repository_id, planId: v.plan_id, baseCommit: v.base_commit, planSha256: v.plan_sha256, buildId: v.build_id })),
      dependencies: dependencies.map(v => ({ producerPlanId: v.producer_plan_id, consumerPlanId: v.consumer_plan_id, dependencyType: v.dependency_type, ...(v.artifact_name ? { artifactName: v.artifact_name } : {}), ...(v.artifact_version ? { artifactVersion: v.artifact_version } : {}), ...(v.shared_resource ? { sharedResource: v.shared_resource } : {}) })) };
  }
}
