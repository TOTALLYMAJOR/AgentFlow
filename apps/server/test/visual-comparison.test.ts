import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { comparePngs } from "../src/visual/comparison.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("browser screenshot comparison", () => {
  it("creates a deterministic diff and enforces the ratio threshold", async () => {
    const root = await temporaryRoot();
    const baselinePath = path.join(root, "baseline.png");
    const actualPath = path.join(root, "actual.png");
    const diffPath = path.join(root, "evidence", "diff.png");
    await writePng(baselinePath, 2, 2, [
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [255, 255, 255, 255],
    ]);
    await writePng(actualPath, 2, 2, [
      [0, 0, 0, 255],
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [255, 255, 255, 255],
    ]);

    const comparison = await comparePngs({
      baselinePath,
      actualPath,
      diffPath,
      pixelThreshold: 0.1,
      maximumDifferenceRatio: 0.1,
    });
    expect(comparison).toEqual({
      width: 2,
      height: 2,
      differentPixels: 1,
      differenceRatio: 0.25,
      status: "failed",
      diffPath,
    });
  });

  it("reports dimension mismatch without fabricating a diff", async () => {
    const root = await temporaryRoot();
    const baselinePath = path.join(root, "baseline.png");
    const actualPath = path.join(root, "actual.png");
    await writePng(baselinePath, 2, 2, [
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [255, 255, 255, 255],
      [255, 255, 255, 255],
    ]);
    await writePng(actualPath, 1, 1, [[255, 255, 255, 255]]);

    await expect(
      comparePngs({
        baselinePath,
        actualPath,
        diffPath: path.join(root, "diff.png"),
        pixelThreshold: 0.1,
        maximumDifferenceRatio: 0,
      }),
    ).resolves.toMatchObject({
      width: 1,
      height: 1,
      differentPixels: 1,
      differenceRatio: 1,
      status: "dimension_mismatch",
      diffPath: null,
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agentflow-visual-"));
  temporaryRoots.push(root);
  return root;
}

async function writePng(
  filePath: string,
  width: number,
  height: number,
  pixels: Array<[number, number, number, number]>,
): Promise<void> {
  const png = new PNG({ width, height });
  pixels.forEach((pixel, index) => {
    const offset = index * 4;
    png.data[offset] = pixel[0];
    png.data[offset + 1] = pixel[1];
    png.data[offset + 2] = pixel[2];
    png.data[offset + 3] = pixel[3];
  });
  await writeFile(filePath, PNG.sync.write(png));
}
