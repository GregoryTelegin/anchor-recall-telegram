import { createHash } from "node:crypto";
import { jsonFingerprint } from "../../shared/json-fingerprint";
import { cloneJsonValue } from "../../shared/json-digest";
import { validateSnapshot, type CompanionSnapshot } from "../../domain/companion/protocol";
import { validateCompanionStudyContext, type CompanionStudyContext } from "../../domain/companion/study-context";

/** Resource bounds apply per page and per request, never to the whole library. */
export const CATALOG_PAGE_BYTES = 512 * 1024;
export const CATALOG_REFERENCE_BATCH = 256;
export const CATALOG_UPLOAD_BATCH = 32;
const PAGE_OVERHEAD = 1024;
export interface CatalogPageReference { sha256: string; bytes: number; count: number; }
export interface CatalogPageSource { reference: CatalogPageReference; bytes(): Buffer; }
export interface CatalogCollection { records: CatalogPageReference; order: CatalogPageReference; count: number; }
type SnapshotHeader = Omit<CompanionSnapshot, "cards" | "studyTarget"> & {
  studyTarget?: Omit<NonNullable<CompanionSnapshot["studyTarget"]>, "cardIds">;
};
export interface CatalogRoot {
  version: 1;
  snapshot: { header: SnapshotHeader; cards: CatalogCollection; targetCardIds?: CatalogPageReference };
  context?: { header: Omit<CompanionStudyContext, "cards">; cards: CatalogCollection };
  consentIds: CatalogPageReference;
  materialConsentIds?: CatalogPageReference;
  timeZone: string;
  attachmentConsent?: boolean;
  offlineConsent?: boolean;
}
export interface CatalogBuildInput {
  snapshot: CompanionSnapshot; context?: CompanionStudyContext; consentIds: readonly string[]; timeZone: string;
  materialConsentIds?: readonly string[]; attachmentConsent?: boolean; offlineConsent?: boolean;
}
export interface CatalogBuild { root: CatalogRoot; revision: string; pages: Map<string, CatalogPageSource>; }
export type CatalogBuildCheckpoint = () => void | Promise<void>;
export interface CatalogPayload {
  snapshot: CompanionSnapshot; context?: CompanionStudyContext; consentIds: string[]; timeZone: string;
  materialConsentIds?: string[]; attachmentConsent?: boolean; offlineConsent?: boolean;
}
type Page = { version: 1; kind: "records" | "list"; values: unknown[] }
  | { version: 1; kind: "index"; children: CatalogPageReference[] }
  | { version: 1; kind: "json"; value: unknown }
  | { version: 1; kind: "object"; members: { name: string; reference: CatalogPageReference }[] }
  | { version: 1; kind: "array"; parts: { reference: CatalogPageReference; spread: boolean }[] };
