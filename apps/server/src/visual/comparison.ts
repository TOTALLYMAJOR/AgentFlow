import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { chromium } from "playwright";

export interface PngComparison {
  width: number;
  height: number;
  differentPixels: number;
  differenceRatio: number;
  status: "passed" | "failed" | "dimension_mismatch";
  diffPath: string | null;
}

export async function comparePngs(input: {
  baselinePath: string;
  actualPath: string;
  diffPath: string;
  pixelThreshold: number;
  maximumDifferenceRatio: number;
}): Promise<PngComparison> {
  const [baseline, actual] = await Promise.all([
    readPng(input.baselinePath),
    readPng(input.actualPath),
  ]);
  if (
    baseline.width !== actual.width ||
    baseline.height !== actual.height
  ) {
    return {
      width: actual.width,
      height: actual.height,
      differentPixels: actual.width * actual.height,
      differenceRatio: 1,
      status: "dimension_mismatch",
      diffPath: null,
    };
  }
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const differentPixels = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    baseline.width,
    baseline.height,
    {
      threshold: input.pixelThreshold,
      includeAA: false,
    },
  );
  const differenceRatio = Number(
    (differentPixels / (baseline.width * baseline.height)).toFixed(8),
  );
  await mkdir(path.dirname(input.diffPath), { recursive: true, mode: 0o700 });
  await writeFile(input.diffPath, PNG.sync.write(diff), { mode: 0o600 });
  return {
    width: baseline.width,
    height: baseline.height,
    differentPixels,
    differenceRatio,
    status:
      differenceRatio <= input.maximumDifferenceRatio ? "passed" : "failed",
    diffPath: input.diffPath,
  };
}

export async function captureBrowserScreenshot(input: {
  url: string;
  outputPath: string;
  width: number;
  height: number;
  fullPage: boolean;
}): Promise<void> {
  const parsed = new URL(input.url);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Browser capture is restricted to loopback routes");
  }
  await mkdir(path.dirname(input.outputPath), {
    recursive: true,
    mode: 0o700,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: input.width, height: input.height },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.goto(parsed.href, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    await page.screenshot({
      path: input.outputPath,
      fullPage: input.fullPage,
      animations: "disabled",
    });
    await context.close();
  } finally {
    await browser.close();
  }
}

async function readPng(filePath: string): Promise<PNG> {
  return PNG.sync.read(await readFile(filePath));
}
