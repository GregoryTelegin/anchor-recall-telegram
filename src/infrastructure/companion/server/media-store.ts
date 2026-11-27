import { constants, type Stats } from "node:fs";
import { open, lstat, mkdir, opendir, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES,
  validateCompanionMediaChunk, validateCompanionMediaIdentity, validateCompanionMediaStatusAssets, isCompanionMediaId,
  type CompanionMediaChunk, type CompanionMediaIdentity, type CompanionMediaStore, type CompanionMediaChunkAck
} from "../../../domain/companion/media";
import { privateDirectory } from "./shared-store";

export interface CompanionMediaLimits { accountBytes: number; totalBytes: number; accountFiles: number; totalFiles: number; }
const budgetKeys = ["accountBytes", "totalBytes", "accountFiles", "totalFiles"] as const;
function check(value: unknown): asserts value { if (!value) throw new Error("Companion media unavailable; preserve private files"); }
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function identity(asset: CompanionMediaIdentity): CompanionMediaIdentity { return { id: asset.id, kind: asset.kind, format: asset.format, bytes: asset.bytes }; }
function equal(a: CompanionMediaIdentity, b: CompanionMediaIdentity): boolean { return a.id === b.id && a.kind === b.kind && a.format === b.format && a.bytes === b.bytes; }
function namespace(value: string): void { check(typeof value === "string" && /^[a-f0-9]{48}$/.test(value)); }
function privateFile(info: Stats): void {
  check(info.isFile() && info.nlink === 1);
  if (process.platform !== "win32") check((info.mode & 0o077) === 0 && (process.getuid === undefined || info.uid === process.getuid()));
}
async function secureOpen(path: string, flags: number): Promise<FileHandle> {
  try { const info = await lstat(path); check(!info.isSymbolicLink()); privateFile(info); }
  catch (error) { if (!absent(error) || !(flags & constants.O_CREAT)) throw error; }
  const file = await open(path, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { privateFile(await file.stat()); check(!(await lstat(path)).isSymbolicLink()); return file; }
  catch (error) { await file.close(); throw error; }
}
async function syncDirectory(path: string): Promise<void> {
  // Windows has no supported directory-fsync contract; the deployed server is Debian.
  if (process.platform === "win32") return;
  const directory = await open(path, "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function ensureDirectory(path: string, parent: string): Promise<void> {
  await privateDirectory(parent);
  try { await mkdir(path, { mode: 0o700 }); await syncDirectory(parent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await privateDirectory(path);
}
async function metadata(path: string, id: string): Promise<CompanionMediaIdentity> {
  const file = await secureOpen(path, constants.O_RDONLY);
  try {
    const info = await file.stat(); check(info.size > 0 && info.size <= 1024);
    const bytes = Buffer.alloc(1025), read = await file.read(bytes, 0, bytes.length, 0);
    check(read.bytesRead === info.size && read.bytesRead <= 1024 && (await file.stat()).size === info.size);
    const value: unknown = JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")); validateCompanionMediaIdentity(value);
    check(value.id === id); return identity(value);
  } finally { await file.close(); }
}
async function content(path: string, asset: CompanionMediaIdentity): Promise<Buffer> {
  const file = await secureOpen(path, constants.O_RDONLY);
  try {
    check((await file.stat()).size === asset.bytes);
    const bytes = Buffer.alloc(asset.bytes); let position = 0;
    while (position < bytes.length) { const result = await file.read(bytes, position, bytes.length - position, position); check(result.bytesRead > 0); position += result.bytesRead; }
    const end = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
    check(end.bytesRead === 0 && (await file.stat()).size === asset.bytes && createHash("sha256").update(bytes).digest("hex") === asset.id);
    return bytes;
  } finally { await file.close(); }
}

/** One root per gateway owner; the gateway's journal lock owns the service process.
 * Optional operator budgets include unfinished uploads; self-hosted stores have no aggregate quota. */
export class CompanionMediaRoot {
  private readonly root: string;
  private readonly state: string;
  private readonly limits: Partial<CompanionMediaLimits>;
  private readonly accounts = new Map<string, Map<string, CompanionMediaIdentity>>();
  private readonly accountBytes = new Map<string, number>();
  // A fresh process must also flush existing entries; failed barriers stay unknown.
  private readonly durableAccountDirectories = new Set<string>();
  private totalBytes = 0;
  private totalFiles = 0;
  private initialized?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private blocked = false;
  constructor(stateDirectory: string, limits: Partial<CompanionMediaLimits> = {}) {
    this.state = resolve(stateDirectory); this.root = join(this.state, "media"); this.limits = { ...limits };
    check(Object.keys(limits).every(key => (budgetKeys as readonly string[]).includes(key)));
    for (const key of budgetKeys) if (this.limits[key] !== undefined) check(Number.isSafeInteger(this.limits[key]) && this.limits[key]! > 0);
  }
  private within(key: keyof CompanionMediaLimits, value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && (this.limits[key] === undefined || value <= this.limits[key]!);
  }
  forAccount(enrollment: string): CompanionMediaStore {
    namespace(enrollment);
    return { put: chunk => this.put(enrollment, chunk), status: assets => this.status(enrollment, assets), has: asset => this.has(enrollment, asset), read: id => this.read(enrollment, id) };
  }
  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      check(!this.blocked); await (this.initialized ??= this.scan());
      await privateDirectory(this.state); await privateDirectory(this.root); return work();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result.catch(() => { throw new Error("Companion media unavailable; preserve private files"); });
  }
  private async scan(): Promise<void> {
    await privateDirectory(this.state); await ensureDirectory(this.root, this.state);
    let accountCount = 0;
    for await (const entry of await opendir(this.root)) {
      check(this.within("totalFiles", ++accountCount)); namespace(entry.name); check(entry.isDirectory() && !entry.isSymbolicLink());
      const path = join(this.root, entry.name); await privateDirectory(path);
      const records = new Map<string, CompanionMediaIdentity>(), files = new Map<string, Set<string>>(); let count = 0;
      for await (const child of await opendir(path)) {
        ++count; check(Number.isSafeInteger(count) && (this.limits.accountFiles === undefined || count <= this.limits.accountFiles * 3)); const match = /^([a-f0-9]{64})\.(json|part|bin)$/.exec(child.name);
        check(match && child.isFile() && !child.isSymbolicLink());
        const info = await lstat(join(path, child.name)); privateFile(info);
        const kinds = files.get(match[1]) ?? new Set<string>(); kinds.add(match[2]); files.set(match[1], kinds);
        if (match[2] === "json") records.set(match[1], await metadata(join(path, child.name), match[1]));
      }
      let bytes = 0;
      for (const [id, kinds] of files) {
        const asset = records.get(id); check(asset && !(kinds.has("bin") && kinds.has("part")));
        bytes += asset.bytes;
        for (const kind of ["part", "bin"]) if (kinds.has(kind)) { const size = (await lstat(join(path, id + "." + kind))).size; check(kind === "bin" ? size === asset.bytes : size <= asset.bytes); }
      }
      check(this.within("accountBytes", bytes) && this.within("accountFiles", records.size));
      this.totalBytes += bytes; this.totalFiles += records.size;
      check(this.within("totalBytes", this.totalBytes) && this.within("totalFiles", this.totalFiles));
      this.accounts.set(entry.name, records);
      this.accountBytes.set(entry.name, bytes);
    }
  }
  private async account(enrollment: string): Promise<string> {
    const path = join(this.root, enrollment); await privateDirectory(path); return path;
  }
  private async syncAccountDirectory(path: string): Promise<void> {
    if (this.durableAccountDirectories.has(path)) return;
    await syncDirectory(path); this.durableAccountDirectories.add(path);
  }
  private async owned(enrollment: string, id: string): Promise<CompanionMediaIdentity | undefined> {
    const known = this.accounts.get(enrollment)?.get(id);
    if (!known) return undefined;
    const path = await this.account(enrollment), fresh = await metadata(join(path, id + ".json"), id);
    check(equal(fresh, known)); return fresh;
  }
  private async reserve(enrollment: string, asset: CompanionMediaIdentity): Promise<string> {
    const records = this.accounts.get(enrollment) ?? new Map<string, CompanionMediaIdentity>();
    const bytes = this.accountBytes.get(enrollment) ?? 0;
    check(this.within("accountFiles", records.size + 1) && this.within("totalFiles", this.totalFiles + 1)
      && this.within("accountBytes", bytes + asset.bytes) && this.within("totalBytes", this.totalBytes + asset.bytes));
    const path = join(this.root, enrollment); await ensureDirectory(path, this.root);
    this.durableAccountDirectories.delete(path);
    try {
      const file = await secureOpen(join(path, asset.id + ".json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try { await file.writeFile(JSON.stringify(asset)); await file.sync(); } finally { await file.close(); }
      await this.syncAccountDirectory(path);
    } catch (error) { this.blocked = true; throw error; }
    records.set(asset.id, asset); this.accounts.set(enrollment, records); this.accountBytes.set(enrollment, bytes + asset.bytes);
    this.totalFiles++; this.totalBytes += asset.bytes;
    return path;
  }
  private async put(enrollment: string, chunk: CompanionMediaChunk): Promise<CompanionMediaChunkAck> {
    validateCompanionMediaChunk(chunk, MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES);
    const asset = identity(chunk.asset), offset = chunk.offset, bytes = Buffer.from(chunk.data, "base64");
    check(bytes.toString("base64") === chunk.data);
    return this.run(async () => {
      const known = await this.owned(enrollment, asset.id); check(!known || equal(known, asset));
      if (!known) check(offset === 0);
      const path = known ? await this.account(enrollment) : await this.reserve(enrollment, asset);
      try { const complete = await content(join(path, asset.id + ".bin"), asset); check(complete.subarray(offset, offset + bytes.length).equals(bytes)); await this.syncAccountDirectory(path); return { id: asset.id, offset: asset.bytes, complete: true }; }
      catch (error) { if (!absent(error)) throw error; }
      const partial = join(path, asset.id + ".part"), directoryWasDurable = this.durableAccountDirectories.delete(path); let file: FileHandle;
      try { file = await secureOpen(partial, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (directoryWasDurable) this.durableAccountDirectories.add(path);
        file = await secureOpen(partial, constants.O_RDWR);
      }
      let size: number;
      try {
        size = (await file.stat()).size; check(size <= asset.bytes && offset <= size);
        const overlap = Math.min(bytes.length, size - offset), previous = Buffer.alloc(overlap);
        if (overlap) { const read = await file.read(previous, 0, overlap, offset); check(read.bytesRead === overlap && previous.equals(bytes.subarray(0, overlap))); }
        let written = overlap;
        while (written < bytes.length) { const result = await file.write(bytes, written, bytes.length - written, offset + written); check(result.bytesWritten > 0); written += result.bytesWritten; }
        await file.sync(); size = (await file.stat()).size; check(size <= asset.bytes);
      } finally { await file.close(); }
      if (size === asset.bytes) { await content(partial, asset); this.durableAccountDirectories.delete(path); await rename(partial, join(path, asset.id + ".bin")); await this.syncAccountDirectory(path); return { id: asset.id, offset: size, complete: true }; }
      await this.syncAccountDirectory(path); return { id: asset.id, offset: size, complete: false };
    });
  }
  private async status(enrollment: string, values: CompanionMediaIdentity[]): Promise<CompanionMediaChunkAck[]> {
    validateCompanionMediaStatusAssets(values); const assets = values.map(identity);
    return this.run(async () => {
      const files: CompanionMediaChunkAck[] = [];
      for (const asset of assets) {
        const known = await this.owned(enrollment, asset.id);
        if (!known) { files.push({ id: asset.id, offset: 0, complete: false }); continue; }
        check(equal(asset, known)); const path = await this.account(enrollment);
        try { await content(join(path, asset.id + ".bin"), asset); await this.syncAccountDirectory(path); files.push({ id: asset.id, offset: asset.bytes, complete: true }); continue; }
        catch (error) { if (!absent(error)) throw error; }
        const partial = join(path, asset.id + ".part"); let size = 0;
        try {
          const file = await secureOpen(partial, constants.O_RDWR);
          try { size = (await file.stat()).size; check(size <= asset.bytes); await file.sync(); check((await file.stat()).size === size); }
          finally { await file.close(); }
        }
        catch (error) { if (!absent(error)) throw error; }
        if (size === asset.bytes) {
          // Complete a verified upload interrupted between its final write and rename.
          await content(partial, asset); this.durableAccountDirectories.delete(path); await rename(partial, join(path, asset.id + ".bin"));
        }
        await this.syncAccountDirectory(path);
        files.push({ id: asset.id, offset: size, complete: size === asset.bytes });
      }
      return files;
    });
  }
  private async has(enrollment: string, value: CompanionMediaIdentity): Promise<boolean> {
    validateCompanionMediaIdentity(value); const asset = identity(value);
    return this.run(async () => {
      const known = await this.owned(enrollment, asset.id); if (!known) return false; check(equal(asset, known));
      try { const path = await this.account(enrollment); await content(join(path, asset.id + ".bin"), asset); await this.syncAccountDirectory(path); return true; }
      catch (error) { if (absent(error)) return false; throw error; }
    });
  }
  async read(enrollment: string, id: string): Promise<{ asset: CompanionMediaIdentity; bytes: Uint8Array }> {
    namespace(enrollment); check(isCompanionMediaId(id));
    return this.run(async () => { const asset = await this.owned(enrollment, id); check(asset); const path = await this.account(enrollment), bytes = await content(join(path, id + ".bin"), asset); await this.syncAccountDirectory(path); return { asset: identity(asset), bytes }; });
  }
}
