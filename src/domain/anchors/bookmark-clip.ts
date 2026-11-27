import { validateCardAttachments, type CardAttachment } from "../cards/card-attachments";

export type BookmarkClipValidation = { valid: true; attachment?: CardAttachment } | { valid: false; error: string };

/** A bookmark may keep one independent audio/video export alongside its original source. */
export function validateBookmarkExportedClip(value: unknown): BookmarkClipValidation {
  if (value === undefined) return { valid: true };
  const checked = validateCardAttachments([value]);
  if (!checked.valid) return checked;
  const attachment = checked.attachments![0];
  if (attachment.kind === "image" || attachment.clip !== undefined)
    return { valid: false, error: "Сохранённый клип закладки должен быть отдельным аудио- или видеофайлом без диапазона clip." };
  return { valid: true, attachment };
}
