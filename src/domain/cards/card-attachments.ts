import { validateMediaRange, type MediaRange } from "../media/media-range";
import { isMediaLibraryId } from "../media/media-library";

export type CardAttachmentKind = "image" | "audio" | "video";
export type CardAttachmentSide = "question" | "answer";

/** References only. An optional libraryId resolves through a device-local user grant. */
export interface CardAttachment {
  id: string;
  kind: CardAttachmentKind;
  path: string;
  libraryId?: string;
  side: CardAttachmentSide;
  caption?: string;
  alt?: string;
  clip?: MediaRange;
  provenance?: MediaRange & { path: string; libraryId?: string };
}

export const MAX_CARD_ATTACHMENTS = 12;
export const MAX_CARD_ATTACHMENT_ID = 80;
export const MAX_CARD_ATTACHMENT_PATH = 1024;
export const MAX_CARD_ATTACHMENT_CAPTION = 500;
export const MAX_CARD_ATTACHMENT_ALT = 300;

export const CARD_ATTACHMENT_EXTENSIONS: Readonly<Record<CardAttachmentKind, readonly string[]>> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"],
  audio: ["mp3", "wav", "ogg", "oga", "m4a", "flac", "opus", "webm"],
  video: ["mp4", "webm", "ogv", "mov", "m4v", "mkv"]
};

const safePathShape = (path: string): boolean => Boolean(path) && path === path.trim()
  && !/[\\:?#\u0000-\u001f\u007f]/u.test(path)
  && path.split("/").every(segment => Boolean(segment) && segment !== "." && segment !== "..");

/** Paths are relative to the vault or a connected library, never absolute paths or URLs. */
export function isSafeCardAttachmentPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_CARD_ATTACHMENT_PATH || !safePathShape(value)) return false;
  // Reject URL-encoded path syntax too: downstream renderers must not turn an encoded
  // traversal/scheme into a different resource. Ordinary percent characters remain legal.
  let decoded = value;
  for (let pass = 0; pass < 4; pass++) {
    const next = decoded.replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) return true;
    if (!safePathShape(next) || next.split("/").length !== value.split("/").length) return false;
    decoded = next;
  }
  return !/%[\da-f]{2}/i.test(decoded);
}

export function getCardAttachmentKinds(path: string): CardAttachmentKind[] {
  if (!isSafeCardAttachmentPath(path)) return [];
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/")) return [];
  const extension = path.slice(dot + 1).toLowerCase();
  return (Object.keys(CARD_ATTACHMENT_EXTENSIONS) as CardAttachmentKind[])
    .filter(kind => CARD_ATTACHMENT_EXTENSIONS[kind].includes(extension));
}

export type CardAttachmentValidation =
  | { valid: true; attachments: CardAttachment[] | undefined }
  | { valid: false; error: string };

