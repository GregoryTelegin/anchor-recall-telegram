import { CARD_ATTACHMENT_EXTENSIONS, type CardAttachmentKind, type CardAttachmentSide } from "../cards/card-attachments";

export const MAX_COMPANION_MEDIA_BYTES = 50_000_000;
export const COMPANION_MEDIA_CHUNK_BYTES = 128 * 1024;
export const MAX_COMPANION_MEDIA_CHUNK_BYTES = 256 * 1024;
export const MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES = 1024 * 1024;
export const MAX_COMPANION_MEDIA_STATUS_ASSETS = 200;

/** Content IDs and authored display text only; no local paths or library grants. */
export interface CompanionMediaIdentity {
  id: string; kind: CardAttachmentKind; format: string; bytes: number;
}
export interface CompanionMediaAttachment extends CompanionMediaIdentity {
  side: CardAttachmentSide; caption?: string; alt?: string;
}
export interface CompanionMediaChunk {
  operation: "media-chunk"; asset: CompanionMediaIdentity; offset: number; data: string;
}
export interface CompanionMediaChunkAck { id: string; offset: number; complete: boolean; }
export type CompanionMediaUploadCapacity = { version: 1; chunkBytes: number; maxAssets: number }
  | { version: 2 | 3; chunkBytes: number; maxAssets: number; binary: true };
/** Device-local evidence tied to an issued revision; never included in a snapshot. */
export interface CompanionMediaVersion { attachmentId: string; fingerprint: string; }
export interface CompanionPreparedMediaCard { media: CompanionMediaAttachment[]; versions: CompanionMediaVersion[]; }
export interface CompanionMediaUpload {
  cardId: string; attachmentId: string; descriptor: CompanionMediaAttachment;
  version: CompanionMediaVersion; bytes: Uint8Array;
}
export interface CompanionMediaStore {
  put(chunk: CompanionMediaChunk): Promise<CompanionMediaChunkAck>;
  status?(assets: CompanionMediaIdentity[]): Promise<CompanionMediaChunkAck[]>;
  has(asset: CompanionMediaIdentity): Promise<boolean>;
  read(id: string): Promise<{ asset: CompanionMediaIdentity; bytes: Uint8Array }>;
}

function check(value: unknown): asserts value { if (!value) throw new Error("Invalid companion media"); }
function object(value: unknown): asserts value is Record<string, unknown> { check(value && typeof value === "object" && !Array.isArray(value)); }
function fields(value: Record<string, unknown>, allowed: string[]): void { check(Object.keys(value).every(key => allowed.includes(key))); }
export function isCompanionMediaId(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function validateCompanionMediaIdentity(value: unknown, attachment = false): asserts value is CompanionMediaIdentity {
  object(value); fields(value, attachment ? ["id", "kind", "format", "bytes", "side", "caption", "alt"] : ["id", "kind", "format", "bytes"]);
  check(isCompanionMediaId(value.id) && ["image", "audio", "video"].includes(String(value.kind)));
  check(typeof value.format === "string" && CARD_ATTACHMENT_EXTENSIONS[value.kind as CardAttachmentKind].includes(value.format));
  check(Number.isSafeInteger(value.bytes) && Number(value.bytes) > 0 && Number(value.bytes) <= MAX_COMPANION_MEDIA_BYTES);
}
export function validateCompanionMediaAttachment(value: unknown): asserts value is CompanionMediaAttachment {
  validateCompanionMediaIdentity(value, true);
  const v = value as unknown as Record<string, unknown>;
  check(v.side === "question" || v.side === "answer");
  check(v.caption === undefined || typeof v.caption === "string" && v.caption.length <= 500);
  check(v.alt === undefined || typeof v.alt === "string" && v.alt.length <= 300);
}
export function validateCompanionMediaChunk(value: unknown, maxChunkBytes = MAX_COMPANION_MEDIA_CHUNK_BYTES): asserts value is CompanionMediaChunk {
  object(value); fields(value, ["operation", "asset", "offset", "data"]);
  check(value.operation === "media-chunk"); validateCompanionMediaIdentity(value.asset);
  check(Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) < value.asset.bytes
    && Number(value.offset) % COMPANION_MEDIA_CHUNK_BYTES === 0);
  check(typeof value.data === "string" && value.data.length > 0 && value.data.length <= Math.ceil(maxChunkBytes / 3) * 4
    && value.data.length % 4 === 0);
  const padding = value.data.endsWith("==") ? 2 : value.data.endsWith("=") ? 1 : 0;
  check(!/[^A-Za-z0-9+/]/.test(value.data.slice(0, value.data.length - padding)));
  const bytes = value.data.length / 4 * 3 - padding;
  check(bytes > 0 && bytes <= maxChunkBytes && Number(value.offset) + bytes <= value.asset.bytes);
}
export function validateCompanionMediaUploadCapacity(value: unknown): asserts value is CompanionMediaUploadCapacity {
  object(value);
  const binary = value.version === 2 || value.version === 3;
  fields(value, binary ? ["version", "chunkBytes", "maxAssets", "binary"] : ["version", "chunkBytes", "maxAssets"]);
  check((value.version === 1 || binary && value.binary === true)
    && value.chunkBytes === (value.version === 3 ? MAX_COMPANION_BINARY_MEDIA_CHUNK_BYTES : MAX_COMPANION_MEDIA_CHUNK_BYTES)
    && Number.isSafeInteger(value.maxAssets) && Number(value.maxAssets) >= 1 && Number(value.maxAssets) <= MAX_COMPANION_MEDIA_STATUS_ASSETS);
}
export function validateCompanionMediaStatusAssets(value: unknown): asserts value is CompanionMediaIdentity[] {
  check(Array.isArray(value) && value.length <= MAX_COMPANION_MEDIA_STATUS_ASSETS);
  const ids = new Set<string>();
  for (const asset of value) { validateCompanionMediaIdentity(asset); check(!ids.has(asset.id)); ids.add(asset.id); }
}
export function validateCompanionMediaAck(value: unknown, asset: CompanionMediaIdentity): asserts value is CompanionMediaChunkAck {
  object(value); fields(value, ["id", "offset", "complete"]);
  check(value.id === asset.id && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= asset.bytes
    && typeof value.complete === "boolean" && (value.complete ? value.offset === asset.bytes : Number(value.offset) < asset.bytes));
}
