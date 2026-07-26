import type Database from "better-sqlite3";
import { systemClock, type Clock } from "./shared.js";
import type { VisualComparisonEntity } from "./types.js";

interface VisualComparisonRow {
  id: string;
  repository_id: string;
  build_id: string | null;
  task_id: string | null;
  route_url: string;
  baseline_path: string;
  actual_path: string;
  diff_path: string | null;
  width: number;
  height: number;
  different_pixels: number;
  difference_ratio: number;
  maximum_difference_ratio: number;
  status: VisualComparisonEntity["status"];
  created_at: string;
}

function mapComparison(row: VisualComparisonRow): VisualComparisonEntity {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    buildId: row.build_id,
    taskId: row.task_id,
    routeUrl: row.route_url,
    baselinePath: row.baseline_path,
    actualPath: row.actual_path,
    diffPath: row.diff_path,
    width: row.width,
    height: row.height,
    differentPixels: row.different_pixels,
    differenceRatio: row.difference_ratio,
    maximumDifferenceRatio: row.maximum_difference_ratio,
    status: row.status,
    createdAt: row.created_at,
  };
}

const SELECT = `SELECT id, repository_id, build_id, task_id, route_url,
  baseline_path, actual_path, diff_path, width, height, different_pixels,
  difference_ratio, maximum_difference_ratio, status, created_at
  FROM visual_comparisons`;

export class VisualComparisonRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  create(
    input: Omit<VisualComparisonEntity, "createdAt"> & {
      createdAt?: string;
    },
  ): VisualComparisonEntity {
    const createdAt = input.createdAt ?? this.clock();
    this.database.prepare(
      `INSERT INTO visual_comparisons (
        id, repository_id, build_id, task_id, route_url, baseline_path,
        actual_path, diff_path, width, height, different_pixels,
        difference_ratio, maximum_difference_ratio, status, created_at
      ) VALUES (
        @id, @repositoryId, @buildId, @taskId, @routeUrl, @baselinePath,
        @actualPath, @diffPath, @width, @height, @differentPixels,
        @differenceRatio, @maximumDifferenceRatio, @status, @createdAt
      )`,
    ).run({ ...input, createdAt });
    return this.getById(input.id);
  }

  getById(id: string): VisualComparisonEntity {
    const row = this.database
      .prepare<[string], VisualComparisonRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    if (row === undefined) {
      throw new Error(`Visual comparison not found: ${id}`);
    }
    return mapComparison(row);
  }

  listForRepository(repositoryId: string): VisualComparisonEntity[] {
    return this.database
      .prepare<[string], VisualComparisonRow>(
        `${SELECT} WHERE repository_id = ? ORDER BY created_at DESC, id DESC`,
      )
      .all(repositoryId)
      .map(mapComparison);
  }
}
