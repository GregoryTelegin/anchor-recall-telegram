/** Private authority history stays on this device; a missing row is distinct from a failed read. */
export type CompanionArchiveKind = "core-offer" | "offline-root" | "offline-attempt" | "bank-grant" | "core-receipt" | "core-answered" | "bank-proof" | "offline-rejected" | "core-grade-proof" | "server-result" | "server-replay";
export interface CompanionArchiveRow { key: string; value: unknown; }
export interface CompanionAuthorityArchive {
  get(kind: CompanionArchiveKind, key: string): unknown;
  getMany(kind: CompanionArchiveKind, keys: readonly string[]): Map<string, unknown>;
  putMany(kind: CompanionArchiveKind, rows: readonly CompanionArchiveRow[], current: () => void): void;
}
export const companionArchiveKey = (...parts: string[]): string => JSON.stringify(parts);
