import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CATALOG_PAGE_BYTES, CATALOG_REFERENCE_BATCH, CATALOG_UPLOAD_BATCH, catalogRootRevision, decodeCatalogPage, readCatalogRoot, validateCatalogReference,
  validateCatalogRoot, type CatalogPageReference, type CatalogPageStorage, type CatalogPayload, type CatalogRoot } from "../catalog-pages";
import { invalid, keys, record, token } from "../../../domain/companion/protocol";
import type { CompanionSnapshot } from "../../../domain/companion/protocol";
import type { CompanionStudyContext } from "../../../domain/companion/study-context";
import { cloneJsonValue, jsonFingerprintEqual } from "../../../shared/json-digest";
import { validateImmutableSnapshot, validateImmutableStudyContext } from "./immutable-content";

interface VerifiedPublication { storage: CatalogPageStorage; root: CatalogRoot; context?: CompanionStudyContext; references: readonly CatalogPageReference[] }
const publications = new WeakMap<CompanionSnapshot, Readonly<VerifiedPublication>>();
/** Only the exact privately decoded, validated objects can reuse their already verified page graph. */
export function verifiedCatalogPublication(storage: CatalogPageStorage, snapshot: CompanionSnapshot, context: CompanionStudyContext | undefined,
  root: CatalogRoot | undefined): Readonly<VerifiedPublication> | undefined {
  const value = publications.get(snapshot);
  return value?.storage === storage && value.context === context && root && jsonFingerprintEqual(value.root, root) ? value : undefined;
}
function freezeRoot(value: unknown): void {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeRoot(child); Object.freeze(value); }
}

