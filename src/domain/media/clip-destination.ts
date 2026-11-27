export const DEFAULT_MEDIA_CLIP_FOLDER = "Anchor Recall/Clips";
export const MAX_MEDIA_CLIP_FOLDER_LENGTH = 900;
export type MediaClipFolderValidation = { valid: true; folder: string } | { valid: false; error: string };

const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)$/i;
const safeShape = (folder: string): boolean => !/[\\:?#"<>|*\u0000-\u001f\u007f]/u.test(folder)
  && folder.split("/").every(segment => segment.length > 0 && segment.length <= 255 && segment === segment.trim()
    && !segment.startsWith(".") && !segment.endsWith(".") && !reserved.test(segment.split(".")[0].trimEnd()));

/** A folder is stored exactly as entered; no URL decoding, normalization or repair. */
export function validateMediaClipFolder(value: unknown): MediaClipFolderValidation {
  const fail = (): MediaClipFolderValidation => ({ valid: false,
    error: "Выберите обычную папку внутри хранилища: путь через /, без URL, .., скрытых служебных папок и зарезервированных имён. Пустой путь означает корень хранилища." });
  if (typeof value !== "string" || value.length > MAX_MEDIA_CLIP_FOLDER_LENGTH) return fail();
  if (value === "") return { valid: true, folder: "" };
  if (!safeShape(value)) return fail();
  let decoded = value;
  for (let pass = 0; pass < 4; pass++) {
    const next = decoded.replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) return { valid: true, folder: value };
    if (!safeShape(next) || next.split("/").length !== value.split("/").length) return fail();
    decoded = next;
  }
  return /%[\da-f]{2}/i.test(decoded) ? fail() : { valid: true, folder: value };
}