export interface CatalogPageReader { read(reference: CatalogPageReference): Promise<Buffer>; }
export interface CatalogPageStorage extends CatalogPageReader {
  has(reference: CatalogPageReference): Promise<boolean>;
  put(reference: CatalogPageReference, bytes: Buffer): Promise<void>;
  putBatch(pages: readonly { reference: CatalogPageReference; bytes: Buffer }[]): Promise<void>;
  flush?(): Promise<void>;
}
function fail(condition: unknown, message = "invalid catalog page"): asserts condition { if (!condition) throw new Error(message); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).every(key => fields.includes(key));
function finishSteps<T>(steps: Generator<void, T>): T {
  let step = steps.next(); while (!step.done) step = steps.next(); return step.value;
}
export const catalogPageHash = (raw: Uint8Array): string => createHash("sha256").update(raw).digest("hex");
export function catalogRootRevision(root: CatalogRoot): string { return catalogPageHash(Buffer.from(jsonFingerprint(root)!)); }
export function validateCatalogReference(value: unknown): asserts value is CatalogPageReference {
  fail(record(value) && only(value, ["sha256", "bytes", "count"]) && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0 && Number(value.bytes) <= CATALOG_PAGE_BYTES
    && Number.isSafeInteger(value.count) && Number(value.count) >= 0);
}
function countReferences(children: readonly CatalogPageReference[]): number {
  const count = children.reduce((sum, ref) => sum + ref.count, 0); fail(Number.isSafeInteger(count)); return count;
}
export function decodeCatalogPage(reference: CatalogPageReference, bytes: Buffer): Page {
  validateCatalogReference(reference);
  fail(bytes.length === reference.bytes && catalogPageHash(bytes) === reference.sha256, "catalog page checksum differs");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  fail(record(value) && value.version === 1);
  if (value.kind === "records" || value.kind === "list") {
    fail(only(value, ["version", "kind", "values"]) && Array.isArray(value.values) && value.values.length === reference.count);
  } else if (value.kind === "index") {
    fail(only(value, ["version", "kind", "children"]) && Array.isArray(value.children) && value.children.length <= CATALOG_REFERENCE_BATCH);
    value.children.forEach(validateCatalogReference); fail(countReferences(value.children as CatalogPageReference[]) === reference.count);
  } else if (value.kind === "array") {
    fail(only(value, ["version", "kind", "parts"]) && Array.isArray(value.parts) && value.parts.length <= CATALOG_REFERENCE_BATCH);
    let count = 0;
    for (const part of value.parts) {
      fail(record(part) && only(part, ["reference", "spread"]) && typeof part.spread === "boolean"); validateCatalogReference(part.reference);
      count += part.spread ? part.reference.count : 1;
    }
    fail(Number.isSafeInteger(count) && count === reference.count);
  } else if (value.kind === "json") {
    fail(only(value, ["version", "kind", "value"]) && Object.prototype.hasOwnProperty.call(value, "value") && reference.count === 1);
  } else if (value.kind === "object") {
    fail(only(value, ["version", "kind", "members"]) && Array.isArray(value.members) && value.members.length <= CATALOG_REFERENCE_BATCH && reference.count === 1);
    const names = new Set<string>();
    for (const member of value.members) {
      fail(record(member) && only(member, ["name", "reference"]) && typeof member.name === "string" && !names.has(member.name));
      names.add(member.name); validateCatalogReference(member.reference);
    }
  } else fail(false);
  return value as Page;
}
export function catalogPageChildren(page: Page): CatalogPageReference[] {
  return page.kind === "index" ? page.children : page.kind === "array" ? page.parts.map(row => row.reference) : page.kind === "object" ? page.members.map(row => row.reference) : [];
}
export function validateCatalogRoot(value: unknown): asserts value is CatalogRoot {
  fail(record(value) && only(value, ["version", "snapshot", "context", "consentIds", "materialConsentIds", "timeZone", "attachmentConsent", "offlineConsent"])
    && value.version === 1 && typeof value.timeZone === "string" && value.timeZone.length > 0 && value.timeZone.length <= 100);
  const collection = (v: unknown): void => {
    fail(record(v) && only(v, ["records", "order", "count"]) && Number.isSafeInteger(v.count) && Number(v.count) >= 0);
    validateCatalogReference(v.records); validateCatalogReference(v.order); fail(v.records.count === v.count && v.order.count === v.count);
  };
  fail(record(value.snapshot) && only(value.snapshot, ["header", "cards", "targetCardIds"]) && record(value.snapshot.header));
  fail(!("cards" in value.snapshot.header)); collection(value.snapshot.cards);
  if (value.snapshot.targetCardIds !== undefined) validateCatalogReference(value.snapshot.targetCardIds);
  if (value.context !== undefined) {
    fail(record(value.context) && only(value.context, ["header", "cards"]) && record(value.context.header) && !("cards" in value.context.header)); collection(value.context.cards);
  }
  validateCatalogReference(value.consentIds);
  if (value.materialConsentIds !== undefined) validateCatalogReference(value.materialConsentIds);
  for (const flag of [value.attachmentConsent, value.offlineConsent]) fail(flag === undefined || typeof flag === "boolean");
  fail(Buffer.byteLength(jsonFingerprint(value)!) <= CATALOG_PAGE_BYTES, "catalog root too large");
}

