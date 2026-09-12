import type Database from "better-sqlite3";
import { systemClock, type Clock } from "./shared.js";

export interface CleanupReceipt { sequence: number; buildId: string; targetType: "worktree" | "branch"; target: string; action: "removed" | "deleted" | "preserved" | "missing"; reason: string; createdAt: string }
interface ReceiptRow { sequence: number; build_id: string; target_type: CleanupReceipt["targetType"]; target: string; action: CleanupReceipt["action"]; reason: string; created_at: string }
export class CleanupReceiptRepository {
  constructor(private readonly database: Database.Database, private readonly clock: Clock = systemClock) {}
  append(input: Omit<CleanupReceipt, "sequence" | "createdAt">): CleanupReceipt {
    const createdAt = this.clock();
    const result = this.database.prepare(`INSERT INTO cleanup_receipts(build_id,target_type,target,action,reason,created_at) VALUES(?,?,?,?,?,?)`).run(input.buildId,input.targetType,input.target,input.action,input.reason,createdAt);
    return { sequence: Number(result.lastInsertRowid), ...input, createdAt };
  }
  list(buildId: string): CleanupReceipt[] {
    return this.database.prepare<[string], ReceiptRow>(`SELECT sequence,build_id,target_type,target,action,reason,created_at FROM cleanup_receipts WHERE build_id=? ORDER BY sequence`).all(buildId).map((row) => ({ sequence: row.sequence, buildId: row.build_id, targetType: row.target_type, target: row.target, action: row.action, reason: row.reason, createdAt: row.created_at }));
  }
}
