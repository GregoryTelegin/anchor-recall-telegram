import { sha256TextChunks } from "../../shared/sha256";
import { jsonFingerprint } from "../../shared/json-fingerprint";
import type { PackageQuestionRef } from "../library/learning-library-core";
import { validateTopicCard } from "../library/topic-card-validation";

const PREFIX = "sha256:";
const HASH = /^sha256:[a-f0-9]{64}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

export const isCompactSourceFingerprint = (value: unknown): boolean => typeof value === "string" && HASH.test(value);
export const isValidSourceCardId = (value: unknown): value is string => typeof value === "string" && SOURCE_ID.test(value);
export const isValidSourceRuleIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 10_000
  && new Set(value).size === value.length && Array.from({ length: value.length }, (_, index) => Object.prototype.hasOwnProperty.call(value, index)
    && typeof value[index] === "string" && value[index].trim() === value[index] && Boolean(value[index]) && value[index].length <= 1024).every(Boolean);

/** Synchronous SHA-256 keeps the read-only planners usable in the browser host. */
export function compactSourceFingerprint(fingerprint: string): string {
  return isCompactSourceFingerprint(fingerprint) ? fingerprint : PREFIX + sha256TextChunks([fingerprint]);
}

export function importSourceFingerprint(value: unknown): string {
  const canonical = jsonFingerprint(value);
  if (canonical === undefined) throw new Error("Не удалось проверить содержимое исходной карточки.");
  return compactSourceFingerprint(canonical);
}

/** Old snapshots remain readable while all newly accepted receipts are hashes. */
export function sourceFingerprintMatches(stored: string, value: unknown): boolean {
  try {
    if (isCompactSourceFingerprint(stored)) return stored === importSourceFingerprint(value);
    if (stored.startsWith(PREFIX)) return false;
    return jsonFingerprint(JSON.parse(stored)) === jsonFingerprint(value);
  } catch { return false; }
}

function legacyTest(value: string): string | undefined {
  if (isCompactSourceFingerprint(value)) return value;
  try { return importSourceFingerprint(validateTopicCard(JSON.parse(value), "Исходная карточка")); } catch { return undefined; }
}

function legacyAuthoring(value: string): string | undefined {
  if (isCompactSourceFingerprint(value)) return value;
  try {
    const source: unknown = JSON.parse(value);
    if (!record(source) || typeof source.title !== "string" || !strings(source.tags) || !strings(source.topicIds)
      || typeof source.unitId !== "string" || (source.unitIds !== undefined && !strings(source.unitIds)) || !strings(source.ruleIds)
      || typeof source.filePath !== "string" || typeof source.needsClarification !== "boolean" || !record(source.anchor)
      || Object.keys(source).some(key => !["title", "tags", "topicIds", "unitId", "unitIds", "ruleIds", "test", "needsClarification", "filePath", "anchor"].includes(key))) return undefined;
    if (source.test !== null) validateTopicCard(source.test, "Исходная карточка");
    return importSourceFingerprint(source);
  } catch { return undefined; }
}

/** Never invent an original for untracked cards or reinterpret other import formats. */
export function compactImportSourceReference(ref: PackageQuestionRef): PackageQuestionRef {
  const copied = { ...ref, ...(Array.isArray(ref.sourceRuleIds) ? { sourceRuleIds: [...ref.sourceRuleIds] } : {}) };
  if (ref.packageId === "markdown-card-draft") {
    const contentFingerprint = legacyTest(ref.contentFingerprint), cardFingerprint = legacyTest(ref.cardFingerprint);
    return contentFingerprint && cardFingerprint ? { ...copied, contentFingerprint, cardFingerprint } : copied;
  }
  if (ref.packageId === "portable-library" && ref.contentFingerprint.startsWith("portable-library-card:")) {
    const cardFingerprint = legacyAuthoring(ref.cardFingerprint);
    if (!cardFingerprint) return copied;
    if (!isCompactSourceFingerprint(ref.cardFingerprint) && ref.sourceRuleIds === undefined) {
      const source = JSON.parse(ref.cardFingerprint) as Record<string, unknown>;
      if (!isValidSourceRuleIds(source.ruleIds)) return copied;
      copied.sourceRuleIds = [...source.ruleIds];
    }
    return { ...copied, cardFingerprint };
  }
  return copied;
}

/** Inspect raw storage before validation so the host can back up the exact legacy bytes. */
export function inspectCompactImportMigration(raw: unknown): { references: number; bytesBefore: number; bytesAfter: number } {
  const result = { references: 0, bytesBefore: 0, bytesAfter: 0 };
  if (!record(raw)) return result;
  const cards = Array.isArray(raw.cards) ? raw.cards : Array.isArray(raw.reminders) ? raw.reminders : [];
  for (const card of cards) {
    if (!record(card) || !record(card.packageQuestionRef)) continue;
    const ref = card.packageQuestionRef;
    if (typeof ref.packageId !== "string" || typeof ref.contentFingerprint !== "string" || typeof ref.cardFingerprint !== "string") continue;
    const before = JSON.stringify(ref), after = JSON.stringify(compactImportSourceReference(ref as unknown as PackageQuestionRef));
    if (before === after) continue;
    result.references++; result.bytesBefore += new TextEncoder().encode(before).length; result.bytesAfter += new TextEncoder().encode(after).length;
  }
  return result;
}
