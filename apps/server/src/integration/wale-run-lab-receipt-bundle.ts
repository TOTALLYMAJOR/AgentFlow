import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonSha256 } from "./design-intelligence.js";
import { makeDesignIntelligenceReceipt } from "./design-intelligence-receipt.js";
import type { DesignIntelligenceReceiptContext, ReceiptExportSource } from "./design-intelligence-receipt.js";
import type { WaleRunLabExperiment } from "./wale-run-lab.js";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const CLAIM_BOUNDARY = "This bundle exposes retained AgentFlow receipt and digest-verified evidence for one terminal experiment. It does not authorize candidate application or establish verification-profile execution, required-check satisfaction, comparison eligibility, release, deployment, effectiveness, or outcome.";

function requireEvidence(condition: boolean): asserts condition {
  if (!condition) throw new Error("Receipt evidence unavailable");
}

export async function verifyWaleReceiptEvidence(sources: readonly ReceiptExportSource[], selectedIndex?: number) {
  requireEvidence(sources.every((source) => source.sha256 !== null));
  const retained = [...sources]
    .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  requireEvidence(retained.length <= 256);
  const paths = new Set<string>();
  let totalBytes = 0;
  const files = [];
  for (const source of retained) {
    const segments = source.relativePath.split("/");
    requireEvidence(segments[0] === "artifacts" && segments.length > 1
      && segments.every((segment) => /^[A-Za-z0-9._-]+$/u.test(segment) && segment !== "." && segment !== "..")
      && !paths.has(source.relativePath) && /^[a-f0-9]{64}$/u.test(source.sha256 ?? ""));
    paths.add(source.relativePath);
    const stat = await lstat(source.sourcePath);
    requireEvidence(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES
      && await realpath(source.sourcePath) === path.resolve(source.sourcePath));
    totalBytes += stat.size;
    requireEvidence(totalBytes <= MAX_TOTAL_BYTES);
    files.push({ source, stat });
  }
  const evidence = [];
  let selectedBytes: Buffer | undefined;
  for (const [index, { source, stat }] of files.entries()) {
    const file = await open(source.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat();
      requireEvidence(opened.isFile() && opened.size === stat.size && opened.ino === stat.ino && opened.dev === stat.dev
        && await realpath(source.sourcePath) === path.resolve(source.sourcePath));
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(64 * 1024);
      const selectedChunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        // One extra byte detects growth without reading an unbounded file.
        const read = await file.read(chunk, 0, Math.min(chunk.length, stat.size - bytes + 1), null);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        requireEvidence(bytes <= stat.size);
        const content = chunk.subarray(0, read.bytesRead);
        hash.update(content);
        if (index === selectedIndex) selectedChunks.push(Buffer.from(content));
      }
      requireEvidence(bytes === stat.size && hash.digest("hex") === source.sha256);
      evidence.push({ index, path: source.relativePath, sha256: source.sha256, bytes });
      if (index === selectedIndex) selectedBytes = Buffer.concat(selectedChunks, bytes);
    } finally { await file.close(); }
  }
  return { evidence, selectedBytes };
}

export async function makeWaleRunLabReceiptBundle(
  context: DesignIntelligenceReceiptContext,
  buildId: string,
  experiment: WaleRunLabExperiment,
  selectedIndex?: number,
) {
  const build = context.store.builds.getById(buildId);
  requireEvidence(["completed", "failed", "cancelled"].includes(build.status));
  const bound = context.store.events.findByExperimentId(experiment.experimentId);
  requireEvidence(bound !== undefined && bound.buildId === buildId && canonicalJsonSha256(bound.payload) === canonicalJsonSha256(experiment));
  const { receipt, sources, sourceEventWatermark: watermark } = await makeDesignIntelligenceReceipt(context, buildId);
  requireEvidence(context.store.events.getLatestSequence(buildId) === watermark);
  requireEvidence(Buffer.byteLength(JSON.stringify(receipt), "utf8") <= MAX_RECEIPT_BYTES);
  const { evidence, selectedBytes } = await verifyWaleReceiptEvidence(sources, selectedIndex);
  requireEvidence(context.store.events.getLatestSequence(buildId) === watermark);
  return {
    bundle: {
      schemaVersion: "1.0.0",
      kind: "agentflow/wale-run-lab-receipt-bundle",
      experimentId: experiment.experimentId,
      runId: experiment.runId,
      bridgeBuildReference: buildId,
      receipt,
      receiptSha256: canonicalJsonSha256(receipt),
      evidence,
      claimBoundary: CLAIM_BOUNDARY,
    },
    selectedBytes,
  };
}
