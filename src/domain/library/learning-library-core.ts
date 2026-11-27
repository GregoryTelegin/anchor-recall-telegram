import { normalizeRecallTest } from "../cards/recall-test-core";
import { cloneCardAttachments, validateCardAttachments, type CardAttachment } from "../cards/card-attachments";
import type { AdaptiveSchedulerMode, Reminder, ReminderStatus, ReviewRating, StoredFsrsCard, StoredLeitnerState, StoredSm2State } from "../review/types";
import type { Bookmark } from "../anchors/types";
import { tagKey } from "./tag-key";
import { unitIdsOf, validUnitBindings } from "./unit-bindings";
import { isCompactSourceFingerprint, isValidSourceCardId, isValidSourceRuleIds } from "../cards/import-source-identity";

export type CardLibraryRole = "bank" | "core";

export interface LearningUnit {
  id: string;
  title: string;
  courseTitle?: string;
  topicIds: string[];
  tags: string[];
}

export interface LearningRule {
  id: string;
  title: string;
  unitId?: string;
  unitIds?: string[];
  topicIds?: string[];
  tags?: string[];
  /** Saved materials that use this rule; never an inferred source or section. */
  materialIds?: string[];
  body: string;
  attachments: CardAttachment[];
  createdAt: number;
  updatedAt: number;
}

export interface LearningLibraryState { version: 1; units: LearningUnit[]; rules: LearningRule[]; }

export interface PracticeAttempt {
  id: string;
  practicedAt: number;
  rating: ReviewRating;
  correct: boolean;
  /** Exact comparison is independent from the learner's memory rating.
   * null means self-check; missing means no comparison was captured. */
  answerMatch?: boolean | null;
  answerDurationMs?: number;
  hintsUsed?: number;
  hintsAvailable?: number;
  sessionId?: string;
  answer?: string;
  question?: string;
  reference?: string;
}

/** Import identity and compatible source fingerprints; never learner scheduling data. */
export interface PackageQuestionRef {
  packageId: string;
  questionId: string;
  revision: number;
  packageRevision: number;
  contentFingerprint: string;
  cardFingerprint: string;
  sourceCardId?: string;
  sourceRuleIds?: string[];
  sourceContextHash?: string;
}

/** Retained when an old manual/SM-2/Leitner card is explicitly promoted to Core. */
export interface ArchivedLegacySchedule {
  archivedAt: number;
  schedulerMode: "manual" | "sm2" | "leitner";
  dueAt: number;
  status: ReminderStatus;
  offsetsMinutes: number[];
  deliveredSteps: number[];
  repeatCount: number;
  repeatLast: boolean;
  cycleIndex: number;
  lastReviewedAt?: number;
  intervalPresetName?: string;
  sm2State?: StoredSm2State;
  leitnerState?: StoredLeitnerState;
}

export const emptyLearningLibrary = (): LearningLibraryState => ({ version: 1, units: [], rules: [] });

/** Explicit rule metadata is authoritative, including an empty selection.
 * Older rules with an absent field still read that field from their sections. */
export function learningRuleMetadata(rule: LearningRule, library: LearningLibraryState): { topicIds: string[]; tags: string[] } {
  const units = unitIdsOf(rule).flatMap(id => library.units.find(item => item.id === id) ?? []);
  const tags: string[] = [], keys = new Set<string>();
  for (const tag of rule.tags ?? units.flatMap(unit => unit.tags)) {
    const key = tagKey(tag);
    if (!keys.has(key)) { keys.add(key); tags.push(tag); }
  }
  return { topicIds: [...new Set(rule.topicIds ?? units.flatMap(unit => unit.topicIds))], tags };
}

export function learningRuleMaterials<T extends { id: string }>(rule: Pick<LearningRule, "materialIds">, materials: readonly T[]): T[] {
  const ids = new Set(rule.materialIds ?? []);
  return materials.filter(material => ids.has(material.id));
}

