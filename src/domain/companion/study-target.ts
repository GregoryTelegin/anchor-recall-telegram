import { studyTargetConfigFingerprint, studyTargetExamEndAt, STUDY_TARGET_TRANSITION_MS, validateStudyTargetConfig, type StudyTargetConfig } from "../planning/study-target";

/** Only the date and the explicitly shared card scope leave the vault. */
export interface CompanionStudyTarget {
  version: 1; id: string; enabled: boolean; targetDate: string; timeZone: string;
  examEndAt: number; transitionEndAt: number; cardIds: string[];
}
type SharedCard = { id: string; mode: "core" | "bank"; eligible: boolean };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (): never => { throw new Error("Invalid companion study target"); };
const fields = ["version", "id", "enabled", "targetDate", "timeZone", "examEndAt", "transitionEndAt", "cardIds"];

export function validateCompanionStudyTarget(value: unknown, cards?: readonly SharedCard[]): asserts value is CompanionStudyTarget {
  if (!object(value) || Object.keys(value).length !== fields.length || !fields.every(key => Object.prototype.hasOwnProperty.call(value, key))
    || value.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id) || typeof value.enabled !== "boolean"
    || typeof value.targetDate !== "string" || !value.targetDate || typeof value.timeZone !== "string" || value.timeZone.length > 100
    || !Array.isArray(value.cardIds) || new Set(value.cardIds).size !== value.cardIds.length
    || !Array.from(value.cardIds).every(id => typeof id === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(id))) return fail();
  let end: number;
  try { end = studyTargetExamEndAt(value.targetDate, value.timeZone); } catch { return fail(); }
  if (value.examEndAt !== end || value.transitionEndAt !== end + STUDY_TARGET_TRANSITION_MS) return fail();
  if (cards) {
    const allowed = new Set(cards.filter(card => card.mode === "core" && card.eligible).map(card => card.id));
    if (!value.cardIds.every(id => allowed.has(id))) return fail();
  }
}

export function projectCompanionStudyTarget(value: StudyTargetConfig, cardIds: readonly string[]): CompanionStudyTarget {
  const config = validateStudyTargetConfig(value), examEndAt = studyTargetExamEndAt(config.targetDate, config.timeZone);
  const target: CompanionStudyTarget = { version: 1, id: studyTargetConfigFingerprint(config).slice("sha256:".length), enabled: config.enabled,
    targetDate: config.targetDate, timeZone: config.timeZone, examEndAt, transitionEndAt: examEndAt + STUDY_TARGET_TRANSITION_MS,
    cardIds: [...cardIds] };
  validateCompanionStudyTarget(target); return target;
}
