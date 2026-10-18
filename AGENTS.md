# AgentFlow repository instructions

Read `.github/copilot-instructions.md` before changing this repository. Its commands, architecture, native task/validation/integration gates, TypeScript conventions, runtime-state placement and accepted-ADR precedence remain in force. This entry point does not replace those instructions.

## Historical integration preparation

`docs/BEGIN-INTEGRATION.md` records the 2026-09-18 preparation. Its instructions to implement governed handoff v2 admission, the build receipt, and the `governor.v1` bridge have since landed on `main`. For a new operator `begin`, inspect the current integration guide, source, branch heads, task records, and native authority before selecting unfinished work; do not replay the historical implementation steps.

The preparation selected native governed-handoff v2 admission, protocol parity, TCP-002 observations, TCP-003 bounded interventions, and an audited local return loop. Verify current native records before classifying any part as unfinished. Do not invent a new scheduler/control plane, install exported V7-EPI backlogs as canonical, or rerun the completed MRI closeout.

Preparation is not execution. `begin` is a natural-language continuation instruction, not a CLI command or authenticated approval. Do not fabricate human receipts, signatures, test passes or runtime evidence. Native adoption, execution approval and acceptance remain distinct; live scope and approval must bind the current code revision. Preserve unpublished work and stop on real authority, scope, access or evidence blockers rather than reopening the chosen architecture.
