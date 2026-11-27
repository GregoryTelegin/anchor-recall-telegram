import { constants, type Stats } from "node:fs";
import { open, lstat, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { invalid, keys, record } from "../../../domain/companion/protocol";
import { CatalogPageBuilder, readPagedJson, validateCatalogReference } from "../catalog-pages";
import { DesktopCatalogPageStorage } from "./catalog-page-storage";
import { cloneJsonValue } from "../../../shared/json-digest";

export const SHARED_GATEWAY_FORMAT = "anchor-recall-gateway-v2";
const ROOT_BYTES = 20_000_000;
function privateFile(info: Stats): void {
  invalid(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= ROOT_BYTES);
  if (process.platform !== "win32") invalid((info.mode & 0o077) === 0 && (process.getuid === undefined || info.uid === process.getuid()));
}
const identity = (info: Stats): string => [info.dev, info.ino, info.size, info.mode, info.nlink, info.mtimeMs, info.ctimeMs].join(":");

export interface SharedStore {
  acquire(): Promise<void>;
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
  close(): Promise<void>;
}

export async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  invalid(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === resolve(path), "private directory required");
  if (process.platform !== "win32") {
    invalid((info.mode & 0o077) === 0 && (process.getuid === undefined || info.uid === process.getuid()), "private directory required");
  }
}

/** Separate private gateway journal. Never auto-steal a crash lock or write plugin data. */
export class SharedFileStore implements SharedStore {
  private lock?: Awaited<ReturnType<typeof open>>;
  private readonly file: string;
  private readonly pages: DesktopCatalogPageStorage;
  constructor(private readonly directory: string) { this.file = join(resolve(directory), "gateway.json"); this.pages = new DesktopCatalogPageStorage(this.file); }
  async acquire(): Promise<void> {
    invalid(!this.lock); await privateDirectory(this.directory);
    this.lock = await open(this.file + ".lock", "wx", 0o600);
    await this.lock.writeFile(String(process.pid)); await this.lock.sync();
  }
  async load(): Promise<unknown> {
    invalid(this.lock);
    let info: Stats;
    try { info = await lstat(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("gateway journal unavailable; preserve for recovery"); }
    try {
      await privateDirectory(this.directory); privateFile(info);
      const file = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let raw: Buffer;
      try {
        const before = await file.stat(); privateFile(before); invalid(identity(before) === identity(info));
        const buffer = Buffer.allocUnsafe(before.size + 1); let offset = 0;
        while (offset < buffer.length) { const read = await file.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        const after = await file.stat(), current = await lstat(this.file); privateFile(after); privateFile(current);
        invalid(offset === before.size && identity(before) === identity(after) && identity(after) === identity(current)); raw = buffer.subarray(0, offset);
      } finally { await file.close(); }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      if (value && typeof value === "object" && (value as { format?: unknown }).format === SHARED_GATEWAY_FORMAT) {
        record(value); keys(value, ["format", "state"]); validateCatalogReference(value.state);
        // Missing/corrupt child pages must fail closed, never look like a fresh gateway.
        return cloneJsonValue(await readPagedJson(value.state, this.pages));
      }
      return value;
    } catch {
      throw new Error("gateway journal unavailable; preserve for recovery");
    }
  }
  async save(value: unknown): Promise<void> {
    invalid(this.lock); const captured = cloneJsonValue(value); await privateDirectory(this.directory);
    const builder = new CatalogPageBuilder(), state = builder.value(captured);
    for (const page of builder.pages.values()) await this.pages.put(page.reference, page.bytes());
    await this.pages.flush();
    const raw = JSON.stringify({ format: SHARED_GATEWAY_FORMAT, state }); invalid(Buffer.byteLength(raw) <= ROOT_BYTES);
    try { privateFile(await lstat(this.file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temp = this.file + "." + randomUUID() + ".tmp";
    try {
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.file);
      if (process.platform !== "win32") {
        const directory = await open(resolve(this.directory), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
  async close(): Promise<void> {
    if (this.lock) { await this.lock.close(); this.lock = undefined; await unlink(this.file + ".lock"); }
  }
}
