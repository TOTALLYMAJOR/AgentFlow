import { open, type FileHandle } from "node:fs/promises";

const TRUNCATION_MARKER = Buffer.from(
  "\n[AgentFlow log truncated because the configured byte limit was reached]\n",
  "utf8",
);

export class BoundedLog {
  private bytesWritten = 0;
  private file: FileHandle | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private truncationMarkerWritten = false;

  public truncated = false;

  constructor(
    private readonly path: string,
    private readonly maximumBytes: number,
  ) {}

  async initialize(): Promise<void> {
    this.file = await open(this.path, "wx", 0o600);
  }

  write(value: string): void {
    if (this.file === null) {
      throw new Error(`log ${this.path} is not initialized`);
    }

    const buffer = Buffer.from(value, "utf8");
    const contentLimit = Math.max(
      0,
      this.maximumBytes - TRUNCATION_MARKER.length,
    );
    const remaining = Math.max(0, contentLimit - this.bytesWritten);
    const accepted = buffer.subarray(0, remaining);
    if (accepted.length > 0) {
      this.bytesWritten += accepted.length;
      const file = this.file;
      this.writeChain = this.writeChain.then(async () => {
        await file.write(accepted);
      });
    }

    if (accepted.length !== buffer.length) {
      this.truncated = true;
      this.writeTruncationMarker();
    }
  }

  private writeTruncationMarker(): void {
    if (this.truncationMarkerWritten || this.file === null) {
      return;
    }
    this.truncationMarkerWritten = true;
    const file = this.file;
    const marker = TRUNCATION_MARKER.subarray(
      0,
      Math.max(0, this.maximumBytes - this.bytesWritten),
    );
    this.bytesWritten += marker.length;
    this.writeChain = this.writeChain.then(async () => {
      await file.write(marker);
    });
  }

  async close(): Promise<void> {
    await this.writeChain;
    await this.file?.close();
    this.file = null;
  }
}