/** No truncation, generated IDs, repaired paths or silently dropped records. */
export function validateCardAttachments(value: unknown): CardAttachmentValidation {
  if (value === undefined) return { valid: true, attachments: undefined };
  if (!Array.isArray(value) || value.length > MAX_CARD_ATTACHMENTS)
    return { valid: false, error: `Вложения: нужен массив не более ${MAX_CARD_ATTACHMENTS} файлов.` };
  const attachments: CardAttachment[] = [], ids = new Set<string>();
  const fields = new Set(["id", "kind", "path", "libraryId", "side", "caption", "alt", "clip", "provenance"]);
  for (let index = 0; index < value.length; index++) {
    const raw: unknown = value[index];
    const fail = (message: string): CardAttachmentValidation => ({ valid: false, error: `Вложение ${index + 1}: ${message}` });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("неверная структура.");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !fields.has(key))) return fail("неподдерживаемые поля.");
    if (typeof item.id !== "string" || !item.id.trim() || item.id.length > MAX_CARD_ATTACHMENT_ID || /[\u0000-\u001f\u007f]/u.test(item.id))
      return fail(`нужен непустой id не более ${MAX_CARD_ATTACHMENT_ID} символов.`);
    if (ids.has(item.id)) return fail("id повторяется в этой карточке.");
    if (item.kind !== "image" && item.kind !== "audio" && item.kind !== "video") return fail("неизвестный вид файла.");
    if (item.side !== "question" && item.side !== "answer") return fail("укажите сторону question или answer.");
    if (item.libraryId !== undefined && !isMediaLibraryId(item.libraryId)) return fail("неверный идентификатор медиапапки.");
    if (!isSafeCardAttachmentPath(item.path)) return fail("нужен относительный путь внутри хранилища или медиапапки без URL, .., \\, ? или #.");
    if (!getCardAttachmentKinds(item.path).includes(item.kind)) return fail("расширение файла не соответствует виду вложения.");
    let clip: MediaRange | undefined, provenance: CardAttachment["provenance"];
    if (item.clip !== undefined || item.provenance !== undefined) {
      if (item.kind === "image") return fail("временные фрагменты доступны только для аудио и видео.");
      if (item.clip !== undefined) {
        const checked = validateMediaRange(item.clip); if (!checked.valid) return fail(checked.error);
        clip = checked.range;
      }
      if (item.provenance !== undefined) {
        if (!item.provenance || typeof item.provenance !== "object" || Array.isArray(item.provenance)) return fail("неверная структура provenance.");
        const source = item.provenance as Record<string, unknown>;
        if (Object.keys(source).some(key => !["path", "libraryId", "start", "end"].includes(key))) return fail("provenance поддерживает только path, libraryId, start и end.");
        if (source.libraryId !== undefined && !isMediaLibraryId(source.libraryId)) return fail("неверный идентификатор медиапапки источника.");
        if (!isSafeCardAttachmentPath(source.path) || !getCardAttachmentKinds(source.path).some(kind => kind === "audio" || kind === "video"))
          return fail("provenance.path должен указывать на локальное аудио или видео.");
        const checked = validateMediaRange({ start: source.start, end: source.end }); if (!checked.valid) return fail(checked.error);
        provenance = { path: source.path, ...(source.libraryId ? { libraryId: source.libraryId } : {}), ...checked.range };
      }
    }
    for (const [field, limit] of [["caption", MAX_CARD_ATTACHMENT_CAPTION], ["alt", MAX_CARD_ATTACHMENT_ALT]] as const) {
      if (item[field] !== undefined && (typeof item[field] !== "string" || item[field].length > limit))
        return fail(`поле ${field}: нужна строка не более ${limit} символов.`);
    }
    ids.add(item.id);
    attachments.push({ id: item.id, kind: item.kind, path: item.path, side: item.side,
      ...(item.libraryId ? { libraryId: item.libraryId as string } : {}),
      ...(item.caption !== undefined ? { caption: item.caption as string } : {}),
      ...(item.alt !== undefined ? { alt: item.alt as string } : {}),
      ...(clip ? { clip } : {}), ...(provenance ? { provenance } : {}) });
  }
  return { valid: true, attachments };
}

export function cloneCardAttachments(value: readonly CardAttachment[] | undefined): CardAttachment[] | undefined {
  return value?.map(item => ({ ...item, ...(item.clip ? { clip: { ...item.clip } } : {}),
    ...(item.provenance ? { provenance: { ...item.provenance } } : {}) }));
}

/** Undefined means unchanged. An unsupported rename leaves a repairable missing link. */
export function renameCardAttachmentPaths(
  attachments: readonly CardAttachment[] | undefined, oldPath: string, newPath: string
): CardAttachment[] | undefined {
  if (!attachments?.length || oldPath === newPath || !isSafeCardAttachmentPath(oldPath) || !isSafeCardAttachmentPath(newPath)) return undefined;
  let changed = false;
  const mapPath = (path: string): string | undefined => path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : undefined;
  const renamed = attachments.map(item => {
    const path = !item.libraryId && mapPath(item.path), sourcePath = item.provenance && !item.provenance.libraryId && mapPath(item.provenance.path);
    const renameFile = path && getCardAttachmentKinds(path).includes(item.kind);
    const renameSource = sourcePath && getCardAttachmentKinds(sourcePath).some(kind => kind === "audio" || kind === "video");
    if (!renameFile && !renameSource) return item;
    changed = true; return { ...item, ...(renameFile ? { path } : {}),
      ...(renameSource ? { provenance: { ...item.provenance!, path: sourcePath! } } : {}) };
  });
  return changed ? renamed : undefined;
}
