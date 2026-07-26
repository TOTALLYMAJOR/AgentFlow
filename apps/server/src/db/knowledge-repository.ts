import type Database from "better-sqlite3";
import { inImmediateTransaction, systemClock, type Clock } from "./shared.js";
import type {
  KnowledgeEdgeEntity,
  KnowledgeNodeEntity,
  KnowledgeSnapshotEntity,
} from "./types.js";

interface SnapshotRow {
  id: string;
  repository_id: string;
  base_commit: string;
  node_count: number;
  edge_count: number;
  created_at: string;
}

function mapSnapshot(row: SnapshotRow): KnowledgeSnapshotEntity {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    baseCommit: row.base_commit,
    nodeCount: row.node_count,
    edgeCount: row.edge_count,
    createdAt: row.created_at,
  };
}

export class KnowledgeRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  createSnapshot(input: {
    id: string;
    repositoryId: string;
    baseCommit: string;
    nodes: readonly KnowledgeNodeEntity[];
    edges: readonly KnowledgeEdgeEntity[];
  }): KnowledgeSnapshotEntity {
    return inImmediateTransaction(this.database, () => {
      const createdAt = this.clock();
      this.database.prepare(
        `INSERT INTO knowledge_snapshots (
          id, repository_id, base_commit, node_count, edge_count, created_at
        ) VALUES (
          @id, @repositoryId, @baseCommit, @nodeCount, @edgeCount, @createdAt
        )`,
      ).run({
        id: input.id,
        repositoryId: input.repositoryId,
        baseCommit: input.baseCommit,
        nodeCount: input.nodes.length,
        edgeCount: input.edges.length,
        createdAt,
      });
      const insertNode = this.database.prepare(
        `INSERT INTO knowledge_nodes (snapshot_id, path, kind, sha256)
         VALUES (@snapshotId, @path, @kind, @sha256)`,
      );
      for (const node of input.nodes) {
        insertNode.run({ snapshotId: input.id, ...node });
      }
      const insertEdge = this.database.prepare(
        `INSERT INTO knowledge_edges (
          snapshot_id, source_path, target_path, edge_type
        ) VALUES (
          @snapshotId, @sourcePath, @targetPath, @edgeType
        )`,
      );
      for (const edge of input.edges) {
        insertEdge.run({ snapshotId: input.id, ...edge });
      }
      return this.getSnapshot(input.id);
    });
  }

  getSnapshot(id: string): KnowledgeSnapshotEntity {
    const row = this.database
      .prepare<[string], SnapshotRow>(
        `SELECT id, repository_id, base_commit, node_count, edge_count,
          created_at FROM knowledge_snapshots WHERE id = ?`,
      )
      .get(id);
    if (row === undefined) {
      throw new Error(`Knowledge snapshot not found: ${id}`);
    }
    return mapSnapshot(row);
  }

  latest(repositoryId: string): KnowledgeSnapshotEntity | undefined {
    const row = this.database
      .prepare<[string], SnapshotRow>(
        `SELECT id, repository_id, base_commit, node_count, edge_count,
          created_at FROM knowledge_snapshots
         WHERE repository_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(repositoryId);
    return row === undefined ? undefined : mapSnapshot(row);
  }

  nodes(snapshotId: string): KnowledgeNodeEntity[] {
    return this.database
      .prepare<
        [string],
        { path: string; kind: KnowledgeNodeEntity["kind"]; sha256: string }
      >(
        `SELECT path, kind, sha256 FROM knowledge_nodes
         WHERE snapshot_id = ? ORDER BY path`,
      )
      .all(snapshotId);
  }

  edges(snapshotId: string): KnowledgeEdgeEntity[] {
    return this.database
      .prepare<
        [string],
        {
          source_path: string;
          target_path: string;
          edge_type: "imports";
        }
      >(
        `SELECT source_path, target_path, edge_type FROM knowledge_edges
         WHERE snapshot_id = ? ORDER BY source_path, target_path`,
      )
      .all(snapshotId)
      .map((row) => ({
        sourcePath: row.source_path,
        targetPath: row.target_path,
        edgeType: row.edge_type,
      }));
  }
}