/** Display only: filters must match each material separately, never mix their classifications. */
export function learningRuleMaterialMetadata(rule: Pick<LearningRule, "materialIds">,
  materials: readonly Pick<Bookmark, "id" | "topicIds" | "tags" | "unitId" | "unitIds">[]): { topicIds: string[]; tags: string[]; unitIds: string[] } {
  const linked = learningRuleMaterials(rule, materials), tags: string[] = [], keys = new Set<string>();
  for (const tag of linked.flatMap(material => material.tags)) {
    const key = tagKey(tag);
    if (!keys.has(key)) { keys.add(key); tags.push(tag); }
  }
  return { topicIds: [...new Set(linked.flatMap(material => material.topicIds))], tags,
    unitIds: [...new Set(linked.flatMap(unitIdsOf))] };
}

/** Material rules stay dynamic; legacy direct links remain valid without copying inherited IDs onto cards. */
export function effectiveCardRuleIds(card: Pick<Reminder, "ruleIds" | "materialId" | "detachedMaterialId" | "linkedMaterialIds">,
  library: LearningLibraryState, materials: readonly { id: string }[]): string[] {
  const knownMaterials = new Set(materials.map(material => material.id)), knownRules = new Set(library.rules.map(rule => rule.id));
  const materialIds = new Set((card.linkedMaterialIds ?? []).filter(id => knownMaterials.has(id)));
  if (card.detachedMaterialId !== card.materialId && knownMaterials.has(card.materialId)) materialIds.add(card.materialId);
  const ids = new Set((card.ruleIds ?? []).filter(id => knownRules.has(id)));
  for (const rule of library.rules) if (rule.materialIds?.some(id => materialIds.has(id))) ids.add(rule.id);
  return [...ids];
}

/** Inference is read-only: opening old data must never schedule or rewrite it. */
export function cardLibraryRole(card: Pick<Reminder, "cardRole" | "schedulerMode" | "test">): CardLibraryRole {
  return card.cardRole ?? (card.schedulerMode === "fsrs" && Boolean(normalizeRecallTest(card.test)) ? "core" : "bank");
}

export function isCoreCard(card: Pick<Reminder, "cardRole" | "schedulerMode" | "test">): boolean {
  return cardLibraryRole(card) === "core" && ["fsrs", "sm2", "leitner"].includes(card.schedulerMode ?? "") && Boolean(normalizeRecallTest(card.test));
}

/** Returns a replacement; the caller must commit it through the data repository. */
export function convertCardLibraryRole(card: Reminder, role: CardLibraryRole, now = Date.now(),
  createFsrsCard?: (card: Reminder, now: number) => StoredFsrsCard, preferredScheduler?: AdaptiveSchedulerMode): Reminder {
  if (preferredScheduler !== undefined && !["fsrs", "sm2", "leitner"].includes(preferredScheduler))
    throw new Error("Выберите алгоритм повторения карточки.");
  const adaptive = ["fsrs", "sm2", "leitner"].includes(card.schedulerMode ?? "");
  const schedulerMode: AdaptiveSchedulerMode = preferredScheduler
    ?? (adaptive && (card.cardRole !== undefined || card.schedulerMode === "fsrs") ? card.schedulerMode as AdaptiveSchedulerMode : "fsrs");
  if (role === "bank") return { ...card, cardRole: "bank", ...(preferredScheduler !== undefined ? { schedulerMode } : {}) };
  if (!normalizeRecallTest(card.test)) throw new Error("Для Core нужен вопрос, который можно оценить.");
  if (card.schedulerMode === schedulerMode) return { ...card, cardRole: "core" };
  if (!Number.isFinite(now) || now < 0) throw new Error("Некорректное время активации Core.");
  // An explicit algorithm choice changes only this card's active engine. Its
  // history and deadline remain authoritative; inactive engine states stay suspended.
  if (adaptive && (card.cardRole !== undefined || preferredScheduler !== undefined)) return { ...card, cardRole: "core", schedulerMode,
    ...(schedulerMode === "fsrs" ? { fsrsCard: card.fsrsCard ? { ...card.fsrsCard, due: card.dueAt }
      : createFsrsCard?.(card, card.dueAt) ?? { due: card.dueAt, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0,
        learningSteps: 0, reps: 0, lapses: 0, state: 0 } } : {}) };
  const archivedLegacySchedule: ArchivedLegacySchedule = card.archivedLegacySchedule ?? {
    archivedAt: now, schedulerMode: card.schedulerMode as ArchivedLegacySchedule["schedulerMode"] ?? "manual", dueAt: card.dueAt, status: card.status,
    offsetsMinutes: [...card.offsetsMinutes], deliveredSteps: [...card.deliveredSteps], repeatCount: card.repeatCount,
    repeatLast: card.repeatLast, cycleIndex: card.cycleIndex,
    ...(card.lastReviewedAt !== undefined ? { lastReviewedAt: card.lastReviewedAt } : {}),
    ...(card.intervalPresetName !== undefined ? { intervalPresetName: card.intervalPresetName } : {}),
    ...(card.sm2State ? { sm2State: { ...card.sm2State } } : {}),
    ...(card.leitnerState ? { leitnerState: { ...card.leitnerState } } : {})
  };
  const initial = schedulerMode === "fsrs" ? card.fsrsCard ?? createFsrsCard?.(card, now) ?? {
      due: now, stability: 0, difficulty: 0, elapsedDays: 0, scheduledDays: 0,
      learningSteps: 0, reps: 0, lapses: 0, state: 0
    } : undefined;
  return { ...card, cardRole: "core", schedulerMode, archivedLegacySchedule,
    deliveredSteps: [], repeatCount: 0, cycleIndex: 0, dueAt: initial?.due ?? now,
    ...(initial ? { fsrsCard: initial } : {}) };
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown, max = 300): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 10_000 && value.every(item => text(item, 1024));
const knownFields = (value: RecordValue, fields: string[]): boolean => Object.keys(value).every(key => fields.includes(key));

