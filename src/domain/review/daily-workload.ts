import type { RecallTestDefinition } from "../cards/recall-test-core";
import { isCoreCard, type CardLibraryRole } from "../library/learning-library-core";
import { fsrsStudyDay } from "../scheduling/fsrs-optimizer-core";
import { isIntradaySiblingLearning } from "./sibling-spacing";
import type { SchedulerMode } from "./types";

export const MAX_DAILY_NEW_LIMIT = 999;
export const MAX_DAILY_REVIEW_LIMIT = 9999;
export const MAX_DAILY_DEBT_PORTION = 100;
export interface DailyWorkloadSettings {
  enabled: boolean;
  newLimit: number | null;
  reviewLimit: number | null;
  pauseNewWithOverdue: boolean;
  debtPortion: number;
}
export const DEFAULT_DAILY_WORKLOAD_SETTINGS: Readonly<DailyWorkloadSettings> = Object.freeze({
  enabled: false, newLimit: 5, reviewLimit: 30, pauseNewWithOverdue: false, debtPortion: 10
});
export type DailyWorkloadKind = "new" | "review" | "step";
export interface WorkloadDayEntry { cardId: string; kind: DailyWorkloadKind; }
export interface WorkloadDay { version: 1; day: number; initializedAt: number; entries: WorkloadDayEntry[]; }
export interface DailyWorkloadCard {
  id: string;
  test?: RecallTestDefinition;
  cardRole?: CardLibraryRole;
  schedulerMode?: SchedulerMode;
  status: "active" | "paused" | "completed";
  dueAt: number;
  fsrsCard?: { state: number; scheduledDays: number };
  reviewHistory: readonly { reviewedAt: number; rating?: number; schedulerMode?: SchedulerMode }[];
}
/** A caller may share classification within one read-only calculation. */
export interface DailyWorkloadCardAnalysis<T extends DailyWorkloadCard = DailyWorkloadCard> {
  isCore(card: T): boolean;
  kind(card: T): DailyWorkloadKind;
}
export interface DailyWorkloadSummary {
  day: number;
  dayStartsAt: number;
  initializedAt: number;
  partial: boolean;
  enabled: boolean;
  newUsed: number;
  reviewUsed: number;
  stepUsed: number;
  newRemaining: number | null;
  reviewRemaining: number | null;
  overdueCount: number;
  settings: DailyWorkloadSettings;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, minimum: number, maximum: number): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
  && value >= 0 && Number.isFinite(new Date(value).getTime());

/** Strict at persistence and command boundaries; absent legacy preferences stay absent. */
export function normalizeDailyWorkloadSettings(value: unknown): DailyWorkloadSettings | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || Object.keys(value).some(key => !["enabled", "newLimit", "reviewLimit", "pauseNewWithOverdue", "debtPortion"].includes(key))
    || typeof value.enabled !== "boolean" || typeof value.pauseNewWithOverdue !== "boolean"
    || value.newLimit !== null && !integer(value.newLimit, 0, MAX_DAILY_NEW_LIMIT)
    || value.reviewLimit !== null && !integer(value.reviewLimit, 0, MAX_DAILY_REVIEW_LIMIT)
    || !integer(value.debtPortion, 1, MAX_DAILY_DEBT_PORTION))
    throw new Error("Повреждены параметры дневной нагрузки.");
  return { enabled: value.enabled, newLimit: value.newLimit as number | null, reviewLimit: value.reviewLimit as number | null,
    pauseNewWithOverdue: value.pauseNewWithOverdue, debtPortion: value.debtPortion };
}

/** Consumed IDs may belong to deleted or moved cards; they must not replenish the day. */
export function normalizeWorkloadDay(value: unknown): WorkloadDay | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.day) || !timestamp(value.initializedAt)
    || Object.keys(value).some(key => !["version", "day", "initializedAt", "entries"].includes(key))
    || !Array.isArray(value.entries))
    throw new Error("Повреждён учёт дневной нагрузки.");
  const ids = new Set<string>(), entries: WorkloadDayEntry[] = [];
  for (let index = 0; index < value.entries.length; index++) {
    const entry: unknown = value.entries[index];
    if (!Object.prototype.hasOwnProperty.call(value.entries, index) || !record(entry)
      || Object.keys(entry).some(key => key !== "cardId" && key !== "kind")
      || typeof entry.cardId !== "string" || !entry.cardId.length || ids.has(entry.cardId)
      || entry.kind !== "new" && entry.kind !== "review" && entry.kind !== "step")
      throw new Error("Повреждены записи дневной нагрузки.");
    ids.add(entry.cardId); entries.push({ cardId: entry.cardId, kind: entry.kind });
  }
  return { version: 1, day: value.day as number, initializedAt: value.initializedAt, entries };
}