/** Factories retain existing records, not another complete serialized copy of the library. */
export class CatalogPageBuilder {
  readonly pages = new Map<string, CatalogPageSource>();
  private add(factory: () => Page, count: number): CatalogPageReference {
    const encode = () => Buffer.from(jsonFingerprint(factory())!);
    const bytes = encode(); fail(bytes.length <= CATALOG_PAGE_BYTES, "catalog record exceeds page limit");
    const reference = { sha256: catalogPageHash(bytes), bytes: bytes.length, count }; validateCatalogReference(reference);
    if (!this.pages.has(reference.sha256)) this.pages.set(reference.sha256, { reference, bytes: () => {
      const current = encode(); fail(current.length === reference.bytes && catalogPageHash(current) === reference.sha256, "catalog changed during transfer"); return current;
    } });
    return reference;
  }
  private tree(children: CatalogPageReference[]): CatalogPageReference {
    if (!children.length) return this.add(() => ({ version: 1, kind: "list", values: [] }), 0);
    while (children.length > CATALOG_REFERENCE_BATCH) {
      const next: CatalogPageReference[] = [];
      for (let offset = 0; offset < children.length; offset += CATALOG_REFERENCE_BATCH) {
        const group = children.slice(offset, offset + CATALOG_REFERENCE_BATCH); next.push(this.add(() => ({ version: 1, kind: "index", children: group }), countReferences(group)));
      }
      children = next;
    }
    return children.length === 1 ? children[0] : this.add(() => ({ version: 1, kind: "index", children }), countReferences(children));
  }
  list(values: readonly unknown[], kind: "list" | "records" = "list"): CatalogPageReference {
    return finishSteps(this.listSteps(values, kind));
  }
  *listSteps(values: readonly unknown[], kind: "list" | "records" = "list"): Generator<void, CatalogPageReference> {
    const pages: CatalogPageReference[] = []; let group: unknown[] = [], bytes = PAGE_OVERHEAD, visited = 0;
    const flush = () => { const records = group; pages.push(this.add(() => ({ version: 1, kind, values: records }), records.length)); group = []; bytes = PAGE_OVERHEAD; };
    for (const value of values) {
      const length = boundedJsonBytes(value, CATALOG_PAGE_BYTES - PAGE_OVERHEAD);
      fail(length !== undefined, "catalog record exceeds page limit");
      if (group.length && bytes + length + 1 > CATALOG_PAGE_BYTES) { flush(); yield; }
      group.push(value); bytes += length + 1;
      if (++visited % 256 === 0) yield;
    }
    if (group.length || !pages.length) { flush(); yield; } return this.tree(pages);
  }
  collection(values: readonly { id: string }[]): CatalogCollection {
    return finishSteps(this.collectionSteps(values));
  }
  *collectionSteps(values: readonly { id: string }[]): Generator<void, CatalogCollection> {
    const buckets = new Map<number, { id: string }[]>(), ids: string[] = [], seen = new Set<string>(); let visited = 0;
    for (const value of values) {
      fail(typeof value.id === "string" && !seen.has(value.id), "duplicate catalog record"); seen.add(value.id); ids.push(value.id);
      const bucket = createHash("sha256").update(value.id).digest()[0], rows = buckets.get(bucket) ?? []; rows.push(value); buckets.set(bucket, rows);
      if (++visited % 256 === 0) yield;
    }
    const refs: CatalogPageReference[] = [];
    for (const [, rows] of [...buckets].sort(([a], [b]) => a - b))
      refs.push(yield* this.listSteps(rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), "records"));
    const records = refs.length ? this.tree(refs) : yield* this.listSteps([], "records"), order = yield* this.listSteps(ids);
    return { records, order, count: values.length };
  }
  value(value: unknown): CatalogPageReference {
    if (boundedJsonBytes(value, CATALOG_PAGE_BYTES - PAGE_OVERHEAD) !== undefined) return this.add(() => ({ version: 1, kind: "json", value }), 1);
    if (Array.isArray(value)) {
      let parts: { reference: CatalogPageReference; spread: boolean }[] = []; let group: unknown[] = [], bytes = PAGE_OVERHEAD;
      const flush = () => { if (!group.length) return; const values = group; parts.push({ reference: this.add(() => ({ version: 1, kind: "list", values }), values.length), spread: true }); group = []; bytes = PAGE_OVERHEAD; };
      for (const item of value) {
        const length = boundedJsonBytes(item, CATALOG_PAGE_BYTES - PAGE_OVERHEAD);
        if (length === undefined) { flush(); parts.push({ reference: this.value(item), spread: false }); }
        else { if (group.length && bytes + length + 1 > CATALOG_PAGE_BYTES) flush(); group.push(item); bytes += length + 1; }
      }
      flush();
      const count = (rows: typeof parts) => rows.reduce((sum, row) => sum + (row.spread ? row.reference.count : 1), 0);
      while (parts.length > CATALOG_REFERENCE_BATCH) {
        const next: typeof parts = [];
        for (let offset = 0; offset < parts.length; offset += CATALOG_REFERENCE_BATCH) {
          const group = parts.slice(offset, offset + CATALOG_REFERENCE_BATCH);
          next.push({ reference: this.add(() => ({ version: 1, kind: "array", parts: group }), count(group)), spread: true });
        }
        parts = next;
      }
      return this.add(() => ({ version: 1, kind: "array", parts }), value.length);
    }
    fail(record(value), "JSON scalar exceeds page limit");
    const members = Object.keys(value).filter(name => value[name] !== undefined).sort().map(name => ({ name, reference: this.value(value[name]) }));
    fail(members.length <= CATALOG_REFERENCE_BATCH, "JSON object has too many fields"); return this.add(() => ({ version: 1, kind: "object", members }), 1);
  }
}