export type LearningLibraryValidation = { valid: true; library: LearningLibraryState } | { valid: false; errors: string[] };

/** No repair or dropping records: the complete catalogue is checked before use. */
export function validateLearningLibrary(value: unknown, topicIds?: ReadonlySet<string>): LearningLibraryValidation {
  if (value === undefined) return { valid: true, library: emptyLearningLibrary() };
  if (!record(value) || value.version !== 1 || !Array.isArray(value.units) || !Array.isArray(value.rules)
    || !knownFields(value, ["version", "units", "rules"])) return { valid: false, errors: ["Библиотека: повреждена структура."] };
  const errors: string[] = [], unitIds = new Set<string>(), ruleIds = new Set<string>();
  const units: LearningUnit[] = [], rules: LearningRule[] = [];
  value.units.forEach((item: unknown, index: number) => {
    if (!record(item) || !knownFields(item, ["id", "title", "courseTitle", "topicIds", "tags"])
      || !text(item.id, 500) || !text(item.title) || (item.courseTitle !== undefined && !text(item.courseTitle))
      || !strings(item.topicIds) || !strings(item.tags)) return void errors.push(`Раздел ${index + 1}: повреждены поля.`);
    if (unitIds.has(item.id)) errors.push(`Раздел ${item.id}: повторяющийся ID.`);
    unitIds.add(item.id);
    if (topicIds) item.topicIds.forEach(id => { if (!topicIds.has(id)) errors.push(`Раздел ${item.id}: отсутствует тема ${id}.`); });
    units.push({ id: item.id, title: item.title, ...(item.courseTitle !== undefined ? { courseTitle: item.courseTitle } : {}),
      topicIds: [...item.topicIds], tags: [...item.tags] });
  });
  value.rules.forEach((item: unknown, index: number) => {
    if (!record(item) || !knownFields(item, ["id", "title", "unitId", "unitIds", "topicIds", "tags", "materialIds", "body", "attachments", "createdAt", "updatedAt"])
      || !text(item.id, 500) || !text(item.title) || typeof item.body !== "string" || item.body.length > 200_000
      || !Array.isArray(item.attachments) || !time(item.createdAt) || !time(item.updatedAt)
      || !validUnitBindings({ unitId: item.unitId, unitIds: item.unitIds }, unitIds)
      || (item.topicIds !== undefined && (!strings(item.topicIds) || new Set(item.topicIds).size !== item.topicIds.length))
      || (item.tags !== undefined && (!strings(item.tags) || new Set(item.tags.map(tagKey)).size !== item.tags.length)))
      return void errors.push(`Правило ${index + 1}: повреждены поля или связь с разделом.`);
    if (item.materialIds !== undefined && (!strings(item.materialIds) || new Set(item.materialIds).size !== item.materialIds.length
      || !Array.from({ length: item.materialIds.length }, (_, index) => Object.prototype.hasOwnProperty.call(item.materialIds, index)).every(Boolean)))
      return void errors.push(`Правило ${index + 1}: повреждены связи с материалами.`);
    const attachments = validateCardAttachments(item.attachments);
    if (!attachments.valid) return void errors.push(`Правило ${item.id}: ${attachments.error}`);
    if (ruleIds.has(item.id)) errors.push(`Правило ${item.id}: повторяющийся ID.`);
    ruleIds.add(item.id);
    if (topicIds && item.topicIds) (item.topicIds as string[]).forEach(id => { if (!topicIds.has(id)) errors.push(`Правило ${item.id}: отсутствует тема ${id}.`); });
    rules.push({ id: item.id, title: item.title, ...(item.unitId !== undefined ? { unitId: item.unitId as string } : {}),
      ...(item.unitIds !== undefined ? { unitIds: [...item.unitIds as string[]] } : {}), body: item.body,
      ...(item.topicIds !== undefined ? { topicIds: [...item.topicIds as string[]] } : {}), ...(item.tags !== undefined ? { tags: [...item.tags as string[]] } : {}),
      ...(item.materialIds !== undefined ? { materialIds: [...item.materialIds as string[]] } : {}),
      attachments: cloneCardAttachments(attachments.attachments) ?? [], createdAt: item.createdAt, updatedAt: item.updatedAt });
  });
  return errors.length ? { valid: false, errors } : { valid: true, library: { version: 1, units, rules } };
}

