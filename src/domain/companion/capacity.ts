/** Numeric card limits describe older wire protocols, never the paged library. */
export const LEGACY_COMPANION_SNAPSHOT_CARDS = 100;
/** Compatibility ceiling advertised to pre-paging clients only. */
export const MAX_COMPANION_SNAPSHOT_CARDS = 100_000;
export const MAX_COMPANION_SESSION_CARDS = 1000;
/** Compatibility ceiling for older saved configurations only. */
export const MAX_COMPANION_MATERIALS = 100_000;
/** A single legacy file/transfer remains bounded; paged catalogs have no total quota. */
export const MAX_COMPANION_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const MAX_COMPANION_SNAPSHOT_CHUNK_BYTES = 512 * 1024;
export const MAX_COMPANION_CATALOG_PAGE_BYTES = 512 * 1024;
/** Time from issuance during which an exported study copy can authorize new answers. */
export const COMPANION_STUDY_COPY_TTL = 30 * 86_400_000;
/** Earlier gateways accept only the original seven-day window. */
export const LEGACY_COMPANION_STUDY_COPY_TTL = 7 * 86_400_000;
