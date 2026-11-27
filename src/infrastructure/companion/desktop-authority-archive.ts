import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { createHash, randomUUID } from "crypto";
import { gzipSync, gunzipSync } from "zlib";
import { MAX_COMPANION_SNAPSHOT_BYTES } from "../../domain/companion/capacity";
import { jsonFingerprint } from "../../shared/json-fingerprint";
import type { CompanionArchiveKind, CompanionArchiveRow, CompanionAuthorityArchive } from "../../features/companion/authority-archive";
import { DesktopCompanionProofStorage, readBoundedCompanionFile } from "./desktop-proof-storage";

const kinds: readonly CompanionArchiveKind[] = ["core-offer", "offline-root", "offline-attempt", "bank-grant", "core-receipt", "core-answered", "bank-proof", "offline-rejected", "core-grade-proof", "server-result", "server-replay"];
const SEGMENT_TARGET_BYTES = 4 * 1024 * 1024, CACHE_BYTES = 8 * 1024 * 1024, CACHE_ENTRIES = 32;
const FILTER_BYTES = 8192;
const INITIALIZED = "anchor-recall-authority-archive-v1\n";
interface Reference { sha256: string; bytes: number; filter?: string; encoding?: "gzip"; uncompressedBytes?: number; }
interface Manifest { version: 1; heads: Record<string, Reference>; checksum: string; }
interface Segment { version: 1; kind: CompanionArchiveKind; prefix: string; previous?: Reference; rows: CompanionArchiveRow[]; }
interface CachedSegment { identity: string; bytes: number; value: Segment; }
const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
function check(value: unknown): asserts value { if (!value) throw new Error("История полномочий Telegram недоступна. Существующие данные сохранены."); }
function object(value: unknown): asserts value is Record<string, unknown> { check(value && typeof value === "object" && !Array.isArray(value)); }
function keys(value: Record<string, unknown>, allowed: readonly string[]): void { check(Object.keys(value).every(key => allowed.includes(key))); }
function key(value: unknown): asserts value is string { check(typeof value === "string" && value.length > 0 && value.length <= 16384); }
function kind(value: unknown): asserts value is CompanionArchiveKind { check(kinds.includes(value as CompanionArchiveKind)); }
function reference(value: unknown): asserts value is Reference {
  object(value); keys(value, ["sha256", "bytes", "filter", "encoding", "uncompressedBytes"]);
  check(typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0 && Number(value.bytes) <= MAX_COMPANION_SNAPSHOT_BYTES);
  check(value.encoding === undefined ? value.uncompressedBytes === undefined : value.encoding === "gzip"
    && Number.isSafeInteger(value.uncompressedBytes) && Number(value.uncompressedBytes) > 0 && Number(value.uncompressedBytes) <= MAX_COMPANION_SNAPSHOT_BYTES);
  check(value.filter === undefined || typeof value.filter === "string" && value.filter.length === Math.ceil(FILTER_BYTES / 3) * 4 && Buffer.from(value.filter, "base64").length === FILTER_BYTES
    && Buffer.from(value.filter, "base64").toString("base64") === value.filter);
}
const positions = (name: string): number[] => { const hash = createHash("sha256").update(name).digest(); return [0, 2, 4, 6].map(offset => hash.readUInt16BE(offset)); };
const contains = (filter: Buffer, name: string): boolean => positions(name).every(bit => (filter[bit >>> 3] & (1 << (bit & 7))) !== 0);
const include = (filter: Buffer, name: string): void => { for (const bit of positions(name)) filter[bit >>> 3] |= 1 << (bit & 7); };
const prefixOf = (value: string): string => digest(value).slice(0, 1);
const segmentFile = (ref: Reference): string => ref.sha256 + (ref.encoding === "gzip" ? ".json.gz" : ".json");
const manifestValue = (heads: Record<string, Reference>): Manifest => ({ version: 1, heads, checksum: digest(JSON.stringify({ version: 1, heads })) });
const identity = (info: NonNullable<ReturnType<typeof lstatSync>>): string => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
function privateFile(info: NonNullable<ReturnType<typeof lstatSync>>): void {
  check(info.isFile() && !info.isSymbolicLink() && Number(info.nlink) === 1 && info.size > 0 && info.size <= MAX_COMPANION_SNAPSHOT_BYTES
    && (process.platform === "win32" || (Number(info.mode) & 0o077) === 0));
}

