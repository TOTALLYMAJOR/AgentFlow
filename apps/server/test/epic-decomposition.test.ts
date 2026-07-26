import { describe, expect, it } from "vitest";
import { planBacklogMarkdown } from "../src/planning/index.js";

describe("epic decomposition and ADR drafts", () => {
  it("derives epic dependencies and proposed ADRs from task metadata", () => {
    const result = planBacklogMarkdown(`# Program

## ARC-001 - Define execution boundary

\`\`\`yaml
estimate_hours: 2
depends_on: []
owns: [src/contracts/]
validate: [npm run typecheck]
epic_id: EPIC-FOUNDATION
epic_title: Execution foundation
epic_outcome: Establish the durable execution contract.
architecture_decisions:
  - title: Use pull-based execution leases
    context: Remote machines cannot accept inbound control-plane connections.
    decision: Runners claim short-lived fenced leases.
    consequences:
      - Late results are rejected.
      - Runners require outbound control-plane access.
\`\`\`

Define the contract.

### Acceptance Criteria

- The contract is versioned.

## RUN-001 - Implement remote runner

\`\`\`yaml
estimate_hours: 4
depends_on: [ARC-001]
owns: [src/runners/]
validate: [npm test]
epic_id: EPIC-DELIVERY
epic_title: Distributed delivery
epic_outcome: Execute governed tasks on remote machines.
\`\`\`

Implement the runner.

### Acceptance Criteria

- A runner claims a fenced lease.
`);

    expect(result.valid).toBe(true);
    expect(result.plan?.epics).toEqual([
      {
        id: "EPIC-DELIVERY",
        title: "Distributed delivery",
        outcome: "Execute governed tasks on remote machines.",
        taskIds: ["RUN-001"],
        dependsOnEpicIds: ["EPIC-FOUNDATION"],
        estimateHours: 4,
      },
      {
        id: "EPIC-FOUNDATION",
        title: "Execution foundation",
        outcome: "Establish the durable execution contract.",
        taskIds: ["ARC-001"],
        dependsOnEpicIds: [],
        estimateHours: 2,
      },
    ]);
    expect(result.plan?.adrDrafts).toHaveLength(1);
    expect(result.plan?.adrDrafts[0]).toMatchObject({
      id: "ADR-DRAFT-001",
      title: "Use pull-based execution leases",
      status: "proposed",
      sourceTaskIds: ["ARC-001"],
    });
    expect(result.plan?.adrDrafts[0]?.markdown).toContain(
      "## Consequences",
    );
  });

  it("rejects an epic-level cycle even when the task graph is acyclic", () => {
    const result = planBacklogMarkdown(`# Program

## A-001 - Start A

\`\`\`yaml
estimate_hours: 1
depends_on: []
owns: [a/start/]
validate: [npm test]
epic_id: EPIC-A
epic_title: Epic A
epic_outcome: Deliver A.
\`\`\`

Start A.

### Acceptance Criteria
- A starts.

## B-001 - Build B

\`\`\`yaml
estimate_hours: 1
depends_on: [A-001]
owns: [b/]
validate: [npm test]
epic_id: EPIC-B
epic_title: Epic B
epic_outcome: Deliver B.
\`\`\`

Build B.

### Acceptance Criteria
- B is built.

## A-002 - Finish A

\`\`\`yaml
estimate_hours: 1
depends_on: [B-001]
owns: [a/finish/]
validate: [npm test]
epic_id: EPIC-A
epic_title: Epic A
epic_outcome: Deliver A.
\`\`\`

Finish A.

### Acceptance Criteria
- A finishes.
`);

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain(
      "EPIC_DEPENDENCY_CYCLE",
    );
  });
});