export function validatePracticeHistory(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "История тренировки: нужен массив.";
  const ids = new Set<string>();
  for (const item of value) {
    if (!record(item) || !knownFields(item, ["id", "practicedAt", "rating", "correct", "answerMatch", "answerDurationMs", "hintsUsed", "hintsAvailable", "sessionId", "answer", "question", "reference"])
      || !text(item.id) || ids.has(item.id) || !time(item.practicedAt) || ![1, 2, 3, 4].includes(Number(item.rating))
      || typeof item.rating !== "number" || typeof item.correct !== "boolean"
      || (item.answerMatch !== undefined && item.answerMatch !== null && typeof item.answerMatch !== "boolean")
      || (item.answerDurationMs !== undefined && !time(item.answerDurationMs))
      || (item.hintsUsed !== undefined && (!time(item.hintsUsed) || !Number.isInteger(item.hintsUsed)))
      || (item.hintsAvailable !== undefined && (!time(item.hintsAvailable) || !Number.isInteger(item.hintsAvailable)))
      || (typeof item.hintsUsed === "number" && typeof item.hintsAvailable === "number" && item.hintsUsed > item.hintsAvailable)
      || (item.sessionId !== undefined && !text(item.sessionId))
      || ["answer", "question", "reference"].some(field => item[field] !== undefined && (typeof item[field] !== "string" || (item[field] as string).length > 100_000))) return "История тренировки: повреждена попытка или повторяется ID.";
    ids.add(item.id);
  }
  return undefined;
}

