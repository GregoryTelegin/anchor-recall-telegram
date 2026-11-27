import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { createHash, randomUUID } from "crypto";
import { MAX_COMPANION_SNAPSHOT_BYTES } from "../../domain/companion/capacity";
import { cloneJsonValue } from "../../shared/json-digest";

function fail(): never { throw new Error("Локальное доказательство Telegram недоступно. Исходные данные сохранены; повторите действие после проверки файлов."); }
function freeze(value: unknown): unknown {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const version = (info: NonNullable<ReturnType<typeof lstatSync>>): string => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const PAGED = "anchor-recall-proof-pages-v1", PAGE = "anchor-recall-proof-page-v1";
const PAGE_TARGET = 4 * 1024 * 1024;
interface PageReference { sha256: string; bytes: number; rows: number; }
interface DecodedPage { version: string; value: { values: unknown[]; previous?: PageReference }; }
type PagedField = { name: string; value: unknown } | { name: string; length: number; head?: PageReference };
interface PagedProof { format: typeof PAGED; fields: PagedField[]; }
export type DesktopCompanionProofKind = "bank" | "offline" | "media" | "authority-archive" | "sequence" | "written-recall" | "card-reports" | "plan-actions" | "answer-history";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const digest = (raw: string): string => createHash("sha256").update(raw, "utf8").digest("hex");

/** A file growing after stat cannot make a private read allocate beyond its checked bound. */
export function readBoundedCompanionFile(descriptor: number, expectedBytes: number): Buffer {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_COMPANION_SNAPSHOT_BYTES) fail();
  const bytes = Buffer.allocUnsafe(expectedBytes + 1); let length = 0;
  while (length < bytes.length) { const read = readSync(descriptor, bytes, length, bytes.length - length, null); if (!read) break; length += read; }
  if (length !== expectedBytes) fail(); return bytes.subarray(0, length);
}

