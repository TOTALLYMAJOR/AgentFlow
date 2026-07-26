import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseRepositories } from "../src/db/index.js";
import {
  applyEstimateCalibration,
  calculateEstimateCalibration,
} from "../src/planning/calibration.js";
import {
  createDatabaseFixture,
  type DatabaseFixture,
} from "./helpers/database-fixture.js";

describe("historical estimate calibration", () => {
  let fixture: DatabaseFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("uses repository-local median evidence after a minimum sample", () => {
    fixture = createDatabaseFixture();
    const store = createDatabaseRepositories(fixture.database);
    store.repositories.create({
      id: "repository_1",
      name: "Repository",
      localPath: "/tmp/calibration-repository",
      configPath: "/tmp/calibration-repository/.agentflow.yaml",
      baseBranch: "main",
    });
    store.createBuild({
      id: "build_1",
      repositoryId: "repository_1",
      backlogPath: "BACKLOG.md",
      baseCommit: "abc123",
      integrationBranch: "agentflow/build-1",
      status: "running",
      expectedElapsedHours: 4,
      tasks: [1, 2, 3, 4].map((number) => ({
        id: `task_${number}`,
        title: `Task ${number}`,
        description: "Calibration sample.",
        acceptanceCriteria: ["Completed."],
        estimateHours: 2,
        state: "ready" as const,
      })),
    });
    for (const number of [1, 2, 3, 4]) {
      fixture.database.prepare(
        `UPDATE tasks SET
          state = 'integrated',
          started_at = '2026-07-26T10:00:00.000Z',
          completed_at = '2026-07-26T11:00:00.000Z'
         WHERE id = ?`,
      ).run(`task_${number}`);
    }
    fixture.database.prepare(
      `UPDATE builds SET status = 'completed', actual_elapsed_seconds = 7200
       WHERE id = 'build_1'`,
    ).run();

    const calibration = calculateEstimateCalibration(
      fixture.database,
      "repository_1",
    );
    expect(calibration).toMatchObject({
      taskSampleCount: 4,
      buildSampleCount: 1,
      taskMedianActualToEstimateRatio: 0.5,
      buildMedianActualToEstimateRatio: 0.5,
      appliedMultiplier: 0.5,
      confidence: "low",
    });
    expect(
      applyEstimateCalibration(
        {
          sequentialHours: 8,
          criticalPathHours: 4,
          expectedElapsedHours: 5,
          expectedSavingsPercent: 37.5,
          maximumTheoreticalConcurrency: 2,
          criticalPathTaskIds: ["task_1"],
          workerEfficiency: 0.85,
          overheadPercent: 10,
        },
        calibration,
      ),
    ).toMatchObject({
      sequentialHours: 4,
      criticalPathHours: 2,
      expectedElapsedHours: 2.5,
      expectedSavingsPercent: 37.5,
    });
  });

  it("does not adjust estimates from fewer than three tasks", () => {
    fixture = createDatabaseFixture();
    const calibration = calculateEstimateCalibration(
      fixture.database,
      "repository_without_history",
    );
    expect(calibration).toMatchObject({
      taskSampleCount: 0,
      appliedMultiplier: 1,
      confidence: "insufficient",
    });
  });
});