/** Immutable linked segments preserve every historical row without an aggregate history cap. */
export class DesktopCompanionAuthorityArchive implements CompanionAuthorityArchive {
  private readonly directory: string;
  private readonly manifest: DesktopCompanionProofStorage<Manifest>;
  private readonly cache = new Map<string, CachedSegment>();
  private cacheBytes = 0;
  private observed?: string | null;
  private seenManifest = false;
  private validatedManifest?: Manifest;
  constructor(private readonly pluginDirectory: string, private readonly binding: string) {
    check(/^[a-f0-9]{64}$/.test(binding)); this.pluginDirectory = resolve(pluginDirectory);
    this.directory = join(this.pluginDirectory, "companion-proofs", binding);
    this.manifest = new DesktopCompanionProofStorage(this.pluginDirectory, binding, "authority-archive", () => undefined);
  }
  private load(): Manifest {
    const before = this.manifestIdentity();
    if (before === null) check(!this.seenManifest && !this.initialized());
    if (this.observed !== undefined && this.observed !== before) { this.observed = before; check(false); }
    const value = this.manifest.read();
    const after = this.manifestIdentity();
    if (after !== before) { this.observed = after; this.seenManifest ||= after !== null; check(false); }
    this.observed = after; this.seenManifest ||= after !== null; this.initialized();
    if (value === undefined) return manifestValue({});
    if (value === this.validatedManifest) return this.validatedManifest;
    object(value); keys(value, ["version", "heads", "checksum"]); check(value.version === 1); object(value.heads);
    check(value.checksum === digest(JSON.stringify({ version: 1, heads: value.heads })));
    for (const [bucket, head] of Object.entries(value.heads)) {
      const split = bucket.lastIndexOf(":"), owner = bucket.slice(0, split), prefix = bucket.slice(split + 1);
      kind(owner); check(/^[a-f0-9]$/.test(prefix)); reference(head);
    }
    this.validatedManifest = value as unknown as Manifest; return this.validatedManifest;
  }
  private checkDirectory(path: string, create: boolean): void {
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(path); }
    catch (error) {
      if (!create || !missing(error)) throw error;
      mkdirSync(path, { mode: 0o700 }); info = lstatSync(path);
    }
    check(info.isDirectory() && !info.isSymbolicLink() && (path === this.pluginDirectory || process.platform === "win32" || (Number(info.mode) & 0o077) === 0));
    if (create && process.platform !== "win32") { const descriptor = openSync(dirname(path), "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
  }
  private bucketDirectory(owner: CompanionArchiveKind, prefix: string, create: boolean): string {
    let path = this.baseDirectory(create);
    for (const part of ["authority-archive", owner, prefix]) { path = join(path, part); this.checkDirectory(path, create); }
    return path;
  }
  private baseDirectory(create: boolean): string {
    this.checkDirectory(this.pluginDirectory, false);
    let path = this.pluginDirectory;
    for (const part of ["companion-proofs", this.binding]) {
      path = join(path, part); this.checkDirectory(path, create);
    }
    return path;
  }
  private manifestIdentity(): string | null {
    try {
      this.baseDirectory(false); const path = join(this.directory, "authority-archive.json"), info = lstatSync(path); privateFile(info);
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      try {
        const before = fstatSync(descriptor); privateFile(before); check(identity(before) === identity(info));
        const raw = readBoundedCompanionFile(descriptor, Number(info.size)), after = fstatSync(descriptor), current = lstatSync(path); privateFile(after); privateFile(current);
        check(identity(after) === identity(info) && identity(current) === identity(info) && raw.length === info.size);
        return identity(info) + ":" + digest(raw);
      } finally { closeSync(descriptor); }
    }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  private initialized(): boolean {
    const path = join(this.directory, "authority-archive.initialized");
    try {
      this.baseDirectory(false); const info = lstatSync(path); privateFile(info); check(info.size === Buffer.byteLength(INITIALIZED));
      const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      try { check(identity(fstatSync(descriptor)) === identity(info) && readBoundedCompanionFile(descriptor, Number(info.size)).toString("utf8") === INITIALIZED && identity(lstatSync(path)) === identity(info)); }
      finally { closeSync(descriptor); }
      return true;
    } catch (error) { if (missing(error)) return false; throw error; }
  }
  private markInitialized(): void {
    if (this.initialized()) return;
    const path = join(this.directory, "authority-archive.initialized"), temporary = join(this.directory, `.${randomUUID()}.initialized.tmp`);
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try { writeFileSync(descriptor, INITIALIZED); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, path);
      if (process.platform !== "win32") { const descriptor = openSync(this.directory, "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
      check(this.initialized());
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private read(owner: CompanionArchiveKind, prefix: string, ref: Reference): Segment {
    reference(ref); const path = join(this.bucketDirectory(owner, prefix, false), segmentFile(ref)), info = lstatSync(path); privateFile(info);
    check(info.size === ref.bytes);
    const observed = identity(info), cached = this.cache.get(path);
    if (cached?.identity === observed) {
      check(cached.bytes === (ref.uncompressedBytes ?? ref.bytes)); this.cache.delete(path); this.cache.set(path, cached); return cached.value;
    }
    const descriptor = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    let raw: Buffer;
    try {
      const before = fstatSync(descriptor); privateFile(before); check(identity(before) === observed);
      raw = readBoundedCompanionFile(descriptor, Number(before.size)); const after = fstatSync(descriptor), current = lstatSync(path); privateFile(after); privateFile(current);
      check(identity(after) === observed && identity(current) === observed && raw.length === ref.bytes && digest(raw) === ref.sha256);
    } finally { closeSync(descriptor); }
    const decoded = ref.encoding === "gzip" ? gunzipSync(raw, { maxOutputLength: ref.uncompressedBytes }) : raw;
    check(decoded.length === (ref.uncompressedBytes ?? ref.bytes));
    const value: unknown = JSON.parse(decoded.toString("utf8")); object(value); keys(value, ["version", "kind", "prefix", "previous", "rows"]);
    check(value.version === 1 && value.kind === owner && value.prefix === prefix && Array.isArray(value.rows) && value.rows.length > 0);
    if (value.previous !== undefined) reference(value.previous);
    const seen = new Set<string>();
    for (const row of value.rows) { object(row); keys(row, ["key", "value"]); key(row.key); check(Object.prototype.hasOwnProperty.call(row, "value") && prefixOf(row.key) === prefix && !seen.has(row.key)); seen.add(row.key); }
    if (ref.filter !== undefined) {
      const filter = Buffer.from(ref.filter, "base64");
      for (const name of seen) check(contains(filter, name));
      if (value.previous !== undefined && (value.previous as Reference).filter !== undefined) {
        const previous = Buffer.from((value.previous as Reference).filter!, "base64");
        check(previous.every((byte, index) => (filter[index] & byte) === byte));
      }
    }
    const segment = value as unknown as Segment;
    if (decoded.length <= CACHE_BYTES) {
      if (cached) { this.cache.delete(path); this.cacheBytes -= cached.bytes; }
      this.cache.set(path, { identity: observed, bytes: decoded.length, value: segment }); this.cacheBytes += decoded.length;
      while (this.cacheBytes > CACHE_BYTES || this.cache.size > CACHE_ENTRIES) { const first = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(first)!.bytes; this.cache.delete(first); }
    }
    return segment;
  }
  get(owner: CompanionArchiveKind, name: string): unknown { return this.getMany(owner, [name]).get(name); }
  getMany(owner: CompanionArchiveKind, names: readonly string[]): Map<string, unknown> {
    kind(owner); check(Array.isArray(names)); const state = this.load(), groups = new Map<string, Set<string>>(), result = new Map<string, unknown>();
    for (const name of names) { key(name); const prefix = prefixOf(name); if (!groups.has(prefix)) groups.set(prefix, new Set()); groups.get(prefix)!.add(name); }
    for (const [prefix, unresolved] of groups) {
      let ref: Reference | undefined = state.heads[`${owner}:${prefix}`]; const visited = new Set<string>();
      while (ref && unresolved.size) {
        // Saturated filters only fall back to exact scans; they never establish a match.
        if (ref.filter !== undefined) { const filter = Buffer.from(ref.filter, "base64"); if (![...unresolved].some(name => contains(filter, name))) break; }
        check(!visited.has(ref.sha256)); visited.add(ref.sha256); const segment = this.read(owner, prefix, ref);
        for (const row of segment.rows) if (unresolved.has(row.key)) { result.set(row.key, clone(row.value)); unresolved.delete(row.key); }
        ref = segment.previous;
      }
    }
    return result;
  }
  private write(owner: CompanionArchiveKind, prefix: string, rows: CompanionArchiveRow[], previous: Reference | undefined, current: () => void): Reference {
    const segment: Segment = { version: 1, kind: owner, prefix, ...(previous ? { previous } : {}), rows }, raw = Buffer.from(JSON.stringify(segment));
    check(raw.length <= MAX_COMPANION_SNAPSHOT_BYTES); current();
    const filter = Buffer.alloc(FILTER_BYTES); let cursor = previous; const visited = new Set<string>();
    while (cursor) {
      if (cursor.filter !== undefined) { const prior = Buffer.from(cursor.filter, "base64"); prior.forEach((byte, index) => filter[index] |= byte); break; }
      check(!visited.has(cursor.sha256)); visited.add(cursor.sha256); const segment = this.read(owner, prefix, cursor);
      for (const row of segment.rows) include(filter, row.key); cursor = segment.previous;
    }
    for (const row of rows) include(filter, row.key);
    const compressed = gzipSync(raw, { level: 6 }), encoded = compressed.length < raw.length ? compressed : raw;
    check(encoded.length <= MAX_COMPANION_SNAPSHOT_BYTES);
    const directory = this.bucketDirectory(owner, prefix, true), ref: Reference = { sha256: digest(encoded), bytes: encoded.length, filter: filter.toString("base64"),
      ...(encoded === compressed ? { encoding: "gzip", uncompressedBytes: raw.length } : {}) }, destination = join(directory, segmentFile(ref));
    try { lstatSync(destination); this.read(owner, prefix, ref); return ref; }
    catch (error) { if (!missing(error)) throw error; }
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try { writeFileSync(descriptor, encoded); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      current(); renameSync(temporary, destination);
      if (process.platform !== "win32") { const descriptor = openSync(directory, "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
      this.read(owner, prefix, ref); return ref;
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  putMany(owner: CompanionArchiveKind, rows: readonly CompanionArchiveRow[], current: () => void): void {
    kind(owner); check(Array.isArray(rows)); current(); const state = this.load(), heads = { ...state.heads }, groups = new Map<string, CompanionArchiveRow[]>();
    const before = this.manifestIdentity();
    const seen = new Map<string, unknown>(), normalized = new Map<string, CompanionArchiveRow[]>();
    for (const row of rows) {
      object(row); keys(row, ["key", "value"]); key(row.key); const raw = JSON.stringify(row.value); check(raw !== undefined);
      const value: unknown = JSON.parse(raw);
      if (seen.has(row.key)) { check(jsonFingerprint(seen.get(row.key)) === jsonFingerprint(value)); continue; } seen.set(row.key, value);
      const prefix = prefixOf(row.key); if (!normalized.has(prefix)) normalized.set(prefix, []); normalized.get(prefix)!.push({ key: row.key, value });
    }
    for (const [prefix, group] of normalized) {
      const existing = this.getMany(owner, group.map(row => row.key));
      const changed = group.filter(row => !existing.has(row.key) || jsonFingerprint(existing.get(row.key)) !== jsonFingerprint(row.value));
      if (changed.length) groups.set(prefix, changed);
    }
    if (!groups.size) {
      current(); check(this.manifestIdentity() === before);
      if (before !== null) {
        this.markInitialized();
        if (process.platform !== "win32") { const descriptor = openSync(this.directory, "r"); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
        check(this.manifestIdentity() === before);
      }
      return;
    }
    for (const [prefix, group] of groups) {
      let chunk: CompanionArchiveRow[] = [], bytes = 0, previous = heads[`${owner}:${prefix}`];
      for (const row of group) {
        const size = Buffer.byteLength(JSON.stringify(row)); check(size + 1024 <= MAX_COMPANION_SNAPSHOT_BYTES);
        if (chunk.length && bytes + size > SEGMENT_TARGET_BYTES) { previous = this.write(owner, prefix, chunk, previous, current); chunk = []; bytes = 0; }
        chunk.push(row); bytes += size;
      }
      if (chunk.length) previous = this.write(owner, prefix, chunk, previous, current);
      heads[`${owner}:${prefix}`] = previous;
    }
    current(); check(this.manifestIdentity() === before);
    const published = manifestValue(heads); this.manifest.write(published);
    const committed = this.manifestIdentity(); check(committed !== null && JSON.stringify(this.manifest.read()) === JSON.stringify(published));
    this.seenManifest = true; this.markInitialized(); check(this.manifestIdentity() === committed); this.observed = committed;
  }
}
