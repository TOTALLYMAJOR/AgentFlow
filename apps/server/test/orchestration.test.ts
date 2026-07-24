import { describe, expect, it } from "vitest";
import {
  assertBuildTransition,
  assertTaskTransition,
  canTransitionBuild,
  canTransitionTask,
} from "../src/orchestration/state-machines.js";
import {
  checkChangedFileOwnership,
  ownershipRootsConflict,
} from "../src/orchestration/ownership.js";
import {
  scheduleTasks,
  type SchedulingTask,
} from "../src/orchestration/scheduler.js";

function task(
  id: string,
  overrides: Partial<SchedulingTask> = {},
): SchedulingTask {
  return {
    id,
    state: "ready",
    dependencyIds: [],
    owns: [`src/${id.toLowerCase()}`],
    artifactRequirements: [],
    criticalPath: false,
    readyAgeCycles: 0,
    riskScore: 0,
    approvalOutstanding: false,
    ...overrides,
  };
}

describe("state machines", () => {
  it("accepts legal build transitions and rejects illegal transitions", () => {
    expect(canTransitionBuild("running", "paused")).toBe(true);
    expect(canTransitionBuild("completed", "running")).toBe(false);
    expect(() => assertBuildTransition("completed", "running")).toThrow(
      "cannot transition",
    );
  });

  it("preserves explicit task validation and integration gates", () => {
    expect(canTransitionTask("running", "validating")).toBe(true);
    expect(canTransitionTask("running", "integrated")).toBe(false);
    expect(() => assertTaskTransition("running", "integrated")).toThrow(
      "cannot transition",
    );
  });
});

describe("ownership", () => {
  it("detects equal and ancestor ownership roots", () => {
    expect(ownershipRootsConflict("apps/web", "apps/web")).toBe(true);
    expect(
      ownershipRootsConflict("apps/web", "apps/web/src/features"),
    ).toBe(true);
    expect(ownershipRootsConflict("apps/web", "apps/api")).toBe(false);
  });

  it("reports changed files outside declared ownership", () => {
    expect(
      checkChangedFileOwnership(
        ["apps/web/src/App.tsx", "packages/contracts/schema.json"],
        ["apps/web"],
      ),
    ).toEqual({
      valid: false,
      normalizedChangedFiles: [
        "apps/web/src/App.tsx",
        "packages/contracts/schema.json",
      ],
      violations: ["packages/contracts/schema.json"],
    });
  });
});

describe("scheduler", () => {
  it("selects four independent tasks deterministically", () => {
    const tasks = ["BL-104", "BL-102", "BL-101", "BL-103", "BL-105"].map(
      (id) => task(id),
    );
    expect(scheduleTasks("running", tasks, [], 4).selectedTaskIds).toEqual([
      "BL-101",
      "BL-102",
      "BL-103",
      "BL-104",
    ]);
  });

  it("serializes ownership conflicts within the same batch", () => {
    const tasks = [
      task("BL-100", { owns: ["apps/web"] }),
      task("BL-101", { owns: ["apps/web/src/features"] }),
      task("BL-102", { owns: ["apps/api"] }),
    ];
    expect(scheduleTasks("running", tasks, [], 4).selectedTaskIds).toEqual([
      "BL-100",
      "BL-102",
    ]);
  });

  it("waits for integrated dependencies and artifacts", () => {
    const tasks = [
      task("BL-100", { state: "validated" }),
      task("BL-101", {
        dependencyIds: ["BL-100"],
        artifactRequirements: [
          {
            name: "checkout-api",
            version: "1.0.0",
            status: "validated",
          },
        ],
      }),
    ];
    const decision = scheduleTasks("running", tasks, [], 4);
    expect(decision.selectedTaskIds).toEqual([]);
    expect(decision.deadlock).toContain("waiting for BL-100");
  });

  it("marks dependents of failed tasks as blocked failed", () => {
    const tasks = [
      task("BL-100", { state: "failed" }),
      task("BL-101", { dependencyIds: ["BL-100"], state: "blocked" }),
    ];
    expect(scheduleTasks("running", tasks, [], 4).blockedFailedTaskIds).toEqual([
      "BL-101",
    ]);
  });

  it("dispatches nothing while paused or cancelled", () => {
    expect(scheduleTasks("paused", [task("BL-100")], [], 4).selectedTaskIds).toEqual(
      [],
    );
    expect(
      scheduleTasks("cancelled", [task("BL-100")], [], 4).selectedTaskIds,
    ).toEqual([]);
  });

  it("stores a ranking explanation", () => {
    const tasks = [
      task("BL-100", {
        criticalPath: true,
        readyAgeCycles: 3,
        riskScore: 0.25,
      }),
      task("BL-101", { dependencyIds: ["BL-100"] }),
    ];
    const result = scheduleTasks("running", tasks, [], 1);
    expect(result.rankings[0]?.explanation.summary).toContain("critical 1");
    expect(result.selectedTaskIds).toEqual(["BL-100"]);
  });
});
