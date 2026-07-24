import { describe, expect, it } from "vitest";

import {
  BacklogPlanningError,
  normalizeOwnershipPath,
  ownershipPathsConflict,
  parseBacklogMarkdown,
  planBacklogMarkdown,
  planBacklogOrThrow,
} from "../src/planning/index.js";

const acceptance = (text: string): string => `
### Acceptance Criteria

- ${text}
`;

describe("Markdown backlog planning", () => {
  it("parses, normalizes, validates, and plans a valid artifact graph", () => {
    const markdown = `
# Checkout backlog

## BL-100 — Define checkout contract

\`\`\`yaml
estimate_hours: 4
depends_on: []
owns:
  - ./contracts/checkout/
validate:
  - npm run contracts
produces:
  - name: checkout-api
    type: openapi
    version: 1.0.0
    path: contracts/checkout/openapi.yaml
\`\`\`

Define the canonical checkout API.
${acceptance("The OpenAPI contract contains success and failure examples.")}

## BL-101 — Implement checkout backend

\`\`\`yaml
estimate_hours: 6
depends_on:
  - BL-100
owns:
  - apps/api/src/checkout/
consumes:
  - task: BL-100
    artifact: checkout-api
    version: 1.0.0
produces:
  - name: checkout-provider
    type: service
    version: 1.0.0
\`\`\`

Implement the provider.
${acceptance("The service passes the contract examples.")}

## BL-102 — Implement checkout frontend

\`\`\`yaml
estimate_hours: 5
depends_on:
  - BL-100
owns:
  - apps\\web\\src\\checkout
consumes:
  - task: BL-100
    artifact: checkout-api
    version: 1.0.0
produces:
  - name: checkout-consumer
    type: frontend
    version: 1.0.0
\`\`\`

Implement loading and outcome states.
${acceptance("Keyboard navigation works in every state.")}

## BL-103 — Verify interoperability

\`\`\`yaml
estimate_hours: 2
depends_on:
  - BL-101
  - BL-102
owns:
  - tests/integration/checkout/
consumes:
  - task: BL-101
    artifact: checkout-provider
    version: 1.0.0
  - task: BL-102
    artifact: checkout-consumer
    version: 1.0.0
\`\`\`

Exercise the frontend and backend together.
${acceptance("The browser flow completes against the real service.")}
`;

    const result = planBacklogMarkdown(markdown, {
      defaultValidation: ["npm run lint", "npm run typecheck"],
      workerMaximum: 2,
      workerEfficiency: 1,
      overheadPercent: 0,
    });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.plan).toBeDefined();
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks[0]).toMatchObject({
      id: "BL-100",
      title: "Define checkout contract",
      description: "Define the canonical checkout API.",
      acceptanceCriteria: [
        "The OpenAPI contract contains success and failure examples.",
      ],
      owns: ["contracts/checkout"],
      validate: ["npm run contracts"],
    });
    expect(result.tasks[1]?.validate).toEqual([
      "npm run lint",
      "npm run typecheck",
    ]);
    expect(result.tasks[2]?.owns).toEqual(["apps/web/src/checkout"]);
    expect(result.plan?.waves).toEqual([
      ["BL-100"],
      ["BL-101", "BL-102"],
      ["BL-103"],
    ]);
    expect(result.plan?.estimates).toEqual({
      sequentialHours: 17,
      criticalPathHours: 12,
      expectedElapsedHours: 12,
      expectedSavingsPercent: 29.41,
      maximumTheoreticalConcurrency: 2,
      criticalPathTaskIds: ["BL-100", "BL-101", "BL-103"],
      workerEfficiency: 1,
      overheadPercent: 0,
    });
  });

  it("returns all graph errors instead of throwing on the first defect", () => {
    const task = (
      id: string,
      dependencies: readonly string[],
      title = "Task",
    ): string => `
## ${id} — ${title}

\`\`\`yaml
estimate_hours: 1
depends_on:
${dependencies.map((dependency) => `  - ${dependency}`).join("\n")}
owns:
  - src/${id}/
\`\`\`

Implement ${id}.
${acceptance(`${id} is complete.`)}
`;
    const markdown = [
      task("BL-1", ["BL-2"]),
      task("BL-2", ["BL-1", "BL-404"]),
      task("BL-1", [], "Duplicate"),
      task("BL-3", ["BL-3"]),
    ].join("\n");

    const result = planBacklogMarkdown(markdown, {
      defaultValidation: ["npm test"],
    });
    const codes = result.errors.map((error) => error.code);

    expect(result.valid).toBe(false);
    expect(result.plan).toBeUndefined();
    expect(codes).toContain("DUPLICATE_TASK_ID");
    expect(codes).toContain("MISSING_DEPENDENCY");
    expect(codes).toContain("SELF_DEPENDENCY");
    expect(codes).toContain("DEPENDENCY_CYCLE");
    expect(result.errors.find((error) => error.code === "DEPENDENCY_CYCLE"))
      .toMatchObject({
        cycle: ["BL-1", "BL-2", "BL-1"],
      });
  });

  it("rejects incomplete metadata and unsafe ownership paths together", () => {
    const markdown = `
## BL-1 — Absolute

\`\`\`yaml
estimate_hours: 0
owns:
  - /etc/passwd
validate: []
\`\`\`

No acceptance subsection.

## BL-2 — Traversal

\`\`\`yaml
estimate_hours: one
owns:
  - src/../secrets
\`\`\`
${acceptance("Traversal is rejected.")}

## BL-3 — Git state

\`\`\`yaml
estimate_hours: 1
owns:
  - .git/hooks/
\`\`\`
${acceptance("Git state remains protected.")}

## BL-4 — Runtime state

\`\`\`yaml
estimate_hours: 1
owns:
  - .agentflow/runs/
\`\`\`
${acceptance("Runtime state remains protected.")}

## BL-5 — Empty ownership

\`\`\`yaml
estimate_hours: 1
owns: []
\`\`\`
${acceptance("At least one path is owned.")}
`;

    const result = planBacklogMarkdown(markdown);
    const codes = result.errors.map((error) => error.code);

    expect(result.valid).toBe(false);
    expect(codes).toContain("MISSING_ACCEPTANCE_CRITERIA");
    expect(codes).toContain("INVALID_ESTIMATE");
    expect(codes).toContain("EMPTY_OWNERSHIP");
    expect(codes).toContain("INVALID_OWNERSHIP_PATH");
    expect(codes).toContain("FORBIDDEN_OWNERSHIP_PATH");
    expect(codes).toContain("MISSING_VALIDATION");
    expect(result.errors).toHaveLength(13);
  });

  it("reports invalid YAML and missing metadata while retaining other tasks", () => {
    const markdown = `
## BL-1 — Broken YAML

\`\`\`yaml
estimate_hours: [
\`\`\`
${acceptance("The defect is reported.")}

## BL-2 — Missing metadata

This task has no metadata block.
${acceptance("The defect is reported too.")}
`;

    const parsed = parseBacklogMarkdown(markdown);

    expect(parsed.tasks.map((task) => task.id)).toEqual(["BL-1", "BL-2"]);
    expect(parsed.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["INVALID_YAML", "MISSING_YAML_METADATA"]),
    );
  });

  it("validates artifact producer dependencies, exact versions, and duplicate outputs", () => {
    const markdown = `
## BL-1 — Producer

\`\`\`yaml
estimate_hours: 2
owns: [contracts/api]
validate: [npm test]
produces:
  - name: checkout-api
    type: openapi
    version: 1.0.0
  - name: checkout-api
    type: openapi
    version: 1.0.0
\`\`\`
${acceptance("The producer publishes a contract.")}

## BL-2 — Range consumer

\`\`\`yaml
estimate_hours: 1
depends_on: [BL-1]
owns: [apps/range]
validate: [npm test]
consumes:
  - task: BL-1
    artifact: checkout-api
    version: ^1.0.0
\`\`\`
${acceptance("Version ranges are rejected.")}

## BL-3 — Undeclared dependency

\`\`\`yaml
estimate_hours: 1
owns: [apps/undeclared]
validate: [npm test]
consumes:
  - task: BL-1
    artifact: checkout-api
    version: 1.0.0
\`\`\`
${acceptance("The producer must be a direct dependency.")}

## BL-4 — Missing artifact

\`\`\`yaml
estimate_hours: 1
depends_on: [BL-1]
owns: [apps/missing]
validate: [npm test]
consumes:
  - task: BL-1
    artifact: absent-api
    version: 1.0.0
\`\`\`
${acceptance("The named artifact must exist.")}

## BL-5 — Wrong version

\`\`\`yaml
estimate_hours: 1
depends_on: [BL-1]
owns: [apps/version]
validate: [npm test]
consumes:
  - task: BL-1
    artifact: checkout-api
    version: 2.0.0
\`\`\`
${acceptance("The exact produced version must match.")}

## BL-6 — Missing producer

\`\`\`yaml
estimate_hours: 1
owns: [apps/producer]
validate: [npm test]
consumes:
  - task: BL-404
    artifact: checkout-api
    version: 1.0.0
\`\`\`
${acceptance("The producer task must exist.")}

## BL-7 — Duplicate producer

\`\`\`yaml
estimate_hours: 1
owns: [contracts/other]
validate: [npm test]
produces:
  - name: checkout-api
    type: openapi
    version: 1.0.0
\`\`\`
${acceptance("Artifact coordinates are globally unique.")}
`;

    const result = planBacklogMarkdown(markdown);
    const codes = result.errors.map((error) => error.code);

    expect(result.valid).toBe(false);
    expect(codes).toContain("DUPLICATE_PRODUCED_ARTIFACT");
    expect(codes).toContain("ARTIFACT_VERSION_NOT_EXACT");
    expect(codes).toContain("ARTIFACT_PRODUCER_NOT_DEPENDENCY");
    expect(codes).toContain("ARTIFACT_NOT_PRODUCED");
    expect(codes).toContain("ARTIFACT_VERSION_MISMATCH");
    expect(codes).toContain("ARTIFACT_PRODUCER_MISSING");
  });

  it("reports ownership conflicts with the concrete overlapping roots", () => {
    const makeTask = (id: string, ownedPath: string): string => `
## ${id} — Ownership
\`\`\`yaml
estimate_hours: 1
owns: [${ownedPath}]
validate: [npm test]
\`\`\`
${acceptance(`${id} stays within ownership.`)}
`;
    const result = planBacklogMarkdown(
      [
        makeTask("BL-1", "apps/web"),
        makeTask("BL-2", "apps/web/src/checkout"),
        makeTask("BL-3", "apps/api"),
      ].join("\n"),
      { workerEfficiency: 1, overheadPercent: 0 },
    );

    expect(result.valid).toBe(true);
    expect(result.plan?.ownershipConflicts).toEqual([
      {
        firstTaskId: "BL-1",
        secondTaskId: "BL-2",
        firstPath: "apps/web",
        secondPath: "apps/web/src/checkout",
      },
    ]);
    expect(ownershipPathsConflict("apps/web/", "./apps/web/src")).toBe(true);
    expect(ownershipPathsConflict("apps/web", "apps/web-old")).toBe(false);
  });

  it("uses worker efficiency and percentage overhead in elapsed estimates", () => {
    const markdown = [1, 2, 3, 4]
      .map(
        (number) => `
## BL-${number} — Independent ${number}
\`\`\`yaml
estimate_hours: 4
owns: [src/task-${number}]
validate: [npm test]
\`\`\`
${acceptance(`Task ${number} is complete.`)}
`,
      )
      .join("\n");

    const result = planBacklogMarkdown(markdown, {
      workerMaximum: 2,
      workerEfficiency: 0.8,
      overheadPercent: 10,
    });

    expect(result.plan?.estimates).toEqual({
      sequentialHours: 16,
      criticalPathHours: 4,
      expectedElapsedHours: 11,
      expectedSavingsPercent: 31.25,
      maximumTheoreticalConcurrency: 4,
      criticalPathTaskIds: ["BL-1", "BL-2", "BL-3", "BL-4"],
      workerEfficiency: 0.8,
      overheadPercent: 10,
    });
  });

  it("returns structured planning-option errors and caps workers at four", () => {
    const markdown = `
## BL-1 — Valid task
\`\`\`yaml
estimate_hours: 1
owns: [src]
validate: [npm test]
\`\`\`
${acceptance("The task is complete.")}
`;
    const result = planBacklogMarkdown(markdown, {
      workerMaximum: 5,
      workerEfficiency: 0,
      overheadPercent: 101,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        "INVALID_WORKER_MAXIMUM",
        "INVALID_WORKER_EFFICIENCY",
        "INVALID_OVERHEAD_PERCENT",
      ]),
    );
  });

  it("offers an explicit throwing adapter without making it the default", () => {
    expect(() => planBacklogOrThrow("# No tasks")).toThrow(
      BacklogPlanningError,
    );
    try {
      planBacklogOrThrow("# No tasks");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BacklogPlanningError);
      expect((error as BacklogPlanningError).errors[0]?.code).toBe("NO_TASKS");
    }
  });

  it("normalizes repository paths and rejects home-relative runtime paths", () => {
    expect(normalizeOwnershipPath("./apps//web/").path).toBe("apps/web");
    expect(normalizeOwnershipPath("~/\\.agentflow/runs").error?.code).toBe(
      "INVALID_OWNERSHIP_PATH",
    );
  });
});