function privateFile(info: Stats | BigIntStats): void {
  invalid(info.isFile() && !info.isSymbolicLink() && Number(info.nlink) === 1 && (process.platform === "win32" || (Number(info.mode) & 0o077) === 0), "private catalog page required");
}
const identity = (info: Stats | BigIntStats): string => [info.dev, info.ino, info.size, info.mode, info.nlink,
  "mtimeNs" in info ? info.mtimeNs : info.mtimeMs, "ctimeNs" in info ? info.ctimeNs : info.ctimeMs].map(String).join(":");
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); }
}
/** Immutable bounded pages are durable before any journal/root pointer can expose them. */
export class DesktopCatalogPageStorage implements CatalogPageStorage {
  readonly directory: string;
  private directoryIdentity?: string;
  private pendingDirectorySync = true;
  private readonly verified = new Map<string, { reference: CatalogPageReference; identity: string }>();
  private readonly identities = new WeakMap<CatalogPageReference, string>();
  private readonly captures = new Set<Map<string, CatalogPageReference>>();
  constructor(journalPath: string) { this.directory = `${journalPath}.pages`; }
  private async directoryReady(create: boolean): Promise<void> {
    let created = false;
    if (create) await mkdir(this.directory, { mode: 0o700 }).then(() => { created = true; }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(this.directory, { bigint: true });
    invalid(info.isDirectory() && !info.isSymbolicLink() && (process.platform === "win32" || (Number(info.mode) & 0o077) === 0), "private catalog directory required");
    const current = [info.dev, info.ino].map(String).join(":");
    if (create && (created || this.directoryIdentity !== current)) {
      this.pendingDirectorySync = true; await syncDirectory(dirname(this.directory)); this.directoryIdentity = current;
    }
  }
  private path(reference: CatalogPageReference): string { validateCatalogReference(reference); return join(this.directory, reference.sha256 + ".json"); }
  async read(reference: CatalogPageReference): Promise<Buffer> {
    await this.directoryReady(false); const path = this.path(reference), named = await lstat(path, { bigint: true }); privateFile(named);
    invalid(Number(named.size) === reference.bytes, "catalog page size differs");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const before = await file.stat({ bigint: true }); privateFile(before); invalid(identity(before) === identity(named));
      const buffer = Buffer.allocUnsafe(reference.bytes + 1); let offset = 0;
      while (offset < buffer.length) { const result = await file.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
      const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true }); privateFile(after); privateFile(current);
      invalid(identity(before) === identity(after) && identity(after) === identity(current) && offset === reference.bytes, "catalog page changed while reading");
      bytes = buffer.subarray(0, offset); decodeCatalogPage(reference, bytes); this.remember(reference, after);
    } finally { await file.close(); }
    return bytes;
  }
  private remember(reference: CatalogPageReference, info: Stats | BigIntStats): void {
    const copy = { ...reference }, current = identity(info); this.identities.set(reference, current); this.identities.set(copy, current);
    this.verified.delete(reference.sha256); this.verified.set(reference.sha256, { reference: copy, identity: current });
    // A performance cache only: live root-reference fences remain in the weak identity map after eviction.
    if (this.verified.size > 4096) this.verified.delete(this.verified.keys().next().value!);
    for (const capture of this.captures) capture.set(reference.sha256, copy);
  }
  async capture<T>(operation: () => Promise<T>): Promise<{ value: T; references: CatalogPageReference[] }> {
    const references = new Map<string, CatalogPageReference>(); this.captures.add(references);
    try { return { value: await operation(), references: [...references.values()] }; } finally { this.captures.delete(references); }
  }
  async assertUnchanged(references: readonly CatalogPageReference[]): Promise<void> {
    await this.directoryReady(false);
    for (const reference of references) {
      const prior = this.verified.get(reference.sha256), expected = this.identities.get(reference) ?? (prior?.reference.bytes === reference.bytes && prior.reference.count === reference.count ? prior.identity : undefined);
      const current = await lstat(this.path(reference), { bigint: true }); privateFile(current);
      invalid(expected && expected === identity(current), "catalog page changed before publication");
      for (const capture of this.captures) { const copy = { ...reference }; this.identities.set(copy, expected); capture.set(reference.sha256, copy); }
    }
  }
  async flush(): Promise<void> {
    await this.directoryReady(true);
    if (this.pendingDirectorySync) { await syncDirectory(this.directory); this.pendingDirectorySync = false; }
  }
  async has(reference: CatalogPageReference): Promise<boolean> {
    try { await this.read(reference); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async put(reference: CatalogPageReference, bytes: Buffer): Promise<void> {
    await this.putBatch([{ reference, bytes }]);
  }
  async putBatch(pages: readonly { reference: CatalogPageReference; bytes: Buffer }[]): Promise<void> {
    for (const { reference, bytes } of pages) await this.writePage(reference, bytes);
    // Each file is synced before rename. A successful batch needs one durable directory sync.
    await this.flush();
  }
  private async writePage(reference: CatalogPageReference, bytes: Buffer): Promise<void> {
    decodeCatalogPage(reference, bytes); await this.directoryReady(true); const destination = this.path(reference);
    if (this.verified.has(reference.sha256)) { await this.assertUnchanged([reference]); return; }
    try { await lstat(destination); await this.read(reference); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      // An existing immutable page is verified, never replaced, when another owner publishes first.
      try { await lstat(destination); await this.read(reference); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.pendingDirectorySync = true; await rename(temporary, destination); }
      await this.read(reference);
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
}

function decodeUploadPage(value: Record<string, unknown>, reference: CatalogPageReference): Buffer {
  invalid(value.encoding === undefined || value.encoding === "gzip");
  invalid(typeof value.data === "string" && value.data.length > 0 && value.data.length <= Math.ceil(CATALOG_PAGE_BYTES / 3) * 4);
  let bytes = Buffer.from(value.data, "base64"); invalid(bytes.toString("base64") === value.data && bytes.length <= CATALOG_PAGE_BYTES);
  if (value.encoding === "gzip") bytes = gunzipSync(bytes, { maxOutputLength: reference.bytes });
  invalid(bytes.length === reference.bytes && createHash("sha256").update(bytes).digest("hex") === reference.sha256);
  return bytes;
}

interface Upload { id: string; root: CatalogRoot; revision: string; baseRevision: string | null; startedAt: number; touchedAt: number; }
export interface CatalogCommit { payload: CatalogPayload; root: CatalogRoot; revision: string; baseRevision: string | null; startedAt: number; }
const idleTtl = 5 * 60_000, maxLifetime = 90 * 60_000;
/** Uploads stage immutable pages only; publication belongs to the canonical runtime transaction. */
export class CatalogPageTransfer {
  private upload?: Upload;
  constructor(private readonly storage: CatalogPageStorage) {}
  async accept(value: Record<string, unknown>, now: number, activeRevision: string | null, activeSequence?: number): Promise<{ response: unknown } | CatalogCommit> {
    if (this.upload && (now - this.upload.touchedAt >= idleTtl || now - this.upload.startedAt >= maxLifetime)) this.upload = undefined;
    if (value.operation === "catalog-pages-begin") {
      keys(value, ["operation", "root", "baseRevision"]); validateCatalogRoot(value.root);
      invalid(value.baseRevision === null || typeof value.baseRevision === "string" && /^[a-f0-9]{64}$/.test(value.baseRevision));
      const revision = catalogRootRevision(value.root);
      invalid(value.baseRevision === activeRevision || revision === activeRevision, "catalog base changed; start a new transfer");
      if (!this.upload || this.upload.revision !== revision || this.upload.baseRevision !== activeRevision)
        this.upload = { id: randomUUID(), root: cloneJsonValue(value.root), revision, baseRevision: activeRevision, startedAt: now, touchedAt: now };
      this.upload.touchedAt = now; return { response: { id: this.upload.id, revision } };
    }
    if (value.operation === "catalog-pages-commit") {
      keys(value, ["operation", "id", "revision"]); token(value.id);
      invalid(typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision));
      if (value.revision === activeRevision) {
        invalid(Number.isSafeInteger(activeSequence) && Number(activeSequence) > 0); return { response: { sequence: activeSequence, revision: activeRevision } };
      }
    }
    token(value.id); const upload = this.upload;
    invalid(upload && upload.id === value.id, "catalog upload expired; start a new transfer");
    invalid(activeRevision === upload.baseRevision, "catalog base changed; start a new transfer"); upload.touchedAt = now;
    if (value.operation === "catalog-pages-missing") {
      keys(value, ["operation", "id", "references"]);
      invalid(Array.isArray(value.references) && value.references.length <= CATALOG_REFERENCE_BATCH);
      const missing: string[] = [], seen = new Set<string>();
      for (const reference of value.references) {
        validateCatalogReference(reference); invalid(!seen.has(reference.sha256), "duplicate catalog reference"); seen.add(reference.sha256);
        if (!await this.storage.has(reference)) missing.push(reference.sha256);
      }
      return { response: { missing } };
    }
    if (value.operation === "catalog-pages-put") {
      keys(value, ["operation", "id", "reference", "data", "encoding"]); validateCatalogReference(value.reference);
      await this.storage.put(value.reference, decodeUploadPage(value, value.reference));
      return { response: { sha256: value.reference.sha256 } };
    }
    if (value.operation === "catalog-pages-put-batch") {
      keys(value, ["operation", "id", "pages"]);
      invalid(Array.isArray(value.pages) && value.pages.length > 0 && value.pages.length <= CATALOG_UPLOAD_BATCH);
      const hashes = new Set<string>(); let totalBytes = 0;
      const pages = value.pages.map(page => {
        record(page); keys(page, ["reference", "data", "encoding"]); validateCatalogReference(page.reference);
        totalBytes += page.reference.bytes;
        invalid(totalBytes <= CATALOG_PAGE_BYTES && !hashes.has(page.reference.sha256), "invalid catalog page batch");
        hashes.add(page.reference.sha256);
        const bytes = decodeUploadPage(page, page.reference);
        decodeCatalogPage(page.reference, bytes);
        return { reference: page.reference, bytes };
      });
      await this.storage.putBatch(pages);
      return { response: { hashes: [...hashes] } };
    }
    invalid(value.operation === "catalog-pages-commit" && value.revision === upload.revision);
    const references = new Map<string, CatalogPageReference>();
    const payload = await readCatalogRoot(upload.root, { read: async reference => {
      const bytes = await this.storage.read(reference); references.set(reference.sha256, reference); return bytes;
    } });
    validateImmutableSnapshot(payload.snapshot); if (payload.context) validateImmutableStudyContext(payload.context);
    await this.storage.flush?.();
    freezeRoot(upload.root);
    publications.set(payload.snapshot, Object.freeze({ storage: this.storage, root: upload.root, context: payload.context,
      references: Object.freeze([...references.values()].map(reference => Object.freeze(reference))) }));
    return { payload, root: upload.root, revision: upload.revision, baseRevision: upload.baseRevision, startedAt: upload.startedAt };
  }
}