export function companionProofDirectory(basePath: string, configDir: string, pluginId: string): string {
  if (!basePath || !/^[a-z0-9-]+$/.test(pluginId)) return fail();
  const base = resolve(basePath), result = resolve(base, configDir, "plugins", pluginId), local = relative(base, result);
  if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`) || resolve(result) === base) return fail();
  return result;
}

/** Private desktop JSON, independent of Chromium localStorage's small quota. */
export class DesktopCompanionProofStorage<T> {
  readonly immutable = true;
  private readonly directory: string;
  private readonly file: string;
  private readonly pagesDirectory: string;
  private cached?: { version: string; digest: string; value: unknown; pages: Map<string, string>; decodedPages: Map<string, DecodedPage> };
  private observed?: string | null;
  private observedDigest?: string | null;
  private reclaimedAnswerHistoryVersion?: string;

  constructor(private readonly pluginDirectory: string, binding: string, private readonly kind: DesktopCompanionProofKind, private readonly legacyRead: () => unknown) {
    if (!/^[a-f0-9]{64}$/.test(binding) || !["bank", "offline", "media", "authority-archive", "sequence", "written-recall", "card-reports", "plan-actions", "answer-history"].includes(kind)) fail();
    this.pluginDirectory = resolve(pluginDirectory);
    this.directory = join(this.pluginDirectory, "companion-proofs", binding);
    this.file = join(this.directory, `${kind}.json`);
    this.pagesDirectory = join(this.directory, `${kind}.proof-pages`);
  }
  private checkDirectory(directory: string, privateDirectory = false): void {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || privateDirectory && process.platform !== "win32" && (Number(info.mode) & 0o077) !== 0) fail();
  }
  private checkParents(create: boolean): void {
    this.checkDirectory(this.pluginDirectory);
    for (const directory of [join(this.pluginDirectory, "companion-proofs"), this.directory]) {
      try { this.checkDirectory(directory, true); }
      catch (error) {
        if (!missing(error)) throw error;
        if (!create) return;
        mkdirSync(directory, { mode: 0o700 }); this.checkDirectory(directory, true);
      }
      if (create) this.syncDirectory(dirname(directory));
    }
  }
  private info(file = this.file): ReturnType<typeof lstatSync> | undefined {
    try {
      this.checkParents(false);
      if (file !== this.file) this.checkDirectory(this.pagesDirectory, true);
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1
        || info.size > (this.kind === "sequence" ? String(Number.MAX_SAFE_INTEGER).length : MAX_COMPANION_SNAPSHOT_BYTES)
        || process.platform !== "win32" && (Number(info.mode) & 0o077) !== 0) fail();
      return info;
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  private readFile(info: NonNullable<ReturnType<typeof lstatSync>>, file = this.file): string {
    const identity = version(info), descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      if (version(fstatSync(descriptor)) !== identity) fail();
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedCompanionFile(descriptor, Number(info.size))), after = this.info(file);
      if (version(fstatSync(descriptor)) !== identity || !after || version(after) !== identity) fail();
      return raw;
    } finally { closeSync(descriptor); }
  }
  private reference(value: unknown): asserts value is PageReference {
    if (!object(value) || !keys(value, ["sha256", "bytes", "rows"]) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
      || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1 || Number(value.bytes) > MAX_COMPANION_SNAPSHOT_BYTES
      || !Number.isSafeInteger(value.rows) || Number(value.rows) < 1) fail();
  }
  private decode(value: unknown): { value: unknown; pages: Map<string, string>; decodedPages: Map<string, DecodedPage> } {
    const pages = new Map<string, string>(), decodedPages = new Map<string, DecodedPage>();
    if (!object(value) || value.format !== PAGED) return { value: freeze(value), pages, decodedPages };
    if (!keys(value, ["format", "fields"]) || !Array.isArray(value.fields)) fail();
    const result: Record<string, unknown> = {}, names = new Set<string>();
    for (const field of value.fields) {
      if (!object(field) || typeof field.name !== "string" || names.has(field.name)) fail(); names.add(field.name);
      let hydrated: unknown;
      if (Object.prototype.hasOwnProperty.call(field, "value")) {
        if (!keys(field, ["name", "value"])) fail(); hydrated = field.value;
      } else {
        if (!keys(field, ["name", "length", "head"]) || !Number.isSafeInteger(field.length) || Number(field.length) < 0
          || (field.length === 0) !== (field.head === undefined)) fail();
        const batches: unknown[][] = [], seen = new Set<string>(); let count = 0, next: unknown = field.head;
        while (next !== undefined) {
          this.reference(next); if (seen.has(next.sha256)) fail(); seen.add(next.sha256);
          const file = join(this.pagesDirectory, `${next.sha256}.json`), info = this.info(file); if (!info || info.size !== next.bytes) fail();
          const raw = this.readFile(info, file); if (Buffer.byteLength(raw, "utf8") !== next.bytes || digest(raw) !== next.sha256) fail();
          const cached = this.cached?.decodedPages.get(file);
          // Verified immutable page bytes can retain their frozen row identities across a new head.
          const page: unknown = cached?.version === version(info) ? cached.value : JSON.parse(raw);
          if (!object(page) || !keys(page, ["format", "values", "previous"]) || page.format !== PAGE || !Array.isArray(page.values) || page.values.length !== next.rows) fail();
          count += page.values.length; if (count > Number(field.length)) fail();
          pages.set(file, version(info)); decodedPages.set(file, { version: version(info), value: freeze(page) as DecodedPage["value"] });
          batches.push(page.values); next = page.previous;
        }
        if (count !== field.length) fail();
        const values: unknown[] = []; for (let index = batches.length - 1; index >= 0; index--) for (const row of batches[index]) values.push(row);
        hydrated = values;
      }
      Object.defineProperty(result, field.name, { value: hydrated, enumerable: true, configurable: true, writable: true });
    }
    return { value: freeze(result), pages, decodedPages };
  }
  private shouldPage(value: unknown): value is Record<string, unknown> {
    if (this.kind === "authority-archive" || !object(value)) return false;
    let bytes = 2;
    for (const [name, field] of Object.entries(value)) {
      bytes += Buffer.byteLength(JSON.stringify(name), "utf8") + 2;
      if (Array.isArray(field)) {
        for (const row of field) { bytes += Buffer.byteLength(JSON.stringify(row) ?? "null", "utf8") + 1; if (bytes > PAGE_TARGET) return true; }
      } else { bytes += Buffer.byteLength(JSON.stringify(field) ?? "null", "utf8"); }
    }
    return bytes > PAGE_TARGET && Object.values(value).some(Array.isArray);
  }
  private syncDirectory(directory: string): void {
    if (process.platform === "win32") return;
    const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  private page(raw: string, rows: number, pages: Map<string, string>): PageReference {
    const ref: PageReference = { sha256: digest(raw), bytes: Buffer.byteLength(raw, "utf8"), rows }; this.reference(ref);
    const file = join(this.pagesDirectory, `${ref.sha256}.json`), previous = this.info(file);
    if (previous) { if (this.readFile(previous, file) !== raw) fail(); pages.set(file, version(previous)); return ref; }
    const temporary = join(this.pagesDirectory, `.${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try { writeFileSync(descriptor, raw, "utf8"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      const existing = this.info(file);
      if (existing) { if (this.readFile(existing, file) !== raw) fail(); }
      else renameSync(temporary, file);
      const committed = this.info(file); if (!committed || this.readFile(committed, file) !== raw) fail(); pages.set(file, version(committed)); return ref;
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private encode(value: T, pages: Map<string, string>): string {
    if (!this.shouldPage(value)) return JSON.stringify(value);
    try { this.checkDirectory(this.pagesDirectory, true); }
    catch (error) { if (!missing(error)) throw error; mkdirSync(this.pagesDirectory, { mode: 0o700 }); this.checkDirectory(this.pagesDirectory, true); }
    const manifest: PagedProof = { format: PAGED, fields: [] };
    for (const [name, field] of Object.entries(value)) {
      if (!Array.isArray(field)) {
        const raw = JSON.stringify(field); if (raw !== undefined) { if (Buffer.byteLength(raw, "utf8") > MAX_COMPANION_SNAPSHOT_BYTES) fail(); manifest.fields.push({ name, value: JSON.parse(raw) }); }
        continue;
      }
      let head: PageReference | undefined, size = 0, pieces: string[] = [];
      const flush = (): void => {
        if (!pieces.length) return;
        const raw = `{"format":${JSON.stringify(PAGE)},"values":[${pieces.join(",")}]${head ? `,"previous":${JSON.stringify(head)}` : ""}}`;
        head = this.page(raw, pieces.length, pages); pieces = []; size = 0;
      };
      for (const row of field) {
        const raw = JSON.stringify(row) ?? "null", bytes = Buffer.byteLength(raw, "utf8"); if (bytes + 1024 > MAX_COMPANION_SNAPSHOT_BYTES) fail();
        if (pieces.length && size + bytes + 1024 > PAGE_TARGET) flush(); pieces.push(raw); size += bytes + 1;
      }
      flush(); manifest.fields.push({ name, length: field.length, ...(head ? { head } : {}) });
    }
    this.syncDirectory(this.pagesDirectory); return JSON.stringify(manifest);
  }
  read(): unknown {
    try {
      const info = this.info();
      if (!info) { this.observed = null; this.observedDigest = null; const legacy = this.legacyRead(); return legacy === undefined ? undefined : freeze(cloneJsonValue(legacy)); }
      const identity = version(info);
      this.observed = identity;
      const verify = this.kind === "authority-archive" || info.size <= PAGE_TARGET || !!this.cached?.pages.size;
      const raw = verify || this.cached?.version !== identity ? this.readFile(info) : undefined, rawDigest = raw === undefined ? this.cached!.digest : digest(raw);
      this.observedDigest = rawDigest;
      if (this.cached?.version === identity && this.cached.digest === rawDigest && [...this.cached.pages].every(([file, expected]) => { const info = this.info(file); return !!info && version(info) === expected; })) return this.cached.value;
      if (raw === undefined) fail();
      const decoded = this.decode(JSON.parse(raw)); const after = this.info(); if (!after || version(after) !== identity) fail();
      if ((verify || decoded.pages.size) && digest(this.readFile(after)) !== rawDigest) fail();
      this.cached = { version: identity, digest: rawDigest, ...decoded }; return decoded.value;
    } catch { return fail(); }
  }
  /** Raw answers are erasable: never retain superseded private pages as an archive.
   * Called by the vault's serialized history writer, only after a durable verified root.
   * Other proof kinds deliberately retain their previous authority pages.
   */
  reclaimAnswerHistoryPages(): boolean {
    if (this.kind !== "answer-history") fail();
    this.read(); const root = this.info(); if (!root) return false;
    const expected = version(root), rootDigest = digest(this.readFile(root));
    if (!this.cached || this.cached.version !== expected || this.cached.digest !== rootDigest) fail();
    if (this.reclaimedAnswerHistoryVersion === expected) return true;
    const keep = new Set(this.cached.pages.keys());
    const current = (): void => { const info = this.info(); if (!info || version(info) !== expected || digest(this.readFile(info)) !== rootDigest) fail(); };
    const erase = (file: string): void => {
      current(); const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || Number(info.nlink) !== 1 || info.size > MAX_COMPANION_SNAPSHOT_BYTES
        || process.platform !== "win32" && (Number(info.mode) & 0o077) !== 0) fail();
      // Recheck the exact ordinary private file before removing this owned name.
      if (version(lstatSync(file)) !== version(info)) fail(); unlinkSync(file);
    };
    try {
      this.checkDirectory(this.pagesDirectory, true);
      for (const name of readdirSync(this.pagesDirectory)) {
        if (!/^(?:[a-f0-9]{64}\.json|\.[a-f0-9-]{36}\.tmp)$/.test(name)) fail();
        const file = join(this.pagesDirectory, name); if (!keep.has(file)) erase(file);
      }
      this.syncDirectory(this.pagesDirectory);
    } catch (error) { if (!missing(error)) throw error; }
    for (const name of readdirSync(this.directory)) {
      if (/^\.answer-history\.[a-f0-9-]{36}\.tmp$/.test(name)) erase(join(this.directory, name));
    }
    this.syncDirectory(this.directory); current();
    for (const [file, identity] of this.cached.pages) { const info = this.info(file); if (!info || version(info) !== identity) fail(); }
    this.reclaimedAnswerHistoryVersion = expected; return true;
  }
  write(value: T): void {
    let temporary: string | undefined, renamed = false;
    // A failed write may have created pages without changing the committed head.
    this.reclaimedAnswerHistoryVersion = undefined;
    try {
      const before = this.info(), baseline = before ? version(before) : undefined;
      if (this.observed !== undefined && this.observed !== (baseline ?? null)) fail();
      const baselineDigest = before ? digest(this.readFile(before)) : null;
      if (this.observedDigest !== undefined && this.observedDigest !== baselineDigest) fail();
      if (before && (this.cached?.version !== baseline || this.cached?.digest !== baselineDigest)) this.read();
      this.checkParents(true);
      if (this.kind === "sequence" && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) fail();
      const pages = new Map<string, string>(), raw = this.encode(value, pages); if (Buffer.byteLength(raw, "utf8") > MAX_COMPANION_SNAPSHOT_BYTES) fail();
      temporary = join(this.directory, this.kind === "answer-history" ? `.answer-history.${randomUUID()}.tmp` : `.${randomUUID()}.tmp`);
      const descriptor = openSync(temporary, "wx", 0o600);
      try { writeFileSync(descriptor, raw, "utf8"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      const current = this.info(); if ((current ? version(current) : undefined) !== baseline) fail();
      if ((current ? digest(this.readFile(current)) : null) !== baselineDigest) fail();
      for (const [file, expected] of pages) { const info = this.info(file); if (!info || version(info) !== expected) fail(); }
      renameSync(temporary, this.file); renamed = true;
      this.syncDirectory(this.directory);
      const committed = this.info(); if (!committed) fail();
      const readback = this.readFile(committed); if (readback !== raw) fail();
      const decoded = this.decode(JSON.parse(readback)), after = this.info(); if (!after || version(after) !== version(committed)) fail();
      if (digest(this.readFile(after)) !== digest(readback)) fail();
      this.cached = { version: version(committed), digest: digest(readback), ...decoded };
      this.observed = this.cached.version;
      this.observedDigest = this.cached.digest;
      if (this.kind === "answer-history") this.reclaimAnswerHistoryPages();
    } catch {
      this.cached = undefined;
      throw new Error(renamed ? "Запись доказательства Telegram требует проверки после сохранения. Повторите действие." : "Не удалось сохранить локальное доказательство Telegram. Предыдущий файл сохранён.");
    } finally { if (temporary && existsSync(temporary)) unlinkSync(temporary); }
  }
}
