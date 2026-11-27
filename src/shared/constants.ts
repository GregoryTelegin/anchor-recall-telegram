import { CURRENT_DATA_SCHEMA_VERSION } from "../domain/data/data-schema-core";


export const VIEW_TYPE = "anchor-recall-manager";

export const ANCHOR_PREFIX = "anchor-recall-anchor:";

export const PLUGIN_DISPLAY_NAME = "Anchor Recall";

export const TITLE_LIMIT = 80;

export const TAG_LIMIT = 30;

export const MAX_REMINDER_TAGS = 8;

export const MINUTE = 60_000;

export const MAX_REMINDERS_PER_NOTIFICATION_BATCH = 5;

export const MAX_INTERVAL_STEPS = 20;

export const MAX_RELATED_MATERIALS = 20;

export const MIN_UI_ICON_SCALE = 80;

export const MAX_UI_ICON_SCALE = 145;

export const DEFAULT_UI_ICON_SCALE = 100;

export const MIN_UI_FONT_SCALE = 85;

export const MAX_UI_FONT_SCALE = 125;

export const DEFAULT_UI_FONT_SCALE = 100;

export const DATA_SCHEMA_VERSION = CURRENT_DATA_SCHEMA_VERSION;

export const MANAGER_PROTOCOL_ACTION = "anchor-recall";

export const GOOGLE_CALENDAR_AUTH_FILE = "integration-google-calendar.json";

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "avif"]);

export const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "ogg", "flac", "opus", "aac", "weba"]);

export const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv", "mkv"]);

export const MEDIA_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

export const WINDOWS_NOTIFICATION_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#6f52c8"/><path d="M20 42h24l-3-5V28a9 9 0 0 0-18 0v9l-3 5Zm8 5a4 4 0 0 0 8 0" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;