export function validateArchivedLegacySchedule(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !knownFields(value, ["archivedAt", "schedulerMode", "dueAt", "status", "offsetsMinutes", "deliveredSteps", "repeatCount", "repeatLast", "cycleIndex", "lastReviewedAt", "intervalPresetName", "sm2State", "leitnerState"])
    || !time(value.archivedAt) || !["manual", "sm2", "leitner"].includes(String(value.schedulerMode)) || !time(value.dueAt)
    || !["active", "paused", "completed"].includes(String(value.status)) || !Array.isArray(value.offsetsMinutes)
    || !value.offsetsMinutes.every(time) || !Array.isArray(value.deliveredSteps) || !value.deliveredSteps.every(time)
    || !time(value.repeatCount) || typeof value.repeatLast !== "boolean" || !time(value.cycleIndex)
    || (value.lastReviewedAt !== undefined && !time(value.lastReviewedAt))
    || (value.intervalPresetName !== undefined && typeof value.intervalPresetName !== "string")
    || (value.sm2State !== undefined && (!record(value.sm2State) || !["repetitions", "intervalDays", "easeFactor"].every(field => time(value.sm2State && (value.sm2State as RecordValue)[field]))))
    || (value.leitnerState !== undefined && (!record(value.leitnerState) || !time(value.leitnerState.box)))) return "Повреждён архив прежнего расписания.";
  return undefined;
}

export function validateCardLearningFields(card: RecordValue, library: LearningLibraryState): string[] {
  const errors: string[] = [];
  if (card.cardRole !== undefined && card.cardRole !== "bank" && card.cardRole !== "core") errors.push("неизвестный тип карточки.");
  if (card.schedulerMode !== undefined && (typeof card.schedulerMode !== "string" || !["manual", "fsrs", "sm2", "leitner"].includes(card.schedulerMode)))
    errors.push("неизвестный алгоритм повторения карточки.");
  if (card.cardRole === "core" && (typeof card.schedulerMode !== "string" || !["fsrs", "sm2", "leitner"].includes(card.schedulerMode) || !record(card.test) || !normalizeRecallTest(card.test))) errors.push("Core требует вопрос и алгоритм FSRS, SM-2 или Лейтнер.");
  if (!validUnitBindings({ unitId: card.unitId, unitIds: card.unitIds }, new Set(library.units.map(unit => unit.id)))) errors.push("повреждены связи с разделами или отсутствует связанный раздел.");
  if (card.ruleIds !== undefined && (!strings(card.ruleIds) || new Set(card.ruleIds).size !== card.ruleIds.length
    || card.ruleIds.some(id => !library.rules.some(rule => rule.id === id)))) errors.push("повреждены связи с правилами.");
  const historyIssue = validatePracticeHistory(card.practiceHistory); if (historyIssue) errors.push(historyIssue);
  const archiveIssue = validateArchivedLegacySchedule(card.archivedLegacySchedule); if (archiveIssue) errors.push(archiveIssue);
  if (card.packageQuestionRef !== undefined) {
    const ref = card.packageQuestionRef;
    if (!record(ref) || !knownFields(ref, ["packageId", "questionId", "revision", "packageRevision", "contentFingerprint", "cardFingerprint", "sourceCardId", "sourceRuleIds", "sourceContextHash"])
      || !text(ref.packageId, 160) || !/^[a-z0-9][a-z0-9._-]*$/.test(ref.packageId)
      || !text(ref.questionId, 160) || !/^[a-z0-9][a-z0-9._-]*$/.test(ref.questionId) || !time(ref.revision) || !Number.isInteger(ref.revision) || ref.revision < 1
      || !time(ref.packageRevision) || !Number.isInteger(ref.packageRevision) || ref.packageRevision < 1
      || !text(ref.contentFingerprint, 500_000) || !text(ref.cardFingerprint, 500_000)
      || (ref.sourceCardId !== undefined && !isValidSourceCardId(ref.sourceCardId))
      || (ref.sourceRuleIds !== undefined && (ref.packageId !== "portable-library" || !isValidSourceRuleIds(ref.sourceRuleIds)))
      || (ref.sourceContextHash !== undefined && (!["portable-library", "csv-import"].includes(String(ref.packageId)) || !isCompactSourceFingerprint(ref.sourceContextHash)))
      || (["markdown-card-draft", "portable-library", "csv-import"].includes(String(ref.packageId))
        && [ref.contentFingerprint, ref.cardFingerprint].some(value => typeof value === "string" && value.startsWith("sha256:") && !isCompactSourceFingerprint(value)))) errors.push("повреждена ссылка на пакет вопросов.");
  }
  return errors;
}
