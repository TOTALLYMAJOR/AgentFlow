import { describe, expect, it } from "vitest";
import { ConservativeTextChurnEvaluator, parseConservativeTextChurn } from "../src/integration/delivery-size.js";

describe("conservative all-text churn proxy", () => {
  it("counts additions plus deletions across all text paths including docs and generated files", () => {
    expect(parseConservativeTextChurn("4\t3\tdocs/a.md\n10\t2\tgenerated/a.js\n")).toMatchObject({
      measurementVersion: "CONSERVATIVE_TEXT_CHURN_V1", additions: 14, deletions: 5, totalChurn: 19, textFileCount: 2,
    });
    expect(parseConservativeTextChurn("").totalChurn).toBe(0);
  });
  it("exposes binary changes so acceptance must refuse unmeasurable size", () => {
    expect(parseConservativeTextChurn("-\t-\tasset.png\n").binaryFileCount).toBe(1);
  });
  it.each(["bad", "1\t2\t", "-1\t0\tx", "1\t-\tx", "9007199254740992\t0\tx", "9007199254740991\t1\tx"]) ("refuses malformed or overflowing output %s", (output) => {
    expect(() => parseConservativeTextChurn(output)).toThrow();
  });
  it("rejects invalid refs before invoking Git and normalizes Git failures", async () => {
    let called = false;
    const evaluator = new ConservativeTextChurnEvaluator({ run: async () => { called = true; throw new Error("private path"); } });
    await expect(evaluator.evaluate({ worktreePath: "/tmp", baseCommit: "--option", candidateCommit: "a".repeat(40) })).rejects.toMatchObject({ code: "WALE_DELIVERY_SIZE_UNMEASURABLE" });
    expect(called).toBe(false);
    await expect(evaluator.evaluate({ worktreePath: "/tmp", baseCommit: "a".repeat(40), candidateCommit: "b".repeat(40) })).rejects.toThrow("could not be measured safely");
  });
});
