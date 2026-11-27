import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { invalid, keys, record, MAX_COMPANION_SNAPSHOT_BYTES } from "../../../domain/companion/protocol";
import type { ServerState } from "./server-state";
import { validateImmutableSnapshot, validateImmutableStudyContext } from "./immutable-content";
import { CatalogPageBuilder, buildCatalogPages, readCatalogRoot, readCatalogList, readPagedJson, validateCatalogReference, validateCatalogRoot,
  type CatalogPageReference, type CatalogRoot } from "../catalog-pages";
import { DesktopCatalogPageStorage, verifiedCatalogPublication } from "./catalog-page-storage";
import { mutableServerState } from "./immutable-content";
import { jsonFingerprintEqual } from "../../../shared/json-digest";

export const JOURNAL_FORMAT = "anchor-recall-journal-v2";
export const PAGED_JOURNAL_FORMAT = "anchor-recall-journal-v3";
interface Reference { sha256: string; bytes: number }
interface PagedJournal { format: typeof PAGED_JOURNAL_FORMAT; state: CatalogPageReference; catalog?: CatalogRoot }
const digest = (raw: Uint8Array): string => createHash("sha256").update(raw).digest("hex");
const privateMetadata = (info: Stats): void => {
  invalid(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o077) === 0, "private catalog required");
};
function reference(value: unknown): asserts value is Reference {
  record(value); keys(value, ["sha256", "bytes"]);
  invalid(typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    && Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0 && Number(value.bytes) <= MAX_COMPANION_SNAPSHOT_BYTES, "invalid catalog reference");
}

/** Catalogs are committed before their small journal pointer; old revisions remain recoverable. */
export class JournalContent {
  private readonly directory: string;
  readonly pages: DesktopCatalogPageStorage;
  private cachedCatalog?: { snapshot: object; context?: object; root: CatalogRoot; references: readonly CatalogPageReference[] };
  private cachedPublication?: { revision: string; references: CatalogPageReference[] };
  constructor(journalPath: string) { this.directory = `${journalPath}.blobs`; this.pages = new DesktopCatalogPageStorage(journalPath); }
  private async checkDirectory(): Promise<void> {
    const info = await lstat(this.directory);
    invalid(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, "private catalog directory required");
  }
  private path(ref: Reference): string { reference(ref); return join(this.directory, `${ref.sha256}.json`); }
  private async read(ref: Reference): Promise<unknown> {
    await this.checkDirectory(); const path = this.path(ref); privateMetadata(await lstat(path));
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let raw: Buffer;
    try {
      const before = await file.stat(); privateMetadata(before); invalid(before.size === ref.bytes);
      const buffer = Buffer.allocUnsafe(ref.bytes + 1); let offset = 0;
      while (offset < buffer.length) { const result = await file.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
      raw = buffer.subarray(0, offset); const after = await file.stat(); privateMetadata(after);
      invalid(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs
        && raw.byteLength === ref.bytes && digest(raw) === ref.sha256, "catalog integrity mismatch");
    } finally { await file.close(); }
    return JSON.parse(raw.toString("utf8"));
  }
  private async publicationFence(state: ServerState, root: CatalogRoot): Promise<void> {
    if (!state.catalogRoot) { this.cachedPublication = undefined; return; }
    validateCatalogRoot(state.catalogRoot);
    invalid(typeof state.catalogRevision === "string", "catalog publication revision missing");
    invalid(jsonFingerprintEqual(state.catalogRoot.snapshot, root.snapshot) && jsonFingerprintEqual(state.catalogRoot.context, root.context), "catalog publication pointer differs");
    if (!this.cachedPublication || this.cachedPublication.revision !== state.catalogRevision) {
      const captured = await this.pages.capture(async () => {
        await readCatalogList(state.catalogRoot!.consentIds, this.pages);
        if (state.catalogRoot!.materialConsentIds) await readCatalogList(state.catalogRoot!.materialConsentIds, this.pages);
      });
      this.cachedPublication = { revision: state.catalogRevision!, references: captured.references };
    }
    await this.pages.assertUnchanged(this.cachedPublication.references);
  }
  async encode(state: ServerState): Promise<PagedJournal> {
    const builder = new CatalogPageBuilder(), stored: PagedJournal = { format: PAGED_JOURNAL_FORMAT, state: builder.value(mutableServerState(state)) };
    for (const source of builder.pages.values()) await this.pages.put(source.reference, source.bytes());
    if (state.domain.snapshot) {
      validateImmutableSnapshot(state.domain.snapshot); if (state.studyContext) validateImmutableStudyContext(state.studyContext);
      let root = this.cachedCatalog?.snapshot === state.domain.snapshot && this.cachedCatalog.context === state.studyContext ? this.cachedCatalog.root : undefined;
      if (!root) {
        const received = verifiedCatalogPublication(this.pages, state.domain.snapshot, state.studyContext, state.catalogRoot);
        if (received) {
          root = received.root;
          this.cachedCatalog = { snapshot: state.domain.snapshot, context: state.studyContext, root, references: received.references };
        } else {
          const build = buildCatalogPages({ snapshot: state.domain.snapshot, context: state.studyContext, consentIds: [], timeZone: "UTC" });
          for (const source of build.pages.values()) await this.pages.put(source.reference, source.bytes()); root = build.root;
          this.cachedCatalog = { snapshot: state.domain.snapshot, context: state.studyContext, root, references: [...build.pages.values()].map(source => source.reference) };
        }
      }
      await this.pages.assertUnchanged(this.cachedCatalog!.references); await this.publicationFence(state, root);
      stored.catalog = root;
    }
    await this.pages.flush();
    return stored;
  }
  async decode(value: unknown): Promise<ServerState> {
    record(value);
    if (value.format === PAGED_JOURNAL_FORMAT) {
      keys(value, ["format", "state", "catalog"]); validateCatalogReference(value.state);
      const state = await readPagedJson(value.state, this.pages); record(state); record(state.domain);
      invalid(state.domain.snapshot === undefined && state.studyContext === undefined, "ambiguous catalog journal");
      if (value.catalog !== undefined) {
        validateCatalogRoot(value.catalog); const captured = await this.pages.capture(() => readCatalogRoot(value.catalog as CatalogRoot, this.pages)), content = captured.value;
        validateImmutableSnapshot(content.snapshot); state.domain.snapshot = content.snapshot;
        if (content.context) { validateImmutableStudyContext(content.context); state.studyContext = content.context; }
        this.cachedCatalog = { snapshot: content.snapshot, context: content.context, root: value.catalog, references: captured.references };
        await this.publicationFence(state as unknown as ServerState, value.catalog);
      }
      return state as unknown as ServerState;
    }
    if (value.format !== JOURNAL_FORMAT) return value as unknown as ServerState;
    keys(value, ["format", "state", "snapshot", "studyContext"]); record(value.state); record(value.state.domain);
    invalid(value.state.domain.snapshot === undefined && value.state.studyContext === undefined, "ambiguous catalog journal");
    const state = value.state as unknown as ServerState;
    if (value.snapshot !== undefined) {
      reference(value.snapshot); const snapshot = await this.read(value.snapshot); validateImmutableSnapshot(snapshot);
      state.domain.snapshot = snapshot;
    }
    if (value.studyContext !== undefined) {
      reference(value.studyContext); const context = await this.read(value.studyContext); validateImmutableStudyContext(context);
      state.studyContext = context;
    }
    return state;
  }
}
