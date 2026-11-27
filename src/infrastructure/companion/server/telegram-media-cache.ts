import { constants, type Stats } from "node:fs";
import { open, lstat, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validateCompanionMediaIdentity, type CompanionMediaIdentity } from "../../../domain/companion/media";
import { privateDirectory } from "./shared-store";
import { recordPerformance, type PerformanceObserver } from "./metrics";

export type TelegramMediaMethod = "sendPhoto" | "sendAudio" | "sendVideo" | "sendDocument";
const MAX_ENTRIES = 10000, MAX_BYTES = 12_000_000;
function check(value: unknown): asserts value { if (!value) throw new Error("Media cache unavailable"); }
function privateFile(info: Stats): void {
  check(info.isFile() && info.nlink === 1);
  if (process.platform !== "win32") check((info.mode & 0o077) === 0 && (process.getuid === undefined || info.uid === process.getuid()));
}
export function validTelegramFileId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(value); }

/** Disposable acceleration data only. Learning state and delivery confirmation never depend on this file. */
export class TelegramMediaFileCache {
  private readonly file: string;
  private readonly scope: string;
  private readonly entries = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();
  private writable = true;
  private constructor(private readonly directory: string, token: string, private readonly observe?: PerformanceObserver) {
    this.file = join(directory, "telegram-media-files.json"); this.scope = createHash("sha256").update(token).digest("hex");
  }
  static async open(stateDirectory: string, options: { botToken: string; observe?: PerformanceObserver }): Promise<TelegramMediaFileCache> {
    check(/^\d+:[A-Za-z0-9_-]+$/.test(options.botToken));
    const cache = new TelegramMediaFileCache(resolve(stateDirectory), options.botToken, options.observe);
    try {
      await privateDirectory(cache.directory);
      let info: Stats;
      try { info = await lstat(cache.file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return cache; throw error; }
      check(!info.isSymbolicLink()); privateFile(info); check(info.size > 0 && info.size <= MAX_BYTES);
      const file = await open(cache.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let raw: string;
      try {
        const opened = await file.stat(); privateFile(opened); check(opened.size > 0 && opened.size <= MAX_BYTES);
        const buffer = Buffer.alloc(opened.size + 1); let length = 0;
        while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
        check(length === opened.size && (await file.stat()).size === opened.size); raw = buffer.subarray(0, length).toString("utf8");
      }
      finally { await file.close(); }
      const parsed: unknown = JSON.parse(raw); check(parsed && typeof parsed === "object" && !Array.isArray(parsed));
      const value = parsed as Record<string, unknown>;
      check(Object.keys(value).sort().join(",") === "entries,scope,version" && value.version === 1 && typeof value.scope === "string" && /^[a-f0-9]{64}$/.test(value.scope));
      check(Array.isArray(value.entries) && value.entries.length <= MAX_ENTRIES);
      const seen = new Set<string>();
      for (const row of value.entries) {
        check(row && typeof row === "object" && !Array.isArray(row) && Object.keys(row).sort().join(",") === "fileId,key");
        check(typeof row.key === "string" && /^[a-f0-9]{64}$/.test(row.key) && validTelegramFileId(row.fileId) && !seen.has(row.key));
        seen.add(row.key); if (value.scope === cache.scope) cache.entries.set(row.key, row.fileId);
      }
    } catch { cache.entries.clear(); cache.writable = false; recordPerformance(cache.observe, "media.cache.invalid", 0); }
    return cache;
  }
  matchesBot(token: string): boolean { return createHash("sha256").update(token).digest("hex") === this.scope; }
  private key(enrollment: string, asset: CompanionMediaIdentity, method: TelegramMediaMethod): string {
    check(/^[a-f0-9]{48}$/.test(enrollment)); validateCompanionMediaIdentity(asset);
    check(["sendPhoto", "sendAudio", "sendVideo", "sendDocument"].includes(method));
    return createHash("sha256").update([this.scope, enrollment, asset.id, asset.kind, asset.format, asset.bytes, method].join("|")).digest("hex");
  }
  get(enrollment: string, asset: CompanionMediaIdentity, method: TelegramMediaMethod): string | undefined { return this.entries.get(this.key(enrollment, asset, method)); }
  has(enrollment: string, asset: CompanionMediaIdentity, method: TelegramMediaMethod): boolean { return this.get(enrollment, asset, method) !== undefined; }
  async set(enrollment: string, asset: CompanionMediaIdentity, method: TelegramMediaMethod, fileId: string): Promise<void> {
    check(validTelegramFileId(fileId)); const key = this.key(enrollment, asset, method);
    if (this.entries.get(key) === fileId) return;
    this.entries.delete(key); this.entries.set(key, fileId);
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    await this.persist();
  }
  async invalidate(enrollment: string, asset: CompanionMediaIdentity, method: TelegramMediaMethod): Promise<void> {
    if (this.entries.delete(this.key(enrollment, asset, method))) await this.persist();
  }
  private persist(): Promise<void> {
    const write = this.tail.then(async () => {
      if (!this.writable) return;
      const temp = this.file + "." + randomUUID() + ".tmp";
      try {
        await privateDirectory(this.directory);
        try { const info = await lstat(this.file); check(!info.isSymbolicLink()); privateFile(info); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const raw = JSON.stringify({ version: 1, scope: this.scope, entries: [...this.entries].map(([key, fileId]) => ({ key, fileId })) });
        check(Buffer.byteLength(raw) <= MAX_BYTES);
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
        await rename(temp, this.file);
      } catch { this.writable = false; recordPerformance(this.observe, "media.cache.invalid", 0); }
      finally { await unlink(temp).catch(() => undefined); }
    });
    this.tail = write.catch(() => undefined); return this.tail;
  }
}
