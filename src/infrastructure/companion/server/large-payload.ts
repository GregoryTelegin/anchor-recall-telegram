import { createHash, randomUUID } from "node:crypto";
import { MAX_COMPANION_SNAPSHOT_BYTES, MAX_COMPANION_SNAPSHOT_CHUNK_BYTES } from "../../../domain/companion/capacity";
import { invalid, keys, record, token } from "../../../domain/companion/protocol";

const IDLE_TTL = 5 * 60_000;
const MAX_LIFETIME = 90 * 60_000;
let stagedBytes = 0;
interface Upload { id: string; bytes: number; hash: string; parts: Buffer[]; received: number; startedAt: number; touched: number; timer?: ReturnType<typeof setTimeout>; }
export type LargePayloadResult = { response: unknown } | { payload: Record<string, unknown>; startedAt: number };

/** Uncommitted uploads are disposable; the previous durable copy stays active until final validation. */
export class LargePayloadAssembler {
  private upload?: Upload;

  private clear(): void {
    if (!this.upload) return;
    clearTimeout(this.upload.timer); stagedBytes -= this.upload.received; this.upload = undefined;
  }
  private touch(now: number): void {
    const upload = this.upload!; upload.touched = now;
    clearTimeout(upload.timer); upload.timer = setTimeout(() => this.clear(), IDLE_TTL); upload.timer.unref?.();
  }
  accept(value: unknown, now: number): LargePayloadResult {
    record(value);
    if (this.upload && (now - this.upload.touched >= IDLE_TTL || now - this.upload.startedAt >= MAX_LIFETIME)) this.clear();
    if (value.operation === "large-payload-begin") {
      keys(value, ["operation", "bytes", "sha256"]);
      invalid(Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0 && Number(value.bytes) <= MAX_COMPANION_SNAPSHOT_BYTES);
      invalid(typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256));
      this.clear();
      this.upload = { id: randomUUID(), bytes: Number(value.bytes), hash: value.sha256, parts: [], received: 0, startedAt: now, touched: now };
      this.touch(now); return { response: { id: this.upload.id, offset: 0 } };
    }
    token(value.id); const upload = this.upload;
    invalid(upload && upload.id === value.id, "upload expired; start a new transfer");
    if (value.operation === "large-payload-chunk") {
      keys(value, ["operation", "id", "offset", "data"]);
      invalid(Number.isSafeInteger(value.offset) && Number(value.offset) >= 0);
      invalid(typeof value.data === "string" && value.data.length > 0 && value.data.length <= Math.ceil(MAX_COMPANION_SNAPSHOT_CHUNK_BYTES / 3) * 4);
      const bytes = Buffer.from(value.data, "base64");
      invalid(bytes.length > 0 && bytes.length <= MAX_COMPANION_SNAPSHOT_CHUNK_BYTES && bytes.toString("base64") === value.data);
      // Exact retries are harmless; reordered or different chunks never replace accepted bytes.
      if (value.offset !== upload.received) {
        let offset = 0;
        const previous = upload.parts.find(part => { const start = offset; offset += part.length; return start === value.offset; });
        invalid(previous?.equals(bytes), "upload offset differs");
      } else {
        invalid(upload.received + bytes.length <= upload.bytes && stagedBytes + bytes.length <= MAX_COMPANION_SNAPSHOT_BYTES * 2, "upload capacity exceeded");
        upload.parts.push(bytes); upload.received += bytes.length; stagedBytes += bytes.length;
      }
      this.touch(now); return { response: { id: upload.id, offset: upload.received } };
    }
    keys(value, ["operation", "id"]); invalid(value.operation === "large-payload-commit" && upload.received === upload.bytes);
    const bytes = Buffer.concat(upload.parts, upload.bytes);
    invalid(createHash("sha256").update(bytes).digest("hex") === upload.hash, "upload hash differs");
    this.clear();
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); record(payload);
    invalid(payload.operation === "study-context" || payload.operation === "study-plan" || payload.operation === undefined && payload.snapshot !== undefined, "unsupported large payload");
    return { payload, startedAt: upload.startedAt };
  }
}