/** Stop at one page; never allocate a JSON string proportional to the whole catalog. */
function boundedJsonBytes(value: unknown, maximum: number): number | undefined {
  let bytes = 0; const ancestors = new Set<object>();
  const add = (length: number): boolean => { bytes += length; return bytes <= maximum; };
  const visit = (item: unknown): boolean => {
    if (!item || typeof item !== "object") { if (typeof item === "string" && item.length > maximum) return false; const text = JSON.stringify(item); return text !== undefined && add(Buffer.byteLength(text)); }
    if (ancestors.has(item)) throw new Error("cyclic catalog value"); ancestors.add(item);
    let ok = add(2);
    if (Array.isArray(item)) {
      for (let index = 0; ok && index < item.length; index++) ok = (!index || add(1)) && visit(item[index] === undefined ? null : item[index]);
    } else {
      let index = 0;
      for (const name of Object.keys(item)) {
        const child = (item as Record<string, unknown>)[name]; if (child === undefined) continue;
        ok = (!index++ || add(1)) && add(Buffer.byteLength(JSON.stringify(name)) + 1) && visit(child); if (!ok) break;
      }
    }
    ancestors.delete(item); return ok;
  };
  return visit(value) ? bytes : undefined;
}

function* catalogBuildSteps(input: CatalogBuildInput): Generator<void, CatalogBuild> {
  const builder = new CatalogPageBuilder(), { cards, studyTarget, ...header } = input.snapshot;
  const snapshotCards = yield* builder.collectionSteps(cards), consentIds = yield* builder.listSteps(input.consentIds);
  const root: CatalogRoot = { version: 1, snapshot: { header, cards: snapshotCards }, consentIds, timeZone: input.timeZone };
  if (studyTarget) { const { cardIds, ...target } = studyTarget; root.snapshot.header.studyTarget = target; root.snapshot.targetCardIds = yield* builder.listSteps(cardIds); }
  if (input.context) { const { cards, ...header } = input.context; root.context = { header, cards: yield* builder.collectionSteps(cards) }; }
  if (input.materialConsentIds !== undefined) root.materialConsentIds = yield* builder.listSteps(input.materialConsentIds);
  if (input.attachmentConsent !== undefined) root.attachmentConsent = input.attachmentConsent;
  if (input.offlineConsent !== undefined) root.offlineConsent = input.offlineConsent;
  validateCatalogRoot(root); return { root, revision: catalogRootRevision(root), pages: builder.pages };
}
export function buildCatalogPages(input: CatalogBuildInput): CatalogBuild {
  validateSnapshot(input.snapshot); if (input.context) validateCompanionStudyContext(input.context);
  return finishSteps(catalogBuildSteps(input));
}
/** Own every input before the first asynchronous turn; later edits cannot mix page versions. */
export async function buildCatalogPagesCooperatively(input: CatalogBuildInput, checkpoint: CatalogBuildCheckpoint): Promise<CatalogBuild> {
  validateSnapshot(input.snapshot); if (input.context) validateCompanionStudyContext(input.context);
  const owned = cloneJsonValue({ snapshot: input.snapshot, ...(input.context ? { context: input.context } : {}),
    consentIds: input.consentIds, timeZone: input.timeZone,
    ...(input.materialConsentIds !== undefined ? { materialConsentIds: input.materialConsentIds } : {}),
    ...(input.attachmentConsent !== undefined ? { attachmentConsent: input.attachmentConsent } : {}),
    ...(input.offlineConsent !== undefined ? { offlineConsent: input.offlineConsent } : {}) });
  await checkpoint();
  const steps = catalogBuildSteps(owned);
  let step = steps.next();
  while (!step.done) { const pending = checkpoint(); if (pending) await pending; step = steps.next(); }
  return step.value;
}
export function catalogRootReferences(root: CatalogRoot): CatalogPageReference[] {
  validateCatalogRoot(root);
  return [root.snapshot.cards.records, root.snapshot.cards.order, root.consentIds,
    ...(root.snapshot.targetCardIds ? [root.snapshot.targetCardIds] : []), ...(root.context ? [root.context.cards.records, root.context.cards.order] : []),
    ...(root.materialConsentIds ? [root.materialConsentIds] : [])];
}
async function page(reference: CatalogPageReference, storage: CatalogPageReader, ancestors: ReadonlySet<string>): Promise<{ page: Page; ancestors: Set<string> }> {
  fail(ancestors.size < 64 && !ancestors.has(reference.sha256), "invalid catalog page depth or cycle"); const next = new Set(ancestors); next.add(reference.sha256);
  return { page: decodeCatalogPage(reference, await storage.read(reference)), ancestors: next };
}
export async function readCatalogList(reference: CatalogPageReference, storage: CatalogPageReader, kind: "list" | "records" = "list", ancestors = new Set<string>(), seen = new Set<string>()): Promise<unknown[]> {
  fail(!seen.has(reference.sha256), "repeated catalog collection page"); seen.add(reference.sha256);
  const current = await page(reference, storage, ancestors);
  if (current.page.kind === kind) return current.page.values;
  fail(current.page.kind === "index", "catalog page kind differs"); const values: unknown[] = [];
  for (const child of current.page.children) for (const value of await readCatalogList(child, storage, kind, current.ancestors, seen)) values.push(value);
  fail(values.length === reference.count); return values;
}
async function readCollection(collection: CatalogCollection, storage: CatalogPageReader): Promise<unknown[]> {
  const records = await readCatalogList(collection.records, storage, "records"), order = await readCatalogList(collection.order, storage), byId = new Map<string, unknown>();
  for (const row of records) { fail(record(row) && typeof row.id === "string" && !byId.has(row.id)); byId.set(row.id, row); }
  const seen = new Set<string>(), result = order.map(id => { fail(typeof id === "string" && !seen.has(id) && byId.has(id)); seen.add(id); return byId.get(id)!; });
  fail(seen.size === byId.size && result.length === collection.count); return result;
}
export async function readCatalogRoot(root: CatalogRoot, storage: CatalogPageReader): Promise<CatalogPayload> {
  validateCatalogRoot(root); const snapshot = { ...root.snapshot.header, cards: await readCollection(root.snapshot.cards, storage) } as CompanionSnapshot;
  if (root.snapshot.header.studyTarget) {
    fail(root.snapshot.targetCardIds); snapshot.studyTarget = { ...root.snapshot.header.studyTarget, cardIds: await readCatalogList(root.snapshot.targetCardIds, storage) as string[] };
  } else fail(root.snapshot.targetCardIds === undefined);
  const result: CatalogPayload = { snapshot, consentIds: await readCatalogList(root.consentIds, storage) as string[], timeZone: root.timeZone };
  if (root.context) result.context = { ...root.context.header, cards: await readCollection(root.context.cards, storage) } as CompanionStudyContext;
  if (root.materialConsentIds) result.materialConsentIds = await readCatalogList(root.materialConsentIds, storage) as string[];
  if (root.attachmentConsent !== undefined) result.attachmentConsent = root.attachmentConsent;
  if (root.offlineConsent !== undefined) result.offlineConsent = root.offlineConsent;
  return result;
}
export async function readPagedJson(reference: CatalogPageReference, storage: CatalogPageReader, ancestors = new Set<string>()): Promise<unknown> {
  const current = await page(reference, storage, ancestors), value = current.page;
  if (value.kind === "json") return value.value;
  if (value.kind === "list") return value.values;
  if (value.kind === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const member of value.members) Object.defineProperty(result, member.name, { value: await readPagedJson(member.reference, storage, current.ancestors), enumerable: true, writable: true, configurable: true });
    return result;
  }
  fail(value.kind === "array", "invalid paged JSON tree"); const result: unknown[] = [];
  for (const part of value.parts) {
    const item = await readPagedJson(part.reference, storage, current.ancestors);
    if (part.spread) { fail(Array.isArray(item)); for (const row of item) result.push(row); } else result.push(item);
  }
  fail(result.length === reference.count); return result;
}
