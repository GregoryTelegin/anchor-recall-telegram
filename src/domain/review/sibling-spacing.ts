import { fsrsStudyDay } from "../scheduling/fsrs-optimizer-core";

export type SiblingSpacingMode = "study-day" | "duration";
export interface SiblingSpacingSettings {
  siblingSpacingEnabled: boolean;
  siblingSpacingMode: SiblingSpacingMode;
  siblingSpacingMinutes: number;
}
export interface SiblingCard {
  id: string;
  dueAt: number;
  test?: unknown;
  reviewHistory?: readonly { reviewedAt: number; rating?: number }[];
  schedulerMode?: string;
  fsrsCard?: { state: number; scheduledDays: number };
}

export const DEFAULT_SIBLING_SPACING_MINUTES = 1440;
export const MAX_SIBLING_SPACING_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);
export const MAX_SIBLING_GROUP_ID_LENGTH = 512;
export const normalizeSiblingGroupId = (value: unknown): string => typeof value === "string"
  ? value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, MAX_SIBLING_GROUP_ID_LENGTH) : "";

const testFields = (card: { test?: unknown }): Record<string, unknown> =>
  card.test && typeof card.test === "object" && !Array.isArray(card.test) ? card.test as Record<string, unknown> : {};

/** IDs describe explicit sibling families, not knowledge or matching answers. */
export const cardSiblingGroupId = (card: { test?: unknown }): string => normalizeSiblingGroupId(testFields(card).siblingGroupId);
export const cardHasActiveSiblings = (card: { test?: unknown }): boolean => {
  const test = testFields(card);
  return Boolean(normalizeSiblingGroupId(test.siblingGroupId)) && (test.siblingEnabled === undefined || test.siblingEnabled === true);
};
export const normalizeSiblingSpacingMinutes = (value: unknown): number => {
  const minutes = typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(minutes) && minutes > 0
    ? Math.max(1, Math.min(MAX_SIBLING_SPACING_MINUTES, Math.round(minutes))) : DEFAULT_SIBLING_SPACING_MINUTES;
};
export const normalizeSiblingSpacingSettings = (value: unknown = {}): SiblingSpacingSettings => {
  const settings = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    siblingSpacingEnabled: settings.siblingSpacingEnabled === true,
    siblingSpacingMode: settings.siblingSpacingMode === "duration" ? "duration" : "study-day",
    siblingSpacingMinutes: normalizeSiblingSpacingMinutes(settings.siblingSpacingMinutes)
  };
};

/** Short FSRS learning steps remain available on their own schedule. */
export const isIntradaySiblingLearning = (card: SiblingCard): boolean => card.schedulerMode === "fsrs"
  && Boolean(card.fsrsCard && (card.fsrsCard.state === 1 || card.fsrsCard.state === 3)
    && Number.isFinite(card.fsrsCard.scheduledDays) && card.fsrsCard.scheduledDays >= 0 && card.fsrsCard.scheduledDays < 1);

/** Queue eligibility only. Callers provide Core candidates and all Core history,
 * including cards outside the visible filter; no dates or learning state change. */
export const selectSiblingReviewCards = <T extends SiblingCard>(
  candidates: readonly T[], allCards: readonly SiblingCard[], now: number, value: unknown = {}
): { available: T[]; deferred: T[] } => {
  const settings = normalizeSiblingSpacingSettings(value);
  if (!settings.siblingSpacingEnabled || !Number.isFinite(now) || now < 0 || !Number.isFinite(new Date(now).getTime()))
    return { available: [...candidates], deferred: [] };

  const studyDay = fsrsStudyDay(now), spacingMs = settings.siblingSpacingMinutes * 60_000;
  const reviewed = new Map<string, Set<string>>();
  for (const card of allCards) {
    if (!cardHasActiveSiblings(card)) continue;
    const recentlyReviewed = card.reviewHistory?.some(event => Number.isFinite(event.reviewedAt) && event.reviewedAt >= 0 && event.reviewedAt <= now
      && Number.isInteger(event.rating) && event.rating! >= 1 && event.rating! <= 4
      && (settings.siblingSpacingMode === "study-day" ? fsrsStudyDay(event.reviewedAt) === studyDay : now - event.reviewedAt < spacingMs));
    if (!recentlyReviewed) continue;
    const group = cardSiblingGroupId(card), members = reviewed.get(group) ?? new Set<string>();
    members.add(card.id); reviewed.set(group, members);
  }

  const representatives = new Map<string, T>();
  for (const card of candidates) {
    if (!cardHasActiveSiblings(card)) continue;
    const group = cardSiblingGroupId(card);
    if (reviewed.has(group)) continue;
    const previous = representatives.get(group);
    if (!previous || (isIntradaySiblingLearning(card) && !isIntradaySiblingLearning(previous))
      || (isIntradaySiblingLearning(card) === isIntradaySiblingLearning(previous)
        && (card.dueAt < previous.dueAt || !Number.isFinite(previous.dueAt) && Number.isFinite(card.dueAt)))) representatives.set(group, card);
  }
  const available: T[] = [], deferred: T[] = [];
  for (const card of candidates) {
    const group = cardSiblingGroupId(card), seen = reviewed.get(group);
    const eligible = !cardHasActiveSiblings(card) || isIntradaySiblingLearning(card)
      || (seen ? seen.has(card.id) : representatives.get(group)?.id === card.id);
    (eligible ? available : deferred).push(card);
  }
  return { available, deferred };
};