export function dailyWorkloadStudyDayStart(now: number): number {
  if (!timestamp(now)) throw new Error("Некорректное время дневной нагрузки.");
  const start = new Date(now); start.setHours(4, 0, 0, 0);
  if (start.getTime() > now) start.setDate(start.getDate() - 1);
  return start.getTime();
}
export function nextDailyWorkloadDayStart(now: number): number {
  const next = new Date(dailyWorkloadStudyDayStart(now)); next.setDate(next.getDate() + 1); return next.getTime();
}

/** A projection only: callers decide when to persist it with an accepted Core answer. */
export function currentWorkloadDay(ledger: WorkloadDay | undefined, now: number): WorkloadDay {
  const start = dailyWorkloadStudyDayStart(now), day = fsrsStudyDay(now);
  const saved = normalizeWorkloadDay(ledger);
  return saved?.day === day ? saved : { version: 1, day, initializedAt: saved ? start : now, entries: [] };
}

export function classifyDailyWorkloadCard(card: DailyWorkloadCard): DailyWorkloadKind {
  const previouslyRated = card.reviewHistory.some(event => timestamp(event.reviewedAt)
    && event.schedulerMode !== "manual" && (event.rating === 1 || event.rating === 2 || event.rating === 3 || event.rating === 4));
  if (!previouslyRated) return "new";
  return isIntradaySiblingLearning(card) ? "step" : "review";
}

export function isDailyWorkloadOverdue<T extends DailyWorkloadCard>(card: T, now: number, analysis?: DailyWorkloadCardAnalysis<T>): boolean {
  return (analysis ? analysis.isCore(card) : isCoreCard(card)) && card.status === "active"
    && (analysis ? analysis.kind(card) : classifyDailyWorkloadCard(card)) === "review"
    && Number.isFinite(card.dueAt) && card.dueAt < dailyWorkloadStudyDayStart(now);
}

/** The card is its pre-grade value; use the writer-head acceptance time, not an old requested review time. */
export function recordDailyWorkloadReview(ledger: WorkloadDay | undefined, card: DailyWorkloadCard, accountedAt: number): WorkloadDay {
  const current = currentWorkloadDay(ledger, accountedAt);
  if (!isCoreCard(card) || current.entries.some(entry => entry.cardId === card.id)) return current;
  return { ...current, entries: [...current.entries, { cardId: card.id, kind: classifyDailyWorkloadCard(card) }] };
}

export function getDailyWorkloadSummary<T extends DailyWorkloadCard>(ledger: WorkloadDay | undefined, allCards: readonly T[], now: number,
  preferences?: DailyWorkloadSettings, analysis?: DailyWorkloadCardAnalysis<T>): DailyWorkloadSummary {
  const settings = normalizeDailyWorkloadSettings(preferences) ?? { ...DEFAULT_DAILY_WORKLOAD_SETTINGS };
  const current = currentWorkloadDay(ledger, now), dayStartsAt = dailyWorkloadStudyDayStart(now);
  const newUsed = current.entries.filter(entry => entry.kind === "new").length;
  const reviewUsed = current.entries.filter(entry => entry.kind === "review").length;
  const stepUsed = current.entries.filter(entry => entry.kind === "step").length;
  const remaining = (limit: number | null, used: number): number | null => settings.enabled && limit !== null ? Math.max(0, limit - used) : null;
  return { day: current.day, dayStartsAt, initializedAt: current.initializedAt, partial: current.initializedAt > dayStartsAt,
    enabled: settings.enabled, newUsed, reviewUsed, stepUsed, newRemaining: remaining(settings.newLimit, newUsed),
    reviewRemaining: remaining(settings.reviewLimit, reviewUsed), overdueCount: allCards.filter(card => isDailyWorkloadOverdue(card, now, analysis)).length, settings };
}
