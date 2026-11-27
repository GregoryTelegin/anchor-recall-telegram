import { constants } from "node:fs";
import { open, rename, unlink, lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { invalid } from "../../../domain/companion/protocol";
import { validateServerState, type Journal, type ServerState } from "./server-state";
import { recordPerformance, type PerformanceObserver } from "./metrics";
import { JournalContent } from "./journal-content";
import { DesktopServerResultArchive } from "./result-archive";
import { DesktopServerReplayArchive } from "./replay-archive";
/** Private, separate, unencrypted service journal. Never the plugin's data.json.
 * Exclusive lock is deliberately NOT auto-stolen: operator must inspect a crash first. */
export class ServerJournal implements Journal {
  private lock?: Awaited<ReturnType<typeof open>>;
  private readonly path: string;
  private readonly content: JournalContent;
  readonly results: DesktopServerResultArchive;
  readonly replay: DesktopServerReplayArchive;
  readonly catalog: JournalContent["pages"];
  constructor(path: string, private readonly observe?: PerformanceObserver) {
    this.path = resolve(path); invalid(basename(this.path) !== "data.json", "not a plugin data file"); this.content = new JournalContent(this.path);
    this.catalog = this.content.pages;
    this.results = new DesktopServerResultArchive(dirname(this.path), createHash("sha256").update("server-results-v1:" + basename(this.path)).digest("hex"));
    this.replay = new DesktopServerReplayArchive(dirname(this.path), createHash("sha256").update("server-replay-v1:" + basename(this.path)).digest("hex"));
  }
  async acquire(): Promise<void> {
    invalid(!this.lock); const parent = await lstat(dirname(this.path)); invalid(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0, "journal directory must be private (0700)");
    this.lock = await open(`${this.path}.lock`, "wx", 0o600);
    await this.lock.writeFile(String(process.pid)); await this.lock.sync();
  }
  async close(): Promise<void> { if (this.lock) { await this.lock.close(); this.lock = undefined; await unlink(`${this.path}.lock`); } }
  async load(): Promise<ServerState | undefined> {
    invalid(this.lock, "journal lock required"); let raw: string;
    try {
      const info = await lstat(this.path); invalid(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 20_000_000 && (info.mode & 0o077) === 0);
      const file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await file.stat(); invalid(before.isFile() && before.nlink === 1 && before.ino === info.ino && before.size <= 20_000_000 && (before.mode & 0o077) === 0);
        const buffer = Buffer.allocUnsafe(before.size + 1); let offset = 0;
        while (offset < buffer.length) { const result = await file.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
        invalid(offset === before.size); raw = buffer.subarray(0, offset).toString("utf8"); const after = await file.stat();
        invalid(after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.nlink === 1
          && (after.mode & 0o077) === 0 && Buffer.byteLength(raw) <= 20_000_000);
      } finally { await file.close(); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("journal unavailable; preserve for recovery"); }
    const value = await this.content.decode(JSON.parse(raw)); validateServerState(value, undefined, this.results); return value;
  }
  async save(state: ServerState): Promise<void> {
    return this.validateAndSave(state);
  }
  /** The runtime may delegate its owner-specific check here instead of validating twice. */
  async validateAndSave(state: ServerState, ownerChatId?: number): Promise<void> {
    invalid(this.lock);
    const validationStarted = performance.now();
    try { validateServerState(state, ownerChatId, this.results); }
    finally { recordPerformance(this.observe, "journal.validate", performance.now() - validationStarted); }
    const started = performance.now();
    try { await this.write(state); }
    finally { recordPerformance(this.observe, "journal.write", performance.now() - started); }
  }
  private async write(state: ServerState): Promise<void> {
    const raw = JSON.stringify(await this.content.encode(state)); invalid(Buffer.byteLength(raw) <= 20_000_000, "journal byte limit");
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path); renamed = true;
      const dir = await open(dirname(this.path), "r"); try { await dir.sync(); } finally { await dir.close(); }
    } catch { throw new Error(renamed ? "journal commit uncertain; restart required" : "journal commit failed"); }
    finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
}
