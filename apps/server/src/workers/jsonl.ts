import { StringDecoder } from "node:string_decoder";

export interface JsonlLine {
  raw: string;
  value: unknown;
  malformed: boolean;
  error: string | null;
}

export class JsonlStreamParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private oversized = false;

  constructor(
    private readonly maximumLineBytes: number,
    private readonly onLine: (line: JsonlLine) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    this.drainCompleteLines();
    this.enforceLineLimit();
  }

  end(): void {
    this.buffer += this.decoder.end();
    this.drainCompleteLines();
    if (this.buffer.length > 0 || this.oversized) {
      this.emitLine(this.buffer, this.oversized);
      this.buffer = "";
      this.oversized = false;
    }
  }

  private drainCompleteLines(): void {
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const raw = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.emitLine(raw, this.oversized);
      this.oversized = false;
      newline = this.buffer.indexOf("\n");
    }
  }

  private enforceLineLimit(): void {
    if (Buffer.byteLength(this.buffer, "utf8") <= this.maximumLineBytes) {
      return;
    }

    const buffer = Buffer.from(this.buffer, "utf8");
    this.buffer = buffer
      .subarray(Math.max(0, buffer.length - this.maximumLineBytes))
      .toString("utf8");
    this.oversized = true;
  }

  private emitLine(raw: string, oversized: boolean): void {
    if (oversized) {
      this.onLine({
        raw,
        value: null,
        malformed: true,
        error: `JSONL line exceeded ${this.maximumLineBytes} bytes`,
      });
      return;
    }

    try {
      this.onLine({
        raw,
        value: JSON.parse(raw) as unknown,
        malformed: false,
        error: null,
      });
    } catch (error) {
      this.onLine({
        raw,
        value: null,
        malformed: true,
        error: error instanceof Error ? error.message : "Invalid JSON",
      });
    }
  }
}
