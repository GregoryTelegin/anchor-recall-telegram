/** Portable identifier only. Absolute directory permissions are device-local. */
export function isMediaLibraryId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
}

export interface MediaStorageDestination { folder: string; libraryId?: string; }
